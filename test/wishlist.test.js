/**
 * Wishlist - regression tests of the write rules of `POST /cards` and of `GET /cards`.
 *
 * The rule these tests keep: a publication that does NOT carry `wishlist_cards` writes nothing
 * (an older client must never wipe the stored list), an explicit empty list clears it, and at most
 * ten keys are accepted. The read side is checked through the `wishlists` map the worker builds.
 *
 * No test framework was added: `node --test` ships with Node and the worker has no dependency
 * (see `package.json`). The sources are imported as they are written, thanks to the type stripping
 * of Node, and the database is a stand-in that records the statements, so the assertions are about
 * the SQL the service emits - not about D1 itself (the real database is checked through
 * `wrangler dev` / a deployed dry run).
 *
 * Run with `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { upsertCard } from "../src/cardService.ts";
import {
  WISHLIST_SLOTS,
  normalizeWishlist,
  readWishlistsByUuids,
  writeWishlist,
} from "../src/wishlistService.ts";

const UUID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";

/** Body of a `POST /cards` without any wishlist, as a client that predates the feature sends it. */
const PUBLICATION = {
  uuid: UUID,
  auth_code: "ABCDEFGH12345678",
  username: "Tester",
  background_card_id: "default",
  profile_picture_id: "none",
  title_id: "none",
  card_color_id: "auto",
  username_color_id: "auto",
  location_id: "assets/img/card_back.png",
  card_layout: "classic",
  profile_icon_size: "normal",
  profile_icon_align: "center",
  profile_icon_shape: "normal",
  card_rarity: 1,
  title_color_id: "auto",
  open_booster: 0,
  different_cards: 0,
  date_first_card: "2026-11-22",
  level: 1,
  block_mined: 0,
  picks: 0,
  points: 10,
};

const SLOT_COLUMNS = Array.from({ length: WISHLIST_SLOTS }, (_, index) => `card${index + 1}`);

/**
 * Stand-in of the D1 binding: records every prepared statement with its bound values.
 *
 * @returns {{statements: Array<{sql: string, values: unknown[]}>, prepare: Function}} The fake.
 */
function fakeDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...values) {
          statements.push({ sql, values });
          return {
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

/**
 * Reads the columns an INSERT writes, in order, without `uuid` and `updated_at`.
 *
 * @param {string} sql - Recorded statement.
 * @returns {string[]} The wishlist columns of the statement.
 */
function writtenColumns(sql) {
  const match = sql.match(/INSERT INTO wishlist \(uuid,\s*([^)]+)\)/);
  assert.ok(match, "the statement must write the wishlist table");
  return match[1]
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "updated_at");
}

/** @param {number} count - Number of empty slots. @returns {null[]} The padding. */
function empties(count) {
  return Array.from({ length: count }, () => null);
}

/**
 * D1 stand-in for one publication: records the statements and answers the two reads `upsertCard`
 * makes (the account lookup, then the card it returns).
 *
 * @returns {{db: object, statements: Array<{sql: string, values: unknown[]}>}} The fake.
 */
function publicationDb() {
  const statements = [];
  return {
    statements,
    db: {
      prepare(sql) {
        const record = { sql, values: [] };
        statements.push(record);
        return {
          bind(...values) {
            record.values = values;
            return {
              async first() {
                if (/FROM users/.test(sql)) return null;
                return { uuid: UUID, username: PUBLICATION.username };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

/**
 * Keeps the statements that write the wishlist.
 *
 * @param {Array<{sql: string}>} statements - Statements of one publication.
 * @returns {Array<{sql: string, values: unknown[]}>} The `wishlist` writes, in order.
 */
function wishlistWrites(statements) {
  return statements.filter((statement) => /INSERT INTO wishlist/.test(statement.sql));
}

test("a publication without the field writes no wishlist row", async () => {
  const { db, statements } = publicationDb();

  await upsertCard(db, PUBLICATION);

  assert.ok(statements.some(({ sql }) => /INSERT INTO cards/.test(sql)));
  assert.equal(wishlistWrites(statements).length, 0);
});

test("a publication with ten keys stores them in slot order", async () => {
  const { db, statements } = publicationDb();
  const keys = Array.from({ length: WISHLIST_SLOTS }, (_, index) => `creeper_${index}`);

  await upsertCard(db, { ...PUBLICATION, wishlist_cards: keys });

  const writes = wishlistWrites(statements);
  assert.equal(writes.length, 1);
  assert.deepEqual(writtenColumns(writes[0].sql), SLOT_COLUMNS);
  assert.deepEqual(writes[0].values, [UUID, ...keys]);
});

test("a publication with an explicit empty list clears every slot", async () => {
  const { db, statements } = publicationDb();

  await upsertCard(db, { ...PUBLICATION, wishlist_cards: [] });

  const writes = wishlistWrites(statements);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].values, [UUID, ...empties(WISHLIST_SLOTS)]);
});

test("a short list pads the remaining slots with NULL", async () => {
  const db = fakeDb();
  await writeWishlist(db, UUID, ["a1_classic", "b2_foil"]);

  const [{ sql, values }] = db.statements;
  assert.deepEqual(writtenColumns(sql), SLOT_COLUMNS);
  assert.deepEqual(values, [UUID, "a1_classic", "b2_foil", ...empties(WISHLIST_SLOTS - 2)]);
});

test("an absent field writes nothing at all", async () => {
  const db = fakeDb();
  await writeWishlist(db, UUID, undefined);

  assert.equal(db.statements.length, 0);
  assert.equal(normalizeWishlist(undefined), undefined);
  assert.equal(normalizeWishlist(null), undefined);
});

test("keys are trimmed, de-duplicated and bounded to ten", () => {
  assert.deepEqual(normalizeWishlist([" c1 ", "c1", "c2"]), ["c1", "c2"]);
  assert.deepEqual(normalizeWishlist([]), []);
  assert.deepEqual(normalizeWishlist(["", "   "]), []);
  assert.equal(normalizeWishlist("c1"), null);
  assert.equal(normalizeWishlist([1]), null);
  assert.equal(normalizeWishlist(["a".repeat(65)]), null);
  assert.equal(
    normalizeWishlist(Array.from({ length: WISHLIST_SLOTS + 1 }, (_, index) => `c${index}`)),
    null
  );
});

test("the read side returns the keys of every row and skips empty slots", async () => {
  const rows = [
    { uuid: UUID, card1: "a1_classic", card2: null, card3: "b2_foil" },
    { uuid: "11111111-1111-4111-8111-111111111111", card1: null },
  ];
  let bound = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          bound = values;
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  };

  const result = await readWishlistsByUuids(db, [UUID, "11111111-1111-4111-8111-111111111111"]);

  assert.deepEqual(bound, [UUID, "11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual(result[UUID], ["a1_classic", "b2_foil"]);
  // A row of empty slots is an EMPTY wishlist, not a missing one: the game must be able to tell
  // "cleared" from "never published".
  assert.deepEqual(result["11111111-1111-4111-8111-111111111111"], []);
});

test("a read without any UUID does not query the database", async () => {
  const db = {
    prepare() {
      throw new Error("no statement expected");
    },
  };
  assert.deepEqual(await readWishlistsByUuids(db, []), {});
});
