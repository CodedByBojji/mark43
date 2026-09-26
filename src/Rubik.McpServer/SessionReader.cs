using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Rubik.Contracts;

namespace Rubik.McpServer;

internal sealed record SessionPage(IReadOnlyList<SessionManifest> Items, string? NextCursor, int InvalidManifestsSkipped);
internal sealed record EventPage(IReadOnlyList<RubikEvent> Items, string? NextCursor, bool ScanLimited);
internal sealed record SummaryResult(SessionManifest Session, IReadOnlyList<Rubik.Correlation.CorrelatedAction> Actions,
    bool Truncated, string InterpretationNotice);

/// <summary>Read-only view limited to a configured Rubik store. No artifact paths are returned or opened.</summary>
internal sealed class SessionReader
{
    private const int MaximumManifestBytes = 1024 * 1024;
    private const int MaximumEventLineBytes = 256 * 1024;
    private const int MaximumSegments = 128;
    private const int MaximumSessionDirectories = 10_000;
    private const long MaximumBytesScannedPerCall = 64L * 1024 * 1024;
    private static readonly Regex SegmentName = new("^events-[0-9]{4}\\.jsonl$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private readonly string _root;
    private readonly string _sessions;

    public SessionReader(string storageRoot)
    {
        _root = Path.GetFullPath(storageRoot);
        _sessions = Path.Combine(_root, "sessions");
    }

    public SessionPage ListSessions(int limit, string? cursor, DateTimeOffset? since, string? status)
    {
        ValidateLimit(limit, 100);
        var skip = ParseIndexCursor(cursor);
        if (since is { } date) since = date.ToUniversalTime();
        if (status is { Length: > 32 } || status?.Any(char.IsControl) == true) throw new ArgumentException("Invalid status filter.");
        var found = new List<SessionManifest>();
        var skipped = 0;
        foreach (var directory in EnumerateSafeSessionDirectories())
        {
            try
            {
                var manifest = LoadManifest(directory);
                if (since is { } start && manifest.StartedAtUtc < start) continue;
                if (!string.IsNullOrEmpty(status) && !string.Equals(manifest.Status, status, StringComparison.OrdinalIgnoreCase)) continue;
                found.Add(manifest);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidDataException or ArgumentException)
            { skipped++; }
        }
        var ordered = found.OrderByDescending(x => x.StartedAtUtc).ThenBy(x => x.SessionId).ToArray();
        var page = ordered.Skip(skip).Take(limit).ToArray();
        var next = skip + page.Length < ordered.Length ? (skip + page.Length).ToString(CultureInfo.InvariantCulture) : null;
        return new SessionPage(page, next, skipped);
    }

    public SessionManifest GetSession(Guid sessionId)
    {
        if (sessionId == Guid.Empty) throw new ArgumentException("session_id must be a non-empty UUID.");
        var sessions = GetSafeSessionsDirectory();
        var directory = Path.Combine(sessions, sessionId.ToString("D"));
        EnsureDirectory(directory);
        var manifest = LoadManifest(directory);
        if (manifest.SessionId != sessionId) throw new InvalidDataException("Session manifest identity does not match its directory.");
        return manifest;
    }

    public EventPage GetEvents(Guid sessionId, int limit, string? cursor, DateTimeOffset? since,
        DateTimeOffset? until, string? kind, CancellationToken cancellationToken = default)
    {
        ValidateLimit(limit, 100);
        if (sessionId == Guid.Empty) throw new ArgumentException("session_id must be a non-empty UUID.");
        if (kind is { Length: > 128 } || kind?.Any(char.IsControl) == true) throw new ArgumentException("Invalid kind filter.");
        var start = since?.ToUniversalTime();
        var end = until?.ToUniversalTime();
        if (start is not null && end is not null && start > end) throw new ArgumentException("since must be earlier than or equal to until.");
        var manifest = GetSession(sessionId);
        var segments = ValidateSegments(manifest);
        var position = ParseEventCursor(cursor, segments.Count);
        var results = new List<RubikEvent>(limit);
        long scanned = 0;
        for (var segmentIndex = position.Segment; segmentIndex < segments.Count; segmentIndex++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var path = segments[segmentIndex];
            var startOffset = segmentIndex == position.Segment ? position.Offset : 0;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 64 * 1024, FileOptions.SequentialScan);
            EnsureFile(stream, path, manifest.Retention.MaxSessionBytes);
            if (startOffset > stream.Length || (startOffset > 0 && !IsLineBoundary(path, startOffset)))
                throw new ArgumentException("Cursor does not point to an event boundary.");
            stream.Position = startOffset;
            var reader = new BoundedLineReader(stream, startOffset);
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var line = reader.ReadLine(MaximumEventLineBytes);
                if (line is null) break;
                scanned += line.Value.End - line.Value.Start;
                if (line.Value.Bytes.Length == 0) continue;
                if (scanned > MaximumBytesScannedPerCall)
                    return new EventPage(results, EncodeEventCursor(segmentIndex, line.Value.Start), true);
                RubikEvent item;
                try
                {
                    item = JsonSerializer.Deserialize<RubikEvent>(line.Value.Bytes, RubikSchema.Json)
                        ?? throw new JsonException("Empty record.");
                    ContractValidation.Validate(item);
                }
                catch (Exception ex) when (ex is JsonException or InvalidDataException)
                { throw new InvalidDataException("An event segment contains an invalid record; no further data was returned."); }
                if (item.SessionId != sessionId) throw new InvalidDataException("An event belongs to a different session.");
                if (start is { } from && item.TsUtc < from || end is { } to && item.TsUtc > to) continue;
                if (!string.IsNullOrEmpty(kind) && !string.Equals(item.Kind, kind, StringComparison.OrdinalIgnoreCase)) continue;
                if (results.Count == limit)
                    return new EventPage(results, EncodeEventCursor(segmentIndex, line.Value.Start), false);
                results.Add(item);
            }
        }
        return new EventPage(results, null, false);
    }

    private IEnumerable<string> EnumerateSafeSessionDirectories()
    {
        if (!Directory.Exists(_root)) yield break;
        EnsureDirectory(_root);
        if (!Directory.Exists(_sessions)) yield break;
        EnsureDirectory(_sessions);
        var count = 0;
        foreach (var path in Directory.EnumerateDirectories(_sessions))
        {
            if (++count > MaximumSessionDirectories) yield break;
            try { EnsureDirectory(path); yield return path; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    private string GetSafeSessionsDirectory()
    {
        EnsureDirectory(_root);
        var path = _sessions;
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException("Rubik sessions directory does not exist.");
        EnsureDirectory(path);
        return path;
    }

    private SessionManifest LoadManifest(string directory)
    {
        EnsureDirectory(directory);
        var path = Path.Combine(directory, "manifest.json");
        EnsurePathWithin(directory, path);
        EnsureNotReparsePoint(path);
        var info = new FileInfo(path);
        if (!info.Exists || info.Length > MaximumManifestBytes) throw new InvalidDataException("Session manifest is missing or too large.");
        var manifest = JsonSerializer.Deserialize<SessionManifest>(File.ReadAllBytes(path), RubikSchema.Json)
            ?? throw new InvalidDataException("Session manifest is empty.");
        if (manifest.SchemaVersion != RubikSchema.CurrentVersion || manifest.SessionId == Guid.Empty ||
            manifest.StartedAtUtc.Offset != TimeSpan.Zero || (manifest.EndedAtUtc is { } ended && ended.Offset != TimeSpan.Zero) ||
            string.IsNullOrWhiteSpace(manifest.Status) || manifest.Status.Length > 32 ||
            manifest.EventsFiles is null || manifest.EventsFiles.Count > MaximumSegments || manifest.Retention is null)
            throw new InvalidDataException("Session manifest has an unsupported or invalid contract.");
        manifest.Retention.Validate();
        foreach (var segment in manifest.EventsFiles)
            if (!SegmentName.IsMatch(segment)) throw new InvalidDataException("Session manifest contains an invalid event segment name.");
        if (Path.GetFileName(directory).Equals(manifest.SessionId.ToString("D"), StringComparison.OrdinalIgnoreCase) == false)
            throw new InvalidDataException("Session manifest identity does not match its directory.");
        return manifest;
    }

    private List<string> ValidateSegments(SessionManifest manifest)
    {
        var directory = Path.Combine(GetSafeSessionsDirectory(), manifest.SessionId.ToString("D"));
        EnsureDirectory(directory);
        var paths = new List<string>(manifest.EventsFiles.Count);
        long total = 0;
        foreach (var name in manifest.EventsFiles)
        {
            if (!SegmentName.IsMatch(name)) throw new InvalidDataException("Invalid event segment name.");
            var path = Path.GetFullPath(Path.Combine(directory, name));
            EnsurePathWithin(directory, path);
            EnsureNotReparsePoint(path);
            if (!File.Exists(path)) continue;
            total = checked(total + new FileInfo(path).Length);
            if (total > manifest.Retention.MaxSessionBytes) throw new InvalidDataException("Session data exceeds its declared storage limit.");
            paths.Add(path);
        }
        return paths;
    }

    private static void EnsureFile(FileStream stream, string path, long maximumBytes)
    {
        EnsureNotReparsePoint(path);
        if (stream.Length > maximumBytes) throw new InvalidDataException("Session data exceeds its declared storage limit.");
    }

    private static bool IsLineBoundary(string path, long offset)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        stream.Position = offset - 1;
        return stream.ReadByte() == (byte)'\n';
    }

    private static void EnsureDirectory(string path)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException("A configured Rubik directory does not exist.");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("Reparse points are not followed.");
    }

    private static void EnsureNotReparsePoint(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("Reparse points are not followed.");
    }

    private static void EnsurePathWithin(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        if (relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(relative))
            throw new UnauthorizedAccessException("Path escapes the configured Rubik root.");
    }

    private static void ValidateLimit(int limit, int maximum)
    { if (limit < 1 || limit > maximum) throw new ArgumentOutOfRangeException(nameof(limit), $"limit must be between 1 and {maximum}."); }

    private static int ParseIndexCursor(string? cursor)
    {
        if (string.IsNullOrEmpty(cursor)) return 0;
        if (cursor.Length > 10 || !int.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value < 0)
            throw new ArgumentException("Invalid cursor.");
        return value;
    }

    private static (int Segment, long Offset) ParseEventCursor(string? cursor, int segmentCount)
    {
        if (string.IsNullOrEmpty(cursor)) return (0, 0);
        if (cursor.Length > 64) throw new ArgumentException("Invalid cursor.");
        try
        {
            var encoded = cursor.Replace('-', '+').Replace('_', '/');
            encoded = encoded.PadRight((encoded.Length + 3) / 4 * 4, '=');
            var parts = Encoding.ASCII.GetString(Convert.FromBase64String(encoded)).Split(':');
            if (parts.Length != 2 || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var segment) ||
                !long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var offset) ||
                segment < 0 || segment > segmentCount || offset < 0 || (segment == segmentCount && offset != 0))
                throw new ArgumentException("Invalid cursor.");
            return (segment, offset);
        }
        catch (FormatException) { throw new ArgumentException("Invalid cursor."); }
    }

    private static string EncodeEventCursor(int segment, long offset)
    {
        var raw = Convert.ToBase64String(Encoding.ASCII.GetBytes($"{segment}:{offset}"));
        return raw.TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private sealed class BoundedLineReader(Stream stream, long initialPosition)
    {
        private readonly byte[] _buffer = new byte[16 * 1024];
        private int _offset;
        private int _available;
        private long _position = initialPosition;

        public (byte[] Bytes, long Start, long End)? ReadLine(int maximumBytes)
        {
            using var line = new MemoryStream();
            var start = _position;
            while (true)
            {
                var value = ReadByte();
                if (value < 0)
                {
                    if (line.Length == 0) return null;
                    return (line.ToArray(), start, _position);
                }
                if (value == '\n') return (line.ToArray(), start, _position);
                if (line.Length >= maximumBytes) throw new InvalidDataException("Event line exceeds the read limit.");
                line.WriteByte((byte)value);
            }
        }

        private int ReadByte()
        {
            if (_offset >= _available)
            {
                _available = stream.Read(_buffer, 0, _buffer.Length);
                _offset = 0;
                if (_available == 0) return -1;
            }
            _position++;
            return _buffer[_offset++];
        }
    }
}
