// ---- Live mic relay -----------------------------------------------------
// Live, continuous listening. After a single tap to grant mic access it runs
// forever: an adaptive voice-activity detector (auto-calibrates to the device's
// own noise floor, so it works on quiet phone mics too) records each utterance,
// then ships it for transcription + Telegram delivery. Nothing sent on silence.

const toggleBtn = document.getElementById("toggleBtn");
const meterFill = document.getElementById("meterFill");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const logEl = document.getElementById("log");
const sensInput = document.getElementById("threshold");
const sensVal = document.getElementById("thresholdVal");

// Timing tunables
const SILENCE_MS = 900; // silence after speech before we cut the clip
const MIN_SPEECH_MS = 250; // ignore blips shorter than this
const MAX_CLIP_MS = 15000; // hard cap so long talking still ships

let running = false;
let stream, audioCtx, analyser, source, rafId;
let mediaRecorder, chunks = [];
let speaking = false;
let speechStart = 0;
let lastLoud = 0;
let clipTimer = null;

// Adaptive detection state
let noiseFloor = null; // EMA of RMS during silence — the device's own baseline
let peak = 0.06; // decaying peak for auto-scaling the meter

let SENS = Number(sensInput.value); // 1 (least) .. 10 (most sensitive)
sensInput.addEventListener("input", () => {
  SENS = Number(sensInput.value);
  sensVal.textContent = sensInput.value;
});

// Single gesture: the tap that grants mic access, then it's live forever.
toggleBtn.addEventListener("click", () => {
  if (!running) start(false);
});

// ---- Environment diagnostics -------------------------------------------
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
      perm = p.state;
    }
  } catch { /* microphone permission not queryable in this browser */ }

  const rows = [
    row("Secure context (HTTPS)", secure, secure ? "yes" : "NO — mic blocked"),
    row("Microphone API present", hasApi, hasApi ? "yes" : "NO"),
    row("Mic permission", perm !== "denied", perm),
  ];
  if (inApp) {
    rows.push(
      `<div class="diag-row bad"><span>Browser</span><b>${inApp} in-app browser — mic usually blocked</b></div>`
    );
  }
  diagEl.innerHTML = rows.join("");

  // Hard blockers first.
  if (inApp) {
    setStatus(`Opened inside the ${inApp} in-app browser, which blocks the mic. Use the ⋯ menu → "Open in Chrome/Safari".`, "error");
    return { canStart: false };
  }
  if (!secure) {
    setStatus("Not a secure context — open the https:// (ngrok) URL directly.", "error");
    return { canStart: false };
  }
  if (!hasApi) {
    setStatus("This browser exposes no microphone API. Open in Chrome or Safari.", "error");
    return { canStart: false };
  }
  if (perm === "denied") {
    setStatus("Mic permission is blocked for this site. Enable it in site settings, then reload.", "error");
    return { canStart: false };
  }
  return { canStart: true };
}

function row(label, ok, value) {
  return `<div class="diag-row ${ok ? "ok" : "bad"}"><span>${label}</span><b>${value}</b></div>`;
}

// Boot: diagnose, then try to go live automatically. If the browser needs a
// user gesture (typical on mobile), show a single tap-to-start button.
(async function boot() {
  const { canStart } = await runDiagnostics();
  if (!canStart) return;
  start(true);
})();

async function start(isAuto) {
  let getUM = null;
  if (navigator.mediaDevices?.getUserMedia) {
    getUM = (c) => navigator.mediaDevices.getUserMedia(c);
  } else {
    const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
    if (legacy) getUM = (c) => new Promise((res, rej) => legacy.call(navigator, c, res, rej));
  }
  if (!getUM) {
    setStatus('No microphone API here. If embedded in a frame it needs allow="microphone".', "error");
    return;
  }

  try {
    if (!isAuto) setStatus("Requesting microphone permission…");
    stream = await getUM({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    // If auto-start was blocked for lack of a gesture, just reveal the tap button.
    if (isAuto && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      showStartButton();
      setStatus("Tap the button to start live listening.");
      return;
    }
    const map = {
      NotAllowedError: "Permission denied or dismissed. Allow mic access, then tap again.",
      SecurityError: "Blocked by browser security policy (needs HTTPS / allowed frame).",
      NotFoundError: "No microphone found on this device.",
      NotReadableError: "The microphone is in use by another app or blocked by the OS.",
      OverconstrainedError: "No microphone matches the requested settings.",
      AbortError: "Microphone start was aborted. Try again.",
    };
    setStatus(map[err.name] || `${err.name || "Error"}: ${err.message || "could not start microphone."}`, "error");
    showStartButton();
    console.error("getUserMedia failed:", err);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch {}
  }
  source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);

  running = true;
  noiseFloor = null;
  toggleBtn.style.display = "none"; // live mode — no manual start/stop
  statusDot.classList.add("live");
  setStatus("Live — listening. Just speak.");
  monitor();
}

function showStartButton() {
  toggleBtn.style.display = "";
  toggleBtn.textContent = "Start live listening";
  toggleBtn.classList.add("primary");
}

function monitor() {
  const buf = new Uint8Array(analyser.fftSize);

  const tick = () => {
    if (!running) return;
    analyser.getByteTimeDomainData(buf);

    // RMS of the waveform → consistent loudness across devices (unlike a
    // frequency-bin average, which reads very low on phone mics).
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / buf.length);

    // Auto-scaling meter: fills nicely regardless of the device's absolute level.
    peak = Math.max(peak * 0.995, rms, 0.03);
    meterFill.style.width = `${Math.min(100, (rms / peak) * 100)}%`;

    // Adapt the noise floor only while NOT speaking, so it learns the room.
    if (!speaking) {
      noiseFloor = noiseFloor === null ? rms : noiseFloor * 0.95 + rms * 0.05;
    }
    const base = noiseFloor ?? 0.01;
    const mult = 1.5 + (10 - SENS) * 0.2; // more sensitive slider → lower bar
    const margin = 0.004 + (10 - SENS) * 0.0016;
    const trigger = base * mult + margin;

    const now = performance.now();
    if (rms > trigger) {
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
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
    setStatus("Live — listening. Just speak.");
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
    setStatus("Live — listening. Just speak.");
    return;
  }

  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : "webm";
  const form = new FormData();
  form.append("audio", blob, `clip.${ext}`);

  try {
    const resp = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) addLog(data.error || "Transcription failed.", "err");
    else if (data.forwarded) addLog(data.text, "sent");
    else if (data.text) addLog(data.text + "  (not sent)", "skip");
    else addLog("No speech recognized.", "skip");
  } catch (err) {
    addLog("Network error: " + err.message, "err");
  } finally {
    if (running) setStatus("Live — listening. Just speak.");
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
