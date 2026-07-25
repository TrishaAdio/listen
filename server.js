import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printBanner, c } from "./banner.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const PROVIDER = (process.env.PROVIDER || "openai").toLowerCase();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-transcribe";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "whisper-large-v3-turbo";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "scribe_v1";

function currentApiKey() {
  if (PROVIDER === "elevenlabs") return ELEVENLABS_API_KEY;
  if (PROVIDER === "groq") return GROQ_API_KEY;
  return OPENAI_API_KEY;
}
function currentModel() {
  if (PROVIDER === "elevenlabs") return ELEVENLABS_MODEL;
  if (PROVIDER === "groq") return GROQ_MODEL;
  return OPENAI_MODEL;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (provider hard limit)
});

// ---- Health / config check (never leaks secrets) ----
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: PROVIDER,
    transcription_configured: Boolean(currentApiKey()),
    telegram_configured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_ID),
  });
});

// ---- Transcribe an audio chunk, then forward to Telegram if it's real English ----
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio uploaded." });
    }

    const text = (await transcribe(req.file)).trim();

    // Only act when we actually heard meaningful English speech.
    if (!isMeaningfulEnglish(text)) {
      return res.json({ text, forwarded: false, reason: "no meaningful speech" });
    }

    let forwarded = false;
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_ID) {
      forwarded = await sendToTelegram(text);
    }

    console.log(
      `${c.gray(new Date().toLocaleTimeString())} ${
        forwarded ? c.green("→ sent") : c.yellow("· heard")
      } ${c.reset(text)}`
    );

    res.json({ text, forwarded });
  } catch (err) {
    console.error(c.red("transcribe error:"), err.message);
    res.status(500).json({ error: err.message || "Transcription failed." });
  }
});

// ---- Transcription: routes to the configured best voice model ----
async function transcribe(file) {
  const blob = new Blob([file.buffer], {
    type: file.mimetype || "audio/webm",
  });
  const filename = file.originalname || "clip.webm";

  const form = new FormData();
  form.append("file", blob, filename);

  let url;
  let headers;

  if (PROVIDER === "elevenlabs") {
    // ElevenLabs Scribe — different endpoint, auth header, and field names.
    if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not set.");
    url = "https://api.elevenlabs.io/v1/speech-to-text";
    headers = { "xi-api-key": ELEVENLABS_API_KEY };
    form.append("model_id", ELEVENLABS_MODEL);
    form.append("language_code", "eng"); // English only (ISO-639-3)
  } else if (PROVIDER === "groq") {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set.");
    url = "https://api.groq.com/openai/v1/audio/transcriptions";
    headers = { Authorization: `Bearer ${GROQ_API_KEY}` };
    form.append("model", GROQ_MODEL);
    form.append("language", "en");
    form.append("response_format", "json");
  } else {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");
    url = "https://api.openai.com/v1/audio/transcriptions";
    headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };
    form.append("model", OPENAI_MODEL);
    form.append("language", "en");
    form.append("response_format", "json");
  }

  const resp = await fetch(url, { method: "POST", headers, body: form });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Transcription API ${resp.status}: ${detail.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data.text || "";
}

// ---- Filter: keep only real English speech, drop noise/blank/hallucinated fillers ----
function isMeaningfulEnglish(text) {
  if (!text) return false;
  const cleaned = text.trim();
  if (cleaned.length < 2) return false;

  // Strip surrounding bracket/paren annotations like "[music]", "(applause)".
  const bare = cleaned.replace(/^[\[\(].*[\]\)]$/s, "").trim();
  if (bare.length < 2) return false;

  // Must contain letters, and be predominantly Latin/English characters.
  const letters = (cleaned.match(/[a-zA-Z]/g) || []).length;
  if (letters === 0) return false;
  const nonSpace = cleaned.replace(/\s/g, "").length || 1;
  const latinish = (cleaned.match(/[a-zA-Z0-9.,!?'"-]/g) || []).length;
  if (latinish / nonSpace < 0.6) return false; // mostly non-English → drop

  // Require at least one real word (2+ letters) so single stray letters don't pass.
  if (!/[a-zA-Z]{2,}/.test(cleaned)) return false;

  // Whisper/GPT models emit these on silence/noise/music. Drop them.
  const noise = new Set([
    "you",
    "yeah",
    "uh",
    "um",
    "hmm",
    "mm",
    "mm-hmm",
    "so",
    "okay.",
    "ok.",
    "bye.",
    "thank you.",
    "thank you",
    "thanks.",
    "thanks for watching!",
    "thank you for watching.",
    "thank you for watching",
    "please subscribe.",
    "you're welcome.",
    ".",
    "..",
    "...",
    "[blank_audio]",
    "[silence]",
    "(silence)",
    "[music]",
    "(music)",
    "[applause]",
  ]);
  if (noise.has(cleaned.toLowerCase())) return false;

  return true;
}

// ---- Telegram delivery ----
async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_ADMIN_ID,
    text: `<b>Live transcript</b>\n<blockquote>${escapeHtml(text)}</blockquote>`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.error("telegram error:", resp.status, detail.slice(0, 300));
    return false;
  }
  return true;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

app.listen(PORT, () => {
  printBanner({
    port: PORT,
    provider: PROVIDER,
    model: currentModel(),
    telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_ID),
  });
});
