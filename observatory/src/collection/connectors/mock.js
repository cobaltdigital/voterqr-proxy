'use strict';
const { sha256 } = require('../../core/util');

/**
 * Deterministic synthetic connector. Generates a reproducible daily series per subject so
 * the whole pipeline — curation, trends, reporting — can be exercised offline and in tests.
 * Configure via source config: { subjects: [{ subject, signal, unit, base, drift, spike_on_day }] }
 */

// Hash-derived pseudo-noise: same inputs always produce the same series.
function noise(seed, dayIndex) {
  const h = sha256(`${seed}:${dayIndex}`);
  return parseInt(h.slice(0, 8), 16) / 0xffffffff; // 0..1
}

async function fetch({ source, config, since }) {
  const days = config.days || 28;
  const subjects = config.subjects || [
    { subject: 'core web vitals', signal: 'lcp_ms', unit: 'ms', base: 2400, drift: -20, channel: 'platform', domain: 'web_design' },
    { subject: 'local pack rank', signal: 'avg_position', unit: 'rank', base: 6, drift: -0.05, channel: 'serp', domain: 'local_business' },
    { subject: 'ai overview presence', signal: 'appearance_rate', unit: 'pct', base: 12, drift: 0.9, channel: 'serp', domain: 'ai', spikeOnDay: 26 },
    { subject: 'paid cpc', signal: 'avg_cpc_cents', unit: 'cents', base: 320, drift: 1.5, channel: 'ads', domain: 'paid_ads' },
  ];

  const end = since ? new Date(since) : new Date();
  const records = [];

  for (const spec of subjects) {
    for (let d = days - 1; d >= 0; d -= 1) {
      const observedAt = new Date(end.getTime() - d * 86400000);
      const dayIndex = days - 1 - d;
      const wobble = (noise(`${source.id}:${spec.subject}`, dayIndex) - 0.5) * (spec.base * 0.04);
      let value = spec.base + spec.drift * dayIndex + wobble;
      if (spec.spikeOnDay != null && dayIndex >= spec.spikeOnDay) value *= spec.spikeMultiplier || 2.2;

      records.push({
        key: `${spec.subject}:${spec.signal}:${observedAt.toISOString().slice(0, 10)}`,
        kind: 'signal',
        title: `${spec.subject} ${spec.signal}`,
        subject: spec.subject,
        signal: spec.signal,
        value: Math.round(value * 100) / 100,
        unit: spec.unit,
        channel: spec.channel || 'platform',
        domain: spec.domain,
        observed_at: observedAt.toISOString(),
        meta: { synthetic: true },
      });
    }
  }
  return { records, costCents: 0 };
}

module.exports = {
  name: 'mock',
  vendor: 'observatory',
  domain: null,
  credentials: [],
  costCentsPerCall: 0,
  freshnessHours: 24,
  fetch,
};
