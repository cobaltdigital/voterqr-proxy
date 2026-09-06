'use strict';
const { json } = require('../core/util');
const { logger } = require('../core/log');
const stats = require('./stats');
const marketActivity = require('../stores/marketActivity');
const trendsStore = require('../stores/trendsStore');
const inquiryStore = require('../stores/inquiryStore');
const review = require('./review');

const log = logger('trends');

/**
 * Trends Worker — detects patterns, anomalies and cross-domain correlations in watched market
 * activity, then routes each detection to the right next step: watch it, propose an experiment,
 * or put it in front of a human.
 *
 * It reads the append-only Market Activity Store and writes detections; it never edits observations.
 */

const DEFAULTS = {
  minPoints: 10,          // below this a "trend" is noise
  anomalyZ: 3,            // standard deviations from the recent baseline
  patternChange: 0.15,    // ≥15% modelled movement across the window
  patternR2: 0.5,         // …and the line has to actually fit
  correlation: 0.85,
  cooldownHours: 72,      // do not re-alert the same subject daily while a shift persists
};

const domainOf = (rows) => {
  for (const row of rows) {
    const domain = json(row.meta_json, {}).domain;
    if (domain) return domain;
  }
  return null;
};

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function detectAnomaly(db, { subject, signal, rows, options }) {
  const values = rows.map((r) => r.value).filter((v) => v != null);
  if (values.length < options.minPoints) return null;

  const latest = values.at(-1);
  const baseline = values.slice(0, -1).slice(-30);
  const z = stats.zScore(latest, baseline);
  if (Math.abs(z) < options.anomalyZ) return null;
  if (trendsStore.alreadyDetected(db, { subject, kind: 'anomaly', withinHours: options.cooldownHours })) return null;

  const direction = z > 0 ? 'above' : 'below';
  return {
    kind: 'anomaly',
    subject,
    domain: domainOf(rows),
    score: Math.min(1, Math.abs(z) / 6),
    summary: `${subject} ${signal} is ${Math.abs(z).toFixed(1)}σ ${direction} its 30-observation baseline ` +
             `(${latest}${rows.at(-1).unit ? ' ' + rows.at(-1).unit : ''} vs mean ${stats.mean(baseline).toFixed(1)})`,
    windowStart: rows[0].observed_at,
    windowEnd: rows.at(-1).observed_at,
    evidence: rows.slice(-5).map((r) => ({ id: r.id, observed_at: r.observed_at, value: r.value, source_id: r.source_id })),
    action: 'review',   // a genuine outlier deserves eyes before anything is built on it
  };
}

function detectPattern(db, { subject, signal, rows, options }) {
  const values = rows.map((r) => r.value).filter((v) => v != null);
  if (values.length < options.minPoints) return null;

  const { slope, r2 } = stats.linearRegression(values);
  const base = Math.abs(stats.mean(values)) || 1;
  const change = (slope * values.length) / base;
  if (Math.abs(change) < options.patternChange || r2 < options.patternR2) return null;
  if (trendsStore.alreadyDetected(db, { subject, kind: 'pattern', withinHours: options.cooldownHours })) return null;

  return {
    kind: 'pattern',
    subject,
    domain: domainOf(rows),
    score: Math.min(1, Math.abs(change)) * r2,
    summary: `${subject} ${signal} moved ${pct(change)} across ${values.length} observations ` +
             `(slope ${slope.toFixed(3)}/obs, fit r²=${r2.toFixed(2)})`,
    windowStart: rows[0].observed_at,
    windowEnd: rows.at(-1).observed_at,
    evidence: rows.filter((_, i) => i % Math.ceil(rows.length / 5) === 0).map((r) => ({ id: r.id, observed_at: r.observed_at, value: r.value })),
    action: 'watch',
  };
}

/** Aligns two series by observation date so correlation compares like with like. */
function alignByDay(rowsA, rowsB) {
  const byDay = (rows) => new Map(rows.map((r) => [r.observed_at.slice(0, 10), r.value]));
  const ma = byDay(rowsA);
  const mb = byDay(rowsB);
  const a = [];
  const b = [];
  for (const [day, value] of ma) {
    if (!mb.has(day) || value == null || mb.get(day) == null) continue;
    a.push(value);
    b.push(mb.get(day));
  }
  return { a, b };
}

function detectCorrelations(db, seriesList, options) {
  const found = [];
  for (let i = 0; i < seriesList.length; i += 1) {
    for (let j = i + 1; j < seriesList.length; j += 1) {
      const x = seriesList[i];
      const y = seriesList[j];
      if (x.subject === y.subject) continue;

      const { a, b } = alignByDay(x.rows, y.rows);
      if (a.length < options.minPoints) continue;

      const r = stats.pearson(a, b);
      if (Math.abs(r) < options.correlation) continue;

      const crossDomain = x.domain && y.domain && x.domain !== y.domain;
      const subject = `${x.subject} ↔ ${y.subject}`;
      if (trendsStore.alreadyDetected(db, { subject, kind: 'correlation', withinHours: options.cooldownHours })) continue;

      found.push({
        kind: 'correlation',
        subject,
        domain: x.domain || y.domain,
        score: Math.abs(r),
        summary: `${x.subject} (${x.signal}) and ${y.subject} (${y.signal}) move ${r > 0 ? 'together' : 'inversely'} ` +
                 `(r=${r.toFixed(2)}, n=${a.length})${crossDomain ? ` — across ${x.domain} and ${y.domain}` : ''}`,
        windowStart: x.rows[0].observed_at,
        windowEnd: x.rows.at(-1).observed_at,
        evidence: [{ subject: x.subject, signal: x.signal }, { subject: y.subject, signal: y.signal }],
        // Correlation is a hypothesis, not a finding: it becomes an experiment, never a KB fact.
        action: 'experiment',
      });
    }
  }
  return found;
}

/** Each detection's action decides where it goes next. */
function dispatch(db, detection, detectionId) {
  if (detection.action === 'watch') {
    trendsStore.watch(db, detectionId, detection.subject);
    return;
  }
  if (detection.action === 'experiment') {
    inquiryStore.ask(db, {
      question: `Does the relationship hold: ${detection.summary}? Worth an experiment?`,
      origin: 'ai',
      domain: detection.domain,
      createdBy: 'trends_worker',
      status: 'experiment',
    });
    trendsStore.watch(db, detectionId, detection.subject);
    return;
  }
  if (detection.action === 'review') {
    review.enqueue(db, {
      reason: 'escalated',
      severity: 'critical',
      detail: `Trend anomaly: ${detection.summary}\nDetection ${detectionId}. Confirm the signal before acting on it.`,
    });
    inquiryStore.ask(db, {
      question: `What caused: ${detection.summary}?`,
      origin: 'ai',
      domain: detection.domain,
      createdBy: 'trends_worker',
      status: 'open',
    });
  }
}

function run_(db, opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const summary = { series: 0, anomalies: 0, patterns: 0, correlations: 0 };

  const seriesList = marketActivity.subjects(db)
    .map(({ subject, signal }) => {
      const rows = marketActivity.series(db, subject, signal);
      return { subject, signal, rows, domain: domainOf(rows) };
    })
    .filter((s) => s.rows.length >= options.minPoints);

  summary.series = seriesList.length;

  for (const series of seriesList) {
    for (const detector of [detectAnomaly, detectPattern]) {
      const detection = detector(db, { ...series, options });
      if (!detection) continue;
      const detectionId = trendsStore.record(db, detection);
      dispatch(db, detection, detectionId);
      summary[detection.kind === 'anomaly' ? 'anomalies' : 'patterns'] += 1;
    }
  }

  for (const detection of detectCorrelations(db, seriesList, options)) {
    const detectionId = trendsStore.record(db, detection);
    dispatch(db, detection, detectionId);
    summary.correlations += 1;
  }

  log.info('trends pass complete', summary);
  return summary;
}

module.exports = { run: run_, detectAnomaly, detectPattern, detectCorrelations, alignByDay, DEFAULTS };
