"use strict";

// FocusGuard 番茄鐘儀表板。
// 計時和狀態都在板子上（python/main.py），這一頁只負責顯示、送指令和播提示音。
// boardUi 來自 app.js（同一個 Socket.IO 連線）。

const pomoCard = document.querySelector("#pomoCard");
const pomoState = document.querySelector("#pomoState");
const pomoTime = document.querySelector("#pomoTime");
const pomoBar = document.querySelector("#pomoBar");
const pomoHint = document.querySelector("#pomoHint");
const pomoStart = document.querySelector("#pomoStart");
const pomoReset = document.querySelector("#pomoReset");
const pomoDemo = document.querySelector("#pomoDemo");
const pomoFocusTotal = document.querySelector("#pomoFocusTotal");
const pomoCount = document.querySelector("#pomoCount");
const pomoAway = document.querySelector("#pomoAway");
const pomoPresence = document.querySelector("#pomoPresence");
const pomoDetail = document.querySelector("#pomoDetail");

const STATE_TEXT = {
  idle: "尚未開始",
  focus: "專注中",
  away: "暫離：計時已暫停",
  break: "休息時間",
};

const STATE_HINT = {
  idle: "先在下方開始辨識，再按「開始專注」。",
  focus: "AI 看得到你，正在倒數。",
  away: "偵測不到人，回到座位就會自動繼續。",
  break: "起來走走，休息結束會響一聲。",
};

// ── 提示音（Web Audio，不需要音檔）──────────────────────────────────────────
// 瀏覽器規定要先有使用者點擊才能出聲，所以在按鈕點擊時建立 AudioContext。

let audioContext = null;

function unlockAudio() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) {
      return;
    }
    audioContext = new AudioCtor();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
}

function playNotes(notes, { type = "sine", volume = 0.25, gap = 0.18, length = 0.35 } = {}) {
  if (!audioContext) {
    return;
  }
  const start = audioContext.currentTime + 0.02;
  notes.forEach((frequency, index) => {
    const at = start + index * gap;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(at);
    osc.stop(at + length + 0.05);
  });
}

const SOUNDS = {
  focus_done: () => playNotes([523, 659, 784, 1047], { length: 0.6 }), // 叮叮叮叮～ 專注完成
  break_done: () => playNotes([784, 523], { length: 0.5, gap: 0.25 }), // 休息結束，回來專注
  away: () => playNotes([330], { type: "triangle", volume: 0.18, length: 0.25 }), // 低音提醒
  back: () => playNotes([880], { volume: 0.12, length: 0.15 }),
  start: () => playNotes([660, 880], { volume: 0.15, length: 0.2, gap: 0.12 }),
};

// ── 畫面 ────────────────────────────────────────────────────────────────────

function mmss(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ms = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${ms}` : ms;
}

function render(snap) {
  const state = snap?.state ?? "idle";
  pomoCard.dataset.state = state;
  pomoState.textContent = STATE_TEXT[state] ?? state;
  pomoHint.textContent = STATE_HINT[state] ?? "";
  pomoTime.textContent = mmss(snap.remaining);

  const total = Math.max(Number(snap.phase_total) || 1, 1);
  const done = state === "idle" ? 0 : 1 - Number(snap.remaining) / total;
  pomoBar.style.width = `${Math.min(100, Math.max(0, done * 100)).toFixed(1)}%`;

  pomoFocusTotal.textContent = mmss(snap.focus_total);
  pomoCount.textContent = `${snap.pomodoros ?? 0} 個`;
  pomoAway.textContent = `${snap.away_count ?? 0} 次`;

  pomoPresence.textContent = snap.present ? "有人在座" : "沒看到人";
  const parts = [];
  if (snap.confidence != null) {
    parts.push(`信心度 ${(snap.confidence * 100).toFixed(0)}%`);
  }
  if (snap.box_ratio != null) {
    parts.push(`框大小 ${(snap.box_ratio * 100).toFixed(1)}%`);
  }
  if (!snap.present && snap.seen_ago != null) {
    parts.push(`${snap.seen_ago} 秒前最後看到`);
  }
  pomoDetail.textContent = parts.join("・") || `偵測標籤：${snap.label}`;

  if (pomoDemo.checked !== Boolean(snap.demo) && document.activeElement !== pomoDemo) {
    pomoDemo.checked = Boolean(snap.demo);
  }
  pomoStart.textContent = state === "idle" ? "開始專注" : "重新開始這一輪";
  document.title = state === "idle" ? "FocusGuard 專注番茄鐘" : `${mmss(snap.remaining)}・${STATE_TEXT[state]}`;
}

// ── 指令與事件 ──────────────────────────────────────────────────────────────

pomoStart.addEventListener("click", () => {
  unlockAudio();
  boardUi.send_message("pomodoro_start", { demo: pomoDemo.checked });
});

pomoReset.addEventListener("click", () => {
  unlockAudio();
  boardUi.send_message("pomodoro_reset", {});
});

pomoDemo.addEventListener("change", () => {
  boardUi.send_message("pomodoro_demo", { demo: pomoDemo.checked });
});

// 開始辨識的按鈕也算一次點擊，順便解鎖聲音
document.querySelector("#startButton")?.addEventListener("click", unlockAudio);

boardUi.on_message("pomodoro", render);
boardUi.on_message("pomodoro_event", (event) => {
  SOUNDS[event?.type]?.();
});
boardUi.on_disconnect(() => {
  pomoPresence.textContent = "未連線";
  pomoDetail.textContent = "請確認 USB 通道和 App 是否在跑";
});
