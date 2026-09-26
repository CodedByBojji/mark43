using System.Text.Json;
using Rubik.Contracts;

namespace Rubik.WindowsAgent;

/// <summary>Maps capture facts to the shared v1 event contract; persistence stays owned by the caller.</summary>
public sealed class ContractsObservationSink(Guid sessionId, Func<RubikEvent, CancellationToken, ValueTask> append) : IObservationSink
{
    public ValueTask WriteAsync(CaptureObservation observation, CancellationToken cancellationToken)
    {
        var data = JsonSerializer.SerializeToElement(new
        {
            window = observation.Window,
            coordinate = observation.Coordinate,
            control_key = observation.ControlKey,
            detail = observation.Detail
        }, RubikSchema.Json);
        var source = observation.Kind switch
        {
            ObservationKind.MouseClick or ObservationKind.MouseWheel or ObservationKind.ControlKey => EventSource.Input,
            ObservationKind.AccessibilityUnavailable => EventSource.Uia,
            _ => EventSource.Win32
        };
        var ev = RubikEvent.Observed(sessionId, observation.TimestampUtc, Math.Max(0, observation.MonotonicMilliseconds),
            "desktop." + ToSnake(observation.Kind.ToString()), new EventProvenance(source, "Rubik.WindowsAgent", "win32_capture"), data);
        return append(ev, cancellationToken);
    }
    private static string ToSnake(string value) => string.Concat(value.Select((c, i) => i > 0 && char.IsUpper(c) ? "_" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));
}
