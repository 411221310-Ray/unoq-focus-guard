# SPDX-FileCopyrightText: 2026
# SPDX-License-Identifier: MPL-2.0
"""FocusGuard：在座偵測專注番茄鐘。

筆電鏡頭的畫面經 USB 送到 UNO Q，板子在本機跑人臉偵測：
- 人在座位 → 番茄鐘倒數
- 連續 AWAY_GRACE_SEC 秒沒看到人 → 判定暫離、倒數暫停
- 專注時間到 → 進入休息，網頁響提示音、LED 矩陣播動畫

狀態每 0.25 秒推給網頁（"pomodoro"），並經 Bridge 把 8×13 畫面送給 MCU 畫在 LED 矩陣上。
"""

import threading
import time
from datetime import UTC, datetime

from arduino.app_bricks.video_objectdetection import VideoObjectDetection
from arduino.app_bricks.web_ui import WebUI
from arduino.app_peripherals.camera import WebSocketCamera
from arduino.app_utils import App, Bridge

import led_frames

# ── 可調參數 ────────────────────────────────────────────────────────────────

# 偵測哪個標籤。課堂 starter 用的是 face-detection 模型（標籤 "face"）。
# 若在 app.yaml 換成有 person 類別的物件偵測模型，這裡改成 "person"。
DETECT_LABEL = "face"

# 框面積至少要佔畫面多少比例才算「在座」（0 = 不過濾）。
# 用 person 模型時，遠處走動的人框很小，可設 0.08 左右擋掉；數值看網頁上的「框大小」來調。
MIN_BOX_RATIO = 0.0

# 防抖：連續幾秒沒偵測到才判定暫離。低頭、側臉漏掉幾幀不會誤判。
AWAY_GRACE_SEC = 3.0

# 番茄鐘長度（秒）：正式模式 / 示範模式
NORMAL_FOCUS_SEC = 25 * 60
NORMAL_BREAK_SEC = 5 * 60
DEMO_FOCUS_SEC = 60
DEMO_BREAK_SEC = 20

TICK_SEC = 0.25
CELEBRATE_SEC = 3.0

# 送給板子的影像大小（要和 assets/app.js 的 SEND_WIDTH / SEND_HEIGHT 一致）
FRAME_W, FRAME_H = 320, 240

# ── 硬體與 Brick ────────────────────────────────────────────────────────────

ui = WebUI()

# 瀏覽器把 JPEG 畫面經 ADB USB 轉發送進來，不需要 Wi-Fi 或 USB hub。
camera = WebSocketCamera(
    port=8080,
    resolution=(FRAME_W, FRAME_H),
    fps=8,
    secret=None,
    encrypt=False,
)

detection = VideoObjectDetection(
    camera,
    confidence=0.5,
    debounce_sec=0.25,
)

# ── 共用狀態 ────────────────────────────────────────────────────────────────

lock = threading.Lock()

# 偵測結果（偵測執行緒寫、計時執行緒讀）
last_seen_at = 0.0  # 最後一次「有效」偵測到人的 time.monotonic()
last_count = 0
last_confidence = None
last_box_ratio = None

# 番茄鐘狀態
state = "idle"  # idle / focus / away / break
demo_mode = True
remaining = float(DEMO_FOCUS_SEC)
phase_total = float(DEMO_FOCUS_SEC)
focus_total_sec = 0.0  # 今日累計專注秒數
away_count = 0
pomodoro_count = 0
celebrate_until = 0.0


def durations() -> tuple[float, float]:
    if demo_mode:
        return float(DEMO_FOCUS_SEC), float(DEMO_BREAK_SEC)
    return float(NORMAL_FOCUS_SEC), float(NORMAL_BREAK_SEC)


def box_ratio(box) -> float:
    """框面積佔整張畫面的比例。座標單位未確認，若超過 1 代表不是像素，會照實顯示。"""
    try:
        x1, y1, x2, y2 = (float(v) for v in box)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, x2 - x1) * max(0.0, y2 - y1) / (FRAME_W * FRAME_H)


# ── 偵測回呼 ────────────────────────────────────────────────────────────────


def report_camera_status(event_type: str, data: dict) -> None:
    print(f"camera:{event_type} {data}", flush=True)


def on_detections(detections: dict) -> None:
    """注意：Brick 只在「有偵測到東西」時才呼叫這裡，所以「不在」要靠 last_seen_at 逾時判斷。"""
    global last_seen_at, last_count, last_confidence, last_box_ratio

    items = detections.get(DETECT_LABEL, [])
    valid = []
    for item in items:
        ratio = box_ratio(item.get("bounding_box_xyxy"))
        if ratio >= MIN_BOX_RATIO:
            valid.append((float(item.get("confidence", 0.0)), ratio))

    with lock:
        last_count = len(valid)
        if valid:
            last_seen_at = time.monotonic()
            last_confidence = max(c for c, _ in valid)
            last_box_ratio = max(r for _, r in valid)


# ── 網頁指令 ────────────────────────────────────────────────────────────────


def send_event(kind: str) -> None:
    ui.send_message("pomodoro_event", {"type": kind})
    print(f"{datetime.now(UTC).isoformat(timespec='seconds')} event={kind}", flush=True)


def on_start(_sid, data) -> None:
    global state, remaining, phase_total, demo_mode
    with lock:
        if isinstance(data, dict) and "demo" in data:
            demo_mode = bool(data["demo"])
        focus, _ = durations()
        state = "focus"
        remaining = phase_total = focus
    send_event("start")


def on_reset(_sid, _data) -> None:
    global state, remaining, phase_total, focus_total_sec, away_count, pomodoro_count, celebrate_until
    with lock:
        focus, _ = durations()
        state = "idle"
        remaining = phase_total = focus
        focus_total_sec = 0.0
        away_count = 0
        pomodoro_count = 0
        celebrate_until = 0.0
    send_event("reset")


def on_set_demo(_sid, data) -> None:
    global demo_mode, remaining, phase_total
    with lock:
        demo_mode = bool(data.get("demo")) if isinstance(data, dict) else not demo_mode
        if state == "idle":
            remaining = phase_total = durations()[0]


# ── 狀態機 ──────────────────────────────────────────────────────────────────


def step(dt: float) -> list[str]:
    """推進一個 tick，回傳這個 tick 發生的事件。呼叫前要先拿 lock。"""
    global state, remaining, phase_total, focus_total_sec, away_count, pomodoro_count, celebrate_until

    now = time.monotonic()
    present = (now - last_seen_at) < AWAY_GRACE_SEC
    events: list[str] = []
    focus, brk = durations()

    if state == "focus":
        if not present:
            state = "away"
            away_count += 1
            events.append("away")
        else:
            remaining -= dt
            focus_total_sec += dt
            if remaining <= 0:
                state = "break"
                remaining = phase_total = brk
                pomodoro_count += 1
                celebrate_until = now + CELEBRATE_SEC
                events.append("focus_done")

    elif state == "away":
        if present:
            state = "focus"
            events.append("back")

    elif state == "break":
        # 休息時不管人在不在都倒數
        remaining -= dt
        if remaining <= 0:
            state = "focus"
            remaining = phase_total = focus
            events.append("break_done")

    return events


def snapshot() -> dict:
    now = time.monotonic()
    return {
        "state": state,
        "remaining": max(0.0, remaining),
        "phase_total": phase_total,
        "focus_total": focus_total_sec,
        "away_count": away_count,
        "pomodoros": pomodoro_count,
        "demo": demo_mode,
        "present": (now - last_seen_at) < AWAY_GRACE_SEC,
        "seen_ago": None if last_seen_at == 0 else round(now - last_seen_at, 1),
        "count": last_count,
        "confidence": last_confidence,
        "box_ratio": last_box_ratio,
        "grace": AWAY_GRACE_SEC,
        "label": DETECT_LABEL,
    }


# ── LED 矩陣（經 Bridge 送給 MCU）────────────────────────────────────────────

_led_ok = True
_last_frame: bytes | None = None


def push_led(frame: bytes) -> None:
    """只在畫面改變時才送。MCU 沒回應（sketch 沒燒、Bridge 卡住）時只印一次警告，不讓整個 App 掛掉。"""
    global _led_ok, _last_frame
    if frame == _last_frame:
        return
    try:
        Bridge.call("draw", frame, timeout=2)
        _last_frame = frame
        if not _led_ok:
            print("LED 矩陣恢復連線", flush=True)
        _led_ok = True
    except Exception as error:  # noqa: BLE001 - 任何 Bridge 錯誤都不該讓計時停掉
        if _led_ok:
            print(f"LED 矩陣送不出去（網頁照常運作）：{error!r}", flush=True)
        _led_ok = False
        _last_frame = None


def led_for(snap: dict, now: float, tick: int) -> bytes:
    if now < celebrate_until:
        return led_frames.celebrate(tick)
    s = snap["state"]
    if s == "focus":
        done = 1.0 - snap["remaining"] / max(snap["phase_total"], 1.0)
        return led_frames.progress(done, blink=tick % 4 < 2)
    if s == "away":
        return led_frames.warning(on=tick % 4 < 2)
    if s == "break":
        return led_frames.smile()
    return led_frames.idle(tick)


# ── 主迴圈 ──────────────────────────────────────────────────────────────────


def loop() -> None:
    last = time.monotonic()
    tick = 0
    while True:
        time.sleep(TICK_SEC)
        now = time.monotonic()
        dt = min(now - last, 1.0)  # 卡住很久也不要一次扣太多
        last = now
        tick += 1

        with lock:
            events = step(dt)
            snap = snapshot()
            frame = led_for(snap, now, tick)

        for kind in events:
            send_event(kind)
        ui.send_message("pomodoro", snap)
        push_led(frame)


camera.on_status_changed(report_camera_status)
detection.on_detect_all(on_detections)
ui.on_message("pomodoro_start", on_start)
ui.on_message("pomodoro_reset", on_reset)
ui.on_message("pomodoro_demo", on_set_demo)

threading.Thread(target=loop, daemon=True).start()

App.run()
