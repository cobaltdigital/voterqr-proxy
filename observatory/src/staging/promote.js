'use strict';
const { json, now } = require('../core/util');
const { get, run } = require('../db');
const audit = require('../core/audit');
const policy = require('../core/policy');
const domainKb = require('../stores/domainKb');
const clientCorpus = require('../stores/clientCorpus');
const evidence = require('../stores/evidenceLedger');

/**
 * The one road into the curated stores.
 *
 * Both the curation worker (auto-promotion) and the human review gate call this, so a record
 * accepted by a person and one promoted by policy are written identically and audited identically.
 * Nothing else in the codebase inserts into kb_entries, client_corpus or claims.
 */

const KB_KINDS = new Set(['fact', 'sop', 'experiment', 'playbook', 'case_study', 'metric']);

/**
 * Raised when no store claims a candidate's kind. Callers turn this into a review item rather
 * than letting the candidate be marked promoted while landing nowhere.
 */
class UnhandledKindError extends Error {
  constructor(kind, candidateId) {
    super(`no curated store handles candidate kind "${kind}" (candidate ${candidateId})`);
    this.name = 'UnhandledKindError';
    this.kind = kind;
    this.candidateId = candidateId;
  }
}

function promote(db, candidateId, { actor = 'curation_worker', reason = 'promoted', detail = null, confidence = null } = {}) {
  const candidate = get(db, 'SELECT * FROM candidates WHERE id = ?', candidateId);
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
  if (candidate.state === 'promoted') return { candidateId, alreadyPromoted: true };

  const artifact = get(db, 'SELECT * FROM staging_artifacts WHERE id = ?', candidate.artifact_id);
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', artifact.source_id);
  const payload = json(artifact.payload_json, {});
  const body = detail ? `${candidate.body}\n\n---\nReviewer detail: ${detail}` : candidate.body;
  const result = { candidateId };

  if (policy.CLIENT_RECORD_KINDS.has(candidate.kind) && candidate.client_id) {
    // Client material: snippet + ref into the client corpus, raw stays in staging.
    result.corpusId = clientCorpus.index(db, {
      clientId: candidate.client_id,
      kind: payload.kind || 'doc',
      title: candidate.title,
      snippet: payload.snippet || payload.summary || body,
      sourceRef: artifact.id,
      metadata: {
        system: payload.system, occurred_at: payload.occurred_at,
        participants: payload.participants, artifact_uri: artifact.uri,
      },
      access: payload.access || {},
    });
  } else if (KB_KINDS.has(candidate.kind)) {
    result.kbEntryId = domainKb.create(db, {
      domain: candidate.domain,
      type: candidate.kind === 'metric' ? 'fact' : candidate.kind,
      title: candidate.title,
      body,
      clientScope: candidate.client_id || 'shared',
      confidence: confidence ?? candidate.trust,
      candidateId: candidate.id,
      actor,
    });

    // Every promoted KB entry gets a cited claim: the evidence ledger is not optional.
    result.claimId = evidence.assert(db, {
      statement: candidate.title,
      kbEntryId: result.kbEntryId,
      domain: candidate.domain,
      confidence: confidence ?? candidate.trust,
      citations: [{
        artifactId: artifact.id,
        sourceId: source.id,
        locator: artifact.uri,
        quote: String(payload.text || payload.summary || candidate.body || candidate.title).slice(0, 500),
        observedAt: artifact.fetched_at,
      }],
    });
  } else if (candidate.kind !== 'signal') {
    // 'signal' candidates are already in the Market Activity Store, so they have a home.
    // Anything else reaching here would be marked promoted while landing in no store at all.
    throw new UnhandledKindError(candidate.kind, candidate.id);
  }

  run(db, 'UPDATE candidates SET state = ? WHERE id = ?', 'promoted', candidate.id);
  audit.record(db, {
    objectType: 'candidate', objectId: candidate.id,
    from: candidate.state, to: 'promoted', actor, reason,
  });
  return result;
}

function decline(db, candidateId, { actor, reason = 'declined by reviewer' }) {
  const candidate = get(db, 'SELECT state FROM candidates WHERE id = ?', candidateId);
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
  run(db, 'UPDATE candidates SET state = ? WHERE id = ?', 'declined', candidateId);
  run(db, `UPDATE staging_artifacts SET state = 'rejected' WHERE id =
             (SELECT artifact_id FROM candidates WHERE id = ?)`, candidateId);
  audit.record(db, { objectType: 'candidate', objectId: candidateId, from: candidate.state, to: 'declined', actor, reason });
  return { candidateId, declinedAt: now() };
}

module.exports = { promote, decline, KB_KINDS, UnhandledKindError };
