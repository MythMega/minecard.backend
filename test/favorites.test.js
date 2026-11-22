/**
 * Favourites - regression tests of the write rules of `POST /cards`.
 *
 * The bug these tests keep out: a publication that does NOT carry `favorite_cards` /
 * `favorite_trophies` used to be read as two empty lists, which erased the favourites of the
 * player. The rule is "absent is not empty": an absent family writes nothing at all, an explicit
 * empty list clears that family, and the two families never touch each other.
 *
 * No test framework was added: `node --test` ships with Node and the worker has no dependency
 * (see `package.json`). The sources are imported as they are written, thanks to the type stripping
 * of Node, and the database is a stand-in that records the statements, so the assertions are about
 * the SQL the service emits - not about D1 itself (the real database was checked by hand through
 * `wrangler dev`).
 *
 * Run with `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { upsertCard } from "../src/cardService.ts";
import { normalizeFavoriteList, writeFavorites } from "../src/favoriteService.ts";

const UUID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const SLOTS = 7;

/** Body of a `POST /cards` without any favourite list, as the client sends it on a first day. */
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

const TROPHY_COLUMNS = Array.from({ length: SLOTS }, (_, index) => `trophy${index + 1}`);
const CARD_COLUMNS = Array.from({ length: SLOTS }, (_, index) => `card${index + 1}`);

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
              return { success: true };
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
 * @returns {string[]} The favourite columns of the statement.
 */
function writtenColumns(sql) {
  const match = sql.match(/INSERT INTO favorite \(uuid,\s*([^)]+)\)/);
  assert.ok(match, "the statement must write the favorite table");
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
                // No row yet: this publication creates the account.
                if (/FROM users/.test(sql)) return null;
                return { uuid: UUID, username: PUBLICATION.username };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
}

/**
 * Keeps the statements that write the favourites.
 *
 * @param {Array<{sql: string}>} statements - Statements of one publication.
 * @returns {Array<{sql: string, values: unknown[]}>} The `favorite` writes, in order.
 */
function favouriteWrites(statements) {
  return statements.filter((statement) => /INSERT INTO favorite/.test(statement.sql));
}

test("a publication without the lists writes no favourite row", async () => {
  const { db, statements } = publicationDb();

  await upsertCard(db, PUBLICATION);

  // The card itself is published: only the favourites are left alone.
  assert.ok(statements.some(({ sql }) => /INSERT INTO cards/.test(sql)));
  assert.equal(favouriteWrites(statements).length, 0);
});

test("a publication with an explicit empty list clears that family only", async () => {
  const { db, statements } = publicationDb();

  await upsertCard(db, { ...PUBLICATION, favorite_cards: [] });

  const writes = favouriteWrites(statements);
  assert.equal(writes.length, 1);
  assert.deepEqual(writtenColumns(writes[0].sql), CARD_COLUMNS);
  assert.deepEqual(writes[0].values, [UUID, ...empties(SLOTS)]);
});

test("a publication with one family leaves the other alone", async () => {
  const { db, statements } = publicationDb();

  await upsertCard(db, { ...PUBLICATION, favorite_trophies: ["A1_completion_bronze"] });

  const writes = favouriteWrites(statements);
  assert.equal(writes.length, 1);
  assert.deepEqual(writtenColumns(writes[0].sql), TROPHY_COLUMNS);
  assert.deepEqual(writes[0].values, [UUID, "A1_completion_bronze", ...empties(SLOTS - 1)]);
});

test("the service writes nothing when both families are absent", async () => {
  // What `POST /cards` forwards when the two fields are absent from the body. Any statement here
  // is the old bug: it would either clear both families or store empty slots.
  const db = fakeDb();
  await writeFavorites(db, UUID, {});
  await writeFavorites(db, UUID, { cards: undefined, trophies: undefined });
  assert.equal(db.statements.length, 0);
});

test("an explicit empty list clears only its own family", async () => {
  const db = fakeDb();
  await writeFavorites(db, UUID, { cards: [] });

  assert.equal(db.statements.length, 1);
  const [{ sql, values }] = db.statements;
  assert.deepEqual(writtenColumns(sql), CARD_COLUMNS);
  assert.deepEqual(values, [UUID, ...empties(SLOTS)]);
  // The trophy slots are not part of the statement: they keep what is stored.
  assert.doesNotMatch(sql, /trophy/);
});

test("one family alone does not touch the other", async () => {
  const db = fakeDb();
  await writeFavorites(db, UUID, { trophies: ["A1_completion_bronze"] });

  const [{ sql, values }] = db.statements;
  assert.deepEqual(writtenColumns(sql), TROPHY_COLUMNS);
  assert.deepEqual(values, [UUID, "A1_completion_bronze", ...empties(SLOTS - 1)]);
  assert.doesNotMatch(sql, /card\d/);
});

test("both families are written in the slot order of the table", async () => {
  const db = fakeDb();
  await writeFavorites(db, UUID, { trophies: ["t1"], cards: ["c1", "c2"] });

  const [{ sql, values }] = db.statements;
  // Trophies first, then cards: the INSERT is positional, a crossed order swaps the two families.
  assert.deepEqual(writtenColumns(sql), [...TROPHY_COLUMNS, ...CARD_COLUMNS]);
  assert.deepEqual(values, [
    UUID,
    "t1",
    ...empties(SLOTS - 1),
    "c1",
    "c2",
    ...empties(SLOTS - 2),
  ]);
});

test("the update clause only assigns the families that were sent", async () => {
  const db = fakeDb();
  await writeFavorites(db, UUID, { cards: ["c1"] });

  const [{ sql }] = db.statements;
  assert.match(sql, /card1 = excluded\.card1/);
  assert.doesNotMatch(sql, /trophy1 = excluded\.trophy1/);
});

test("an absent field is not normalized into an empty list", () => {
  assert.equal(normalizeFavoriteList(undefined), undefined);
  assert.equal(normalizeFavoriteList(null), undefined);
});

test("an explicit empty list stays empty", () => {
  assert.deepEqual(normalizeFavoriteList([]), []);
  assert.deepEqual(normalizeFavoriteList(["", "   "]), []);
});

test("ids are trimmed, de-duplicated and bounded", () => {
  assert.deepEqual(normalizeFavoriteList([" c1 ", "c1", "c2"]), ["c1", "c2"]);
  assert.equal(normalizeFavoriteList("c1"), null);
  assert.equal(normalizeFavoriteList([1]), null);
  assert.equal(normalizeFavoriteList(["a".repeat(65)]), null);
  assert.equal(
    normalizeFavoriteList(Array.from({ length: SLOTS + 1 }, (_, index) => `c${index}`)),
    null
  );
});
