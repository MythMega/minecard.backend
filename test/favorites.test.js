/**
 * Favourites - regression tests of the write rules of `POST /cards`.
 *
 * The bug these tests keep out: a publication that does NOT carry `favorite_cards` /
 * `favorite_trophies` used to be read as two empty lists, which erased the favourites of the
 * player. The rule is "absent is not empty": an absent family writes nothing at all, an explicit
 * empty list clears that family, and the two families never touch each other.
 *
 * No test framework was added: `node --test` ships with Node and the worker has no dependency
 * (see `package.json`). `src/favoriteService.ts` is imported directly thanks to the type stripping
 * of Node, and the database is a stand-in that records the statements, so the assertions are about
 * the SQL the service emits - not about D1 itself (the real database was checked by hand through
 * `wrangler dev`, see the summary of the change).
 *
 * Run with `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFavoriteList, writeFavorites } from "../src/favoriteService.ts";

const UUID = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const SLOTS = 7;

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

test("a publication without the lists writes nothing", async () => {
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
