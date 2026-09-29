// Start the API server bound to 127.0.0.1 on an auto-assigned port, persist
// only project-local pid/port files. Manages only this project's process.
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pidFile = resolve(root, "server.pid");
const portFile = resolve(root, "server.port");

if (existsSync(pidFile)) {
  const oldPid = parseInt(readFileSync(pidFile, "utf8"), 10);
  try {
    process.kill(oldPid, 0);
    console.error(`Server already running with pid ${oldPid}`);
    process.exit(1);
  } catch {
    // stale pid file; fall through and restart
  }
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", resolve(root, "src/api/server.ts")],
  {
    cwd: root,
    env: { ...process.env, PROTEOMICS_DB: resolve(root, "data/proteomics.db") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  }
);

let settled = false;
const onData = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const match = text.match(/127\.0\.0\.1:(\d+)/);
  if (match && !settled) {
    settled = true;
    writeFileSync(pidFile, String(child.pid));
    writeFileSync(portFile, match[1]);
    child.unref();
    setTimeout(() => process.exit(0), 200);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", (c) => process.stderr.write(c));
child.on("exit", (code) => {
  if (!settled) process.exit(code ?? 1);
});
setTimeout(() => {
  if (!settled) {
    console.error("Timed out waiting for server to report its port");
    child.kill();
    process.exit(1);
  }
}, 10000);
