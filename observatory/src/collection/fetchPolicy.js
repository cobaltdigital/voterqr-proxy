'use strict';
const { json } = require('../core/util');

/**
 * Fetch policy for the scraper: host allow/deny plus a per-source token bucket.
 * The scraper refuses to fetch anything policy does not clear, so "politeness" is
 * a property of the collector rather than of whoever configured a source.
 */

const buckets = new Map();

function allowedHost(source, url) {
  const config = json(source.config_json, {});
  let host;
  try { host = new URL(url).hostname; } catch { return { ok: false, reason: 'invalid_url' }; }

  const deny = config.deny_hosts || [];
  if (deny.some((h) => host === h || host.endsWith(`.${h}`))) return { ok: false, reason: 'denied_host' };

  const allow = config.allow_hosts || [];
  if (allow.length && !allow.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  return { ok: true, host };
}

/** Token bucket, refilled continuously at rate_limit_per_min. */
function takeToken(source, at = Date.now()) {
  const capacity = Math.max(1, source.rate_limit_per_min || 30);
  const perMs = capacity / 60000;
  const bucket = buckets.get(source.id) || { tokens: capacity, updated: at };
  bucket.tokens = Math.min(capacity, bucket.tokens + (at - bucket.updated) * perMs);
  bucket.updated = at;
  if (bucket.tokens < 1) {
    buckets.set(source.id, bucket);
    return { ok: false, reason: 'rate_limited', retryInMs: Math.ceil((1 - bucket.tokens) / perMs) };
  }
  bucket.tokens -= 1;
  buckets.set(source.id, bucket);
  return { ok: true };
}

function check(source, url, at = Date.now()) {
  const host = allowedHost(source, url);
  if (!host.ok) return host;
  return takeToken(source, at);
}

const reset = () => buckets.clear();

module.exports = { check, allowedHost, takeToken, reset };
