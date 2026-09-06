'use strict';
const { json } = require('./util');

/**
 * Access + promotion policy. Every read that can cross a client boundary and every
 * automatic promotion goes through here, so the rules live in one auditable place.
 */

class PolicyError extends Error {
  constructor(message, code = 'policy_denied') {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.status = 403;
  }
}

const ROLES = ['viewer', 'analyst', 'reviewer', 'admin'];

/**
 * @param {object} input
 * @param {string} input.id            actor id, recorded in audit rows
 * @param {string} input.role          viewer|analyst|reviewer|admin
 * @param {string[]} input.clientScope client ids this principal may read; ['*'] for all
 */
function principal({ id, role = 'viewer', clientScope = [] } = {}) {
  if (!id) throw new PolicyError('principal requires an id', 'principal_required');
  if (!ROLES.includes(role)) throw new PolicyError(`unknown role: ${role}`, 'unknown_role');
  return Object.freeze({ id, role, clientScope: Object.freeze([...clientScope]) });
}

const SYSTEM = principal({ id: 'system', role: 'admin', clientScope: ['*'] });

const canReadClient = (p, clientId) =>
  !clientId || p.role === 'admin' || p.clientScope.includes('*') || p.clientScope.includes(clientId);

function assertClientAccess(p, clientId) {
  if (!canReadClient(p, clientId)) {
    throw new PolicyError(`principal ${p.id} may not read client ${clientId}`, 'client_scope');
  }
  return true;
}

function assertRole(p, minimum) {
  if (ROLES.indexOf(p.role) < ROLES.indexOf(minimum)) {
    throw new PolicyError(`role ${p.role} is below required ${minimum}`, 'role');
  }
  return true;
}

/** Row-level filter for client_corpus rows carrying their own access parameters. */
function visibleRows(p, rows) {
  return rows.filter((row) => {
    if (!canReadClient(p, row.client_id)) return false;
    const access = json(row.access_json, {});
    if (access.restricted_to && !access.restricted_to.includes(p.role) && p.role !== 'admin') return false;
    return true;
  });
}

// ── Promotion policy ─────────────────────────────────────────────────────────
// A candidate promotes itself only when it is both well-sourced and low-risk.
// Everything else is a human decision — that is the whole point of the review gate.
const PROMOTION = {
  autoTrust: 0.75,
  autoRisk: 0.25,
  criticalRisk: 0.7,
  duplicateSimilarity: 0.85,     // Jaccard — near-duplicate detection, wants precision
  duplicateContainment: 0.95,    // …plus: one text contains essentially all of the other
  duplicateLengthRatio: 1.5,     // …and they are comparable in length (a re-fetch, not a summary)
  contradictionSimilarity: 0.30, // overlap coefficient — "same subject", wants recall
  supersessionSimilarity: 0.45,
};

// Record kinds that belong to the Client Corpus Index rather than the shared Domain KB.
const CLIENT_RECORD_KINDS = new Set(['meeting', 'email', 'task', 'doc', 'sales', 'icp', 'form', 'report']);

// Client material is filed by client_id, not by marketing domain: a meeting note has no
// "SEO vs paid" answer and must not be held for review just for lacking one.
const DOMAIN_EXEMPT_KINDS = CLIENT_RECORD_KINDS;

function routeCandidate(candidate) {
  const domainRequired = !(DOMAIN_EXEMPT_KINDS.has(candidate.kind) && candidate.clientId);
  if (domainRequired && (!candidate.domain || candidate.domain === 'unrouted')) {
    return { state: 'in_review', reason: 'unrouted', severity: 'normal' };
  }
  if (candidate.risk >= PROMOTION.criticalRisk) {
    return { state: 'in_review', reason: 'high_risk', severity: 'critical' };
  }
  if (candidate.risk > PROMOTION.autoRisk) {
    return { state: 'in_review', reason: 'high_risk', severity: 'normal' };
  }
  if (candidate.trust < PROMOTION.autoTrust) {
    return { state: 'in_review', reason: 'low_trust', severity: 'normal' };
  }
  return { state: 'promoted', reason: 'auto_promoted', severity: 'normal' };
}

/**
 * Report-safe view: strips client identity from any text or row headed outside
 * the account team. Used by reporting and by public-safe strategy candidates.
 */
function reportSafe(text, clients = []) {
  let out = String(text || '');
  for (const client of clients) {
    if (!client.name) continue;
    const pattern = new RegExp(client.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(pattern, `[${client.tier || 'client'} client]`);
  }
  return out;
}

module.exports = {
  PolicyError, ROLES, PROMOTION, SYSTEM, DOMAIN_EXEMPT_KINDS, CLIENT_RECORD_KINDS,
  principal, canReadClient, assertClientAccess, assertRole, visibleRows, routeCandidate, reportSafe,
};
