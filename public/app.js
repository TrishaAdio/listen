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

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    setStatus("Microphone access denied.", "error");
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
