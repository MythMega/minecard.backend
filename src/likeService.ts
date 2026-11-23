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
 * ONE LIKE PER FRIEND PER DAY
 *   Enforced by `like_daily_target` (primary key `liker_uuid, target_uuid, day`)
 *   and by the UTC day of the SERVER clock, never by the device one. A player
 *   can therefore like their whole Follow List, once each: `POST /likes/batch`
 *   does it in ONE request instead of one per friend.
 *
 * Reference: `sql/schema/05-likes.sql`, `sql/schema/07-like-everyone.sql` and
 * `doc/likes.md`.
 */

/** Maximum number of UUIDs a batch read answers. Mirrors the card batch read. */
const MAX_LIKE_BATCH = 100;

/** Maximum number of friends one batch like accepts. */
const MAX_LIKE_TARGETS = 100;

/** Bonus added to the liked player by one like. */
const LIKE_BONUS = 0.1;

/** Number of entries each side of the like history answers. */
const LIKE_HISTORY_LIMIT = 10;

/**
 * Reservation of the day. The primary key of `like_daily_target` refuses a second like to the same
 * friend, whatever the client sends, and `meta.changes` tells whether this one was the first.
 */
const RESERVE_LIKE_SQL = `INSERT INTO like_daily_target (liker_uuid, target_uuid, day)
       VALUES (?, ?, date('now'))
       ON CONFLICT(liker_uuid, target_uuid, day) DO NOTHING`;

/** Counter of the RECEIVER: one more like, one more tenth of a Spark, row created on the first. */
const COUNT_LIKE_SQL = `INSERT INTO likes (uuid, like_count, bonus_from_like)
       VALUES (?, 1, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         like_count = like_count + 1,
         bonus_from_like = bonus_from_like + ?,
         updated_at = datetime('now')`;

/** One entry of a `db.batch()` result, reduced to the row count it changed. */
interface BatchStepResult {
  meta?: { changes?: number };
}

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

/** One row of `like_daily_target` joined with the public card of the other player. */
interface LikeHistoryRow {
  uuid: string;
  username: string | null;
  profile_picture_id: string | null;
  card_rarity: number | null;
  day: string;
  created_at: string;
}

/** One entry of the like history, already normalized for the game. */
interface LikeHistoryEntry {
  uuid: string;
  username: string;
  profile_picture_id: string;
  card_rarity: number;
  day: string;
  liked_at: string;
}

/** One entry of a `db.batch()` result, reduced to the rows it selected. */
interface BatchQueryResult {
  results?: LikeHistoryRow[];
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
 * Lists the friends one player already liked today.
 *
 * The game paints a like button per friend from it, so the daily state arrives with the count of
 * the player instead of one request per row of the Follow List.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} likerUuid - Liker UUID.
 * @returns {Promise<string[]>} The liked friend UUIDs, in like order.
 */
async function readLikedTargetsToday(db: D1Database, likerUuid: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT target_uuid FROM like_daily_target
       WHERE liker_uuid = ? AND day = date('now')
       ORDER BY created_at ASC`
    )
    .bind(likerUuid)
    .all<{ target_uuid: string }>();
  return (result.results ?? [])
    .map((row) => row.target_uuid)
    .filter((uuid): uuid is string => typeof uuid === "string" && uuid !== "");
}

/**
 * Reads the LAST likes one player received, newest first.
 *
 * `like_daily_target` holds who liked whom and when, so the ten last hearts of an account need no
 * new table. The public card of the liker is joined to name it: a liker who never published their
 * card keeps an empty name, and the game only offers to follow the named ones.
 */
const RECEIVED_HISTORY_SQL = `SELECT d.liker_uuid AS uuid, d.day, d.created_at,
         c.username, c.profile_picture_id, c.card_rarity
       FROM like_daily_target d
       LEFT JOIN cards c ON c.uuid = d.liker_uuid
       WHERE d.target_uuid = ?
       ORDER BY d.created_at DESC
       LIMIT ?`;

/** Same read for the likes one player SENT (the `liker_uuid` side of the table). */
const SENT_HISTORY_SQL = `SELECT d.target_uuid AS uuid, d.day, d.created_at,
         c.username, c.profile_picture_id, c.card_rarity
       FROM like_daily_target d
       LEFT JOIN cards c ON c.uuid = d.target_uuid
       WHERE d.liker_uuid = ?
       ORDER BY d.created_at DESC
       LIMIT ?`;

/**
 * Normalizes the rows of one history read.
 *
 * The worker rounds the rarity and the strings it returns, so the game can paint an avatar without
 * defending itself against a malformed row.
 *
 * @param {BatchQueryResult|undefined} result - One result of `db.batch()`.
 * @returns {LikeHistoryEntry[]} The entries, newest first.
 */
function readHistoryRows(result: BatchQueryResult | undefined): LikeHistoryEntry[] {
  return (result?.results ?? [])
    .filter((row) => typeof row.uuid === "string" && row.uuid !== "")
    .map((row) => ({
      uuid: row.uuid,
      username: typeof row.username === "string" ? row.username : "",
      profile_picture_id:
        typeof row.profile_picture_id === "string" ? row.profile_picture_id : "",
      card_rarity: Math.min(6, Math.max(1, Math.trunc(Number(row.card_rarity) || 1))),
      day: typeof row.day === "string" ? row.day : "",
      liked_at: typeof row.created_at === "string" ? row.created_at : "",
    }));
}

/**
 * Reads the last likes a player received and the last likes it sent.
 *
 * Both reads travel in ONE `db.batch()`, so the history costs a single D1 round trip like the
 * counters of the authenticated read.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Authenticated player.
 * @returns {Promise<{received: LikeHistoryEntry[], sent: LikeHistoryEntry[]}>} The history.
 */
async function readLikeHistory(
  db: D1Database,
  uuid: string
): Promise<{ received: LikeHistoryEntry[]; sent: LikeHistoryEntry[] }> {
  const [received, sent] = (await db.batch([
    db.prepare(RECEIVED_HISTORY_SQL).bind(uuid, LIKE_HISTORY_LIMIT),
    db.prepare(SENT_HISTORY_SQL).bind(uuid, LIKE_HISTORY_LIMIT),
  ])) as BatchQueryResult[];
  return { received: readHistoryRows(received), sent: readHistoryRows(sent) };
}

/**
 * `GET /likes/history` - the ten last likes received and the ten last likes sent.
 *
 * Authenticated with the usual `uuid` + `auth_code` pair: a heart is private, so a history is only
 * ever answered to the account itself. Each entry carries the public card of the other player
 * (name, avatar, rarity), which lets the game follow a liker without a second request.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<LikeRouteResult>} The result.
 */
async function readLikeHistoryRoute(
  request: Request,
  db: D1Database
): Promise<LikeRouteResult> {
  const url = new URL(request.url);
  const uuid = (url.searchParams.get("uuid") ?? "").trim();
  if (uuid === "" || !UUID_PATTERN.test(uuid)) {
    return { status: 400, body: { error: "Le champ 'uuid' est invalide." } };
  }
  const authCode = (url.searchParams.get("auth_code") ?? "").trim();
  if (!(await authenticate(db, uuid, authCode))) {
    return { status: 403, body: { error: "Authentification invalide pour cet UUID." } };
  }
  return { status: 200, body: await readLikeHistory(db, uuid) };
}

/**
 * Counts every like one player ever gave.
 *
 * It is the `likessent` trophy counter: the worker already knows the number, so the game reads it
 * instead of rebuilding it from a local history that a new device would not have.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} likerUuid - Liker UUID.
 * @returns {Promise<number>} The likes given since the account exists.
 */
async function countLikesSent(db: D1Database, likerUuid: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM like_daily_target WHERE liker_uuid = ?")
    .bind(likerUuid)
    .first<{ total: number }>();
  return Math.max(0, Math.trunc(Number(row?.total) || 0));
}

/**
 * Gives the like of the UTC day to one friend, or reports that it was already given.
 *
 * The daily row is inserted FIRST: it is the reservation of the day, and the database refuses a
 * second one for the same friend. Only then does the counter grow, so a like the day cannot give
 * twice never reaches the counters.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} likerUuid - Authenticated liker.
 * @param {string} targetUuid - Friend to like (already validated, another account).
 * @returns {Promise<'liked'|'already'>} What happened.
 */
async function giveLike(
  db: D1Database,
  likerUuid: string,
  targetUuid: string
): Promise<"liked" | "already"> {
  const reserved = await db
    .prepare(RESERVE_LIKE_SQL)
    .bind(likerUuid, targetUuid)
    .run();
  if ((reserved.meta?.changes ?? 0) === 0) return "already";

  await db
    .prepare(COUNT_LIKE_SQL)
    .bind(targetUuid, LIKE_BONUS, LIKE_BONUS)
    .run();
  return "liked";
}

/**
 * Gives the like of the UTC day to several friends in TWO D1 round trips.
 *
 * One request per friend cost 2 statements each, in series: 30 friends took 3.6 s from the client.
 * `db.batch()` sends the days as one transaction and returns one result per target, so the split
 * between `liked` and `already` comes from the database itself, exactly like `giveLike`.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} likerUuid - Authenticated liker.
 * @param {string[]} targets - Friends to like (validated, another account, no duplicate).
 * @returns {Promise<{liked: string[], already: string[]}>} What happened, in the order received.
 */
async function giveLikes(
  db: D1Database,
  likerUuid: string,
  targets: string[]
): Promise<{ liked: string[]; already: string[] }> {
  if (targets.length === 0) return { liked: [], already: [] };

  const reservations = (await db.batch(
    targets.map((target) => db.prepare(RESERVE_LIKE_SQL).bind(likerUuid, target))
  )) as BatchStepResult[];

  const liked: string[] = [];
  const already: string[] = [];
  targets.forEach((target, index) => {
    if ((reservations[index]?.meta?.changes ?? 0) > 0) liked.push(target);
    else already.push(target);
  });

  if (liked.length > 0) {
    await db.batch(
      liked.map((target) => db.prepare(COUNT_LIKE_SQL).bind(target, LIKE_BONUS, LIKE_BONUS))
    );
  }
  return { liked, already };
}

/**
 * Reads the like counts of a list of friends.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string[]} uuids - Friend UUIDs.
 * @returns {Promise<Record<string, number>>} UUID -> count, missing players at 0.
 */
async function readCounts(
  db: D1Database,
  uuids: string[]
): Promise<Record<string, number>> {
  const likes: Record<string, number> = {};
  uuids.forEach((uuid) => {
    likes[uuid] = 0;
  });
  if (uuids.length === 0) return likes;

  const placeholders = uuids.map(() => "?").join(", ");
  const rows = await db
    .prepare(`SELECT uuid, like_count FROM likes WHERE uuid IN (${placeholders})`)
    .bind(...uuids)
    .all<LikeCountRow>();
  for (const row of rows.results ?? []) {
    likes[row.uuid] = Math.max(0, Math.trunc(Number(row.like_count) || 0));
  }
  return likes;
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
    return { status: 200, body: { likes: await readCounts(db, uuids) } };
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
      // The like counters of the ACCOUNT: what it received, what it sent, and which friends it
      // already liked today (one row each, so the game paints its buttons without any extra read).
      likes_sent: await countLikesSent(db, uuid),
      liked_targets_today: await readLikedTargetsToday(db, uuid),
    },
  };
}

/**
 * `POST /likes/friend` - gives the like of the day to one followed player.
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

  if ((await giveLike(db, likerUuid, targetUuid)) === "already") {
    return {
      status: 409,
      body: { error: "Vous avez déjà liké ce joueur aujourd'hui.", liked_today: true },
    };
  }

  const row = await readLikeRow(db, targetUuid);
  return {
    status: 200,
    body: {
      target_uuid: targetUuid,
      likes: Math.max(0, Math.trunc(Number(row?.like_count) || 1)),
      bonus_from_like: roundBonus(row?.bonus_from_like),
      likes_sent: await countLikesSent(db, likerUuid),
      liked_today: true,
    },
  };
}

/**
 * `POST /likes/batch` - gives the like of the day to a whole list of friends.
 *
 * One request for the entire Follow List: the client sends every UUID it follows, and this route
 * reports what was liked, what was already liked today and what has no online account. Self is
 * silently dropped (the game never offers it); an unknown account is reported instead of failing
 * the batch, so one stale follow cannot block the other nineteen.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body (`target_uuids`).
 * @param {string} likerUuid - Authenticated liker.
 * @returns {Promise<LikeRouteResult>} The result.
 */
async function likeBatch(
  db: D1Database,
  body: Record<string, unknown>,
  likerUuid: string
): Promise<LikeRouteResult> {
  const raw = body.target_uuids;
  if (!Array.isArray(raw)) {
    return { status: 400, body: { error: "Le champ 'target_uuids' doit être une liste d'UUID." } };
  }
  const requested = Array.from(
    new Set(
      raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value !== "")
    )
  );
  if (requested.length === 0) {
    return { status: 400, body: { error: "Le champ 'target_uuids' est vide." } };
  }
  if (requested.length > MAX_LIKE_TARGETS) {
    return {
      status: 400,
      body: { error: `Un lot de likes accepte au plus ${MAX_LIKE_TARGETS} joueurs.` },
    };
  }
  const invalid = requested.find((value) => !UUID_PATTERN.test(value));
  if (invalid) {
    return { status: 400, body: { error: "Le champ 'target_uuids' contient un UUID invalide." } };
  }

  const candidates = requested.filter((value) => value !== likerUuid);
  const known = new Set<string>();
  if (candidates.length > 0) {
    const placeholders = candidates.map(() => "?").join(", ");
    const rows = await db
      .prepare(`SELECT uuid FROM users WHERE uuid IN (${placeholders})`)
      .bind(...candidates)
      .all<{ uuid: string }>();
    for (const row of rows.results ?? []) {
      if (typeof row.uuid === "string") known.add(row.uuid);
    }
  }

  const unknown = candidates.filter((target) => !known.has(target));
  const { liked, already } = await giveLikes(
    db,
    likerUuid,
    candidates.filter((target) => known.has(target))
  );

  return {
    status: 200,
    body: {
      liked,
      already,
      unknown,
      likes: await readCounts(db, [...liked, ...already]),
      likes_sent: await countLikesSent(db, likerUuid),
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

  if (path === "/likes/history") {
    if (request.method !== "GET") {
      return { status: 405, body: { error: "Méthode non autorisée." } };
    }
    return readLikeHistoryRoute(request, db);
  }

  if (path === "/likes/friend" || path === "/likes/batch") {
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
    return path === "/likes/friend" ? likeFriend(db, body, uuid) : likeBatch(db, body, uuid);
  }

  return { status: 404, body: { error: "Route introuvable." } };
}
