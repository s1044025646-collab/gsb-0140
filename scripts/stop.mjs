// Stop the project API server recorded in server.pid. Only targets that pid.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pidFile = resolve(root, "server.pid");
const portFile = resolve(root, "server.port");

if (!existsSync(pidFile)) {
  console.log("No server.pid found; nothing to stop.");
  process.exit(0);
}
const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
try {
  process.kill(pid);
  console.log(`Stopped server pid ${pid}`);
} catch {
  console.log(`Process ${pid} was not running; removing stale pid file.`);
} finally {
  rmSync(pidFile, { force: true });
  rmSync(portFile, { force: true });
}
