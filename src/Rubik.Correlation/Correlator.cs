using Rubik.Contracts;

namespace Rubik.Correlation;

public sealed record FileObservation(Guid SessionId, DateTimeOffset TsUtc, long MonotonicMs, string FullPath,
    string ChangeKind, long Size, string? Sha256, Guid EventId, IReadOnlyList<ArtifactReference>? Evidence = null);

/// <summary>Debounces noisy watcher notifications. Emits file detection metadata, never semantic property claims.</summary>
public sealed class FileChangeGrouper
{
    private readonly string[] _allowedRoots;
    private readonly TimeSpan _window;
    private readonly Dictionary<string, FileObservation> _pending = new(StringComparer.OrdinalIgnoreCase);
    public FileChangeGrouper(IEnumerable<string> allowedRoots, TimeSpan? groupingWindow = null)
    {
        _allowedRoots = allowedRoots.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (_allowedRoots.Length == 0) throw new ArgumentException("At least one explicitly selected root is required.", nameof(allowedRoots));
        _window = groupingWindow ?? TimeSpan.FromMilliseconds(800);
        if (_window < TimeSpan.Zero || _window > TimeSpan.FromMinutes(1)) throw new ArgumentOutOfRangeException(nameof(groupingWindow));
    }

    public IReadOnlyList<FileObservation> Add(FileObservation observation)
    {
        var path = ValidatePath(observation.FullPath);
        if (observation.Size < 0) throw new InvalidDataException("Negative file size.");
        var normalized = observation with { FullPath = path, TsUtc = observation.TsUtc.ToUniversalTime() };
        var emitted = new List<FileObservation>();
        if (_pending.TryGetValue(path, out var previous))
        {
            if (normalized.TsUtc - previous.TsUtc <= _window && normalized.TsUtc >= previous.TsUtc)
            {
                // Keep earliest correlation anchor and newest stable metadata, so repeated OS notifications collapse.
                _pending[path] = normalized with { EventId = previous.EventId, TsUtc = previous.TsUtc,
                    MonotonicMs = previous.MonotonicMs, ChangeKind = MergeKind(previous.ChangeKind, normalized.ChangeKind),
                    Evidence = MergeEvidence(previous.Evidence, normalized.Evidence) };
                return emitted;
            }
            emitted.Add(previous);
        }
        _pending[path] = normalized;
        return emitted;
    }

    public IReadOnlyList<FileObservation> Flush(DateTimeOffset nowUtc, bool all = false)
    {
        nowUtc = nowUtc.ToUniversalTime();
        var ready = _pending.Where(pair => all || nowUtc - pair.Value.TsUtc >= _window)
            .Select(pair => pair.Value).OrderBy(item => item.TsUtc).ToArray();
        foreach (var item in ready) _pending.Remove(item.FullPath);
        return ready;
    }

    public static RubikEvent ToDetectionEvent(FileObservation observation)
    {
        var data = System.Text.Json.JsonSerializer.SerializeToElement(new
        {
            path = observation.FullPath, change_kind = observation.ChangeKind,
            size_bytes = observation.Size, sha256 = observation.Sha256,
            interpretation = "file_detection_only", semantic_change = false
        }, RubikSchema.Json);
        return new RubikEvent(RubikSchema.CurrentVersion, observation.EventId, observation.SessionId,
            observation.TsUtc.ToUniversalTime(), observation.MonotonicMs, "file.detected", EventNature.Observed,
            new EventProvenance(EventSource.FileSystem, "watcher", "debounced_path_and_hash"),
            null, null, null, observation.Evidence, data);
    }

    private string ValidatePath(string candidate)
    {
        var full = Path.GetFullPath(candidate);
        if (!_allowedRoots.Any(root => IsInside(root, full))) throw new UnauthorizedAccessException("Observed file is outside configured roots.");
        var current = full;
        while (File.Exists(current) || Directory.Exists(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("Reparse points are not followed.");
            var parent = Path.GetDirectoryName(current);
            if (parent is null || string.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
            current = parent;
        }
        return full;
    }
    private static bool IsInside(string root, string candidate)
    { var rel = Path.GetRelativePath(root, candidate); return rel != ".." && !rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) && !Path.IsPathRooted(rel); }
    private static string MergeKind(string oldKind, string newKind) => oldKind == newKind ? oldKind : "changed";
    private static IReadOnlyList<ArtifactReference>? MergeEvidence(IReadOnlyList<ArtifactReference>? a, IReadOnlyList<ArtifactReference>? b) =>
        (a ?? []).Concat(b ?? []).DistinctBy(x => x.ArtifactId).ToArray() is { Length: > 0 } all ? all : null;
}

public sealed record CorrelatedAction(string CorrelationId, IReadOnlyList<Guid> EventIds,
    IReadOnlyList<ArtifactReference> Evidence, DateTimeOffset StartedAtUtc, DateTimeOffset EndedAtUtc,
    string Summary, double Confidence, IReadOnlyList<string> Uncertainties);

/// <summary>Deterministic temporal grouping. It links evidence but does not invent semantic file changes.</summary>
public static class TemporalCorrelator
{
    public static IReadOnlyList<CorrelatedAction> Group(IEnumerable<RubikEvent> input,
        TimeSpan? maximumGap = null, TimeSpan? maximumDuration = null)
    {
        var gap = maximumGap ?? TimeSpan.FromSeconds(3);
        var duration = maximumDuration ?? TimeSpan.FromSeconds(15);
        if (gap < TimeSpan.Zero || duration <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(maximumGap));
        var events = input.OrderBy(e => e.TsUtc).ToArray();
        foreach (var e in events) ContractValidation.Validate(e);
        var result = new List<CorrelatedAction>();
        var group = new List<RubikEvent>();
        foreach (var e in events)
        {
            if (group.Count > 0 && (e.SessionId != group[^1].SessionId || e.TsUtc - group[^1].TsUtc > gap || e.TsUtc - group[0].TsUtc > duration))
            { result.Add(Build(group)); group.Clear(); }
            group.Add(e);
        }
        if (group.Count > 0) result.Add(Build(group));
        return result;
    }

    private static CorrelatedAction Build(IReadOnlyList<RubikEvent> events)
    {
        var ids = events.Select(e => e.EventId).ToArray();
        var artifacts = events.SelectMany(e => e.Evidence ?? []).DistinctBy(a => a.ArtifactId).ToArray();
        var onlyObserved = events.All(e => e.Nature == EventNature.Observed);
        var containsFileDetection = events.Any(e => e.Kind == "file.detected");
        var uncertainty = new List<string>();
        if (containsFileDetection) uncertainty.Add("File metadata/hash indicates a file change only; document semantics were not interpreted.");
        if (!onlyObserved) uncertainty.Add("Group includes inferred events; inspect their source event IDs and confidence.");
        if (artifacts.Length == 0) uncertainty.Add("No artifact references are attached to this group.");
        var summary = containsFileDetection ? "Temporally related observations include file detection." : "Temporally related observations grouped; inspect linked evidence for meaning.";
        var confidence = onlyObserved && events.Count > 1 ? 0.5 : 0.35;
        return new CorrelatedAction(Guid.NewGuid().ToString("N"), ids, artifacts,
            events[0].TsUtc, events[^1].TsUtc, summary, confidence, uncertainty);
    }
}
