/**
 * Favorites - the favourite cards and the featured trophies of a trainer card.
 *
 * Reference: `sql/schema/06-favorites.sql`.
 *
 * The `favorite` table holds ONE row per account: the seven favourite collection keys
 * (`card1` … `card7`) and the seven featured trophy ids (`trophy1` … `trophy7`), in the order the
 * player pinned them. Every slot is nullable, so an account that pinned fewer favourites only
 * stores what it has.
 *
 * The worker never interprets an id: a card key (`creeper_foil`) and a trophy id
 * (`A1_completion_bronze`) are opaque strings, resolved by the game. They are only bounded here
 * (length, control characters, seven slots) so a client cannot store an unbounded blob.
 *
 * The row is written by the publication of the card (`POST /cards`, see `cardService.upsertCard`)
 * and read in the same batch request the Follow List already makes (`GET /cards?uuids=…`).
 */

/** Number of favourite slots of a card (`trophy1` … `trophy7`, `card1` … `card7`). */
export const FAVORITE_SLOTS = 7;

/** Longest id accepted: a collection key or a trophy id stays far below. */
export const MAX_FAVORITE_ID_LENGTH = 64;

/** Largest number of UUIDs one batch read may ask for (mirrors the other routes). */
const MAX_FAVORITE_BATCH = 100;

/** The favourites of one player, in display order. */
export interface FavoriteLists {
  trophies: string[];
  cards: string[];
}

/** Slot columns of the table, in declaration order (`trophy1`, `card1`, … ). */
const SLOT_COLUMNS: string[] = Array.from({ length: FAVORITE_SLOTS }, (_, index) => index + 1)
  .flatMap((slot) => [`trophy${slot}`, `card${slot}`]);

/** Every column of the table, `uuid` first. */
const FAVORITE_COLUMNS = ["uuid", ...SLOT_COLUMNS].join(", ");

/** One `?` per column of `FAVORITE_COLUMNS`. */
const FAVORITE_PLACEHOLDERS = ["uuid", ...SLOT_COLUMNS].map(() => "?").join(", ");

/** `trophy1 = excluded.trophy1, …` of the upsert. */
const FAVORITE_ASSIGNMENTS = SLOT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(
  ", "
);

/**
 * Validates and normalizes one list of ids sent by the client.
 *
 * An absent or null field means "no favourite" (an old client that does not know the feature yet
 * would otherwise overwrite a stored list with nothing: it sends nothing at all).
 *
 * @param {unknown} value - Raw value of the payload.
 * @returns {string[] | null} The trimmed, de-duplicated ids, or null when the value is refused.
 */
export function normalizeFavoriteList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
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
 * The whole row is replaced (every slot, empty ones as NULL): the payload always carries the
 * complete list, so an unpinned favourite disappears instead of surviving in an old slot.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Account UUID (the row is created with the card).
 * @param {FavoriteLists} lists - Validated favourites.
 * @returns {Promise<void>} Resolves once the row is written.
 */
export async function writeFavorites(
  db: D1Database,
  uuid: string,
  lists: FavoriteLists
): Promise<void> {
  const values = [...padSlots(lists.trophies), ...padSlots(lists.cards)];
  await db
    .prepare(
      `INSERT INTO favorite (${FAVORITE_COLUMNS}, updated_at)
      VALUES (${FAVORITE_PLACEHOLDERS}, datetime('now'))
      ON CONFLICT(uuid) DO UPDATE SET
        ${FAVORITE_ASSIGNMENTS},
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
    .prepare(`SELECT ${FAVORITE_COLUMNS} FROM favorite WHERE uuid IN (${placeholders})`)
    .bind(...cleaned)
    .all<Record<string, unknown>>();

  const favorites: Record<string, FavoriteLists> = {};
  for (const row of result.results ?? []) {
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    if (uuid === "") continue;
    favorites[uuid] = {
      trophies: readSlots(row, "trophy"),
      cards: readSlots(row, "card"),
    };
  }
  return favorites;
}
