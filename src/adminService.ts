/**
 * Administration routes - full database backup and restore.
 *
 * `GET /admin/backup` sends the whole D1 database as ONE gzipped JSON file, and
 * `POST /admin/restore` reads that exact file back and rewrites the database
 * from zero. Both require the `adminkey` variable in the `x-admin-key` header:
 * a header, not a query string, so the key never lands in a server log or in a
 * browser history.
 *
 * WHY NOT A `.sqlite` FILE
 *   A Worker isolate has no SQLite engine: it cannot build the database file
 *   format, it can only run SQL against D1. Producing a real `.sqlite` needs
 *   the local CLI (`npx wrangler d1 export` then `sqlite3`), see
 *   `doc/admin-backup.md`. This route therefore ships the same data as a dump:
 *   one entry per table with its column list and its rows, gzipped, which is
 *   small (the `saves` table is already Base64 text) and restores from anywhere.
 *
 * SHAPE
 *   { format, version, exported_at, tables: [{ name, columns, rows }] }
 *   `rows` are arrays, in the `columns` order, not objects: a dump of a few
 *   thousand saves stays compact and its rows stay short.
 *
 * RESTORE GUARANTEES
 *   Everything is validated BEFORE the first write: unknown marker or version,
 *   unknown table, unknown column, row of the wrong width or a non scalar value
 *   all answer 400 without touching the database. The tables are then emptied
 *   in one atomic batch (children first), and the rows are inserted in batches
 *   of `INSERT_ROWS_PER_BATCH` (each atomic, `users` before its children).
 *
 *   A restore cannot be one transaction across batches, so the answer carries
 *   `safety_backup`: the state of the database JUST BEFORE the rewrite, gzipped
 *   and Base64-encoded, to POST back if a restore is interrupted. It is omitted
 *   (`null`) above `MAX_SAFETY_BACKUP_BYTES`, where the operator should take a
 *   `GET /admin/backup` first.
 *
 * Reference: `doc/admin-backup.md`.
 */

/** Marker written in every dump, so a restore refuses a file it did not produce. */
export const BACKUP_FORMAT = "minecards-backup";

/** Bumped on any incompatible change of the dump shape. */
export const BACKUP_VERSION = 1;

/**
 * Tables of the schema, in the order a restore inserts them: `likes`, `cards`, `saves`, `favorite`
 * and `like_daily_target` point at `users` through a foreign key, so the parent goes first.
 *
 * `favorite` carries the pinned cards and trophies of every trainer card: leaving it out of a
 * restore would keep rows of the previous database that no longer have an account. `likes` holds
 * the counters and the Spark bonus, `like_daily_target` the likes already given today: leaving
 * them out would reset what a restore is supposed to bring back.
 */
const BACKUP_TABLES = [
  "users",
  "likes",
  "cards",
  "trades",
  "saves",
  "favorite",
  "like_daily_target",
] as const;

/**
 * Tables a dump may omit without being refused.
 *
 * `favorite`, `likes` and `like_daily_target` arrived after the first backups were in circulation:
 * a dump written before them simply has nothing to restore for those tables, and refusing it would
 * lose the data the operator still wants back. Such a dump empties them, like any restore.
 */
const OPTIONAL_BACKUP_TABLES: ReadonlySet<string> = new Set([
  "favorite",
  "likes",
  "like_daily_target",
]);

/** Order that empties the database: children first, parents last. */
const CLEAR_TABLES: readonly string[] = [...BACKUP_TABLES].reverse();

/** Largest upload accepted, in bytes (gzipped or not). */
const MAX_RESTORE_BYTES = 10 * 1024 * 1024;

/** Largest dump accepted once decompressed, in characters. */
const MAX_RESTORE_TEXT = 50 * 1024 * 1024;

/** Largest number of rows one restore may insert, all tables together. */
const MAX_RESTORE_ROWS = 200000;

/** Rows per batch: keeps one D1 request small while staying atomic per chunk. */
const INSERT_ROWS_PER_BATCH = 40;

/** Largest pre-restore snapshot echoed in the answer, in gzipped bytes. */
const MAX_SAFETY_BACKUP_BYTES = 4 * 1024 * 1024;

/** A cell of the dump: what a restored row binds. */
type BackupValue = string | number | null;

/** One table of the dump. */
interface BackupTable {
  name: string;
  columns: string[];
  rows: BackupValue[][];
}

/** The dump itself. */
interface BackupFile {
  format: string;
  version: number;
  exported_at: string;
  tables: BackupTable[];
}

/** Options of one admin route. */
export interface AdminContext {
  db: D1Database;
  /** Value of the `adminkey` variable; undefined when it was never configured. */
  adminKey: string | undefined;
}

/** Result of the validation of an uploaded dump. */
type ValidationResult = { ok: true; file: BackupFile } | { ok: false; error: string };

/** Web APIs the hand-written typings do not declare. */
interface CompressionRuntime {
  CompressionStream: new (format: string) => unknown;
  DecompressionStream: new (format: string) => unknown;
}

/** The only member of a byte stream this service uses. */
interface StreamBody {
  pipeThrough(transform: unknown): unknown;
}

function jsonResponse(data: unknown, status: number): Response {
  // No CORS header: the administration API is called from the command line (see
  // `doc/admin-backup.md`), never by a page. A `*` would let any web page read a backup that
  // contains the auth code of every account, as soon as the key leaks.
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Answers 401/403/503 when the request does not carry the administration key.
 *
 * @param {Request} request - Incoming request.
 * @param {string|undefined} adminKey - Configured key.
 * @returns {Response|null} The refusal, or null when the caller may continue.
 */
function checkAdminKey(request: Request, adminKey: string | undefined): Response | null {
  if (typeof adminKey !== "string" || adminKey === "") {
    return jsonResponse(
      { error: "L'API d'administration n'est pas configurée (variable 'adminkey' absente)." },
      503
    );
  }
  const presented = request.headers.get("x-admin-key") ?? "";
  if (presented === "") {
    return jsonResponse({ error: "En-tête 'x-admin-key' manquant." }, 401);
  }
  // A tiny constant-time compare is not worth it here: the key never protects money,
  // and a wrong key costs one request anyway.
  if (presented !== adminKey) {
    return jsonResponse({ error: "Clé d'administration invalide." }, 403);
  }
  return null;
}

/**
 * Gzips a text.
 *
 * @param {string} text - Text to compress.
 * @returns {Promise<ArrayBuffer>} The gzipped bytes.
 */
function gzip(text: string): Promise<ArrayBuffer> {
  const runtime = globalThis as unknown as CompressionRuntime;
  const body = new Response(text).body as StreamBody;
  const compressed = body.pipeThrough(new runtime.CompressionStream("gzip")) as BodyInit;
  return new Response(compressed).arrayBuffer();
}

/**
 * Guns a gzip stream.
 *
 * @param {ArrayBuffer} bytes - Gzipped bytes.
 * @returns {Promise<ArrayBuffer>} The decompressed bytes.
 */
function gunzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const runtime = globalThis as unknown as CompressionRuntime;
  const body = new Response(bytes).body as StreamBody;
  const decompressed = body.pipeThrough(new runtime.DecompressionStream("gzip")) as BodyInit;
  return new Response(decompressed).arrayBuffer();
}

/**
 * Reads the live column list of one table.
 *
 * The dump is built AND restored from this list, so a column added by a later
 * schema script travels without touching this file.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} table - Table name.
 * @returns {Promise<string[]>} The columns, in their declaration order.
 */
async function readColumns(db: D1Database, table: string): Promise<string[]> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (result.results ?? []).map((column) => column.name);
}

/**
 * Reads the whole database into a dump.
 *
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<BackupFile|null>} The dump, or null when a table of the schema is missing.
 */
async function buildBackupFile(db: D1Database): Promise<BackupFile | null> {
  const tables: BackupTable[] = [];

  for (const name of BACKUP_TABLES) {
    const columns = await readColumns(db, name);
    if (columns.length === 0) return null;
    const result = await db.prepare(`SELECT * FROM ${name}`).all<Record<string, BackupValue>>();
    const rows = (result.results ?? []).map((row) => columns.map((column) => row[column] ?? null));
    tables.push({ name, columns, rows });
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    tables,
  };
}

/**
 * `GET /admin/backup` - the whole database as one gzipped JSON file.
 *
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<Response>} The download.
 */
async function exportBackup(db: D1Database): Promise<Response> {
  const file = await buildBackupFile(db);
  if (!file) {
    return jsonResponse({ error: "Une table du schéma est introuvable dans la base." }, 500);
  }

  const archive = await gzip(JSON.stringify(file));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  return new Response(archive, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="minecard-backup-${stamp}.json.gz"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Encodes bytes as Base64, in chunks so a large dump does not overflow the call stack.
 *
 * @param {ArrayBuffer} bytes - Raw bytes.
 * @returns {string} The Base64 text.
 */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const chunk = 4096;
  let binary = "";
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Reads a dump cell.
 *
 * @param {unknown} value - Raw JSON value.
 * @returns {BackupValue} The value, or undefined when it is not a scalar.
 */
function readValue(value: unknown): BackupValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

/**
 * Validates an uploaded dump against the live schema, before any write.
 *
 * @param {D1Database} db - D1 binding.
 * @param {unknown} parsed - Decoded JSON.
 * @returns {Promise<ValidationResult>} The dump, or the reason it is refused.
 */
async function validateBackup(db: D1Database, parsed: unknown): Promise<ValidationResult> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Le fichier n'est pas un objet JSON." };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.format !== BACKUP_FORMAT) {
    return { ok: false, error: `Ce fichier n'est pas une sauvegarde MineCards ('format').` };
  }
  if (raw.version !== BACKUP_VERSION) {
    return {
      ok: false,
      error: `Version de sauvegarde non prise en charge (${String(raw.version)} au lieu de ${BACKUP_VERSION}).`,
    };
  }
  if (!Array.isArray(raw.tables)) {
    return { ok: false, error: "Le champ 'tables' est requis." };
  }

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: typeof raw.exported_at === "string" ? raw.exported_at : "",
    tables: [],
  };
  let totalRows = 0;

  for (const expected of BACKUP_TABLES) {
    const entry = (raw.tables as unknown[]).find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        (candidate as { name?: unknown }).name === expected
    ) as Record<string, unknown> | undefined;

    const liveColumns = await readColumns(db, expected);
    if (liveColumns.length === 0) {
      // The schema is older than the dump: say it here, before the empty batch fails on a table
      // that does not exist yet.
      return { ok: false, error: `La table '${expected}' est introuvable dans la base.` };
    }

    if (!entry) {
      if (OPTIONAL_BACKUP_TABLES.has(expected)) {
        // Old dump: the table was not exported yet, so a restore empties it and inserts nothing.
        file.tables.push({ name: expected, columns: liveColumns, rows: [] });
        continue;
      }
      return { ok: false, error: `La table '${expected}' manque dans la sauvegarde.` };
    }

    const columns = Array.isArray(entry.columns) ? entry.columns : null;
    if (!columns || columns.length === 0) {
      return { ok: false, error: `La table '${expected}' n'a aucune colonne.` };
    }
    if (!columns.every((column): column is string => typeof column === "string")) {
      return { ok: false, error: `Les colonnes de '${expected}' doivent être des chaînes.` };
    }
    if (new Set(columns).size !== columns.length) {
      return { ok: false, error: `La table '${expected}' répète une colonne.` };
    }
    for (const column of columns) {
      // The column list is interpolated in the INSERT below: it must exist, exactly.
      if (!liveColumns.includes(column)) {
        return { ok: false, error: `La colonne '${column}' n'existe pas dans '${expected}'.` };
      }
    }

    if (!Array.isArray(entry.rows)) {
      return { ok: false, error: `Les lignes de '${expected}' sont requises.` };
    }
    const rows: BackupValue[][] = [];
    for (const [index, rawRow] of (entry.rows as unknown[]).entries()) {
      if (!Array.isArray(rawRow) || rawRow.length !== columns.length) {
        return {
          ok: false,
          error: `La ligne ${index + 1} de '${expected}' n'a pas ${columns.length} valeurs.`,
        };
      }
      const row: BackupValue[] = [];
      for (const value of rawRow) {
        const cell = readValue(value);
        if (cell === undefined) {
          return {
            ok: false,
            error: `La ligne ${index + 1} de '${expected}' contient une valeur non scalaire.`,
          };
        }
        row.push(cell);
      }
      rows.push(row);
    }

    totalRows += rows.length;
    if (totalRows > MAX_RESTORE_ROWS) {
      return { ok: false, error: `La sauvegarde dépasse ${MAX_RESTORE_ROWS} lignes.` };
    }
    file.tables.push({ name: expected, columns, rows });
  }

  return { ok: true, file };
}

/**
 * Emptyies every table, then inserts the dump. See "RESTORE GUARANTEES" above.
 *
 * @param {D1Database} db - D1 binding.
 * @param {BackupFile} file - Validated dump.
 * @returns {Promise<Record<string, number>>} Inserted rows, per table.
 */
async function writeBackup(db: D1Database, file: BackupFile): Promise<Record<string, number>> {
  await db.batch(CLEAR_TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));

  const counts: Record<string, number> = {};

  for (const table of file.tables) {
    const placeholders = table.columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders})`;
    let pending: D1PreparedStatement[] = [];

    for (const row of table.rows) {
      pending.push(db.prepare(sql).bind(...row));
      if (pending.length >= INSERT_ROWS_PER_BATCH) {
        await db.batch(pending);
        pending = [];
      }
    }
    if (pending.length > 0) {
      await db.batch(pending);
    }
    counts[table.name] = table.rows.length;
  }

  return counts;
}

/**
 * Decodes the uploaded file: gzip (the format the export produces) or plain JSON.
 *
 * @param {ArrayBuffer} bytes - Request body.
 * @returns {Promise<string|null>} The JSON text, or null when it cannot be decoded.
 */
async function decodeUpload(bytes: ArrayBuffer): Promise<string | null> {
  const view = new Uint8Array(bytes);
  const compressed = view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b;
  try {
    const raw = compressed ? await gunzip(bytes) : bytes;
    const text = new TextDecoder("utf-8").decode(raw);
    return text.length > MAX_RESTORE_TEXT ? null : text;
  } catch {
    return null;
  }
}

/**
 * `POST /admin/restore` - rewrites the whole database from an exported file.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<Response>} The counts of the restored rows.
 */
async function restoreBackup(request: Request, db: D1Database): Promise<Response> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return jsonResponse({ error: "Le corps de la requête est vide." }, 400);
  }
  if (bytes.byteLength > MAX_RESTORE_BYTES) {
    return jsonResponse(
      { error: `Le fichier dépasse ${Math.round(MAX_RESTORE_BYTES / (1024 * 1024))} Mo.` },
      413
    );
  }

  const text = await decodeUpload(bytes);
  if (text === null) {
    return jsonResponse(
      { error: "Fichier illisible : gzip ou JSON attendu, et moins de 50 Mo décompressé." },
      400
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "JSON invalide." }, 400);
  }

  const validation = await validateBackup(db, parsed);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, 400);
  }

  // Snapshot BEFORE the first DELETE: an interrupted restore can be undone by sending this back.
  const snapshot = await buildBackupFile(db);
  let safetyBackup: string | null = null;
  let safetyBytes = 0;
  if (snapshot) {
    const archive = await gzip(JSON.stringify(snapshot));
    safetyBytes = archive.byteLength;
    if (safetyBytes <= MAX_SAFETY_BACKUP_BYTES) safetyBackup = toBase64(archive);
  }

  const startedAt = Date.now();
  const counts = await writeBackup(db, validation.file);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  console.log(`Admin restore: ${total} rows written in ${Date.now() - startedAt} ms.`);

  return jsonResponse(
    {
      restored: true,
      exported_at: validation.file.exported_at,
      tables: counts,
      rows: total,
      duration_ms: Date.now() - startedAt,
      // Gzipped Base64 of the database as it was before the rewrite; null when too large.
      safety_backup: safetyBackup,
      safety_backup_bytes: safetyBytes,
    },
    200
  );
}

/**
 * Answers the administration routes.
 *
 * @param {Request} request - Incoming request.
 * @param {AdminContext} context - D1 binding and configured key.
 * @param {string} path - Normalized pathname (no trailing slash).
 * @returns {Promise<Response|null>} The response, or null when the path is not an admin route.
 */
export async function handleAdminRequest(
  request: Request,
  context: AdminContext,
  path: string
): Promise<Response | null> {
  if (!path.startsWith("/admin")) return null;

  const refusal = checkAdminKey(request, context.adminKey);
  if (refusal) return refusal;

  if (path === "/admin/backup") {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Méthode non autorisée." }, 405);
    }
    return exportBackup(context.db);
  }

  if (path === "/admin/restore") {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Méthode non autorisée." }, 405);
    }
    return restoreBackup(request, context.db);
  }

  return jsonResponse({ error: "Route introuvable." }, 404);
}
