/**
 * Likes service ("Cœurs") - MineCards backend.
 *
 * A player likes ONE followed friend per UTC day. The like is worth two things
 * for the player who receives it:
 *   - `likes.like_count` grows by 1: the public count shown in the Follow List
 *     and in the game header;
 *   - `likes.bonus_from_like` grows by 0.1: a reserve that pays 1 Spark per
 *     whole unit.
 *
 * THE BONUS IS CONSUMED BY WHOLE UNITS
 *   `GET /likes?uuid=...&auth_code=...` is the ONLY read that needs the secret
 *   code, because it is the only one that spends the bonus: it takes the
 *   integer part of `bonus_from_like` (4.8 -> 0.8) and returns it as Sparks to
 *   credit. The balance itself stays local, like every other currency of the
 *   game (`SparksManager`), so the worker only hands out the amount.
 *   The subtraction is guarded by `CAST(bonus_from_like AS INTEGER) = earned`,
 *   which makes two concurrent reads credit the same units at most once.
 *
 * THE PUBLIC READ
 *   `GET /likes?uuid=...` returns the like count alone, without any code: a
 *   Follow List shows the hearts of its friends without ever touching their
 *   bonus. `GET /likes?uuids=a,b,c` answers the whole list in one request.
 *
 * ONE LIKE PER LIKER PER DAY
 *   Enforced by `like_daily` (primary key `liker_uuid, day`) and by the UTC day
 *   of the SERVER clock, never by the device one.
 *
 * Reference: `sql/schema/05-likes.sql` and `doc/likes.md`.
 */

/** Maximum number of UUIDs a batch read answers. Mirrors the card batch read. */
const MAX_LIKE_BATCH = 100;

/** Bonus added to the liked player by one like. */
const LIKE_BONUS = 0.1;

/** UUID shape accepted by every other route of the worker. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface LikeRow {
  uuid: string;
  like_count: number;
  bonus_from_like: number;
}

interface LikeCountRow {
  uuid: string;
  like_count: number;
}

interface AuthRow {
  auth_code: string;
}

/** Result of one like route, wrapped into a JSON response by `index.ts`. */
export interface LikeRouteResult {
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
 * Rounds a bonus to one decimal.
 *
 * 0.1 additions in floating point drift (4.800000000000001), and that drift
 * would show in the game: every value leaving this file is rounded.
 *
 * @param {unknown} value - Raw bonus.
 * @returns {number} The bonus with one decimal.
 */
function roundBonus(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 10) / 10;
}

/**
 * Checks the `uuid` + `auth_code` pair against the `users` row.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @param {string} authCode - Secret code.
 * @returns {Promise<boolean>} True when the pair is valid.
 */
async function authenticate(db: D1Database, uuid: string, authCode: string): Promise<boolean> {
  if (uuid === "" || authCode === "") return false;
  const row = await db
    .prepare("SELECT auth_code FROM users WHERE uuid = ?")
    .bind(uuid)
    .first<AuthRow>();
  return Boolean(row && row.auth_code === authCode);
}

/**
 * Tells whether the player already used the like of the current UTC day.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Liker UUID.
 * @returns {Promise<boolean>} True when a like was already given today.
 */
async function hasLikedToday(db: D1Database, uuid: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT liker_uuid FROM like_daily WHERE liker_uuid = ? AND day = date('now')")
    .bind(uuid)
    .first<{ liker_uuid: string }>();
  return Boolean(row);
}

/**
 * Reads one player's likes, creating no row: an unknown account simply has 0.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @returns {Promise<LikeRow|null>} The row, or null when the player was never liked.
 */
async function readLikeRow(db: D1Database, uuid: string): Promise<LikeRow | null> {
  return db
    .prepare("SELECT uuid, like_count, bonus_from_like FROM likes WHERE uuid = ?")
    .bind(uuid)
    .first<LikeRow>();
}

/**
 * Consumes the whole units of a bonus and returns how many Sparks they are worth.
 *
 * The integer part is read from the row the caller just fetched, then the
 * subtraction is guarded by that exact integer part: if another read already
 * claimed it, the update changes no row and this one credits nothing. A like
 * that arrived in between only raises the decimal part, so the guard still
 * matches and the claimed amount stays the one that was read.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @param {unknown} bonus - Bonus seen by the caller.
 * @returns {Promise<number>} Whole Sparks to credit, 0 when there is nothing left.
 */
async function claimBonus(db: D1Database, uuid: string, bonus: unknown): Promise<number> {
  const earned = Math.floor(roundBonus(bonus));
  if (earned <= 0) return 0;

  const claimed = await db
    .prepare(
      `UPDATE likes
       SET bonus_from_like = MAX(0, bonus_from_like - ?), updated_at = datetime('now')
       WHERE uuid = ? AND CAST(ROUND(bonus_from_like, 1) AS INTEGER) = ?`
    )
    .bind(earned, uuid, earned)
    .run();
  return (claimed.meta?.changes ?? 0) > 0 ? earned : 0;
}

/**
 * `GET /likes` - the like count of one player, or of a whole list.
 *
 * `uuids` answers a map `{ uuid: count }` (missing players read 0) and is what
 * the Follow List calls, without any secret code. `uuid` answers one player;
 * adding `auth_code` authenticates the request and CLAIMS the bonus, returning
 * the Sparks the game must credit.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<LikeRouteResult>} The result.
 */
async function readLikes(request: Request, db: D1Database): Promise<LikeRouteResult> {
  const url = new URL(request.url);

  const rawUuids = (url.searchParams.get("uuids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (rawUuids.length > 0) {
    const invalid = rawUuids.find((value) => !UUID_PATTERN.test(value));
    if (invalid) {
      return { status: 400, body: { error: "Le champ 'uuids' contient un UUID invalide." } };
    }
    const uuids = Array.from(new Set(rawUuids)).slice(0, MAX_LIKE_BATCH);
    const placeholders = uuids.map(() => "?").join(", ");
    const rows = await db
      .prepare(`SELECT uuid, like_count FROM likes WHERE uuid IN (${placeholders})`)
      .bind(...uuids)
      .all<LikeCountRow>();
    const likes: Record<string, number> = {};
    uuids.forEach((uuid) => {
      likes[uuid] = 0;
    });
    for (const row of rows.results ?? []) {
      likes[row.uuid] = Math.max(0, Math.trunc(Number(row.like_count) || 0));
    }
    return { status: 200, body: { likes } };
  }

  const uuid = (url.searchParams.get("uuid") ?? "").trim();
  if (uuid === "") {
    return { status: 400, body: { error: "Le champ 'uuid' ou 'uuids' est requis." } };
  }
  if (!UUID_PATTERN.test(uuid)) {
    return { status: 400, body: { error: "Le champ 'uuid' est invalide." } };
  }

  const row = await readLikeRow(db, uuid);
  const likes = Math.max(0, Math.trunc(Number(row?.like_count) || 0));
  const authCode = (url.searchParams.get("auth_code") ?? "").trim();

  // Without a code, the bonus is never touched: this is the public read the
  // Follow List and the profiles use.
  if (authCode === "") {
    return { status: 200, body: { uuid, likes } };
  }
  if (!(await authenticate(db, uuid, authCode))) {
    return { status: 403, body: { error: "Authentification invalide pour cet UUID." } };
  }

  const sparks = await claimBonus(db, uuid, row?.bonus_from_like);
  const fresh = await readLikeRow(db, uuid);
  return {
    status: 200,
    body: {
      uuid,
      likes: Math.max(0, Math.trunc(Number(fresh?.like_count) || likes)),
      bonus_from_like: roundBonus(fresh?.bonus_from_like),
      sparks,
      liked_today: await hasLikedToday(db, uuid),
    },
  };
}

/**
 * `POST /likes/friend` - gives the like of the day to one followed player.
 *
 * The daily row is inserted FIRST: it is the reservation of the day, and the
 * database refuses a second one. Only then do the counts grow, so a like the
 * day cannot give twice never reaches the counters.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} likerUuid - Authenticated liker.
 * @returns {Promise<LikeRouteResult>} The result.
 */
async function likeFriend(
  db: D1Database,
  body: Record<string, unknown>,
  likerUuid: string
): Promise<LikeRouteResult> {
  const targetUuid = readString(body, "target_uuid");
  if (targetUuid === "" || !UUID_PATTERN.test(targetUuid)) {
    return { status: 400, body: { error: "Le champ 'target_uuid' est invalide." } };
  }
  if (targetUuid === likerUuid) {
    return { status: 400, body: { error: "Vous ne pouvez pas vous liker vous-même." } };
  }

  const target = await db
    .prepare("SELECT uuid FROM users WHERE uuid = ?")
    .bind(targetUuid)
    .first<{ uuid: string }>();
  if (!target) {
    return { status: 404, body: { error: "Ce joueur n'a pas de compte en ligne." } };
  }

  const reserved = await db
    .prepare(
      `INSERT INTO like_daily (liker_uuid, target_uuid, day)
       VALUES (?, ?, date('now'))
       ON CONFLICT(liker_uuid, day) DO NOTHING`
    )
    .bind(likerUuid, targetUuid)
    .run();
  if ((reserved.meta?.changes ?? 0) === 0) {
    return {
      status: 409,
      body: { error: "Vous avez déjà donné votre like du jour.", liked_today: true },
    };
  }

  await db
    .prepare(
      `INSERT INTO likes (uuid, like_count, bonus_from_like)
       VALUES (?, 1, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         like_count = like_count + 1,
         bonus_from_like = bonus_from_like + ?,
         updated_at = datetime('now')`
    )
    .bind(targetUuid, LIKE_BONUS, LIKE_BONUS)
    .run();

  const row = await readLikeRow(db, targetUuid);
  return {
    status: 200,
    body: {
      target_uuid: targetUuid,
      likes: Math.max(0, Math.trunc(Number(row?.like_count) || 1)),
      bonus_from_like: roundBonus(row?.bonus_from_like),
      liked_today: true,
    },
  };
}

/**
 * Routes every `/likes` request.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @param {string} path - Normalized pathname.
 * @returns {Promise<LikeRouteResult|null>} The result, or null for any other path.
 */
export async function handleLikesRequest(
  request: Request,
  db: D1Database,
  path: string
): Promise<LikeRouteResult | null> {
  if (path !== "/likes" && !path.startsWith("/likes/")) return null;

  if (path === "/likes") {
    if (request.method !== "GET") {
      return { status: 405, body: { error: "Méthode non autorisée." } };
    }
    return readLikes(request, db);
  }

  if (path === "/likes/friend") {
    if (request.method !== "POST") {
      return { status: 405, body: { error: "Méthode non autorisée." } };
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json<unknown>();
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { status: 400, body: { error: "JSON invalide." } };
    }
    const uuid = readString(body, "uuid");
    const authCode = readString(body, "auth_code");
    if (!(await authenticate(db, uuid, authCode))) {
      return { status: 403, body: { error: "Authentification invalide pour cet UUID." } };
    }
    return likeFriend(db, body, uuid);
  }

  return { status: 404, body: { error: "Route introuvable." } };
}
