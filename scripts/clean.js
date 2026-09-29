// Remove only project-local generated data/temp artifacts and the built dist.
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const targets = [
  "data/proteomics.db",
  "data/proteomics.db-wal",
  "data/proteomics.db-shm",
  "data/built-server.db",
  "data/built-server.db-wal",
  "data/built-server.db-shm",
  "data/built-check.db",
  "data/built-check.db-wal",
  "data/built-check.db-shm",
  "temp/demo.db",
  "temp/demo.db-wal",
  "temp/demo.db-shm",
  "server.pid",
  "server.port",
  "dist",
];
for (const t of targets) {
  const p = resolve(root, t);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`removed ${t}`);
  }
}
console.log("clean complete");
