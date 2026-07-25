// Tiny zero-dependency ANSI color helper (colorama-style) + ASCII banner.

const ESC = "\x1b[";
const enabled = process.stdout.isTTY || process.env.FORCE_COLOR === "1";

function wrap(open, close) {
  return (s) => (enabled ? `${ESC}${open}m${s}${ESC}${close}m` : String(s));
}

export const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

const ART = [
  "  ██╗     ██╗███████╗████████╗███████╗███╗   ██╗",
  "  ██║     ██║██╔════╝╚══██╔══╝██╔════╝████╗  ██║",
  "  ██║     ██║███████╗   ██║   █████╗  ██╔██╗ ██║",
  "  ██║     ██║╚════██║   ██║   ██╔══╝  ██║╚██╗██║",
  "  ███████╗██║███████║   ██║   ███████╗██║ ╚████║",
  "  ╚══════╝╚═╝╚══════╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝",
];

import os from "node:os";

function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

export function printBanner({ port, provider, model, telegram, scheme = "http" }) {
  const line = c.gray("  " + "─".repeat(48));
  const ip = lanIP();
  console.log("");
  for (const row of ART) console.log(c.cyan(row));
  console.log(c.dim("  mic → english speech → transcribe → telegram"));
  console.log(line);
  console.log(`  ${c.bold("Local")}     ${c.green(`${scheme}://localhost:${port}`)}`);
  if (ip) {
    const phone = scheme === "https" ? c.green : c.yellow;
    console.log(`  ${c.bold("Phone")}     ${phone(`${scheme}://${ip}:${port}`)}`);
  }
  console.log(`  ${c.bold("Secure")}    ${scheme === "https" ? c.green("yes (mic works on phones)") : c.red("no  (mic blocked on phones)")}`);
  console.log(`  ${c.bold("Model")}     ${c.magenta(`${provider} (${model})`)}`);
  console.log(
    `  ${c.bold("Telegram")}  ${
      telegram ? c.green("configured") : c.red("NOT configured — edit .env")
    }`
  );
  console.log(line);
  console.log(c.dim("  Open the URL, click Start listening, allow mic access."));
  console.log("");
}
