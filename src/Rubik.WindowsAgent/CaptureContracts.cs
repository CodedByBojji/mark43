namespace Rubik.WindowsAgent;

public enum CaptureState { Idle, Recording, Paused, Stopped }
public enum ObservationKind { MouseClick, MouseWheel, ControlKey, ForegroundChanged, EventsLost, AccessibilityUnavailable }
public sealed record Coordinate(int X, int Y, string Space, string? MonitorId, uint Dpi);
public sealed record WindowContext(uint ProcessId, string ProcessName, string? Title, string? MonitorId, uint Dpi,
    int X, int Y, int Width, int Height);
public sealed record CaptureObservation(DateTimeOffset TimestampUtc, long MonotonicMilliseconds,
    ObservationKind Kind, WindowContext? Window, Coordinate? Coordinate = null, string? ControlKey = null,
    string? Detail = null);
public sealed record CapturePolicy(IReadOnlySet<string> ExcludedProcessNames, TimeSpan AccessibilityTimeout,
    int QueueCapacity = 512, bool IncludeWindowTitles = false);

public interface IObservationSink { ValueTask WriteAsync(CaptureObservation observation, CancellationToken cancellationToken); }
public interface IVisibleCaptureIndicator : IDisposable
{
    void ShowRecording();
    void ShowPaused();
    void Hide();
}
public interface IAccessibilityProvider
{
    ValueTask<AccessibilityResult> InspectAsync(WindowContext? window, Coordinate? point, CancellationToken cancellationToken);
}
public sealed record AccessibilityResult(bool Available, string? Detail = null);

/// <summary>Called by an explicit local UI action. Construction alone never starts capture.</summary>
public interface IWindowsCaptureSession : IAsyncDisposable
{
    CaptureState State { get; }
    ValueTask StartAsync(CapturePolicy policy, CancellationToken cancellationToken = default);
    void Pause();
    void Resume();
    ValueTask StopAsync(CancellationToken cancellationToken = default);
}
