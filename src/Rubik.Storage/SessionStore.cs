using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Rubik.Contracts;

namespace Rubik.Storage;

/// <summary>Per-session append-only JSONL store. A torn final line is preserved in a recovery sidecar and a fresh segment is opened.</summary>
public sealed class SessionStore
{
    private readonly string _directory;
    private readonly RetentionPolicy _retention;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<string> _segments = [];
    private FileStream? _stream;
    private long _bytes;
    private int _segment;
    public Guid SessionId { get; }
    public IReadOnlyList<string> EventSegments => _segments.AsReadOnly();

    private SessionStore(string directory, Guid sessionId, RetentionPolicy retention)
    { _directory = directory; SessionId = sessionId; _retention = retention; }

    public static async Task<SessionStore> CreateAsync(string storageRoot, Guid sessionId,
        IEnumerable<string> allowedRoots, RetentionPolicy? retention = null, CancellationToken cancellationToken = default)
    {
        if (sessionId == Guid.Empty) throw new ArgumentException("Session ID is required.", nameof(sessionId));
        retention ??= new(); retention.Validate();
        var root = Path.GetFullPath(storageRoot);
        Directory.CreateDirectory(root);
        var directory = Path.GetFullPath(Path.Combine(root, "sessions", sessionId.ToString("D")));
        EnsureWithin(root, directory);
        Directory.CreateDirectory(directory);
        var store = new SessionStore(directory, sessionId, retention);
        await store.InitializeAsync(allowedRoots, cancellationToken).ConfigureAwait(false);
        return store;
    }

    public async Task AppendAsync(RubikEvent e, CancellationToken cancellationToken = default)
    {
        ContractValidation.Validate(e);
        if (e.SessionId != SessionId) throw new InvalidDataException("Event belongs to a different session.");
        var line = JsonSerializer.SerializeToUtf8Bytes(e, RubikSchema.Json);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_stream is null) throw new ObjectDisposedException(nameof(SessionStore));
            if (_bytes + line.Length + 1 > _retention.MaxSessionBytes) throw new IOException("Session storage limit reached.");
            await _stream.WriteAsync(line, cancellationToken).ConfigureAwait(false);
            await _stream.WriteAsync("\n"u8.ToArray(), cancellationToken).ConfigureAwait(false);
            await _stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            _bytes += line.Length + 1;
        }
        finally { _gate.Release(); }
    }

    public async Task<SessionManifest> WriteManifestAsync(DateTimeOffset startedAtUtc, DateTimeOffset? endedAtUtc,
        string status, string? label, IEnumerable<string> allowedRoots, CancellationToken cancellationToken = default)
    {
        var roots = allowedRoots.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var manifest = new SessionManifest(RubikSchema.CurrentVersion, SessionId, startedAtUtc.ToUniversalTime(),
            endedAtUtc?.ToUniversalTime(), status, label, _segments.ToArray(), roots, _retention);
        var path = Path.Combine(_directory, "manifest.json");
        var temp = path + ".new-" + Guid.NewGuid().ToString("N");
        await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(manifest, RubikSchema.Json), cancellationToken).ConfigureAwait(false);
        File.Move(temp, path, true);
        return manifest;
    }

    public string ValidateArtifactPath(string configuredRoot, string candidatePath, long size)
    {
        if (size < 0 || size > _retention.MaxArtifactBytes) throw new IOException("Artifact size exceeds configured limit.");
        var root = Path.GetFullPath(configuredRoot);
        var path = Path.GetFullPath(candidatePath);
        EnsureWithin(root, path);
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Artifact does not exist.", path);
        if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Symbolic links and reparse points are not accepted.");
        if (info.Length > _retention.MaxArtifactBytes) throw new IOException("Artifact size exceeds configured limit.");
        return path;
    }

    public static async Task<byte[]> Sha256Async(string path, long maximumBytes, CancellationToken cancellationToken = default)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
        if (stream.Length > maximumBytes) throw new IOException("File exceeds hash size limit.");
        return await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false);
    }

    public static IEnumerable<string> FindExpiredSessions(string storageRoot, RetentionPolicy policy, DateTimeOffset nowUtc)
    {
        policy.Validate();
        if (!policy.DeleteExpiredSessions) yield break;
        var sessions = Path.GetFullPath(Path.Combine(storageRoot, "sessions"));
        if (!Directory.Exists(sessions)) yield break;
        foreach (var dir in Directory.EnumerateDirectories(sessions))
        {
            var path = Path.Combine(dir, "manifest.json");
            if (!File.Exists(path)) continue;
            SessionManifest? manifest;
            try { manifest = JsonSerializer.Deserialize<SessionManifest>(File.ReadAllText(path), RubikSchema.Json); }
            catch (JsonException) { continue; }
            if (manifest?.EndedAtUtc is { } end && end < nowUtc.AddDays(-policy.KeepDays)) yield return Path.GetFullPath(dir);
        }
    }

    public async ValueTask DisposeAsync()
    { await _gate.WaitAsync().ConfigureAwait(false); try { if (_stream is not null) { await _stream.FlushAsync().ConfigureAwait(false); await _stream.DisposeAsync().ConfigureAwait(false); _stream = null; } } finally { _gate.Release(); _gate.Dispose(); } }

    private async Task InitializeAsync(IEnumerable<string> allowedRoots, CancellationToken cancellationToken)
    {
        var normalizedRoots = allowedRoots.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var manifestPath = Path.Combine(_directory, "manifest.json");
        if (File.Exists(manifestPath))
        {
            var existing = JsonSerializer.Deserialize<SessionManifest>(await File.ReadAllTextAsync(manifestPath, cancellationToken).ConfigureAwait(false), RubikSchema.Json)
                ?? throw new InvalidDataException("Session manifest is empty.");
            if (existing.SchemaVersion != RubikSchema.CurrentVersion || existing.SessionId != SessionId) throw new InvalidDataException("Incompatible manifest.");
            _segments.AddRange(existing.EventsFiles);
        }
        else
        {
            var initial = Path.Combine(_directory, "events-0001.jsonl");
            _segments.Add(Path.GetFileName(initial));
        }
        foreach (var name in _segments.ToArray())
        {
            if (Path.GetFileName(name) != name) throw new InvalidDataException("Manifest event path must be a file name.");
            var path = Path.Combine(_directory, name);
            if (!File.Exists(path)) continue;
            var (validBytes, count, total) = await ScanCompleteLinesAsync(path, SessionId, cancellationToken).ConfigureAwait(false);
            _bytes += validBytes;
            if (total > validBytes)
            {
                // Preserve the torn suffix verbatim. Do not rewrite the existing segment; continue in a new segment.
                var tail = new byte[total - validBytes];
                await using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                { input.Position = validBytes; await input.ReadExactlyAsync(tail, cancellationToken).ConfigureAwait(false); }
                var recovery = path + ".recovery-" + DateTimeOffset.UtcNow.ToString("yyyyMMddTHHmmssfffZ") + ".partial";
                await File.WriteAllBytesAsync(recovery, tail, cancellationToken).ConfigureAwait(false);
                _segment = Math.Max(_segment, ParseSegment(name));
                _segment++;
                var next = $"events-{_segment:0000}.jsonl";
                if (!_segments.Contains(next)) _segments.Add(next);
            }
            else _segment = Math.Max(_segment, ParseSegment(name));
        }
        if (_segments.Count == 0) { _segment = 1; _segments.Add("events-0001.jsonl"); }
        var current = Path.Combine(_directory, _segments[^1]);
        _stream = new FileStream(current, FileMode.Append, FileAccess.Write, FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.WriteThrough);
        _bytes = Directory.EnumerateFiles(_directory, "events-*.jsonl").Sum(p => new FileInfo(p).Length);
        if (_bytes > _retention.MaxSessionBytes) throw new IOException("Existing session exceeds configured storage limit.");
        _ = normalizedRoots; // roots are persisted in the manifest by the session owner.
    }

    private static async Task<(long valid, long count, long total)> ScanCompleteLinesAsync(string path, Guid sessionId, CancellationToken token)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536, true);
        var buffer = new byte[65536]; long total = 0, lastNewline = 0, count = 0; using var line = new MemoryStream();
        int read;
        while ((read = await stream.ReadAsync(buffer, token).ConfigureAwait(false)) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                total++;
                if (buffer[i] == (byte)'\n')
                {
                    var bytes = line.ToArray(); line.SetLength(0);
                    if (bytes.Length > 0 && bytes[^1] == (byte)'\r') Array.Resize(ref bytes, bytes.Length - 1);
                    try
                    {
                        var e = JsonSerializer.Deserialize<RubikEvent>(bytes, RubikSchema.Json) ?? throw new JsonException();
                        ContractValidation.Validate(e);
                        if (e.SessionId != sessionId) throw new InvalidDataException("Event session ID does not match its store.");
                        lastNewline = total; count++;
                    }
                    catch (Exception ex) when (ex is JsonException or InvalidDataException) { /* invalid complete record remains in place, and halts recovery at this boundary */ return (lastNewline, count, stream.Length); }
                }
                else
                {
                    line.WriteByte(buffer[i]);
                    if (line.Length > 1_048_576) return (lastNewline, count, stream.Length);
                }
            }
        }
        return (lastNewline, count, total);
    }
    private static int ParseSegment(string name) { var stem = Path.GetFileNameWithoutExtension(name); return int.TryParse(stem.AsSpan("events-".Length), out var i) ? i : 0; }
    private static void EnsureWithin(string root, string path)
    { var rel = Path.GetRelativePath(root, path); if (rel == ".." || rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(rel)) throw new UnauthorizedAccessException("Path escapes its configured root."); }
}
