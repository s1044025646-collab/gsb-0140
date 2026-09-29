// Standalone migration runner. Safe to run repeatedly (idempotent).
import { resolve } from "node:path";
import { initDatabase } from "../src/db/database.js";

const dbPath = process.env.PROTEOMICS_DB ?? resolve("data/proteomics.db");
const db = initDatabase(dbPath);
const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
  v: number;
};
console.log(`Migrations up to date at ${dbPath} (schema version ${version.v})`);
db.close();
