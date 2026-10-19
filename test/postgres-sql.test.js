const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toPostgresSql } = require("../lib/postgres");

test("prefixes tutor tables and converts placeholders", () => {
  const sql = toPostgresSql(`
    SELECT r.id FROM registrations r
    JOIN slots s ON s.id = r.slot_id
    JOIN courses c ON c.id = s.course_id
    WHERE r.id = ? AND s.date >= ?
  `);
  assert.match(sql, /johnny_ai_tutor_registrations r/);
  assert.match(sql, /johnny_ai_tutor_slots s/);
  assert.match(sql, /johnny_ai_tutor_courses c/);
  assert.doesNotMatch(sql, /johnny_ai_tutor_johnny_ai_tutor/);
  assert.match(sql, /\$1/);
  assert.match(sql, /\$2/);
  assert.doesNotMatch(sql, /\?/);
});
