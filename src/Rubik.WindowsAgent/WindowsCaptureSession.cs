using System.Diagnostics;
using System.Threading.Channels;

namespace Rubik.WindowsAgent;

/// <summary>Bounded, best-effort event pipeline. Hook callbacks only enqueue compact native event data.</summary>
public sealed class WindowsCaptureSession : IWindowsCaptureSession
{
    private readonly IObservationSink _sink;
    private readonly IVisibleCaptureIndicator _indicator;
    private readonly IAccessibilityProvider? _accessibility;
    private readonly Channel<RawInput> _queue;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private Win32InputHooks? _hooks;
    private CancellationTokenSource? _workerCancellation;
    private CancellationTokenSource? _pollerCancellation;
    private Task? _worker;
    private Task? _foregroundPoller;
    private CapturePolicy? _policy;
    private long _dropped;
    private int _state;

    public CaptureState State => (CaptureState)Volatile.Read(ref _state);

    public WindowsCaptureSession(IObservationSink sink, IVisibleCaptureIndicator indicator, IAccessibilityProvider? accessibility = null)
    {
        _sink = sink; _indicator = indicator; _accessibility = accessibility;
        _queue = Channel.CreateBounded<RawInput>(new BoundedChannelOptions(512)
        { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = false });
    }

    public ValueTask StartAsync(CapturePolicy policy, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(policy);
        if (State != CaptureState.Idle) throw new InvalidOperationException("A capture session instance can be started only once.");
        _policy = policy;
        // Channel capacity is fixed and deliberately bounded; policy cannot silently make it unbounded.
        _workerCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Volatile.Write(ref _state, (int)CaptureState.Recording);
        _indicator.ShowRecording();
        _worker = Task.Run(() => ProcessAsync(_workerCancellation.Token), CancellationToken.None);
        _pollerCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _foregroundPoller = Task.Run(() => PollForegroundAsync(_pollerCancellation.Token), CancellationToken.None);
        try { _hooks = new Win32InputHooks(Enqueue); }
        catch
        {
            Volatile.Write(ref _state, (int)CaptureState.Stopped); _indicator.Hide();
            _queue.Writer.TryComplete(); _workerCancellation.Cancel(); _pollerCancellation?.Cancel(); throw;
        }
        return ValueTask.CompletedTask;
    }

    /// <summary>Immediate local pause; hooks are removed synchronously before returning.</summary>
    public void Pause()
    {
        if (State != CaptureState.Recording) return;
        Volatile.Write(ref _state, (int)CaptureState.Paused);
        Interlocked.Exchange(ref _hooks, null)?.Dispose();
        _indicator.ShowPaused();
    }

    public void Resume()
    {
        if (State != CaptureState.Paused) return;
        var hooks = new Win32InputHooks(Enqueue);
        _hooks = hooks;
        Volatile.Write(ref _state, (int)CaptureState.Recording);
        _indicator.ShowRecording();
    }

    public async ValueTask StopAsync(CancellationToken cancellationToken = default)
    {
        if (State is CaptureState.Idle or CaptureState.Stopped) return;
        Volatile.Write(ref _state, (int)CaptureState.Stopped);
        Interlocked.Exchange(ref _hooks, null)?.Dispose();
        _pollerCancellation?.Cancel();
        if (_foregroundPoller is not null) await _foregroundPoller.WaitAsync(cancellationToken).ConfigureAwait(false);
        _queue.Writer.TryComplete();
        if (_worker is not null) await _worker.WaitAsync(cancellationToken).ConfigureAwait(false);
        _workerCancellation?.Cancel(); _workerCancellation?.Dispose(); _workerCancellation = null;
        _pollerCancellation?.Dispose(); _pollerCancellation = null;
        _indicator.Hide();
    }

    private void Enqueue(RawInput input)
    {
        if (State != CaptureState.Recording) return;
        if (!_queue.Writer.TryWrite(input)) Interlocked.Increment(ref _dropped);
    }

    private async Task PollForegroundAsync(CancellationToken cancellationToken)
    {
        uint previous = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            if (State == CaptureState.Recording)
            {
                var current = WindowsNative.GetForegroundContext(_policy!.IncludeWindowTitles);
                if (current is not null && current.ProcessId != previous)
                {
                    previous = current.ProcessId;
                    Enqueue(new(ObservationKind.ForegroundChanged));
                }
            }
            await Task.Delay(TimeSpan.FromMilliseconds(500), cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ProcessAsync(CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var input in _queue.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                if (State != CaptureState.Recording) continue;
                var lost = Interlocked.Exchange(ref _dropped, 0);
                if (lost > 0) await _sink.WriteAsync(Observation(input, ObservationKind.EventsLost, detail: $"dropped={lost}"), cancellationToken).ConfigureAwait(false);
                var win = WindowsNative.GetForegroundContext(_policy!.IncludeWindowTitles);
                if (win is not null && _policy.ExcludedProcessNames.Contains(win.ProcessName)) continue;
                var kind = input.Kind;
                var coord = input.HasPoint ? WindowsNative.GetCoordinate(input.X, input.Y) : null;
                await _sink.WriteAsync(Observation(input, kind, win, coord, input.ControlKey), cancellationToken).ConfigureAwait(false);
                if (input.Kind is ObservationKind.MouseClick or ObservationKind.ForegroundChanged)
                {
                    if (_accessibility is null)
                        await _sink.WriteAsync(Observation(input, ObservationKind.AccessibilityUnavailable, win, detail: "provider_not_configured"), cancellationToken).ConfigureAwait(false);
                    else
                    {
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                        timeout.CancelAfter(_policy.AccessibilityTimeout);
                        try
                        {
                            var result = await _accessibility.InspectAsync(win, coord, timeout.Token).AsTask()
                                .WaitAsync(_policy.AccessibilityTimeout, cancellationToken).ConfigureAwait(false);
                            if (!result.Available) await _sink.WriteAsync(Observation(input, ObservationKind.AccessibilityUnavailable, win, detail: result.Detail ?? "provider_unavailable"), cancellationToken).ConfigureAwait(false);
                        }
                        catch (TimeoutException) { await _sink.WriteAsync(Observation(input, ObservationKind.AccessibilityUnavailable, win, detail: "timeout"), cancellationToken).ConfigureAwait(false); }
                        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                        { await _sink.WriteAsync(Observation(input, ObservationKind.AccessibilityUnavailable, win, detail: "timeout"), cancellationToken).ConfigureAwait(false); }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private CaptureObservation Observation(RawInput i, ObservationKind kind, WindowContext? window = null, Coordinate? point = null, string? key = null, string? detail = null)
        => new(DateTimeOffset.UtcNow, _clock.ElapsedMilliseconds, kind, window, point, key, detail);

    public async ValueTask DisposeAsync() { await StopAsync().ConfigureAwait(false); _indicator.Dispose(); }
}

internal sealed record RawInput(ObservationKind Kind, int X = 0, int Y = 0, bool HasPoint = false, string? ControlKey = null);
