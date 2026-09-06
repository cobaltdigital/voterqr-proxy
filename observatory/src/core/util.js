'use strict';
const crypto = require('node:crypto');

const now = () => new Date().toISOString();

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');

/**
 * Content fingerprint used for dedupe. Normalises case, punctuation and whitespace
 * so "Core Web Vitals: LCP under 2.5s" and "core web vitals lcp under 2.5s" collide.
 */
function fingerprint(...parts) {
  const norm = parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s.%-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(norm);
}

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how in is it its of on or that the this to was what when where which who why with your you we our'.split(' ')
);

/** Content tokens, with a light plural fold so "rankings" and "ranking" match. */
function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.%-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('ies') ? `${t.slice(0, -3)}y` : t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/**
 * Jaccard overlap on content tokens: cheap topical similarity, no embeddings needed.
 * Precise but length-sensitive — use it for ranking and near-duplicate detection.
 */
function similarity(a, b) {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  return shared / (sa.size + sb.size - shared);
}

/**
 * Overlap coefficient: shared tokens over the *smaller* vocabulary.
 * Two documents on the same subject stay comparable when one is far longer than the other, which
 * Jaccard punishes — a short revision note and a full SOP about the same metric score ~0.27 by
 * Jaccard but ~0.45 here. Used for "do these cover the same ground", not for dedupe.
 */
function topicalOverlap(a, b) {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  return shared / Math.min(sa.size, sb.size);
}

/**
 * Retrieval score: what fraction of the *query's* terms the document covers.
 * Jaccard is the wrong tool for search — a four-word question against an 800-word SOP scores
 * near zero however well the SOP answers it. Coverage stays stable as documents grow.
 */
function coverage(query, text) {
  const q = new Set(tokens(query));
  if (!q.size) return 0;
  const d = new Set(tokens(text));
  let shared = 0;
  for (const t of q) if (d.has(t)) shared += 1;
  return shared / q.size;
}

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

const daysBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

const json = (value, fallback = {}) => {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

module.exports = { now, id, sha256, fingerprint, tokens, similarity, topicalOverlap, coverage, clamp, daysBetween, json };
