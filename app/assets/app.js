"use strict";

const CAMERA_WIDTH = 640;
const CAMERA_HEIGHT = 480;
const SEND_WIDTH = 320;
const SEND_HEIGHT = 240;
const TARGET_FPS = 8;
const JPEG_QUALITY = 0.55;
const MAX_SOCKET_BUFFER = 512 * 1024;
const BPP_HEADER_BYTES = 14;
const BPP_VERSION = 0;
const BPP_MODE_NONE = 0;

const cameraSelect = document.querySelector("#cameraSelect");
const startButton = document.querySelector("#startButton");
const externalButton = document.querySelector("#externalButton");
const stopButton = document.querySelector("#stopButton");
const localVideo = document.querySelector("#localVideo");
const localPlaceholder = document.querySelector("#localPlaceholder");
const aiFrame = document.querySelector("#aiFrame");
const aiPlaceholder = document.querySelector("#aiPlaceholder");
const boardFpsNote = document.querySelector("#boardFpsNote");
const captureCanvas = document.querySelector("#captureCanvas");
const captureContext = captureCanvas.getContext("2d", { alpha: false });

const cameraStatus = document.querySelector("#cameraStatus");
const usbStatus = document.querySelector("#usbStatus");
const frameStatus = document.querySelector("#frameStatus");
const cameraDot = document.querySelector("#cameraDot");
const usbDot = document.querySelector("#usbDot");
const frameDot = document.querySelector("#frameDot");

const sendFpsValue = document.querySelector("#sendFpsValue");
const dataRateValue = document.querySelector("#dataRateValue");
const resolutionValue = document.querySelector("#resolutionValue");
const uptimeValue = document.querySelector("#uptimeValue");
const skippedValue = document.querySelector("#skippedValue");
const aiFacesValue = document.querySelector("#aiFacesValue");
const aiConfidenceValue = document.querySelector("#aiConfidenceValue");

const boardUi = new WebUI();

let mediaStream = null;
let socket = null;
let frameTimer = null;
let reconnectTimer = null;
let frameCount = 0;
let isRunning = false;
let externalMode = false;
let statsTimer = null;
let aiIdleTimer = null;
let sessionStartedAt = 0;
let statsWindowStartedAt = 0;
let windowFrameCount = 0;
let windowByteCount = 0;
let skippedFrameCount = 0;
let boardClockOffsetMs = 0;

function setStatus(element, dot, message, state = "idle") {
  element.textContent = message;
  dot.classList.toggle("ok", state === "ok");
  dot.classList.toggle("error", state === "error");
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteSecond = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${minuteSecond}` : minuteSecond;
}

function resetLiveStats() {
  const now = performance.now();
  sessionStartedAt = now;
  statsWindowStartedAt = now;
  windowFrameCount = 0;
  windowByteCount = 0;
  skippedFrameCount = 0;

  sendFpsValue.textContent = "0.0 FPS";
  dataRateValue.textContent = "0 KB/s";
  uptimeValue.textContent = "00:00";
  skippedValue.textContent = "0 張";
  aiFacesValue.textContent = "等待畫面";
  aiConfidenceValue.textContent = "信心度 —";
}

function updateLiveStats() {
  const now = performance.now();
  const windowSeconds = Math.max((now - statsWindowStartedAt) / 1000, 0.001);
  const sendFps = windowFrameCount / windowSeconds;
  const kilobytesPerSecond = windowByteCount / windowSeconds / 1024;

  // 外部來源模式下畫面不是這一頁送的，這兩個數字量不到——
  // 印 0.0 FPS 會讓人以為沒在送，所以維持「—」，實際速率看 Python 那邊的輸出。
  if (!externalMode) {
    sendFpsValue.textContent = `${sendFps.toFixed(1)} FPS`;
    dataRateValue.textContent = `${kilobytesPerSecond.toFixed(0)} KB/s`;
  }
  uptimeValue.textContent = formatDuration(now - sessionStartedAt);
  skippedValue.textContent = `${skippedFrameCount} 張`;

  statsWindowStartedAt = now;
  windowFrameCount = 0;
  windowByteCount = 0;
}

function handleAiStats(stats) {
  const faceCount = Number(stats?.face_count ?? 0);
  const confidence = stats?.max_confidence;

  aiFacesValue.textContent = `${faceCount} 張臉`;
  aiConfidenceValue.textContent =
    confidence == null ? "信心度 —" : `最高信心度 ${(Number(confidence) * 100).toFixed(1)}%`;

  window.clearTimeout(aiIdleTimer);
  aiIdleTimer = window.setTimeout(() => {
    aiFacesValue.textContent = "0 張臉";
    aiConfidenceValue.textContent = "目前沒有偵測到人臉";
  }, 1500);
}

// UNO Q 沒有電池 RTC、教室版又沒有網路，開機後板子時鐘往往差好幾小時；
// 板子只收 ±10 秒內的時間戳，所以先用板子自己回的 HTTP Date 算出時差，之後照板子的時間打戳。
async function syncBoardClock() {
  try {
    const started = Date.now();
    const response = await fetch(`${window.location.pathname}?clock=${started}`, {
      method: "HEAD",
      cache: "no-store",
    });
    const boardMs = Date.parse(response.headers.get("Date") || "");

    if (Number.isNaN(boardMs)) {
      boardClockOffsetMs = 0;
      return;
    }

    // Date 標頭只到秒（無條件捨去），補半秒抵掉截斷；再扣掉來回時間的一半。
    boardClockOffsetMs = Math.round(boardMs + 500 - (started + Date.now()) / 2);
  } catch {
    boardClockOffsetMs = 0;
  }
}

function clockNote() {
  if (Math.abs(boardClockOffsetMs) < 2000) {
    return "";
  }

  const seconds = Math.round(boardClockOffsetMs / 1000);
  const shown =
    Math.abs(seconds) >= 60 ? `${Math.round(seconds / 60)} 分` : `${seconds} 秒`;
  return `（已校正板子時鐘 ${shown}）`;
}

function createBppHeader() {
  const buffer = new ArrayBuffer(BPP_HEADER_BYTES);
  const view = new DataView(buffer);
  const randomValue = crypto.getRandomValues(new Uint32Array(1))[0];

  view.setUint8(0, BPP_VERSION);
  view.setUint8(1, BPP_MODE_NONE);
  view.setBigUint64(2, BigInt(Date.now() + boardClockOffsetMs) * 1000n, false);
  view.setUint32(10, randomValue, false);
  return buffer;
}

function canvasToJpegBytes() {
  const dataUrl = captureCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function createBppPacket(jpegBytes) {
  const packet = new Uint8Array(BPP_HEADER_BYTES + jpegBytes.length);
  packet.set(new Uint8Array(createBppHeader()), 0);
  packet.set(jpegBytes, BPP_HEADER_BYTES);
  return packet.buffer;
}

function serviceHost() {
  return window.location.hostname || "127.0.0.1";
}

// AI 框選那格嵌的是 Edge Impulse 自己的頁面（14912 埠、跨來源，改不到它的 CSS）。
// 2026-07-22 實測它的版面規律：**畫面恆為 640×480、左右在視窗裡置中、距頂固定 23px**，
// 而且不會隨容器縮放。所以我們給 iframe 一個固定虛擬視窗，再整個縮放。
//
// ⚠️ 關鍵：要對準的是「那張圖」，不是整個 iframe。
// 對整個 iframe 縮放的話，會連 EI 自己的留白一起算進去 → 圖被縮得又小又偏。
const AI_FRAME_WIDTH = 700; // 要跟 style.css 的 #aiFrame width 一致
const AI_FRAME_HEIGHT = 540; // 要跟 style.css 的 #aiFrame height 一致
const AI_IMAGE_WIDTH = 640;
const AI_IMAGE_HEIGHT = 480;
const AI_IMAGE_LEFT = (AI_FRAME_WIDTH - AI_IMAGE_WIDTH) / 2; // 置中 → 30
const AI_IMAGE_TOP = 23; // 實測固定值（視窗高度改變也不動）

function fitAiFrame() {
  const stage = aiFrame.parentElement;
  if (!stage) {
    return;
  }

  const { width, height } = stage.getBoundingClientRect();
  if (!width || !height) {
    return;
  }

  // 讓「圖」盡量放大又完整看得到；EI 的留白被推到卡片外，由 overflow:hidden 切掉
  const scale = Math.min(width / AI_IMAGE_WIDTH, height / AI_IMAGE_HEIGHT);
  const offsetX = (width - AI_IMAGE_WIDTH * scale) / 2 - AI_IMAGE_LEFT * scale;
  const offsetY = (height - AI_IMAGE_HEIGHT * scale) / 2 - AI_IMAGE_TOP * scale;
  aiFrame.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

function watchAiFrameSize() {
  const stage = aiFrame.parentElement;
  if (stage && typeof ResizeObserver === "function") {
    new ResizeObserver(fitAiFrame).observe(stage);
  }
  window.addEventListener("resize", fitAiFrame);
  fitAiFrame();
}

function openAiView() {
  aiPlaceholder.hidden = false;
  aiFrame.addEventListener(
    "load",
    () => {
      aiPlaceholder.hidden = true;
      fitAiFrame();
    },
    { once: true },
  );
  aiFrame.src = `http://${serviceHost()}:14912/embed?time=${Date.now()}`;
  fitAiFrame();
}

async function listCameras(preferredDeviceId = "") {
  if (!navigator.mediaDevices?.enumerateDevices) {
    cameraSelect.innerHTML = '<option value="">這個瀏覽器不支援攝影機</option>';
    return;
  }

  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "videoinput",
  );

  cameraSelect.replaceChildren();
  if (devices.length === 0) {
    const option = new Option("找不到攝影機", "");
    cameraSelect.add(option);
    return;
  }

  devices.forEach((device, index) => {
    const label = device.label || `攝影機 ${index + 1}`;
    cameraSelect.add(new Option(label, device.deviceId));
  });

  if (preferredDeviceId && devices.some((device) => device.deviceId === preferredDeviceId)) {
    cameraSelect.value = preferredDeviceId;
  }
}

function closeSocket() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;

  if (socket) {
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    socket = null;
  }
}

function scheduleReconnect() {
  if (!isRunning || reconnectTimer) {
    return;
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectCameraSocket();
  }, 2000);
}

function connectCameraSocket() {
  closeSocket();
  setStatus(usbStatus, usbDot, "正在連接 UNO Q…");

  try {
    socket = new WebSocket(`ws://${serviceHost()}:18080`);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      setStatus(usbStatus, usbDot, `已連接${clockNote()}`, "ok");
    };

    socket.onclose = () => {
      if (isRunning) {
        setStatus(usbStatus, usbDot, "連線中斷，正在重試…", "error");
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      setStatus(usbStatus, usbDot, "無法連接，請重新執行啟動腳本", "error");
    };
  } catch (error) {
    setStatus(usbStatus, usbDot, `連線失敗：${error.message}`, "error");
    scheduleReconnect();
  }
}

function sendFrame() {
  if (!isRunning) {
    return;
  }

  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount > MAX_SOCKET_BUFFER ||
    localVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    skippedFrameCount += 1;
    return;
  }

  // 左邊的預覽是鏡像的（`.local-stage video { transform: scaleX(-1) }`，自拍視角，
  // 舉右手看起來就是右手）。送給板子的畫面也要跟著鏡像，否則右邊的 AI 結果
  // 會跟左邊左右相反（2026-07-22 Ted 回報）。
  //
  // 為什麼是在這裡翻、不是去翻右邊那格：右邊是板子畫好框、連 `face (0.87)`
  // 的文字都畫在圖上了，整格翻過去字會變成反的。從源頭送鏡像才對。
  captureContext.save();
  captureContext.translate(SEND_WIDTH, 0);
  captureContext.scale(-1, 1);
  captureContext.drawImage(localVideo, 0, 0, SEND_WIDTH, SEND_HEIGHT);
  captureContext.restore();

  try {
    const packet = createBppPacket(canvasToJpegBytes());
    socket.send(packet);
    frameCount += 1;
    windowFrameCount += 1;
    windowByteCount += packet.byteLength;
    setStatus(frameStatus, frameDot, `${frameCount} 張`, "ok");
  } catch {
    skippedFrameCount += 1;
  }
}

async function startCamera() {
  startButton.disabled = true;
  externalButton.disabled = true;
  setStatus(cameraStatus, cameraDot, "正在開啟…");

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("這個瀏覽器不支援攝影機功能");
    }

    const selectedDevice = cameraSelect.value;
    const videoConstraints = {
      width: { ideal: CAMERA_WIDTH },
      height: { ideal: CAMERA_HEIGHT },
      frameRate: { ideal: TARGET_FPS, max: 12 },
    };

    if (selectedDevice) {
      videoConstraints.deviceId = { exact: selectedDevice };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    localVideo.srcObject = mediaStream;
    await localVideo.play();

    const activeDeviceId = mediaStream.getVideoTracks()[0]?.getSettings().deviceId || "";
    await listCameras(activeDeviceId);

    isRunning = true;
    frameCount = 0;
    localPlaceholder.hidden = true;
    stopButton.disabled = false;
    setStatus(cameraStatus, cameraDot, "使用中", "ok");
    setStatus(frameStatus, frameDot, "0 張");
    resolutionValue.textContent = `${SEND_WIDTH} × ${SEND_HEIGHT}`;
    resetLiveStats();

    await syncBoardClock();
    connectCameraSocket();
    openAiView();
    frameTimer = window.setInterval(sendFrame, Math.round(1000 / TARGET_FPS));
    statsTimer = window.setInterval(updateLiveStats, 1000);
  } catch (error) {
    startButton.disabled = false;
    externalButton.disabled = false;
    const permissionMessage =
      error.name === "NotAllowedError"
        ? "未取得權限。請在網址列允許使用攝影機，再按一次開始。"
        : `無法開啟：${error.message}`;
    setStatus(cameraStatus, cameraDot, permissionMessage, "error");
  }
}

// 「用 Python 送」＝外部來源模式：這一頁**不送畫面**，只負責顯示。
// 為什麼行得通：右邊的 AI 框選是嵌板子的 4912 埠、統計是板子主動推的 ai_stats，
// 兩者都不在乎畫面是誰送的——只有送幀迴圈才綁瀏覽器攝影機。
//
// 左邊那格會「試著」開攝影機做本機預覽（純顯示、不送）：
// macOS 能不能讓瀏覽器跟 Python 同時開同一支鏡頭，各版本／各機器不一定，
// 所以不預設答案——開得起來就顯示，開不起來就留白並說明原因。
// 只開本機預覽、不送任何畫面。失敗不是錯誤——多半是攝影機已經被 Python 那支佔住。
async function startLocalPreviewOnly() {
  setStatus(cameraStatus, cameraDot, "正在試著開預覽…");

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("這個瀏覽器不支援攝影機功能");
    }

    const videoConstraints = {
      width: { ideal: CAMERA_WIDTH },
      height: { ideal: CAMERA_HEIGHT },
    };
    if (cameraSelect.value) {
      videoConstraints.deviceId = { exact: cameraSelect.value };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    localVideo.srcObject = mediaStream;
    await localVideo.play();
    localPlaceholder.hidden = true;
    setStatus(cameraStatus, cameraDot, "只做預覽（不送畫面）", "ok");
  } catch (error) {
    // 開不起來就留白，並講清楚為什麼——這不影響辨識，畫面是 Python 在送
    localVideo.srcObject = null;
    localPlaceholder.hidden = false;
    localPlaceholder.textContent =
      error.name === "NotReadableError" || error.name === "AbortError"
        ? "攝影機已被 Python 程式佔用，所以這裡不顯示預覽。辨識照常進行。"
        : `畫面由 Python 程式送出。（本機預覽打不開：${error.name || error.message}）`;
    setStatus(cameraStatus, cameraDot, "未使用（外部來源）");
  }
}

async function startExternalSource() {
  externalMode = true;
  frameCount = 0;

  startButton.disabled = true;
  externalButton.disabled = true;
  stopButton.disabled = false;

  setStatus(usbStatus, usbDot, "由 Python 程式送出", "ok");
  setStatus(frameStatus, frameDot, "由外部程式計算");
  resolutionValue.textContent = "外部決定";
  sendFpsValue.textContent = "—";
  dataRateValue.textContent = "—";
  aiFacesValue.textContent = "等待畫面";

  resetLiveStats();
  sendFpsValue.textContent = "—";
  dataRateValue.textContent = "—";

  openAiView();
  statsTimer = window.setInterval(updateLiveStats, 1000);

  await startLocalPreviewOnly();
}

function stopCamera() {
  isRunning = false;
  externalMode = false;
  externalButton.disabled = false;
  localPlaceholder.textContent = "按「開始辨識」後，畫面會出現在這裡。";
  window.clearInterval(frameTimer);
  frameTimer = null;
  window.clearInterval(statsTimer);
  statsTimer = null;
  window.clearTimeout(aiIdleTimer);
  aiIdleTimer = null;
  closeSocket();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  localVideo.srcObject = null;
  localPlaceholder.hidden = false;
  aiFrame.removeAttribute("src");
  aiPlaceholder.hidden = false;
  startButton.disabled = false;
  stopButton.disabled = true;

  setStatus(cameraStatus, cameraDot, "已停止");
  setStatus(usbStatus, usbDot, "等待連線");
  setStatus(frameStatus, frameDot, `${frameCount} 張`);
  sendFpsValue.textContent = "0.0 FPS";
  dataRateValue.textContent = "0 KB/s";
  boardFpsNote.textContent = "每秒送到 UNO Q 的畫面數";
  aiFacesValue.textContent = "已停止";
  aiConfidenceValue.textContent = "信心度 —";
}

startButton.addEventListener("click", startCamera);
externalButton.addEventListener("click", startExternalSource);
stopButton.addEventListener("click", stopCamera);

boardUi.on_connect(() => {
  if (!isRunning && !externalMode) {
    aiFacesValue.textContent = "等待畫面";
  }
});
boardUi.on_disconnect(() => {
  aiFacesValue.textContent = "統計未連線";
  aiConfidenceValue.textContent = "請確認 USB 通道";
});
boardUi.on_message("ai_stats", handleAiStats);

// 板子每秒回報它「實際收到幾張畫面」。用 Python 送的時候這一頁量不到，
// 只有板子看得到；瀏覽器模式下這個數字也有用——它是真的進到板子的量，
// 跟本機送出的量對照，就看得出來有沒有在路上被丟掉。
boardUi.on_message("board_throughput", (stats) => {
  const fps = Number(stats?.fps);
  if (!Number.isFinite(fps)) {
    return;
  }

  if (externalMode) {
    sendFpsValue.textContent = `${fps.toFixed(1)} FPS`;
    boardFpsNote.textContent = "板子實際收到的張數（上限 8）";
  } else if (isRunning) {
    boardFpsNote.textContent = `板子實際收到 ${fps.toFixed(1)} FPS`;
  }
});

navigator.mediaDevices?.addEventListener("devicechange", () => {
  listCameras(cameraSelect.value).catch(() => {});
});

window.addEventListener("beforeunload", stopCamera);

watchAiFrameSize();

listCameras().catch((error) => {
  cameraSelect.innerHTML = `<option value="">無法讀取攝影機：${error.message}</option>`;
});
