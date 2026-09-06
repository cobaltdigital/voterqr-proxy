'use strict';

/**
 * Declared-but-unimplemented vendors from the Marketing APIs box.
 *
 * Each stub carries the real metadata the rest of the system needs — credentials, cost per
 * call, freshness budget, which domain its data routes to, and the shape of the records it
 * will emit. Calling one without an implementation fails loudly with the exact next step
 * rather than silently producing nothing.
 *
 * To implement one: replace `fetch` with a real request that returns `{ records, costCents }`
 * in the registry's record shape (see pagespeed.js for a worked example) and drop
 * `implemented: false`.
 */

function notImplemented(spec) {
  return async function fetch() {
    throw new Error(
      `connector "${spec.name}" (${spec.vendor}) is declared but not implemented — ` +
      `implement fetch() in src/collection/connectors/stubs.js or point the source at the "mock" connector. ` +
      `Credentials it expects: ${spec.credentials.join(', ') || 'none'}. ` +
      `Expected records: ${spec.emits.join(', ')}.`
    );
  };
}

const SPECS = [
  {
    name: 'dataforseo', vendor: 'DataForSEO', domain: 'seo',
    credentials: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    costCentsPerCall: 3, freshnessHours: 24,
    emits: ['serp_position', 'keyword_volume', 'serp_feature_presence'],
  },
  {
    name: 'gsc', vendor: 'Google Search Console', domain: 'seo',
    credentials: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GSC_REFRESH_TOKEN'],
    costCentsPerCall: 0, freshnessHours: 48,
    emits: ['clicks', 'impressions', 'ctr', 'avg_position'],
  },
  {
    name: 'ga4', vendor: 'Google Analytics 4', domain: 'seo',
    credentials: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GA4_PROPERTY_ID', 'GA4_REFRESH_TOKEN'],
    costCentsPerCall: 0, freshnessHours: 24,
    emits: ['sessions', 'conversions', 'engagement_rate', 'channel_mix'],
  },
  {
    name: 'google_ads', vendor: 'Google Ads', domain: 'paid_ads',
    credentials: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_REFRESH_TOKEN'],
    costCentsPerCall: 0, freshnessHours: 12,
    emits: ['spend', 'impressions', 'avg_cpc_cents', 'conversion_rate', 'impression_share'],
  },
  {
    name: 'gbp', vendor: 'Google Business Profile', domain: 'local_business',
    credentials: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GBP_ACCOUNT_ID'],
    costCentsPerCall: 0, freshnessHours: 24,
    emits: ['profile_views', 'calls', 'direction_requests', 'review_count', 'review_rating'],
  },
  {
    name: 'crux', vendor: 'Chrome UX Report', domain: 'web_design',
    credentials: ['CRUX_API_KEY'],
    costCentsPerCall: 0, freshnessHours: 168,
    emits: ['lcp_p75', 'inp_p75', 'cls_p75'],
  },
  {
    name: 'callrail', vendor: 'CallRail', domain: 'local_business',
    credentials: ['CALLRAIL_API_KEY', 'CALLRAIL_ACCOUNT_ID'],
    costCentsPerCall: 0, freshnessHours: 6,
    emits: ['calls', 'first_time_callers', 'call_duration', 'source_attribution'],
  },
  {
    name: 'meta_ads', vendor: 'Meta Marketing API', domain: 'paid_ads',
    credentials: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'],
    costCentsPerCall: 0, freshnessHours: 12,
    emits: ['spend', 'reach', 'frequency', 'cpm_cents', 'result_rate'],
  },
  {
    name: 'social', vendor: 'Social platform APIs', domain: 'social',
    credentials: ['SOCIAL_API_TOKEN'],
    costCentsPerCall: 0, freshnessHours: 24,
    emits: ['followers', 'engagement_rate', 'post_reach'],
  },
];

const all = SPECS.map((spec) => ({ ...spec, implemented: false, fetch: notImplemented(spec) }));

module.exports = { all, SPECS };
