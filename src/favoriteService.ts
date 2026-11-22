/**
 * Favorites - the favourite cards and the featured trophies of a trainer card.
 *
 * Reference: `sql/schema/06-favorites.sql`.
 *
 * The `favorite` table holds ONE row per account: the seven favourite collection keys
 * (`card1` … `card7`), the seven featured trophy ids (`trophy1` … `trophy7`), in the order the
 * player pinned them, and the share code of the binder the profile pins on its card
 * (`binder_code`). Every slot is nullable, so an account that pinned fewer favourites only stores
 * what it has.
 *
 * ABSENT IS NOT EMPTY
 *   A payload that omits `favorite_cards` / `favorite_trophies` leaves the stored list ALONE: an
 *   older client (or a script that only updates the counters) must never wipe what the player
 *   pinned. Only an explicit field changes a family, and an explicit empty list clears it. The two
 *   families are independent: sending the cards alone keeps the trophies.
 *
 * The worker never interprets an id: a card key (`creeper_foil`) and a trophy id
 * (`A1_completion_bronze`) are opaque strings, resolved by the game. They are only bounded here
 * (length, control characters, seven slots) so a client cannot store an unbounded blob.
 *
 * The row is written by the publication of the card (`POST /cards`, see `cardService.upsertCard`)
 * and read in the same batch request the Follow List already makes (`GET /cards?uuids=…`).
 */

/** Number of favourite slots of a card (`trophy1` … `trophy7`, `card1` … `card7`). */
const FAVORITE_SLOTS = 7;

/** Longest id accepted: a collection key or a trophy id stays far below. */
const MAX_FAVORITE_ID_LENGTH = 64;

/** Largest number of UUIDs one batch read may ask for (mirrors the other routes). */
const MAX_FAVORITE_BATCH = 100;

/**
 * Longest binder code accepted: the payload of a full 30-card page deflates to a few kilobytes, so
 * the limit is generous while still refusing an unbounded blob.
 */
const MAX_BINDER_CODE_LENGTH = 8192;

/** Characters a share code may contain: it is the URL-safe Base64 of a deflated payload. */
const BINDER_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The favourites of one player, in display order. */
export interface FavoriteLists {
  trophies: string[];
  cards: string[];
  /** Share code of the binder pinned on the card, or an empty string. */
  binder: string;
}

/**
 * The families a publication may write: `undefined` means "not sent, keep what is stored".
 *
 * This is the input of `writeFavorites`, not the shape of the table: an empty array clears a
 * family, an absent one is not touched, and an empty binder code clears the pinned binder.
 */
export interface FavoriteWrite {
  trophies?: string[];
  cards?: string[];
  /** Share code of the pinned binder; `undefined` keeps the stored one, `""` clears it. */
  binder?: string;
}

/** Slot columns of one family, in declaration order (`trophy1` … `trophy7`). */
function slotColumns(prefix: string): string[] {
  return Array.from({ length: FAVORITE_SLOTS }, (_, index) => `${prefix}${index + 1}`);
}

/**
 * Every column of the table, `uuid` first (`trophy1` … `trophy7`, then `card1` … `card7`, then the
 * pinned binder).
 */
const ALL_COLUMNS = ["uuid", ...slotColumns("trophy"), ...slotColumns("card"), "binder_code"].join(
  ", "
);

/**
 * Validates and normalizes one list of ids sent by the client.
 *
 * @param {unknown} value - Raw value of the payload.
 * @returns {string[] | null | undefined} The trimmed, de-duplicated ids; an empty array for an
 *   explicit empty list; `undefined` when the field is absent (nothing must change); `null` when
 *   the value is refused.
 */
export function normalizeFavoriteList(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const id = entry.trim();
    if (id === "") continue;
    if (id.length > MAX_FAVORITE_ID_LENGTH) return null;
    if (/[\u0000-\u001f\u007f]/.test(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length > FAVORITE_SLOTS) return null;
  return ids;
}

/**
 * Validates the share code of the binder a profile pins on its card.
 *
 * The worker never reads a code: it stores the opaque string the game produced (the deflated,
 * URL-safe Base64 payload of a binder) and gives it back to the followed players, so only its
 * shape is checked here.
 *
 * @param {unknown} value - Raw value of the payload.
 * @returns {string | null | undefined} The trimmed code; an empty string for an explicit "no
 *   binder" (it clears the stored one); `undefined` when the field is absent (nothing changes);
 *   `null` when the value is refused.
 */
export function normalizeBinderCode(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;

  const code = value.trim();
  if (code === "") return "";
  if (code.length > MAX_BINDER_CODE_LENGTH) return null;
  if (!BINDER_CODE_PATTERN.test(code)) return null;
  return code;
}

/**
 * Pads one list to the seven slots of the table.
 *
 * @param {string[]} ids - Ids, in display order.
 * @returns {(string|null)[]} One value per slot, `null` for an empty slot.
 */
function padSlots(ids: string[]): (string | null)[] {
  return Array.from({ length: FAVORITE_SLOTS }, (_, index) => ids[index] ?? null);
}

/**
 * Reads the non-empty ids of one family of slots from a table row.
 *
 * @param {Record<string, unknown>} row - Row of the `favorite` table.
 * @param {string} prefix - `trophy` or `card`.
 * @returns {string[]} The ids, in slot order.
 */
function readSlots(row: Record<string, unknown>, prefix: string): string[] {
  const ids: string[] = [];
  for (let slot = 1; slot <= FAVORITE_SLOTS; slot += 1) {
    const value = row[`${prefix}${slot}`];
    if (typeof value === "string" && value !== "") ids.push(value);
  }
  return ids;
}

/**
 * Writes the favourites of one account, creating the row on the first publication.
 *
 * Only the families present in `lists` are written: the statement assigns those columns and lets
 * the others keep their stored value, which is what makes an omitted field a no-op instead of a
 * wipe. An empty array writes seven NULLs, which clears the family.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Account UUID (the row is created with the card).
 * @param {FavoriteWrite} lists - Validated favourites; a family may be absent.
 * @returns {Promise<void>} Resolves once the write is done, or immediately when nothing was sent.
 */
export async function writeFavorites(
  db: D1Database,
  uuid: string,
  lists: FavoriteWrite
): Promise<void> {
  const trophyColumns = lists.trophies === undefined ? [] : slotColumns("trophy");
  const cardColumns = lists.cards === undefined ? [] : slotColumns("card");
  const binderColumns = lists.binder === undefined ? [] : ["binder_code"];
  const columns = [...trophyColumns, ...cardColumns, ...binderColumns];
  // Nothing was sent: not a single statement, so the stored favourites stay untouched.
  if (columns.length === 0) return;

  // Same order as the columns: the INSERT is positional, a crossed order would swap the slots.
  const values = [
    ...(lists.trophies === undefined ? [] : padSlots(lists.trophies)),
    ...(lists.cards === undefined ? [] : padSlots(lists.cards)),
    ...(lists.binder === undefined ? [] : [lists.binder === "" ? null : lists.binder]),
  ];
  const placeholders = columns.map(() => "?").join(", ");
  const assignments = columns.map((column) => `${column} = excluded.${column}`).join(", ");

  await db
    .prepare(
      `INSERT INTO favorite (uuid, ${columns.join(", ")}, updated_at)
      VALUES (?, ${placeholders}, datetime('now'))
      ON CONFLICT(uuid) DO UPDATE SET
        ${assignments},
        updated_at = datetime('now')`
    )
    .bind(uuid, ...values)
    .run();
}

/**
 * Reads the favourites of several players in one query.
 *
 * Only the players that have a row are returned: a caller falls back to empty lists otherwise.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string[]} uuids - Account UUIDs.
 * @returns {Promise<Record<string, FavoriteLists>>} UUID -> favourites.
 */
export async function readFavoritesByUuids(
  db: D1Database,
  uuids: string[]
): Promise<Record<string, FavoriteLists>> {
  const cleaned = Array.from(
    new Set(uuids.map((uuid: string) => uuid.trim()).filter((uuid: string) => uuid.length > 0))
  ).slice(0, MAX_FAVORITE_BATCH);

  if (cleaned.length === 0) return {};

  const placeholders = cleaned.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT ${ALL_COLUMNS} FROM favorite WHERE uuid IN (${placeholders})`)
    .bind(...cleaned)
    .all<Record<string, unknown>>();

  const favorites: Record<string, FavoriteLists> = {};
  for (const row of result.results ?? []) {
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    if (uuid === "") continue;
    favorites[uuid] = {
      trophies: readSlots(row, "trophy"),
      cards: readSlots(row, "card"),
      binder: typeof row.binder_code === "string" ? row.binder_code : "",
    };
  }
  return favorites;
}
