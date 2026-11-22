/**
 * Wishlist - the cards a player hopes to receive.
 *
 * Reference: `sql/schema/09-wishlist.sql`.
 *
 * The `wishlist` table holds ONE row per account: up to ten collection keys (`card1` … `card10`),
 * in the order the collection shows them. Every slot is nullable, so a wishlist of three cards
 * stores three keys and seven NULLs.
 *
 * ABSENT IS NOT EMPTY
 *   A payload that omits `wishlist_cards` leaves the stored list ALONE: an older client (or a
 *   script that only updates the counters) must never wipe what the player wished for. Only an
 *   explicit field changes the list, and an explicit empty list clears it.
 *
 * The worker never interprets a key: `creeper_foil` is an opaque string resolved by the game. It
 * is only bounded here (length, control characters, ten slots) so a client cannot store an
 * unbounded blob.
 *
 * The row is written by the publication of the card (`POST /cards`, see `cardService.upsertCard`)
 * and read in the same batch request the Follow List already makes (`GET /cards?uuids=…`).
 */

/** Number of wishlist slots of a card (`card1` … `card10`). */
export const WISHLIST_SLOTS = 10;

/** Longest key accepted: a collection key stays far below. */
const MAX_WISHLIST_KEY_LENGTH = 64;

/** Largest number of UUIDs one batch read may ask for (mirrors the other routes). */
const MAX_WISHLIST_BATCH = 100;

/** Slot columns, in declaration order (`card1` … `card10`). */
const SLOT_COLUMNS = Array.from({ length: WISHLIST_SLOTS }, (_, index) => `card${index + 1}`);

/** Every column of the table, `uuid` first. */
const ALL_COLUMNS = ["uuid", ...SLOT_COLUMNS].join(", ");

/**
 * Validates and normalizes the list of keys sent by the client.
 *
 * @param {unknown} value - Raw value of the payload.
 * @returns {string[] | null | undefined} The trimmed, de-duplicated keys; an empty array for an
 *   explicit empty list; `undefined` when the field is absent (nothing must change); `null` when
 *   the value is refused.
 */
export function normalizeWishlist(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return null;

  const keys: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const key = entry.trim();
    if (key === "") continue;
    if (key.length > MAX_WISHLIST_KEY_LENGTH) return null;
    if (/[\u0000-\u001f\u007f]/.test(key)) return null;
    if (!keys.includes(key)) keys.push(key);
  }

  if (keys.length > WISHLIST_SLOTS) return null;
  return keys;
}

/**
 * Pads one list to the ten slots of the table.
 *
 * @param {string[]} keys - Keys, in display order.
 * @returns {(string|null)[]} One value per slot, `null` for an empty slot.
 */
function padSlots(keys: string[]): (string | null)[] {
  return Array.from({ length: WISHLIST_SLOTS }, (_, index) => keys[index] ?? null);
}

/**
 * Writes the wishlist of one account, creating the row on the first publication.
 *
 * @param {D1Database} db - D1 binding.
 * @param {string} uuid - Account UUID (the row is created with the card).
 * @param {string[] | undefined} keys - Validated keys; `undefined` leaves the row untouched.
 * @returns {Promise<void>} Resolves once the write is done, or immediately when nothing was sent.
 */
export async function writeWishlist(
  db: D1Database,
  uuid: string,
  keys: string[] | undefined
): Promise<void> {
  // Nothing was sent: not a single statement, so the stored wishlist stays untouched.
  if (keys === undefined) return;

  const placeholders = SLOT_COLUMNS.map(() => "?").join(", ");
  const assignments = SLOT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ");

  await db
    .prepare(
      `INSERT INTO wishlist (uuid, ${SLOT_COLUMNS.join(", ")}, updated_at)
      VALUES (?, ${placeholders}, datetime('now'))
      ON CONFLICT(uuid) DO UPDATE SET
        ${assignments},
        updated_at = datetime('now')`
    )
    .bind(uuid, ...padSlots(keys))
    .run();
}

/**
 * Reads the wishlists of several players in one query.
 *
 * Only the players that have a row are returned: a caller falls back to an empty list otherwise.
 * A row of empty slots reads as an empty list, so a player who cleared their wishlist is
 * distinguishable from a player who never published one (`undefined` vs `[]`).
 *
 * @param {D1Database} db - D1 binding.
 * @param {string[]} uuids - Account UUIDs.
 * @returns {Promise<Record<string, string[]>>} UUID -> wishlist keys, in slot order.
 */
export async function readWishlistsByUuids(
  db: D1Database,
  uuids: string[]
): Promise<Record<string, string[]>> {
  const cleaned = Array.from(
    new Set(uuids.map((uuid: string) => uuid.trim()).filter((uuid: string) => uuid.length > 0))
  ).slice(0, MAX_WISHLIST_BATCH);

  if (cleaned.length === 0) return {};

  const placeholders = cleaned.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT ${ALL_COLUMNS} FROM wishlist WHERE uuid IN (${placeholders})`)
    .bind(...cleaned)
    .all<Record<string, unknown>>();

  const wishlists: Record<string, string[]> = {};
  for (const row of result.results ?? []) {
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    if (uuid === "") continue;
    const keys: string[] = [];
    for (const column of SLOT_COLUMNS) {
      const value = row[column];
      if (typeof value === "string" && value !== "") keys.push(value);
    }
    wishlists[uuid] = keys;
  }
  return wishlists;
}
