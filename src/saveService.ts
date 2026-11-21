/**
 * Online save backups ("Sauvegarde en ligne") - MineCards backend.
 *
 * A player uploads the exact `.save` file the game exports (a Base64 text of a
 * deflate stream, see `js/classes/SaveFile.js`), so another device can download
 * it and load the game where the first one left off. The last 5 uploads of an
 * account are kept.
 *
 * AUTHENTICATION
 *   `uuid` + `auth_code`, exactly like `POST /cards` and the trade routes. The
 *   pair is checked BEFORE anything is written, without exception:
 *     - a known account must present the code stored in `users`;
 *     - an unknown account creates its `users` row with the code of this first
 *       upload (this is how an account that never published its trainer card
 *       gets its code).
 *   Reads are private too: the download and the "when was the last one" query
 *   both require the code, so an UUID alone never exposes somebody's save.
 *
 * WHAT IS STORED
 *   The file text, untouched, plus its length and the server timestamp. Nothing
 *   of it is parsed or trusted: validation is the job of the game, which runs
 *   `SaveFile.validateSavePayload()` before writing anything in IndexedDB.
 *
 * Reference: `sql/schema/04-save.sql` and `doc/saves.md`.
 */

/** Uploads kept per account: the older ones are deleted after each insert. */
export const SAVES_KEPT_PER_ACCOUNT = 5;

/**
 * Maximum length of the save text, in characters, and therefore in bytes: a `.save` is Base64, so
 * pure ASCII (`SaveFile.createSaveFile()` ships exactly this text).
 *
 * Both halves MUST agree: `SAVE_SYNC_MAX_BYTES` in the game's `SaveSyncManager.js` holds the same
 * value. D1 documents a 2,000,000-byte limit per ROW, and the row also stores `uuid`, `byte_size`
 * and `created_at`: a live test proved a 2 MiB value is stored today, but half of the documented
 * ceiling keeps every row inside it. A real save is a few dozen KiB.
 */
export const MAX_SAVE_BYTES = 1000000;

/** Shape of the `auth_code` generated and checked by the game. */
const AUTH_CODE_PATTERN = /^[A-Z0-9]{16}$/;

/** Shape of a v4 UUID. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One stored save row. */
interface SaveRow {
  id: number;
  save_blob: string;
  created_at: string;
}

/** A `users` row reduced to what authentication needs. */
interface AuthRow {
  auth_code: string;
}

/** Result of one save route, wrapped into a JSON response by `index.ts`. */
export interface SaveRouteResult {
  status: number;
  body: unknown;
}

/**
 * Reads a body field as a trimmed string.
 *
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} field - Field name.
 * @returns {string} The value, or an empty string.
 */
function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Checks that an authentication pair is well formed before touching the database.
 *
 * @param {string} uuid - Player UUID.
 * @param {string} authCode - Secret code.
 * @returns {boolean} True when both strings have the expected shape.
 */
function isWellFormedAuth(uuid: string, authCode: string): boolean {
  return UUID_PATTERN.test(uuid) && AUTH_CODE_PATTERN.test(authCode);
}

/**
 * Reads the secret code stored for one account.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @returns {Promise<string|null>} The code, or null when the account has no row yet.
 */
async function readStoredAuthCode(db: D1Database, uuid: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT auth_code FROM users WHERE uuid = ?")
    .bind(uuid)
    .first<AuthRow>();
  return row?.auth_code ?? null;
}

/**
 * Authenticates an upload, creating the `users` row of a brand new account.
 *
 * The insert is the ONLY write that happens before the code was proven valid: an
 * account that does not exist yet has no code to compare with, so the code of the
 * first upload becomes its own (that is how the game gets a code without
 * publishing a trainer card). A concurrent insert is re-read and compared, so two
 * devices racing on the same fresh UUID cannot both impose a code.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @param {string} authCode - Secret code presented by the client.
 * @returns {Promise<boolean>} True when the write is allowed.
 */
async function authenticateForWrite(
  db: D1Database,
  uuid: string,
  authCode: string
): Promise<boolean> {
  const stored = await readStoredAuthCode(db, uuid);
  if (stored !== null) return stored === authCode;

  try {
    await db
      .prepare("INSERT INTO users (uuid, auth_code) VALUES (?, ?)")
      .bind(uuid, authCode)
      .run();
    return true;
  } catch (error) {
    // Another request created the row between the read and the insert.
    console.warn("Save upload: the account row already existed.", error);
    return (await readStoredAuthCode(db, uuid)) === authCode;
  }
}

/**
 * Authenticates a read against the stored code.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @param {string} authCode - Secret code presented by the client.
 * @returns {Promise<boolean>} True when the pair matches.
 */
async function authenticateForRead(
  db: D1Database,
  uuid: string,
  authCode: string
): Promise<boolean> {
  return (await readStoredAuthCode(db, uuid)) === authCode;
}

/**
 * Deletes the uploads of one account beyond the newest `SAVES_KEPT_PER_ACCOUNT`.
 *
 * The sub-select is ordered by `id`, not by `created_at`: two uploads made in the
 * same second must still have a stable order.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @returns {Promise<void>} Resolves once the trim is done.
 */
async function trimSaves(db: D1Database, uuid: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM saves
       WHERE uuid = ?
         AND id NOT IN (
           SELECT id FROM saves WHERE uuid = ? ORDER BY id DESC LIMIT ${SAVES_KEPT_PER_ACCOUNT}
         )`
    )
    .bind(uuid, uuid)
    .run();
}

/**
 * `POST /saves` - stores one uploaded save.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @returns {Promise<SaveRouteResult>} The result.
 */
async function uploadSave(
  db: D1Database,
  body: Record<string, unknown>
): Promise<SaveRouteResult> {
  const uuid = readString(body, "uuid").toLowerCase();
  const authCode = readString(body, "auth_code").toUpperCase();
  const save = typeof body.save === "string" ? body.save.trim() : "";

  if (!isWellFormedAuth(uuid, authCode)) {
    return { status: 400, body: { error: "Le champ 'uuid' ou 'auth_code' est invalide." } };
  }
  if (save === "") {
    return { status: 400, body: { error: "Le champ 'save' est requis." } };
  }
  if (save.length > MAX_SAVE_BYTES) {
    return {
      status: 413,
      body: {
        error: `La sauvegarde dépasse la limite de 1 Mo (${MAX_SAVE_BYTES} caractères).`,
      },
    };
  }

  if (!(await authenticateForWrite(db, uuid, authCode))) {
    return { status: 403, body: { error: "Code d'authentification invalide pour cet UUID." } };
  }

  await db
    .prepare("INSERT INTO saves (uuid, save_blob, byte_size) VALUES (?, ?, ?)")
    .bind(uuid, save, save.length)
    .run();
  await trimSaves(db, uuid);

  const row = await db
    .prepare("SELECT created_at FROM saves WHERE uuid = ? ORDER BY id DESC LIMIT 1")
    .bind(uuid)
    .first<{ created_at: string }>();

  return {
    status: 201,
    body: {
      saved_at: row?.created_at ?? null,
      kept: SAVES_KEPT_PER_ACCOUNT,
    },
  };
}

/**
 * `GET /saves/last` - date of the newest save of one account, without its content.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<SaveRouteResult>} The result.
 */
async function getLastSaveDate(request: Request, db: D1Database): Promise<SaveRouteResult> {
  const url = new URL(request.url);
  const uuid = (url.searchParams.get("uuid") ?? "").trim().toLowerCase();
  const authCode = (url.searchParams.get("auth_code") ?? "").trim().toUpperCase();

  if (!isWellFormedAuth(uuid, authCode)) {
    return { status: 400, body: { error: "Le champ 'uuid' ou 'auth_code' est invalide." } };
  }
  if (!(await authenticateForRead(db, uuid, authCode))) {
    return { status: 403, body: { error: "Code d'authentification invalide pour cet UUID." } };
  }

  const row = await db
    .prepare("SELECT created_at FROM saves WHERE uuid = ? ORDER BY id DESC LIMIT 1")
    .bind(uuid)
    .first<{ created_at: string }>();

  return {
    status: 200,
    body: { exists: Boolean(row), saved_at: row?.created_at ?? null },
  };
}

/**
 * `GET /saves/last/file` - the newest save of one account, with its content.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<SaveRouteResult>} The result.
 */
async function getLastSaveFile(request: Request, db: D1Database): Promise<SaveRouteResult> {
  const url = new URL(request.url);
  const uuid = (url.searchParams.get("uuid") ?? "").trim().toLowerCase();
  const authCode = (url.searchParams.get("auth_code") ?? "").trim().toUpperCase();

  if (!isWellFormedAuth(uuid, authCode)) {
    return { status: 400, body: { error: "Le champ 'uuid' ou 'auth_code' est invalide." } };
  }
  if (!(await authenticateForRead(db, uuid, authCode))) {
    return { status: 403, body: { error: "Code d'authentification invalide pour cet UUID." } };
  }

  const row = await db
    .prepare(
      "SELECT id, save_blob, created_at FROM saves WHERE uuid = ? ORDER BY id DESC LIMIT 1"
    )
    .bind(uuid)
    .first<SaveRow>();

  return {
    status: 200,
    body: {
      exists: Boolean(row),
      saved_at: row?.created_at ?? null,
      save: row?.save_blob ?? null,
    },
  };
}

/**
 * Answers the save routes.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @param {string} path - Normalized pathname (no trailing slash).
 * @returns {Promise<SaveRouteResult|null>} The result, or null when the path is not a save route.
 */
export async function handleSaveRequest(
  request: Request,
  db: D1Database,
  path: string
): Promise<SaveRouteResult | null> {
  if (!path.startsWith("/saves")) return null;

  if (request.method === "GET") {
    if (path === "/saves/last") return getLastSaveDate(request, db);
    if (path === "/saves/last/file") return getLastSaveFile(request, db);
    return { status: 404, body: { error: "Route introuvable." } };
  }

  if (request.method !== "POST") {
    return { status: 405, body: { error: "Méthode non autorisée." } };
  }
  if (path !== "/saves") {
    return { status: 404, body: { error: "Route introuvable." } };
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json<unknown>();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { status: 400, body: { error: "JSON invalide." } };
  }
  return uploadSave(db, body);
}
