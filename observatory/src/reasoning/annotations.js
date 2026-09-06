'use strict';
const { id, now } = require('../core/util');
const { run, all } = require('../db');

/**
 * Annotation Ledger — notes, rationale, approvals, evidence + platform review.
 * Attaches human judgement to any object without mutating it, so the reasoning behind a
 * decision survives even when the object itself is later superseded.
 */

const KINDS = ['note', 'rationale', 'approval', 'platform_review'];

function add(db, { objectType, objectId, kind = 'note', note, actor }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown annotation kind: ${kind}`);
  if (!note) throw new Error('annotation requires a note');
  const rowId = id('ann');
  run(db, `INSERT INTO annotations (id, object_type, object_id, kind, note, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rowId, objectType, objectId, kind, note, actor, now());
  return rowId;
}

const forObject = (db, objectType, objectId) =>
  all(db, 'SELECT * FROM annotations WHERE object_type = ? AND object_id = ? ORDER BY created_at', objectType, objectId);

const recent = (db, limit = 50) =>
  all(db, 'SELECT * FROM annotations ORDER BY created_at DESC LIMIT ?', limit);

const approvals = (db, objectType, objectId) =>
  forObject(db, objectType, objectId).filter((a) => a.kind === 'approval');

module.exports = { KINDS, add, forObject, recent, approvals };
