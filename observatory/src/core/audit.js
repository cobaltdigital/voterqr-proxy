'use strict';
const { id, now } = require('./util');
const { run, all } = require('../db');

/** Records a state transition. Call this on every promotion, decline or supersession. */
function record(db, { objectType, objectId, from = null, to, actor, reason = null }) {
  const rowId = id('aud');
  run(db,
    `INSERT INTO promotion_audit (id, object_type, object_id, from_state, to_state, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    rowId, objectType, objectId, from, to, actor, reason, now());
  return rowId;
}

const history = (db, objectType, objectId) =>
  all(db, 'SELECT * FROM promotion_audit WHERE object_type = ? AND object_id = ? ORDER BY created_at', objectType, objectId);

module.exports = { record, history };
