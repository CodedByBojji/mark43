using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rubik.Contracts;

public static class RubikSchema
{
    public const int CurrentVersion = 1;
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) }
    };
}

public enum EventSource { Win32, Input, Uia, Ocr, Visual, FileSystem, Api, Inference, System }
public enum EventNature { Observed, Inferred }

public sealed record ArtifactReference(string ArtifactId, string Kind, string Relation, string? Sha256 = null);
public sealed record EventProvenance(EventSource Source, string Provider, string Method, string? Rule = null);

/// <summary>Version 1 normalized event. Observed facts and inferred descriptions remain explicitly distinct.</summary>
public sealed record RubikEvent(
    int SchemaVersion,
    Guid EventId,
    Guid SessionId,
    DateTimeOffset TsUtc,
    long MonotonicMs,
    string Kind,
    EventNature Nature,
    EventProvenance Provenance,
    double? Confidence = null,
    string? CorrelationId = null,
    IReadOnlyList<Guid>? DerivedFrom = null,
    IReadOnlyList<ArtifactReference>? Evidence = null,
    JsonElement? Data = null,
    IReadOnlyList<string>? Notes = null)
{
    public static RubikEvent Observed(Guid sessionId, DateTimeOffset utc, long monotonicMs, string kind,
        EventProvenance provenance, JsonElement? data = null, IReadOnlyList<ArtifactReference>? evidence = null) =>
        new(RubikSchema.CurrentVersion, Guid.NewGuid(), sessionId, utc.ToUniversalTime(), monotonicMs, kind,
            EventNature.Observed, provenance, null, null, null, evidence, data);
}

public sealed record RetentionPolicy(int MaxSessionBytes = 268435456, int MaxArtifactBytes = 52428800,
    int KeepDays = 30, bool DeleteExpiredSessions = false)
{
    public void Validate()
    {
        if (MaxSessionBytes is < 1024 or > 10737418240) throw new ArgumentOutOfRangeException(nameof(MaxSessionBytes));
        if (MaxArtifactBytes is < 1 or > 2147483647) throw new ArgumentOutOfRangeException(nameof(MaxArtifactBytes));
        if (KeepDays is < 1 or > 3650) throw new ArgumentOutOfRangeException(nameof(KeepDays));
    }
}

public sealed record SessionManifest(int SchemaVersion, Guid SessionId, DateTimeOffset StartedAtUtc,
    DateTimeOffset? EndedAtUtc, string Status, string? Label, IReadOnlyList<string> EventsFiles,
    IReadOnlyList<string> AllowedRoots, RetentionPolicy Retention, long RecoveredCompleteLines = 0);

public static class ContractValidation
{
    public static void Validate(RubikEvent e)
    {
        if (e.SchemaVersion != RubikSchema.CurrentVersion) throw new InvalidDataException($"Unsupported event schema {e.SchemaVersion}.");
        if (e.EventId == Guid.Empty || e.SessionId == Guid.Empty) throw new InvalidDataException("Event and session IDs are required.");
        if (e.TsUtc.Offset != TimeSpan.Zero || e.MonotonicMs < 0) throw new InvalidDataException("Event timestamps must be UTC and monotonic time nonnegative.");
        if (string.IsNullOrWhiteSpace(e.Kind) || e.Kind.Length > 128) throw new InvalidDataException("Invalid event kind.");
        if (string.IsNullOrWhiteSpace(e.Provenance.Provider) || string.IsNullOrWhiteSpace(e.Provenance.Method)) throw new InvalidDataException("Event provenance is required.");
        if (e.Nature == EventNature.Inferred)
        {
            if (e.Confidence is null or < 0 or > 1 || e.DerivedFrom is not { Count: > 0 } || string.IsNullOrWhiteSpace(e.Provenance.Rule))
                throw new InvalidDataException("Inferred events require confidence, source event IDs, and a rule.");
        }
        else if (e.Confidence is not null) throw new InvalidDataException("Confidence is reserved for inferred events.");
    }
}
