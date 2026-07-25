// ---- Live mic relay -----------------------------------------------------
// Continuously monitors the mic. When the volume rises above the threshold
// (speech), it records until a short silence, then ships that clip to the
// server for transcription + Telegram delivery. Nothing is sent on silence.

const toggleBtn = document.getElementById("toggleBtn");
const meterFill = document.getElementById("meterFill");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const logEl = document.getElementById("log");
const thresholdInput = document.getElementById("threshold");
const thresholdVal = document.getElementById("thresholdVal");

// Tunables
const SILENCE_MS = 900; // silence after speech before we cut the clip
const MIN_SPEECH_MS = 350; // ignore blips shorter than this
const MAX_CLIP_MS = 15000; // hard cap so long talking still ships

let running = false;
let stream, audioCtx, analyser, source, rafId;
let mediaRecorder, chunks = [];
let speaking = false;
let speechStart = 0;
let lastLoud = 0;
let clipTimer = null;

let VOLUME_THRESHOLD = Number(thresholdInput.value);
thresholdInput.addEventListener("input", () => {
  VOLUME_THRESHOLD = Number(thresholdInput.value);
  thresholdVal.textContent = thresholdInput.value;
});

toggleBtn.addEventListener("click", () => (running ? stop() : start()));

// ---- Environment diagnostics -------------------------------------------
// Runs on load so mobile users can see exactly what's blocking the mic
// (in-app browser, insecure context, missing API, denied permission).
const diagEl = document.getElementById("diag");

function detectInAppBrowser() {
  const ua = navigator.userAgent || "";
  const apps = [
    ["Telegram", /Telegram/i],
    ["Instagram", /Instagram/i],
    ["Facebook", /FBAN|FBAV|FB_IAB/i],
    ["Messenger", /Messenger/i],
    ["Twitter/X", /Twitter/i],
    ["TikTok", /musical_ly|Bytedance|TikTok/i],
    ["Snapchat", /Snapchat/i],
    ["LINE", /\bLine\//i],
    ["WhatsApp", /WhatsApp/i],
    ["WeChat", /MicroMessenger/i],
    ["Android WebView", /; wv\)/i],
  ];
  for (const [name, re] of apps) if (re.test(ua)) return name;
  return null;
}

async function runDiagnostics() {
  const rows = [];
  const secure = window.isSecureContext;
  const hasApi = Boolean(
    navigator.mediaDevices?.getUserMedia ||
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia
  );
  const inApp = detectInAppBrowser();

  let perm = "unknown";
  try {
    if (navigator.permissions?.query) {
      const p = await navigator.permissions.query({ name: "microphone" });
      perm = p.state; // granted | denied | prompt
    }
  } catch { /* not all browsers support querying microphone */ }

  rows.push(row("Secure context (HTTPS)", secure, secure ? "yes" : "NO — mic blocked"));
  rows.push(row("Microphone API present", hasApi, hasApi ? "yes" : "NO"));
  rows.push(row("Mic permission", perm !== "denied", perm));
  if (inApp) {
    rows.push(
      `<div class="diag-row bad"><span>Browser</span><b>${inApp} in-app browser — mic usually blocked</b></div>`
    );
  }

  diagEl.innerHTML = rows.join("");

  // Loud, actionable banner for the most common mobile blocker.
  if (inApp) {
    setStatus(
      `Opened inside the ${inApp} in-app browser, which blocks the microphone. Tap the ⋯ menu and choose "Open in Chrome/Safari".`,
      "error"
    );
  } else if (!secure) {
    setStatus("Not a secure context — open the https:// (ngrok) URL directly.", "error");
  } else if (!hasApi) {
    setStatus("This browser exposes no microphone API. Open in Chrome or Safari.", "error");
  } else if (perm === "denied") {
    setStatus("Mic permission is blocked for this site. Enable it in browser site settings, then reload.", "error");
  }
}

function row(label, ok, value) {
  return `<div class="diag-row ${ok ? "ok" : "bad"}"><span>${label}</span><b>${value}</b></div>`;
}

runDiagnostics();

async function start() {
  // Secure-context guard: getUserMedia only exists on https:// or localhost.
  if (!window.isSecureContext) {
    setStatus(
      "Not a secure context. Open the site over HTTPS (or http://localhost). Mic is blocked otherwise.",
      "error"
    );
    return;
  }

  // Prefer the modern API; fall back to the legacy callback API only if needed.
  let getUM = null;
  if (navigator.mediaDevices?.getUserMedia) {
    getUM = (c) => navigator.mediaDevices.getUserMedia(c);
  } else {
    const legacy =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia;
    if (legacy) {
      getUM = (c) => new Promise((res, rej) => legacy.call(navigator, c, res, rej));
    }
  }

  if (!getUM) {
    setStatus(
      "This browser exposes no microphone API here. If the page is embedded in a frame, it needs allow=\"microphone\".",
      "error"
    );
    return;
  }

  try {
    setStatus("Requesting microphone permission…");
    stream = await getUM({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    // Surface the ACTUAL reason instead of always saying "denied".
    const map = {
      NotAllowedError: "Permission denied or dismissed. Allow mic access in the browser/site settings, then click again.",
      SecurityError: "Blocked by the browser security policy (needs HTTPS / allowed frame).",
      NotFoundError: "No microphone found on this device.",
      NotReadableError: "The microphone is in use by another app or blocked by the OS.",
      OverconstrainedError: "No microphone matches the requested settings.",
      AbortError: "Microphone start was aborted. Try again.",
    };
    const msg = map[err.name] || `${err.name || "Error"}: ${err.message || "could not start microphone."}`;
    setStatus(msg, "error");
    console.error("getUserMedia failed:", err);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  running = true;
  toggleBtn.textContent = "Stop listening";
  toggleBtn.classList.remove("primary");
  toggleBtn.classList.add("stop");
  statusDot.classList.add("live");
  setStatus("Listening… speak into the mic.");

  monitor();
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
  if (clipTimer) clearTimeout(clipTimer);
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  speaking = false;

  toggleBtn.textContent = "Start listening";
  toggleBtn.classList.add("primary");
  toggleBtn.classList.remove("stop");
  statusDot.classList.remove("live", "speaking");
  meterFill.style.width = "0%";
  setStatus("Idle");
}

function monitor() {
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    if (!running) return;
    analyser.getByteFrequencyData(data);

    // Average volume (0–255) → simple loudness estimate.
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const volume = sum / data.length;

    meterFill.style.width = `${Math.min(100, (volume / 80) * 100)}%`;

    const now = performance.now();
    if (volume > VOLUME_THRESHOLD) {
      lastLoud = now;
      if (!speaking) beginClip(now);
    } else if (speaking && now - lastLoud > SILENCE_MS) {
      endClip(now);
    }

    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function beginClip(now) {
  speaking = true;
  speechStart = now;
  chunks = [];
  statusDot.classList.add("speaking");
  setStatus("Speech detected — recording…");

  const mime = pickMime();
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = shipClip;
  mediaRecorder.start();

  // Safety cap for a long continuous utterance.
  clipTimer = setTimeout(() => {
    if (speaking) endClip(performance.now());
  }, MAX_CLIP_MS);
}

function endClip(now) {
  speaking = false;
  statusDot.classList.remove("speaking");
  if (clipTimer) clearTimeout(clipTimer);

  const duration = now - speechStart;
  if (duration < MIN_SPEECH_MS) {
    // Too short — treat as noise, discard.
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
    setStatus("Listening… speak into the mic.");
    return;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  setStatus("Transcribing…");
}

async function shipClip() {
  const type = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (blob.size < 1200) {
    setStatus("Listening… speak into the mic.");
    return;
  }

  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("audio", blob, `clip.${ext}`);

  try {
    const resp = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await resp.json();

    if (!resp.ok) {
      addLog(data.error || "Transcription failed.", "err");
    } else if (data.forwarded) {
      addLog(data.text, "sent");
    } else if (data.text) {
      addLog(data.text + "  (not sent)", "skip");
    } else {
      addLog("No speech recognized.", "skip");
    }
  } catch (err) {
    addLog("Network error: " + err.message, "err");
  } finally {
    if (running) setStatus("Listening… speak into the mic.");
  }
}

function pickMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function addLog(text, cls) {
  const li = document.createElement("li");
  li.className = cls;
  const time = new Date().toLocaleTimeString();
  li.innerHTML = `<span class="time">${time}</span>${escapeHtml(text)}`;
  logEl.prepend(li);
}

function setStatus(msg, kind) {
  statusText.textContent = msg;
  statusDot.classList.toggle("error", kind === "error");
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
