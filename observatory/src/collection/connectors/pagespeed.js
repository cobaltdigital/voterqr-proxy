'use strict';

/**
 * PageSpeed Insights + CrUX field data. A fully implemented connector, kept as the
 * reference for what the vendor stubs should grow into: real request, real cost/latency,
 * records normalised to the registry's record shape before anything else sees them.
 *
 * Config: { urls: string[], strategy: 'mobile'|'desktop' }
 * Credential PAGESPEED_API_KEY is optional (unkeyed requests are heavily rate limited).
 */

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

const METRICS = [
  ['LARGEST_CONTENTFUL_PAINT_MS', 'lcp_ms', 'ms'],
  ['INTERACTION_TO_NEXT_PAINT', 'inp_ms', 'ms'],
  ['CUMULATIVE_LAYOUT_SHIFT_SCORE', 'cls', 'score'],
  ['FIRST_CONTENTFUL_PAINT_MS', 'fcp_ms', 'ms'],
];

async function fetchOne(url, strategy, apiKey) {
  const params = new URLSearchParams({ url, strategy });
  if (apiKey) params.set('key', apiKey);
  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`pagespeed HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetch_({ config, credentials }) {
  const strategy = config.strategy || 'mobile';
  const urls = config.urls || (config.url ? [config.url] : []);
  const observedAt = new Date().toISOString();
  const records = [];

  for (const url of urls) {
    const data = await fetchOne(url, strategy, credentials.PAGESPEED_API_KEY);
    const field = (data.loadingExperience && data.loadingExperience.metrics) || {};
    const lighthouse = (data.lighthouseResult && data.lighthouseResult.categories) || {};

    for (const [apiKey, signal, unit] of METRICS) {
      const metric = field[apiKey];
      if (!metric) continue;
      records.push({
        key: `${url}:${signal}:${observedAt.slice(0, 10)}`,
        kind: 'signal',
        title: `${url} ${signal}`,
        subject: url,
        signal,
        value: metric.percentile,
        unit,
        channel: 'platform',
        domain: 'web_design',
        observed_at: observedAt,
        meta: { strategy, category: metric.category },
      });
    }

    if (lighthouse.performance) {
      records.push({
        key: `${url}:lighthouse_performance:${observedAt.slice(0, 10)}`,
        kind: 'signal',
        title: `${url} lighthouse performance`,
        subject: url,
        signal: 'lighthouse_performance',
        value: Math.round(lighthouse.performance.score * 100),
        unit: 'score',
        channel: 'platform',
        domain: 'web_design',
        observed_at: observedAt,
        meta: { strategy },
      });
    }
  }

  return { records, costCents: 0 };
}

module.exports = {
  name: 'pagespeed',
  vendor: 'Google PageSpeed / CrUX',
  domain: 'web_design',
  credentials: ['PAGESPEED_API_KEY'],
  optionalCredentials: ['PAGESPEED_API_KEY'],
  costCentsPerCall: 0,
  freshnessHours: 24,
  fetch: fetch_,
};
