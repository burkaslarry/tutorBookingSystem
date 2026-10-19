import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PG_ID = "dpg-d6iok5q4d50c738643c0-a";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sql = readFileSync(join(root, "sql/johnny_ai_tutor.sql"), "utf8");
execFileSync("render", ["psql", PG_ID, "--confirm", "--output", "text", "--command", sql], {
  stdio: "inherit",
});

const listed = execFileSync("render", [
  "psql", PG_ID, "--confirm", "--output", "text", "--command",
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'johnny_ai_tutor_%' ORDER BY table_name;",
], { encoding: "utf8" });
process.stdout.write(listed);
