// Generates a self-signed cert into certs/ so the server can run over HTTPS.
// Works cross-platform without openssl. Mobile browsers need HTTPS for mic access.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "certs");
fs.mkdirSync(dir, { recursive: true });

// Collect every non-internal IPv4 so the cert is valid for LAN access too.
const ips = [];
const nets = os.networkInterfaces();
for (const name of Object.keys(nets)) {
  for (const net of nets[name] || []) {
    if (net.family === "IPv4" && !net.internal) ips.push(net.address);
  }
}

const altNames = [
  { type: 2, value: "localhost" }, // DNS
  { type: 7, ip: "127.0.0.1" }, // IP
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = selfsigned.generate([{ name: "commonName", value: "listen-local" }], {
  days: 365,
  keySize: 2048,
  algorithm: "sha256",
  extensions: [{ name: "subjectAltName", altNames }],
});

fs.writeFileSync(path.join(dir, "key.pem"), pems.private);
fs.writeFileSync(path.join(dir, "cert.pem"), pems.cert);

console.log("Self-signed cert written to certs/");
if (ips.length) console.log("Valid for: localhost, 127.0.0.1, " + ips.join(", "));
console.log("Restart the server (npm start) to serve over HTTPS.");
