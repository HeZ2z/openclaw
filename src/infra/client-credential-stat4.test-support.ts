import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** True when the test runtime can create a genuine sqlite_stat4 table itself. */
export const stat4CompiledIn = (() => {
  using database = new DatabaseSync(":memory:");
  const row = database
    .prepare("SELECT sqlite_compileoption_used('ENABLE_STAT4') AS enabled")
    .get() as { enabled: number } | undefined;
  return row?.enabled === 1;
})();

/**
 * SQLite stores the declared scope of every statistic table in its catalog. A
 * genuine empty sqlite_stat4 needs a STAT4-enabled producer, so rewrite a
 * same-shape placeholder in place to reproduce the runtime refusal on Node
 * builds without ENABLE_STAT4.
 */
export function installLegacyStat4(pathname: string): void {
  const placeholder = "legacy_stat4";
  {
    using database = new DatabaseSync(pathname);
    database.exec(`
      CREATE TABLE ${placeholder} (tbl TEXT, idx TEXT, ncol INTEGER, ndlt INTEGER, nlt INTEGER, dlt BLOB, sample BLOB);
      ANALYZE;
      PRAGMA journal_mode=DELETE;
    `);
  }
  const bytes = fs.readFileSync(pathname);
  const declared = Buffer.from(placeholder, "utf8");
  const replacement = Buffer.from("sqlite_stat4", "utf8");
  let replaced = 0;
  for (let index = 0; index + declared.length <= bytes.length;) {
    if (bytes.subarray(index, index + declared.length).equals(declared)) {
      replacement.copy(bytes, index);
      replaced += 1;
      index += declared.length;
    } else {
      index += 1;
    }
  }
  if (replaced === 0) {
    throw new Error("Legacy STAT4 fixture lost its sqlite_schema placeholder.");
  }
  // Bump the schema cookie so a fresh connection reloads the rewritten catalog.
  bytes.writeUInt32BE((bytes.readUInt32BE(40) + 1) >>> 0, 40);
  fs.writeFileSync(pathname, bytes);
  using check = new DatabaseSync(pathname, { readOnly: true });
  if (check.prepare("SELECT count(*) AS rows FROM sqlite_stat4").get()?.rows !== 0) {
    throw new Error("Legacy STAT4 fixture did not expose an empty sqlite_stat4.");
  }
}
