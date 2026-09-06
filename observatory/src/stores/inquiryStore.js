'use strict';
const { id, now } = require('../core/util');
const { run, all, get } = require('../db');

/**
 * Inquiry Store — open questions, human submitted or AI suggested, plus potential experiments.
 * This is where "we don't know yet" is recorded as a first-class object instead of being lost.
 */

const STATUSES = ['open', 'watching', 'experiment', 'answered', 'closed'];

function ask(db, { question, origin = 'human', domain = null, clientId = null, createdBy = 'unknown', status = 'open' }) {
  const existing = get(db, `SELECT id FROM inquiries WHERE question = ? AND status NOT IN ('answered','closed')`, question);
  if (existing) return existing.id;   // asking twice does not open a second thread

  const inquiryId = id('inq');
  run(db, `INSERT INTO inquiries (id, question, origin, status, domain, client_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    inquiryId, question, origin, status, domain, clientId, createdBy, now());
  return inquiryId;
}

function setStatus(db, inquiryId, status) {
  if (!STATUSES.includes(status)) throw new Error(`unknown inquiry status: ${status}`);
  run(db, 'UPDATE inquiries SET status = ? WHERE id = ?', status, inquiryId);
  return inquiryId;
}

function answer(db, inquiryId, { answer: text, actor = 'human' }) {
  run(db, `UPDATE inquiries SET status = 'answered', answer = ?, answered_at = ?, created_by = COALESCE(created_by, ?)
           WHERE id = ?`, text, now(), actor, inquiryId);
  return inquiryId;
}

const open = (db, { limit = 50, domain = null } = {}) =>
  all(db, `SELECT * FROM inquiries WHERE status IN ('open','watching','experiment') AND (? IS NULL OR domain = ?)
           ORDER BY created_at DESC LIMIT ?`, domain, domain, limit);

const byId = (db, inquiryId) => get(db, 'SELECT * FROM inquiries WHERE id = ?', inquiryId);

const stats = (db) => all(db, 'SELECT status, origin, COUNT(*) AS n FROM inquiries GROUP BY status, origin');

module.exports = { ask, answer, setStatus, open, byId, stats, STATUSES };
