"""
Computer-use dataset recorder for Windows.

Captures a single synchronized timeline of user actions for training a model
that infers user *intent*. Each event is turned into a semantic label at
capture time, e.g.:

    click en (1142, 250)  ->  "click-izq en boton 'Guardar'"
    Ctrl+C                ->  "atajo Ctrl+C en 'Editor'"

Streams captured:
  1. Mouse   - clicks and scrolls.
  2. Keyboard- keystrokes and shortcuts (Ctrl+C, Ctrl+Shift+P, ...).
  3. Context - the UI element under the cursor via Windows UI Automation
               (control type: Button / TabItem / Edit / DataItem (cell) / ...,
               its accessible name, and bounding box). This is what turns a
               raw pixel into a meaningful target.

Output is JSON Lines: one JSON object per line in events.jsonl. Example row:

    {"timestamp": "2026-09-28T00:40:53.931", "event_type": "click",
     "label": "click-izq en pestana 'mouse_clicks.csv'",
     "modifiers": [], "window": {"title": "...", "process": "Code.exe"},
     "mouse": {"x": 1142, "y": 250, "button": "Button.left", "monitor": "\\\\.\\DISPLAY3"},
     "ui": {"control_type": "TabItem", "name": "mouse_clicks.csv",
            "class": "", "rect": [1100, 240, 1250, 270]}}

Usage:
    python capture.py [--out DIR] [--mask-keys]

Controls (global hotkeys):
    Esc                stop and exit
    Ctrl+Alt+P         pause / resume capture

Dependencies:
    pip install pynput pywin32 uiautomation psutil

Privacy: while running, EVERYTHING you type is logged (passwords included).
Use --mask-keys to log only key categories, or Ctrl+Alt+P to pause before
entering secrets.
"""

import os
import sys
import json
import math
import time
import queue
import ctypes
import argparse
import datetime
import threading
from ctypes import wintypes

from pynput import mouse, keyboard

try:
    import win32gui
    import win32api
    import win32con
    import win32process
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# UI Automation is imported lazily inside the worker thread, because it is
# only safe to initialize on the thread that calls it.

# ----- DPI awareness: accurate coordinates on high-DPI / multi-monitor -----
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE_V2
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# UIA control type -> friendly Spanish noun for the label.
CONTROL_ES = {
    "Button": "boton",
    "SplitButton": "boton",
    "TabItem": "pestana",
    "Tab": "pestana",
    "Edit": "campo de texto",
    "Document": "documento",
    "DataItem": "celda",
    "DataGrid": "tabla",
    "HeaderItem": "encabezado",
    "MenuItem": "opcion de menu",
    "Menu": "menu",
    "Hyperlink": "enlace",
    "CheckBox": "casilla",
    "RadioButton": "opcion",
    "ComboBox": "desplegable",
    "ListItem": "elemento de lista",
    "List": "lista",
    "TreeItem": "nodo de arbol",
    "Text": "texto",
    "Image": "imagen",
    "Slider": "control deslizante",
    "Spinner": "selector numerico",
    "ToolBar": "barra de herramientas",
    "TitleBar": "barra de titulo",
    "ScrollBar": "barra de desplazamiento",
    "Pane": "panel",
    "Window": "ventana",
    "Group": "grupo",
}

BUTTON_ES = {
    "Button.left": "click-izq",
    "Button.right": "click-der",
    "Button.middle": "click-medio",
}

# --- Drag capture tuning ---------------------------------------------------
# Minimum distance (px) a move must travel from the last sampled point to be
# recorded. Keeps the path compact without losing shape.
DRAG_SAMPLE_DIST = 3.0
# A press->release whose path is shorter than this (px) is treated as a plain
# click, not a drag.
DRAG_MIN_TRAVEL = 5.0
# Hard cap on stored points per stroke, so a very long drag can't blow up.
DRAG_MAX_POINTS = 8000


# --- Gesture intent classification ----------------------------------------
# Best-effort mapping from the destination control type to a drag intent.
# The raw path + element are ground truth; drag_kind is a heuristic guess.
TEXT_CTRLS = {"Edit", "Document", "Text"}
ADJUST_CTRLS = {"Slider", "ScrollBar", "Spinner"}
ITEM_CTRLS = {"ListItem", "TreeItem", "DataItem"}
CONTAINER_CTRLS = {"List", "Tree", "DataGrid"}

# Drawing / image-editing apps: a drag over their generic canvas surface is a
# free-hand stroke, not a text selection or item move. Process name (lower).
CANVAS_PROCS = {
    "mspaint.exe", "paint.net.exe", "photoshop.exe", "gimp.exe", "gimp-2.10.exe",
    "krita.exe", "clipstudiopaint.exe", "mypaint.exe", "inkscape.exe",
    "firealpaca.exe", "medibangpaintpro.exe", "sai.exe", "sai2.exe",
    "blender.exe", "drawio.exe",
}
# Control types that count as a canvas surface when inside a drawing app.
CANVAS_SURFACE_CTRLS = {"Pane", "Image", "Document", "Custom", ""}

KIND_ES = {
    "seleccion_texto": "seleccion de texto",
    "ajuste_control": "ajuste de control",
    "mover_elemento": "mover elemento",
    "seleccion_multiple": "seleccion multiple (marco)",
    "trazo_libre": "trazo libre",
    "arrastre": "arrastre",
}


def classify_drag(ctype, name, proc=""):
    # Process-aware canvas override: inside a drawing app, a drag over the
    # canvas surface is a stroke even if UIA only reports a generic Pane.
    if proc and proc.lower() in CANVAS_PROCS and ctype in CANVAS_SURFACE_CTRLS:
        return "trazo_libre"
    if ctype in TEXT_CTRLS:
        return "seleccion_texto"
    if ctype in ADJUST_CTRLS:
        return "ajuste_control"
    if ctype in ITEM_CTRLS:
        return "mover_elemento"
    if ctype in CONTAINER_CTRLS and not name:
        return "seleccion_multiple"
    # NOTE: a bare Pane/Image is too generic to call a free-hand stroke; that
    # is decided by the canvas-process check above, not by control type alone.
    return "arrastre"


def _selection_hint(modifiers):
    if "shift" in modifiers:
        return " [extender rango]"
    if "ctrl" in modifiers:
        return " [alternar seleccion]"
    return ""


def describe_click(button, ctype, name, proc, count=1, modifiers=()):
    base = BUTTON_ES.get(button, button)
    prefix = {2: "doble ", 3: "triple "}.get(count, "")
    noun = CONTROL_ES.get(ctype, ctype.lower() if ctype else "elemento")
    target = f"{noun} '{name}'" if name else noun
    where = f" [{proc}]" if proc else ""
    return f"{prefix}{base} en {target}{_selection_hint(modifiers)}{where}"


def describe_scroll(dx, dy, ctype, name, proc):
    direction = "abajo" if dy < 0 else "arriba" if dy > 0 else "lateral"
    noun = CONTROL_ES.get(ctype, ctype.lower() if ctype else "elemento")
    target = f"{noun} '{name}'" if name else noun
    where = f" [{proc}]" if proc else ""
    return f"scroll {direction} sobre {target}{where}"


def _target_str(ctype, name):
    noun = CONTROL_ES.get(ctype, ctype.lower() if ctype else "elemento")
    return f"{noun} '{name}'" if name else noun


def describe_drag(button, ctype, name, proc, metrics, kind, modifiers=(), dest=None):
    verbo = KIND_ES.get(kind, "arrastre")
    target = _target_str(ctype, name)
    where = f" [{proc}]" if proc else ""
    size = f" ({metrics['length_px']} px, {metrics['points']} puntos)"
    # Drag-and-drop: name the drop destination when it's a real move onto a
    # different element.
    if dest is not None:
        drop = _target_str(dest.get("control_type", ""), dest.get("name", ""))
        return f"arrastrar y soltar {target} -> {drop}{size}{where}"
    return f"{verbo} sobre {target}{_selection_hint(modifiers)}{size}{where}"


def describe_key(is_hotkey, combo, proc):
    where = f" en '{proc}'" if proc else ""
    return f"{'atajo' if is_hotkey else 'tecla'} {combo}{where}"


def stroke_metrics(path):
    """Compute length/bbox from a path of [x, y, dt_ms] points."""
    xs = [p[0] for p in path]
    ys = [p[1] for p in path]
    length = 0.0
    for (x0, y0, _), (x1, y1, _) in zip(path, path[1:]):
        length += math.hypot(x1 - x0, y1 - y0)
    return {
        "points": len(path),
        "length_px": round(length, 1),
        "duration_ms": path[-1][2] if path else 0,
        "bbox": [min(xs), min(ys), max(xs), max(ys)] if path else None,
    }


# --------------------------------------------------------------------------
# Foreground-window helpers (cheap, safe to call from any thread)
# --------------------------------------------------------------------------
def get_monitor_name(x, y):
    if not HAS_WIN32:
        return ""
    try:
        hmon = win32api.MonitorFromPoint((x, y), win32con.MONITOR_DEFAULTTONEAREST)
        return win32api.GetMonitorInfo(hmon).get("Device", "")
    except Exception:
        return ""


class _GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD),
        ("hwndActive", wintypes.HWND), ("hwndFocus", wintypes.HWND),
        ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
        ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND),
        ("rcCaret", wintypes.RECT),
    ]


def focused_is_password_win32():
    """Fast, synchronous check: does the focused control have ES_PASSWORD?

    Covers classic Win32 password boxes (login dialogs, many desktop apps)
    with negligible cost, so it's safe to call on every keystroke. Browser /
    Electron password fields aren't Win32 controls and are handled separately
    via UI Automation's IsPassword on click.
    """
    if not HAS_WIN32:
        return False
    try:
        u = ctypes.windll.user32
        hwnd_fg = u.GetForegroundWindow()
        tid = u.GetWindowThreadProcessId(hwnd_fg, None)
        info = _GUITHREADINFO()
        info.cbSize = ctypes.sizeof(_GUITHREADINFO)
        if not u.GetGUIThreadInfo(tid, ctypes.byref(info)):
            return False
        hwnd = info.hwndFocus
        if not hwnd:
            return False
        ES_PASSWORD = 0x0020
        GWL_STYLE = -16
        if u.GetWindowLongW(hwnd, GWL_STYLE) & ES_PASSWORD:
            return True
        EM_GETPASSWORDCHAR = 0x00D2
        return u.SendMessageW(hwnd, EM_GETPASSWORDCHAR, 0, 0) != 0
    except Exception:
        return False


class SecureState:
    """Thread-safe latch: is the current input target a password field?

    Set asynchronously by the worker whenever a click resolves onto an
    element (True if that element is a password field, else False).
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._from_click = False

    def set_from_click(self, value):
        with self._lock:
            self._from_click = bool(value)

    def is_secure(self):
        # Win32 style check is authoritative and synchronous; the click latch
        # covers browser/Electron fields that Win32 can't see.
        with self._lock:
            latched = self._from_click
        return latched or focused_is_password_win32()


def get_foreground_info():
    """Return (window_title, process_exe_name)."""
    if not HAS_WIN32:
        return "", ""
    try:
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd)
        proc = ""
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if HAS_PSUTIL and pid:
                proc = psutil.Process(pid).name()
        except Exception:
            pass
        return title, proc
    except Exception:
        return "", ""


# --------------------------------------------------------------------------
# Keyboard: reconstruct modifier state and shortcut combos
# --------------------------------------------------------------------------
MODIFIER_KEYS = {
    keyboard.Key.ctrl, keyboard.Key.ctrl_l, keyboard.Key.ctrl_r,
    keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r, keyboard.Key.alt_gr,
    keyboard.Key.shift, keyboard.Key.shift_l, keyboard.Key.shift_r,
    keyboard.Key.cmd, keyboard.Key.cmd_l, keyboard.Key.cmd_r,
}


def modifier_name(key):
    n = getattr(key, "name", "") or ""
    if n.startswith("ctrl"):
        return "ctrl"
    if n.startswith("alt"):
        return "alt"
    if n.startswith("shift"):
        return "shift"
    if n.startswith("cmd"):
        return "win"
    return ""


def key_repr(key, mask):
    """Human-readable name for a key. If mask=True, return only a category."""
    if isinstance(key, keyboard.Key):
        return key.name
    ch = getattr(key, "char", None)
    if ch is None:
        vk = getattr(key, "vk", None)
        return f"vk{vk}" if vk is not None else "unknown"
    if mask:
        if ch.isalpha():
            return "<letra>"
        if ch.isdigit():
            return "<digito>"
        return "<simbolo>"
    return ch


# --------------------------------------------------------------------------
# JSONL sink (thread-safe): one JSON object per line.
# --------------------------------------------------------------------------
class JsonlWriter:
    def __init__(self, path):
        self._f = open(path, "a", encoding="utf-8")
        self._lock = threading.Lock()

    def write(self, obj):
        line = json.dumps(obj, ensure_ascii=False)
        with self._lock:
            self._f.write(line + "\n")
            self._f.flush()

    def close(self):
        self._f.close()


# --------------------------------------------------------------------------
# Worker thread: expensive UIA lookup, then compose label + write the row.
# Keeps the input listeners responsive so no events are dropped.
# --------------------------------------------------------------------------
class ContextWorker(threading.Thread):
    def __init__(self, sink, secure_state, capture_text=False):
        super().__init__(daemon=True)
        self.q = queue.Queue()
        self.sink = sink
        self.secure_state = secure_state
        self.capture_text = capture_text
        self._stop = threading.Event()
        self._uia = None

    def _lazy_init(self):
        # UI Automation is COM. Initialize THIS thread as MTA (multithreaded)
        # *before* importing uiautomation, so cross-process element queries
        # don't require a message pump and never block/hang this worker.
        try:
            import comtypes
            comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
        except Exception:
            pass
        try:
            import uiautomation as auto
            # Cap how long any UIA search can block, as a safety net.
            try:
                auto.SetGlobalSearchTimeout(0.5)
            except Exception:
                pass
            self._uia = auto
        except Exception:
            self._uia = None

    def submit(self, event):
        self.q.put(event)

    def stop(self):
        self._stop.set()
        self.q.put(None)

    def run(self):
        self._lazy_init()
        while not self._stop.is_set():
            event = self.q.get()
            if event is None:
                break
            try:
                self._enrich_and_write(event)
            except Exception as exc:
                print(f"[worker] error: {exc}", file=sys.stderr)

    def _is_password(self, ctrl):
        try:
            v = ctrl.GetPropertyValue(self._uia.PropertyId.IsPasswordPropertyId)
            return bool(v)
        except Exception:
            pass
        try:
            return bool(ctrl.IsPassword)
        except Exception:
            return False

    def _element_at(self, x, y):
        """Return (info_dict, ctrl). info_dict/ctrl are None on failure.

        The raw control is returned too so callers can query extra patterns
        (e.g. TextPattern) without a second ControlFromPoint lookup.
        """
        if self._uia is None:
            return None, None
        try:
            ctrl = self._uia.ControlFromPoint(x, y)
            if ctrl is None:
                return None, None
            rect = ctrl.BoundingRectangle
            info = {
                "control_type": getattr(ctrl, "ControlTypeName", "") or "",
                "name": (getattr(ctrl, "Name", "") or "")[:200],
                "class": getattr(ctrl, "ClassName", "") or "",
                "rect": [rect.left, rect.top, rect.right, rect.bottom],
                "is_password": self._is_password(ctrl),
            }
            return info, ctrl
        except Exception:
            return None, None

    def _text_ok(self, ctype, ui):
        """True if it's a text control safe to read (not a password/secure)."""
        if ctype not in TEXT_CTRLS:
            return False
        if ui and ui.get("is_password"):
            return False
        return not self.secure_state.is_secure()

    def _selected_text(self, ctrl):
        """Read the currently selected text via UIA TextPattern (best effort)."""
        if ctrl is None:
            return ""
        try:
            tp = ctrl.GetTextPattern()
        except Exception:
            tp = None
        if not tp:
            return ""
        parts = []
        try:
            for rng in tp.GetSelection():
                try:
                    parts.append(rng.GetText(200))
                except Exception:
                    pass
        except Exception:
            return ""
        return " ".join(p for p in parts if p).strip()[:500]

    def _enrich_and_write(self, event):
        # Enrichment must never prevent the row from being written. If the
        # UIA lookup fails, we still log the raw event with ui=None.
        ui = None
        try:
            m = event["mouse"]
            ui, ctrl = self._element_at(m["x"], m["y"])
            ctype = ui["control_type"] if ui else ""
            name = ui["name"] if ui else ""
            proc = event["window"]["process"]
            mods = event.get("modifiers", [])

            if event["event_type"] == "click":
                # A click sets/leaves the input focus: latch whether that
                # target is a password field, for keystroke redaction.
                self.secure_state.set_from_click(bool(ui and ui.get("is_password")))
                count = event.get("click_count", 1)
                # Double/triple click on text selects a word/line: capture it.
                if self.capture_text and count >= 2 and self._text_ok(ctype, ui):
                    sel = self._selected_text(ctrl)
                    if sel:
                        event["selection_text"] = sel
                event["label"] = describe_click(m.get("button", ""), ctype, name,
                                                 proc, count, mods)

            elif event["event_type"] == "drag":
                kind = classify_drag(ctype, name, proc)
                event["drag_kind"] = kind
                dest = None
                # Resolve the element at the drop point for drag-and-drop.
                end = m.get("end")
                if end:
                    ui_end, _ = self._element_at(end[0], end[1])
                    event["ui_end"] = ui_end
                    if kind == "mover_elemento" and ui_end and \
                       ui_end.get("rect") != (ui.get("rect") if ui else None):
                        dest = ui_end
                # Capture the selected text of a text-selection drag.
                if self.capture_text and kind == "seleccion_texto" and \
                   self._text_ok(ctype, ui):
                    sel = self._selected_text(ctrl)
                    if sel:
                        event["selection_text"] = sel
                event["label"] = describe_drag(m.get("button", ""), ctype, name,
                                               proc, event["metrics"], kind, mods, dest)

            elif event["event_type"] == "scroll":
                dx, dy = m.get("scroll", [0, 0])
                event["label"] = describe_scroll(dx, dy, ctype, name, proc)
        except Exception as exc:
            print(f"[worker] enrich failed: {exc}", file=sys.stderr)
        finally:
            event["ui"] = ui
            self.sink.write(event)
            print(f"{event['timestamp']}  ->  {event['label']}")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Computer-use dataset recorder")
    ap.add_argument("--out", default="dataset", help="output directory")
    ap.add_argument("--mask-keys", action="store_true",
                    help="log key categories instead of actual characters")
    ap.add_argument("--capture-text", action="store_true",
                    help="record selected text on text-selection gestures "
                         "(never for password/secure fields)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    jsonl_path = os.path.join(args.out, "events.jsonl")
    sink = JsonlWriter(jsonl_path)

    secure_state = SecureState()
    worker = ContextWorker(sink, secure_state, capture_text=args.capture_text)
    worker.start()

    state = {"paused": False}
    active_mods = set()

    def now():
        return datetime.datetime.now().isoformat(timespec="milliseconds")

    def mods_list():
        order = ["ctrl", "alt", "shift", "win"]
        return [m for m in order if m in active_mods]

    # ---- mouse ----
    # A gesture spans press -> (moves) -> release. On press we open a stroke;
    # every held move appends a sampled point; on release we emit ONE event:
    # a "click" if the pointer barely moved, else a "drag" with the full path.
    drags = {}  # button -> stroke state

    # Multi-click detection: consecutive clicks of the same button within the
    # OS double-click time and a few pixels count as double/triple.
    try:
        DCLICK_MS = ctypes.windll.user32.GetDoubleClickTime() or 500
    except Exception:
        DCLICK_MS = 500
    DCLICK_DIST = 6
    last_click = {}  # button -> [t_ms, x, y, count]

    def click_count(btn, x, y):
        t = time.monotonic() * 1000
        prev = last_click.get(btn)
        if prev and (t - prev[0]) <= DCLICK_MS and \
           math.hypot(x - prev[1], y - prev[2]) <= DCLICK_DIST:
            count = min(prev[3] + 1, 3)
        else:
            count = 1
        last_click[btn] = [t, x, y, count]
        return count

    def on_click(x, y, button, pressed):
        if state["paused"]:
            return
        btn = str(button)
        if pressed:
            title, proc = get_foreground_info()
            drags[btn] = {
                "timestamp": now(),
                "t0": time.monotonic(),
                "button": btn,
                "modifiers": mods_list(),
                "window": {"title": title, "process": proc},
                "monitor": get_monitor_name(x, y),
                "start": (x, y),
                "path": [[x, y, 0]],
                "click_count": click_count(btn, x, y),
            }
            return

        # release: finalize the gesture opened by this button
        d = drags.pop(btn, None)
        if d is None:
            return
        path = d["path"]
        metrics = stroke_metrics(path)
        is_drag = metrics["length_px"] >= DRAG_MIN_TRAVEL and len(path) > 1
        event = {
            "timestamp": d["timestamp"],
            "event_type": "drag" if is_drag else "click",
            "label": None,
            "modifiers": d["modifiers"],
            "window": d["window"],
            # x, y = press point, so the worker resolves the element where the
            # gesture began (the target the user aimed at).
            "mouse": {"x": d["start"][0], "y": d["start"][1],
                      "button": btn, "monitor": d["monitor"]},
        }
        if is_drag:
            event["mouse"]["start"] = list(d["start"])
            event["mouse"]["end"] = [x, y]
            event["path"] = path
            event["metrics"] = metrics
        else:
            event["click_count"] = d.get("click_count", 1)
        worker.submit(event)

    def on_move(x, y):
        if state["paused"] or not drags:
            return
        for d in drags.values():
            path = d["path"]
            if len(path) >= DRAG_MAX_POINTS:
                continue
            lx, ly, _ = path[-1]
            if math.hypot(x - lx, y - ly) >= DRAG_SAMPLE_DIST:
                path.append([x, y, int((time.monotonic() - d["t0"]) * 1000)])

    def on_scroll(x, y, dx, dy):
        if state["paused"]:
            return
        title, proc = get_foreground_info()
        worker.submit({
            "timestamp": now(), "event_type": "scroll", "label": None,
            "modifiers": mods_list(),
            "window": {"title": title, "process": proc},
            "mouse": {"x": x, "y": y, "scroll": [dx, dy],
                      "monitor": get_monitor_name(x, y)},
        })

    # ---- keyboard ----
    REDACTED = "<oculto>"

    def write_key_event(key):
        title, proc = get_foreground_info()
        is_hotkey = bool(active_mods) and key not in MODIFIER_KEYS

        # If focus is on a password field, omit the typed CONTENT entirely.
        # Character keys are redacted; structural keys (Enter/Tab/Backspace),
        # modifiers and shortcuts are kept since they reveal no secret text.
        is_char_key = not isinstance(key, keyboard.Key)
        secured = is_char_key and not is_hotkey and secure_state.is_secure()

        if secured:
            keytxt = REDACTED
        else:
            keytxt = key_repr(key, args.mask_keys)
        combo = ("+".join(mods_list()) + "+" if is_hotkey else "") + keytxt

        row = {
            "timestamp": now(),
            "event_type": "hotkey" if is_hotkey else "key",
            "label": describe_key(is_hotkey, combo, proc),
            "modifiers": mods_list(),
            "window": {"title": title, "process": proc},
            "key": {"value": keytxt, "combo": combo},
        }
        if secured:
            row["secure"] = True
        sink.write(row)
        print(f"{now()}  ->  {row['label']}")

    def on_press(key):
        if key == keyboard.Key.esc:
            print("Esc -> stopping.")
            mouse_listener.stop()
            return False

        m = modifier_name(key)
        if m:
            active_mods.add(m)

        # Ctrl+Alt+P toggles pause.
        if not isinstance(key, keyboard.Key):
            if getattr(key, "char", None) in ("p", "\x10") and \
               "ctrl" in active_mods and "alt" in active_mods:
                state["paused"] = not state["paused"]
                print(f"--- {'PAUSED' if state['paused'] else 'RESUMED'} ---")
                return

        if state["paused"]:
            return
        write_key_event(key)

    def on_release(key):
        m = modifier_name(key)
        if m:
            active_mods.discard(m)

    mouse_listener = mouse.Listener(on_click=on_click, on_scroll=on_scroll,
                                    on_move=on_move)
    key_listener = keyboard.Listener(on_press=on_press, on_release=on_release)

    print(f"Recording -> {jsonl_path}")
    print("  keys:", "masked" if args.mask_keys else "raw",
          "| selected text:", "on" if args.capture_text else "off")
    print("  Esc = stop   |   Ctrl+Alt+P = pause/resume")
    if not HAS_WIN32:
        print("  WARNING: pywin32 not installed - no window/monitor context.")

    mouse_listener.start()
    key_listener.start()
    try:
        key_listener.join()
    except KeyboardInterrupt:
        pass
    finally:
        mouse_listener.stop()
        worker.stop()
        worker.join(timeout=3)
        sink.close()
        print("Stopped. Dataset saved in", args.out)


if __name__ == "__main__":
    main()
