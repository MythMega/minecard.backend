/**
 * Trade service ("Échanges") - MineCards backend.
 *
 * Two players exchange one card of the SAME rarity. The trade is initiated by
 * player A, answered by player B, then accepted (or cancelled) by player A.
 * Both sides claim the card they receive, which is what completes the trade.
 *
 * EVERYTHING THE WORKER OWNS
 *   - the status machine of a trade, one status per phase (`pending`,
 *     `proposed`, `accepted`, `completed`, `declined`, `cancelled`, `expired`);
 *   - the Ender Eyes balance (max 5, +1 per UTC day), because it is what makes
 *     a trade possible: the client can never spend more than allowed here;
 *   - the 24 h deadline: every authenticated request first expires the overdue
 *     trades and refunds the Ender Eyes of both sides;
 *   - the statistics (per rarity, per outcome, Sparks spent).
 *
 * WHAT THE WORKER DOES NOT OWN
 *   The collection and the Sparks balance live in the browser
 *   (`user_state["collection"]` and `user_state["sparks"]`). The worker
 *   therefore stores the card payload as JSON: the receiver adds that exact
 *   card to its local collection when it claims, and a refund returns the same
 *   payload. `sparks_cost` is the amount the client escrowed locally; the
 *   worker only records it, and only counts it as spent when the trade is
 *   completed.
 *
 * AUTHENTICATION
 *   `uuid` + `auth_code`, exactly like `POST /cards`. A player must have
 *   published their trainer card (a row in `users`) to trade, because that row
 *   is the only place the secret code lives.
 *
 * Reference: `sql/schema/trade-table.sql` and `doc/trades.md`.
 */

/** Rarities a trade can involve. Rarity 6 (Unique) is never tradable. */
const MIN_TRADE_RARITY = 1;
const MAX_TRADE_RARITY = 5;

/** Maximum Ender Eyes an account can hold. */
const MAX_ENDER_EYES = 5;

/** Ender Eyes granted per UTC day. */
const ENDER_EYES_PER_DAY = 1;

/** Deadline of a trade that is not accepted yet, in hours. */
const TRADE_EXPIRY_HOURS = 24;

/** Statuses that still wait for an answer (they expire after 24 h). */
const OPEN_REQUEST_STATUSES = ["pending", "proposed"] as const;

/** Every status a trade can carry. */
export const TRADE_STATUSES = [
  "pending",
  "proposed",
  "accepted",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;

export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** Card payload exchanged between the two players. */
export interface TradeCardPayload {
  key: string;
  card_id: string;
  style: string;
  set: string;
  rarity: number;
  name: string;
  image: string;
}

interface TradeRow {
  id: string;
  status: TradeStatus;
  rarity: number;
  initiator_uuid: string;
  responder_uuid: string;
  initiator_card_key: string;
  initiator_card_json: string;
  responder_card_key: string | null;
  responder_card_json: string | null;
  sparks_cost: number;
  ender_eyes_cost: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  initiator_claimed_at: string | null;
  responder_claimed_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
}

interface TradeAccountRow {
  uuid: string;
  ender_eyes: number;
  ender_eyes_day: string;
}

interface AuthRow {
  auth_code: string;
}

interface UsernameRow {
  uuid: string;
  username: string;
}

/** Result of one trade route, wrapped into a JSON response by `index.ts`. */
export interface TradeRouteResult {
  status: number;
  body: unknown;
}

/** Cost of one side of a trade, for a given rarity. */
export function getTradeCost(rarity: number): { sparks: number; enderEyes: number } {
  return { sparks: rarity * rarity, enderEyes: rarity };
}

/**
 * Reads the current UTC day.
 *
 * @returns {string} `YYYY-MM-DD`.
 */
function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Counts the whole days between two `YYYY-MM-DD` values.
 *
 * A malformed or future origin reads as 0, so a broken stored day can never
 * grant a burst of Ender Eyes.
 *
 * @param {string} from - Earlier day.
 * @param {string} to - Later day.
 * @returns {number} A non-negative integer.
 */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

/**
 * Generates a trade identifier.
 *
 * @returns {string} A v4 UUID.
 */
function generateTradeId(): string {
  const runtime = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (!runtime.crypto || typeof runtime.crypto.randomUUID !== "function") {
    throw new Error("The Web Crypto API is unavailable: no trade identifier can be generated.");
  }
  return runtime.crypto.randomUUID();
}

/**
 * Clamps a stored Ender Eyes balance into its legal range.
 *
 * @param {unknown} value - Raw balance.
 * @returns {number} An integer between 0 and 5.
 */
function normalizeEnderEyes(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return MAX_ENDER_EYES;
  return Math.min(MAX_ENDER_EYES, Math.max(0, Math.trunc(number)));
}

/**
 * Accepts only a local asset path for a card illustration.
 *
 * The payload is written by the other player, so a remote URL would turn the
 * trade screen into a request for an arbitrary third-party image.
 *
 * @param {unknown} value - Raw path.
 * @returns {string} A safe `assets/...` path, or an empty string.
 */
function safeTradeAssetPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim().replace(/^\.\//, "");
  if (path === "" || path.startsWith("/") || path.startsWith("//") || path.includes("..")) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "";
  return path.startsWith("assets/") ? path : "";
}

/**
 * Validates the card a player offers.
 *
 * @param {unknown} raw - Value of the `card` field.
 * @param {number} expectedRarity - Rarity imposed by the trade.
 * @returns {{ok: true, card: TradeCardPayload} | {ok: false, error: string}} The result.
 */
function validateTradeCard(
  raw: unknown,
  expectedRarity: number
): { ok: true; card: TradeCardPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Le champ 'card' est requis." };
  }
  const card = raw as Record<string, unknown>;
  const key = typeof card.key === "string" ? card.key.trim() : "";
  if (key === "" || key.length > 200) {
    return { ok: false, error: "Le champ 'card.key' est invalide." };
  }
  const rarity = typeof card.rarity === "number" ? Math.trunc(card.rarity) : Number(card.rarity);
  if (!Number.isInteger(rarity) || rarity < MIN_TRADE_RARITY || rarity > MAX_TRADE_RARITY) {
    return { ok: false, error: "La rareté de la carte doit être comprise entre 1 et 5." };
  }
  if (rarity !== expectedRarity) {
    return { ok: false, error: "Les deux cartes doivent avoir la même rareté." };
  }
  const text = (value: unknown, max: number, fallback = ""): string => {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed === "" ? fallback : trimmed.slice(0, max);
  };

  return {
    ok: true,
    card: {
      key,
      card_id: text(card.card_id, 200, key),
      style: text(card.style, 40, "classic"),
      set: text(card.set, 40, ""),
      rarity,
      name: text(card.name, 120, "?"),
      image: safeTradeAssetPath(card.image),
    },
  };
}

/**
 * Reads a body field as a trimmed non-empty string.
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
 * Checks the `uuid` + `auth_code` pair against the published trainer card.
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
 * Reads the trade account, creating it with a full stock on first use.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @returns {Promise<TradeAccountRow>} The stored account.
 */
async function ensureTradeAccount(db: D1Database, uuid: string): Promise<TradeAccountRow> {
  const today = currentUtcDay();
  const row = await db
    .prepare("SELECT uuid, ender_eyes, ender_eyes_day FROM trade_accounts WHERE uuid = ?")
    .bind(uuid)
    .first<TradeAccountRow>();
  if (row) return row;

  await db
    .prepare(
      "INSERT INTO trade_accounts (uuid, ender_eyes, ender_eyes_day) VALUES (?, ?, ?)"
    )
    .bind(uuid, MAX_ENDER_EYES, today)
    .run();
  return { uuid, ender_eyes: MAX_ENDER_EYES, ender_eyes_day: today };
}

/**
 * Applies the daily Ender Eyes refill (1 per elapsed UTC day, capped at 5).
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @returns {Promise<number>} The up-to-date balance.
 */
async function refillEnderEyes(db: D1Database, uuid: string): Promise<number> {
  const account = await ensureTradeAccount(db, uuid);
  const today = currentUtcDay();
  const balance = normalizeEnderEyes(account.ender_eyes);
  if (typeof account.ender_eyes_day !== "string" || account.ender_eyes_day >= today) {
    return balance;
  }

  const granted = daysBetween(account.ender_eyes_day, today) * ENDER_EYES_PER_DAY;
  const next = Math.min(MAX_ENDER_EYES, balance + granted);
  await db
    .prepare(
      "UPDATE trade_accounts SET ender_eyes = ?, ender_eyes_day = ?, updated_at = datetime('now') WHERE uuid = ?"
    )
    .bind(next, today, uuid)
    .run();
  return next;
}

/**
 * Debits Ender Eyes inside a guarded update.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @param {number} amount - Eyes to spend.
 * @returns {Promise<boolean>} True when the balance covered the amount.
 */
async function spendEnderEyes(db: D1Database, uuid: string, amount: number): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE trade_accounts SET ender_eyes = ender_eyes - ?, updated_at = datetime('now') WHERE uuid = ? AND ender_eyes >= ?"
    )
    .bind(amount, uuid, amount)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Gives Ender Eyes back, without ever exceeding the stock limit.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Player UUID.
 * @param {number} amount - Eyes to refund.
 * @returns {Promise<void>} Resolves once the balance is written.
 */
async function refundEnderEyes(db: D1Database, uuid: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await ensureTradeAccount(db, uuid);
  await db
    .prepare(
      "UPDATE trade_accounts SET ender_eyes = MIN(?, ender_eyes + ?), updated_at = datetime('now') WHERE uuid = ?"
    )
    .bind(MAX_ENDER_EYES, amount, uuid)
    .run();
}

/**
 * Expires every trade that was never accepted within the deadline.
 *
 * Both sides are refunded: the initiator always, the responder when they had
 * proposed a card. The status is updated with a guard so a trade answered at
 * the same moment cannot be expired twice.
 *
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<void>} Resolves once the sweep is done.
 */
async function expireOverdueTrades(db: D1Database): Promise<void> {
  const overdue = await db
    .prepare(
      `SELECT * FROM trades
       WHERE status IN ('pending', 'proposed') AND expires_at <= datetime('now')`
    )
    .all<TradeRow>();

  for (const trade of overdue.results ?? []) {
    const closed = await db
      .prepare(
        `UPDATE trades
         SET status = 'expired', closed_at = datetime('now'), closed_by = 'system', updated_at = datetime('now')
         WHERE id = ? AND status IN ('pending', 'proposed')`
      )
      .bind(trade.id)
      .run();
    if ((closed.meta?.changes ?? 0) === 0) continue;

    await refundEnderEyes(db, trade.initiator_uuid, trade.ender_eyes_cost);
    if (trade.responder_card_key) {
      await refundEnderEyes(db, trade.responder_uuid, trade.ender_eyes_cost);
    }
  }
}

/**
 * Parses one stored card payload without ever throwing.
 *
 * @param {string|null} raw - Stored JSON.
 * @returns {TradeCardPayload|null} The card, or null when unusable.
 */
function parseCard(raw: string | null): TradeCardPayload | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as TradeCardPayload;
    if (!parsed || typeof parsed !== "object" || typeof parsed.key !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Builds the payload the client consumes for one trade.
 *
 * @param {TradeRow} row - Stored trade.
 * @param {string} viewerUuid - Player asking for the list.
 * @param {Map<string, string>} usernames - Published usernames by UUID.
 * @returns {object} The trade view.
 */
function buildTradeView(row: TradeRow, viewerUuid: string, usernames: Map<string, string>): object {
  return {
    id: row.id,
    status: row.status,
    rarity: row.rarity,
    sparks_cost: row.sparks_cost,
    ender_eyes_cost: row.ender_eyes_cost,
    my_role: row.initiator_uuid === viewerUuid ? "initiator" : "responder",
    initiator: {
      uuid: row.initiator_uuid,
      username: usernames.get(row.initiator_uuid) ?? "",
      card: parseCard(row.initiator_card_json),
      claimed: row.initiator_claimed_at !== null,
    },
    responder: {
      uuid: row.responder_uuid,
      username: usernames.get(row.responder_uuid) ?? "",
      card: parseCard(row.responder_card_json),
      claimed: row.responder_claimed_at !== null,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    closed_at: row.closed_at,
    closed_by: row.closed_by,
  };
}

/**
 * Reads the public usernames of every player involved in a list of trades.
 *
 * @param {D1Database} db - D1 binding.
 * @param {TradeRow[]} rows - Trades.
 * @returns {Promise<Map<string, string>>} Usernames by UUID.
 */
async function loadUsernames(db: D1Database, rows: TradeRow[]): Promise<Map<string, string>> {
  const uuids = Array.from(
    new Set(rows.flatMap((row) => [row.initiator_uuid, row.responder_uuid]))
  );
  if (uuids.length === 0) return new Map();
  const placeholders = uuids.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT uuid, username FROM cards WHERE uuid IN (${placeholders})`)
    .bind(...uuids)
    .all<UsernameRow>();
  return new Map((result.results ?? []).map((row) => [row.uuid, row.username]));
}

/**
 * Reads one trade by id.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} id - Trade identifier.
 * @returns {Promise<TradeRow|null>} The trade, or null.
 */
async function getTrade(db: D1Database, id: string): Promise<TradeRow | null> {
  const row = await db.prepare("SELECT * FROM trades WHERE id = ?").bind(id).first<TradeRow>();
  return row ?? null;
}

/**
 * Answers the trade routes.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @param {string} path - Normalized pathname (no trailing slash).
 * @returns {Promise<TradeRouteResult|null>} The result, or null when the path is not a trade route.
 */
export async function handleTradeRequest(
  request: Request,
  db: D1Database,
  path: string
): Promise<TradeRouteResult | null> {
  if (!path.startsWith("/trades")) return null;

  if (request.method === "GET" && path === "/trades") {
    return listTrades(request, db);
  }
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
  await refillEnderEyes(db, uuid);

  switch (path) {
    case "/trades":
      return createTrade(db, body, uuid);
    case "/trades/respond":
      return respondToTrade(db, body, uuid);
    case "/trades/accept":
      return acceptTrade(db, body, uuid);
    case "/trades/cancel":
      return cancelTrade(db, body, uuid);
    case "/trades/claim":
      return claimTrade(db, body, uuid);
    default:
      return { status: 404, body: { error: "Route introuvable." } };
  }
}

/**
 * `GET /trades` - every trade of one player, plus the Ender Eyes balance.
 *
 * @param {Request} request - Incoming request.
 * @param {D1Database} db - D1 binding.
 * @returns {Promise<TradeRouteResult>} The result.
 */
async function listTrades(request: Request, db: D1Database): Promise<TradeRouteResult> {
  const url = new URL(request.url);
  const uuid = (url.searchParams.get("uuid") ?? "").trim();
  const authCode = (url.searchParams.get("auth_code") ?? "").trim();
  if (!(await authenticate(db, uuid, authCode))) {
    return { status: 403, body: { error: "Authentification invalide pour cet UUID." } };
  }

  await expireOverdueTrades(db);
  const enderEyes = await refillEnderEyes(db, uuid);

  const active = await db
    .prepare(
      `SELECT * FROM trades
       WHERE (initiator_uuid = ? OR responder_uuid = ?)
         AND status IN ('pending', 'proposed', 'accepted')
       ORDER BY created_at DESC`
    )
    .bind(uuid, uuid)
    .all<TradeRow>();
  const history = await db
    .prepare(
      `SELECT * FROM trades
       WHERE (initiator_uuid = ? OR responder_uuid = ?)
         AND status IN ('completed', 'declined', 'cancelled', 'expired')
       ORDER BY updated_at DESC
       LIMIT 20`
    )
    .bind(uuid, uuid)
    .all<TradeRow>();

  const activeRows = active.results ?? [];
  const historyRows = history.results ?? [];
  const usernames = await loadUsernames(db, [...activeRows, ...historyRows]);
  const incoming = activeRows.filter((row) => row.responder_uuid === uuid);
  const outgoing = activeRows.filter((row) => row.initiator_uuid === uuid);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return {
    status: 200,
    body: {
      uuid,
      ender_eyes: enderEyes,
      max_ender_eyes: MAX_ENDER_EYES,
      next_refill_day: tomorrow,
      incoming: incoming.map((row) => buildTradeView(row, uuid, usernames)),
      outgoing: outgoing.map((row) => buildTradeView(row, uuid, usernames)),
      history: historyRows.map((row) => buildTradeView(row, uuid, usernames)),
    },
  };
}

/**
 * `POST /trades` - player A proposes one of their cards to a friend.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} uuid - Authenticated player.
 * @returns {Promise<TradeRouteResult>} The result.
 */
async function createTrade(
  db: D1Database,
  body: Record<string, unknown>,
  uuid: string
): Promise<TradeRouteResult> {
  const responderUuid = readString(body, "responder_uuid");
  if (responderUuid === "" || responderUuid === uuid) {
    return { status: 400, body: { error: "Le destinataire de l'échange est invalide." } };
  }

  const target = await db
    .prepare("SELECT uuid FROM users WHERE uuid = ?")
    .bind(responderUuid)
    .first<{ uuid: string }>();
  if (!target) {
    return { status: 404, body: { error: "Ce joueur n'a pas publié sa carte de dresseur." } };
  }

  const rawRarity = Number(body.rarity);
  if (!Number.isInteger(rawRarity) || rawRarity < MIN_TRADE_RARITY || rawRarity > MAX_TRADE_RARITY) {
    return { status: 400, body: { error: "Cette rareté ne peut pas être échangée." } };
  }
  const validation = validateTradeCard(body.card, rawRarity);
  if (!validation.ok) {
    return { status: 400, body: { error: validation.error } };
  }

  const open = await db
    .prepare(
      `SELECT id FROM trades WHERE initiator_uuid = ? AND status IN ('pending', 'proposed') LIMIT 1`
    )
    .bind(uuid)
    .first<{ id: string }>();
  if (open) {
    return { status: 409, body: { error: "Vous avez déjà une demande d'échange en cours." } };
  }

  const cost = getTradeCost(rawRarity);
  const balance = await refillEnderEyes(db, uuid);
  if (balance < cost.enderEyes) {
    return { status: 409, body: { error: "Vous n'avez pas assez d'Œil de l'End." } };
  }
  if (!(await spendEnderEyes(db, uuid, cost.enderEyes))) {
    return { status: 409, body: { error: "Vous n'avez pas assez d'Œil de l'End." } };
  }

  const id = generateTradeId();
  const clientCreatedAt = readString(body, "created_at").slice(0, 40);
  try {
    await db
      .prepare(
        `INSERT INTO trades
          (id, status, rarity, initiator_uuid, responder_uuid,
           initiator_card_key, initiator_card_json,
           sparks_cost, ender_eyes_cost, client_created_at, expires_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${TRADE_EXPIRY_HOURS} hours'))`
      )
      .bind(
        id,
        rawRarity,
        uuid,
        responderUuid,
        validation.card.key,
        JSON.stringify(validation.card),
        cost.sparks,
        cost.enderEyes,
        clientCreatedAt
      )
      .run();
  } catch (error) {
    // A concurrent request won the "one open trade" index: give the Eyes back.
    await refundEnderEyes(db, uuid, cost.enderEyes);
    console.warn("Trade creation rejected:", error);
    return { status: 409, body: { error: "Vous avez déjà une demande d'échange en cours." } };
  }

  const trade = await getTrade(db, id);
  if (!trade) {
    await refundEnderEyes(db, uuid, cost.enderEyes);
    return { status: 500, body: { error: "L'échange n'a pas pu être relu." } };
  }
  const usernames = await loadUsernames(db, [trade]);
  return { status: 201, body: { trade: buildTradeView(trade, uuid, usernames), ender_eyes: balance - cost.enderEyes } };
}

/**
 * `POST /trades/respond` - player B denies the request, or proposes a card.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} uuid - Authenticated player.
 * @returns {Promise<TradeRouteResult>} The result.
 */
async function respondToTrade(
  db: D1Database,
  body: Record<string, unknown>,
  uuid: string
): Promise<TradeRouteResult> {
  const trade = await getTrade(db, readString(body, "trade_id"));
  if (!trade) return { status: 404, body: { error: "Échange introuvable." } };
  if (trade.responder_uuid !== uuid) {
    return { status: 403, body: { error: "Cet échange ne vous est pas destiné." } };
  }
  if (!OPEN_REQUEST_STATUSES.includes(trade.status as "pending" | "proposed")) {
    return { status: 409, body: { error: "Cet échange n'attend plus de réponse." } };
  }

  const action = readString(body, "action");
  if (action === "deny") {
    const closed = await db
      .prepare(
        `UPDATE trades SET status = 'declined', closed_at = datetime('now'), closed_by = ?, updated_at = datetime('now')
         WHERE id = ? AND status IN ('pending', 'proposed')`
      )
      .bind(uuid, trade.id)
      .run();
    if ((closed.meta?.changes ?? 0) === 0) {
      return { status: 409, body: { error: "Cet échange a déjà été clos." } };
    }
    await refundEnderEyes(db, trade.initiator_uuid, trade.ender_eyes_cost);
    if (trade.responder_card_key) {
      await refundEnderEyes(db, trade.responder_uuid, trade.ender_eyes_cost);
    }
    return { status: 200, body: { trade_id: trade.id, status: "declined" } };
  }

  if (action !== "propose") {
    return { status: 400, body: { error: "Action inconnue." } };
  }

  const validation = validateTradeCard(body.card, trade.rarity);
  if (!validation.ok) {
    return { status: 400, body: { error: validation.error } };
  }
  if (validation.card.key === trade.initiator_card_key) {
    return { status: 400, body: { error: "Vous ne pouvez pas proposer la carte déjà proposée." } };
  }

  // Replacing a proposal: the previous one is refunded first, so the balance
  // check below is made against the real available stock.
  if (trade.responder_card_key) {
    await refundEnderEyes(db, uuid, trade.ender_eyes_cost);
  }
  const balance = await refillEnderEyes(db, uuid);
  if (balance < trade.ender_eyes_cost) {
    return { status: 409, body: { error: "Vous n'avez pas assez d'Œil de l'End." } };
  }
  if (!(await spendEnderEyes(db, uuid, trade.ender_eyes_cost))) {
    return { status: 409, body: { error: "Vous n'avez pas assez d'Œil de l'End." } };
  }

  const updated = await db
    .prepare(
      `UPDATE trades
       SET status = 'proposed', responder_card_key = ?, responder_card_json = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'proposed')`
    )
    .bind(validation.card.key, JSON.stringify(validation.card), trade.id)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) {
    await refundEnderEyes(db, uuid, trade.ender_eyes_cost);
    return { status: 409, body: { error: "Cet échange a déjà été clos." } };
  }

  return {
    status: 200,
    body: { trade_id: trade.id, status: "proposed", ender_eyes: balance - trade.ender_eyes_cost },
  };
}

/**
 * `POST /trades/accept` - player A accepts B's proposal.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} uuid - Authenticated player.
 * @returns {Promise<TradeRouteResult>} The result.
 */
async function acceptTrade(
  db: D1Database,
  body: Record<string, unknown>,
  uuid: string
): Promise<TradeRouteResult> {
  const trade = await getTrade(db, readString(body, "trade_id"));
  if (!trade) return { status: 404, body: { error: "Échange introuvable." } };
  if (trade.initiator_uuid !== uuid) {
    return { status: 403, body: { error: "Seul l'initiateur peut accepter cet échange." } };
  }
  if (trade.status !== "proposed") {
    return { status: 409, body: { error: "Cet échange n'a pas de contre-proposition à accepter." } };
  }

  const updated = await db
    .prepare(
      `UPDATE trades SET status = 'accepted', updated_at = datetime('now')
       WHERE id = ? AND status = 'proposed'`
    )
    .bind(trade.id)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) {
    return { status: 409, body: { error: "Cet échange a déjà été clos." } };
  }
  return { status: 200, body: { trade_id: trade.id, status: "accepted" } };
}

/**
 * `POST /trades/cancel` - A cancels the whole trade, or B withdraws a proposal.
 *
 * A withdrawal does not destroy A's request: the trade goes back to `pending`,
 * with B's card and Ender Eyes returned.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} uuid - Authenticated player.
 * @returns {Promise<TradeRouteResult>} The result.
 */
async function cancelTrade(
  db: D1Database,
  body: Record<string, unknown>,
  uuid: string
): Promise<TradeRouteResult> {
  const trade = await getTrade(db, readString(body, "trade_id"));
  if (!trade) return { status: 404, body: { error: "Échange introuvable." } };
  if (trade.status !== "pending" && trade.status !== "proposed") {
    return { status: 409, body: { error: "Cet échange ne peut plus être annulé." } };
  }

  if (trade.responder_uuid === uuid && trade.status === "proposed") {
    const withdrawn = await db
      .prepare(
        `UPDATE trades
         SET status = 'pending', responder_card_key = NULL, responder_card_json = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND status = 'proposed'`
      )
      .bind(trade.id)
      .run();
    if ((withdrawn.meta?.changes ?? 0) === 0) {
      return { status: 409, body: { error: "Cet échange a déjà été clos." } };
    }
    await refundEnderEyes(db, uuid, trade.ender_eyes_cost);
    return { status: 200, body: { trade_id: trade.id, status: "pending" } };
  }

  if (trade.initiator_uuid !== uuid) {
    return { status: 403, body: { error: "Cet échange ne vous appartient pas." } };
  }

  const closed = await db
    .prepare(
      `UPDATE trades SET status = 'cancelled', closed_at = datetime('now'), closed_by = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN ('pending', 'proposed')`
    )
    .bind(uuid, trade.id)
    .run();
  if ((closed.meta?.changes ?? 0) === 0) {
    return { status: 409, body: { error: "Cet échange a déjà été clos." } };
  }
  await refundEnderEyes(db, trade.initiator_uuid, trade.ender_eyes_cost);
  if (trade.responder_card_key) {
    await refundEnderEyes(db, trade.responder_uuid, trade.ender_eyes_cost);
  }
  return { status: 200, body: { trade_id: trade.id, status: "cancelled" } };
}

/**
 * `POST /trades/claim` - a player takes the card they receive.
 *
 * The trade becomes `completed` once BOTH sides claimed, which is when the
 * statistics are written: a card taken by one side only is not a finished
 * exchange yet, but nothing is refunded either.
 *
 * @param {D1Database} db - D1 binding.
 * @param {Record<string, unknown>} body - Request body.
 * @param {string} uuid - Authenticated player.
 * @returns {Promise<TradeRouteResult>} The result.
 */
async function claimTrade(
  db: D1Database,
  body: Record<string, unknown>,
  uuid: string
): Promise<TradeRouteResult> {
  const trade = await getTrade(db, readString(body, "trade_id"));
  if (!trade) return { status: 404, body: { error: "Échange introuvable." } };
  const isInitiator = trade.initiator_uuid === uuid;
  const isResponder = trade.responder_uuid === uuid;
  if (!isInitiator && !isResponder) {
    return { status: 403, body: { error: "Cet échange ne vous concerne pas." } };
  }
  if (trade.status === "completed") {
    return { status: 200, body: { trade_id: trade.id, status: "completed" } };
  }
  if (trade.status !== "accepted") {
    return { status: 409, body: { error: "Cet échange n'a pas encore été accepté." } };
  }

  const column = isInitiator ? "initiator_claimed_at" : "responder_claimed_at";
  await db
    .prepare(
      `UPDATE trades SET ${column} = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'accepted' AND ${column} IS NULL`
    )
    .bind(trade.id)
    .run();

  const refreshed = await getTrade(db, trade.id);
  if (!refreshed) return { status: 500, body: { error: "L'échange n'a pas pu être relu." } };

  if (refreshed.initiator_claimed_at && refreshed.responder_claimed_at) {
    // No counter is written here: the trade statistics live in the player's save (see
    // `TradeManager`), so the worker only seals the status.
    await db
      .prepare(
        `UPDATE trades SET status = 'completed', closed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND status = 'accepted'`
      )
      .bind(trade.id)
      .run();
  }

  const final = await getTrade(db, trade.id);
  return {
    status: 200,
    body: {
      trade_id: trade.id,
      status: final?.status ?? "accepted",
      claimed: true,
    },
  };
}
