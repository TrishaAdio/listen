import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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

// Primary + backup ElevenLabs keys. The backup is used automatically when the
// primary is rejected (bad key) or out of quota. Filled at startup if missing.
const ELEVENLABS_KEYS = {
  primary: ELEVENLABS_API_KEY,
  backup: process.env.ELEVENLABS_API_KEY_BACKUP || "",
};

function currentApiKey() {
  if (PROVIDER === "elevenlabs") return ELEVENLABS_KEYS.primary || ELEVENLABS_KEYS.backup;
  if (PROVIDER === "groq") return GROQ_API_KEY;
  return OPENAI_API_KEY;
}
function currentModel() {
  if (PROVIDER === "elevenlabs") return ELEVENLABS_MODEL;
  if (PROVIDER === "groq") return GROQ_MODEL;
  return OPENAI_MODEL;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Accept multiple admins: TELEGRAM_ADMIN_ID can be comma-separated, and
// TELEGRAM_ADMIN_ID_2 is also honored. Deduped, order preserved.
const ADMIN_IDS = [
  ...String(process.env.TELEGRAM_ADMIN_ID || "").split(","),
  ...String(process.env.TELEGRAM_ADMIN_ID_2 || "").split(","),
]
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i);

// ---- Forward gate ----
// KEYWORDS: only transcripts mentioning one of these words are sent.
// A transcript containing a number always passes (full sentence is sent).
const KEYWORDS = String(
  process.env.KEYWORDS ??
    "received,credited,debited,payment,paid,transfer,transferred,sent,rupees,balance"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// SEND_ON_NUMBER=false disables the "any number passes" rule.
const SEND_ON_NUMBER = String(process.env.SEND_ON_NUMBER ?? "true").toLowerCase() !== "false";

function shouldForward(text) {
  const lower = text.toLowerCase();

  // Numbers (digits, incl. the ₹ amounts we normalized) → send full sentence.
  if (SEND_ON_NUMBER && /\d/.test(text)) return { pass: true, reason: "number" };

  // Otherwise require one of the watched words.
  const hit = KEYWORDS.find((k) => new RegExp(`\\b${escapeRegex(k)}\\b`).test(lower));
  if (hit) return { pass: true, reason: `keyword:${hit}` };

  return { pass: false, reason: "no keyword or number" };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    telegram_configured: Boolean(TELEGRAM_BOT_TOKEN && ADMIN_IDS.length),
    admin_count: ADMIN_IDS.length,
  });
});

// ---- Transcribe an audio chunk, then forward to Telegram if it's real English ----
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio uploaded." });
    }

    const raw = (await transcribe(req.file)).trim();

    // Only act when we actually heard meaningful English speech.
    if (!isMeaningfulEnglish(raw)) {
      return res.json({ text: raw, forwarded: false, reason: "no meaningful speech" });
    }

    // Normalize: spoken numbers → digits, currency words → the ₹ (INR) symbol.
    const text = formatText(raw);

    // Gate: forward only when a watched word is mentioned, OR the sentence
    // contains a number (then the full sentence goes out).
    const gate = shouldForward(text);
    if (!gate.pass) {
      console.log(
        `${c.gray(new Date().toLocaleTimeString())} ${c.gray("· ignored")} ${c.gray(text)}`
      );
      return res.json({ text, forwarded: false, reason: gate.reason });
    }

    let forwarded = false;
    if (TELEGRAM_BOT_TOKEN && ADMIN_IDS.length) {
      forwarded = await sendToTelegram(text);
    }

    console.log(
      `${c.gray(new Date().toLocaleTimeString())} ${
        forwarded ? c.green("→ sent") : c.yellow("· heard")
      } ${c.gray(`[${gate.reason}]`)} ${c.reset(text)}`
    );

    res.json({ text, forwarded, matched: gate.reason });
  } catch (err) {
    console.error(c.red("transcribe error:"), err.message);
    res.status(500).json({ error: err.message || "Transcription failed." });
  }
});

// ---- Transcription: primary key, with automatic failover to the backup ----
async function transcribe(file) {
  if (PROVIDER === "elevenlabs") {
    const keys = [ELEVENLABS_KEYS.primary, ELEVENLABS_KEYS.backup].filter(Boolean);
    if (!keys.length) throw new Error("No ElevenLabs API key configured.");

    let lastErr;
    for (let i = 0; i < keys.length; i++) {
      try {
        return await callProvider(file, keys[i]);
      } catch (err) {
        lastErr = err;
        const retryable = /\b(401|402|403|429)\b|quota|unauthorized|limit/i.test(err.message);
        const hasNext = i < keys.length - 1;
        if (!retryable || !hasNext) throw err;
        console.warn(c.yellow(`  Primary ElevenLabs key failed (${err.message.slice(0, 80)}) — switching to backup key.`));
      }
    }
    throw lastErr;
  }
  return callProvider(file);
}

async function callProvider(file, elevenKey) {
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
    url = "https://api.elevenlabs.io/v1/speech-to-text";
    headers = { "xi-api-key": elevenKey };
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

// ---- Telegram delivery (to every configured admin) ----
async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const message = `<b>Verified</b>\n<blockquote>${escapeHtml(text)}</blockquote>`;

  const results = await Promise.all(
    ADMIN_IDS.map(async (chatId) => {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => "");
          console.error(`telegram error for ${chatId}:`, resp.status, detail.slice(0, 200));
          return false;
        }
        return true;
      } catch (err) {
        console.error(`telegram send failed for ${chatId}:`, err.message);
        return false;
      }
    })
  );

  // Forwarded if it reached at least one admin.
  return results.some(Boolean);
}

// ---- Text normalization: spoken numbers → digits, "rupees" → ₹ ----
const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MAG = {
  hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000,
  crore: 10000000, crores: 10000000, million: 1000000, billion: 1000000000,
};
const NUM_WORDS = [...Object.keys(SMALL), ...Object.keys(TENS), ...Object.keys(MAG)];

function chunkToNumber(tokens) {
  let total = 0;
  let current = 0;
  for (const tok of tokens) {
    const w = tok.toLowerCase();
    if (w === "and") continue;
    if (w in SMALL) current += SMALL[w];
    else if (w in TENS) current += TENS[w];
    else if (w in MAG) {
      const m = MAG[w];
      if (m >= 1000) {
        total += (current || 1) * m;
        current = 0;
      } else {
        current = (current || 1) * m; // hundred
      }
    }
  }
  return total + current;
}

function formatText(input) {
  let text = input;

  // Convert runs of number words (optionally joined by "and") into digits.
  const runRe = new RegExp(
    `\\b(?:${NUM_WORDS.join("|")})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUM_WORDS.join("|")}))*\\b`,
    "gi"
  );
  text = text.replace(runRe, (m) => String(chunkToNumber(m.split(/[\s-]+/))));

  // Currency: "<amount> rupees/rupee/rs/inr" and "rs/inr <amount>" → ₹<amount>.
  text = text.replace(/(\d+(?:\.\d+)?)\s*(?:rupees|rupee|rs\.?|inr)\b/gi, "₹$1");
  text = text.replace(/\b(?:rs\.?|inr)\s*(\d+(?:\.\d+)?)/gi, "₹$1");
  // Also handle "paisa/paise" left dangling rarely — leave as-is otherwise.

  return text.replace(/\s{2,}/g, " ").trim();
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- Start server: HTTPS if certs are provided, else HTTP ----
// Mobile browsers require HTTPS (or localhost) to grant microphone access.
// Provide cert paths via SSL_KEY / SSL_CERT, or drop certs/key.pem + certs/cert.pem.
const SSL_KEY = process.env.SSL_KEY || path.join(__dirname, "certs", "key.pem");
const SSL_CERT = process.env.SSL_CERT || path.join(__dirname, "certs", "cert.pem");
const hasCerts = fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT);

function onListen(scheme) {
  printBanner({
    port: PORT,
    provider: PROVIDER,
    model: currentModel(),
    telegram: Boolean(TELEGRAM_BOT_TOKEN && ADMIN_IDS.length),
    scheme,
  });
  if (scheme === "http") {
    console.log(
      c.yellow(
        "  Note: phones need HTTPS for mic access. Run `npm run cert` then restart for https://\n"
      )
    );
  }
}

// ---- Ask for a backup ElevenLabs token at startup (skipped if already set) ----
async function askBackupKey() {
  if (PROVIDER !== "elevenlabs") return;
  if (ELEVENLABS_KEYS.backup) {
    console.log(c.dim("  Backup ElevenLabs key loaded from .env"));
    return;
  }
  // Non-interactive (service/pm2/docker) — don't block startup.
  if (!process.stdin.isTTY) return;

  const answer = await prompt(
    c.bold("  Backup ElevenLabs API token") + c.dim(" (press Enter to skip): ")
  );
  const key = answer.trim();
  if (!key) {
    console.log(c.dim("  No backup key set — continuing with the primary only."));
    return;
  }
  ELEVENLABS_KEYS.backup = key;

  // Persist to .env so you aren't asked again on the next start.
  try {
    const envPath = path.join(__dirname, ".env");
    const line = `ELEVENLABS_API_KEY_BACKUP=${key}`;
    let body = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    body = /^ELEVENLABS_API_KEY_BACKUP=.*$/m.test(body)
      ? body.replace(/^ELEVENLABS_API_KEY_BACKUP=.*$/m, line)
      : (body.endsWith("\n") || body === "" ? body : body + "\n") + line + "\n";
    fs.writeFileSync(envPath, body);
    console.log(c.green("  Backup key saved to .env"));
  } catch (err) {
    console.warn(c.yellow("  Could not save to .env: " + err.message));
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    const onData = (d) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(String(d));
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

await askBackupKey();

if (hasCerts) {
  const creds = { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) };
  https.createServer(creds, app).listen(PORT, "0.0.0.0", () => onListen("https"));
} else {
  http.createServer(app).listen(PORT, "0.0.0.0", () => onListen("http"));
}
