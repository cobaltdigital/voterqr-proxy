'use strict';

/**
 * Connector registry.
 *
 * Contract every connector implements:
 *   {
 *     name, vendor, domain,
 *     credentials: string[],        // env var names; presence is checked before a call is attempted
 *     costCentsPerCall: number,     // logged per run so cost is visible per source
 *     freshnessHours: number,       // how stale data from this vendor may be before a refetch
 *     async fetch({ source, config, credentials, since }) -> { records: Record[], costCents? }
 *   }
 *
 * Record shape:
 *   { key, title, kind: 'metric'|'signal'|'fact'|'doc', subject, signal, value, unit,
 *     observed_at, channel, body?, meta? }
 *
 * `kind: 'signal'` records are also appended to the Market Activity Store by the runner.
 */

const mock = require('./mock');
const pagespeed = require('./pagespeed');
const stubs = require('./stubs');

const registry = new Map();
const register = (connector) => registry.set(connector.name, connector);

register(mock);
register(pagespeed);
for (const stub of stubs.all) register(stub);

function get(name) {
  const connector = registry.get(name);
  if (!connector) throw new Error(`unknown connector: ${name} (registered: ${[...registry.keys()].join(', ')})`);
  return connector;
}

const list = () => [...registry.values()].map(({ name, vendor, domain, credentials, costCentsPerCall, freshnessHours, implemented }) =>
  ({ name, vendor, domain, credentials, costCentsPerCall, freshnessHours, implemented: implemented !== false }));

/** Reads declared credentials out of the environment; missing ones are reported, never guessed. */
function resolveCredentials(connector, env = process.env) {
  const values = {};
  const missing = [];
  for (const key of connector.credentials || []) {
    if (env[key]) values[key] = env[key];
    else missing.push(key);
  }
  return { values, missing };
}

module.exports = { get, list, register, registry, resolveCredentials };
