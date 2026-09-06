'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { json, now } = require('../core/util');
const { logger } = require('../core/log');
const fetchPolicy = require('./fetchPolicy');
const { startRun, finishRun, writeArtifact } = require('./artifacts');

const log = logger('scraper');
const PARSER_VERSION = '1.1.0';

/** Strips scripts/styles/tags and collapses whitespace. Swap for a browser fetch when JS rendering matters. */
function extractText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const extractTitle = (html) => (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();

function extractHeadings(html) {
  const out = [];
  const re = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 25) {
    const text = extractText(m[2]);
    if (text) out.push({ level: Number(m[1]), text });
  }
  return out;
}

/** Offline/dev mode: serve a fixture file instead of hitting the network. */
function readFixture(fixture) {
  const file = path.isAbsolute(fixture) ? fixture : path.join(process.cwd(), fixture);
  return fs.readFileSync(file, 'utf8');
}

async function fetchDocument(source, url) {
  const config = json(source.config_json, {});
  if (config.fixture || process.env.OBSERVATORY_OFFLINE === '1') {
    if (!config.fixture) throw new Error(`offline mode and no fixture configured for ${source.id}`);
    return { body: readFixture(config.fixture), status: 200, offline: true };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms || 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': config.user_agent || 'ObservatoryBot/1.0 (+contact in source config)' },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return { body, status: res.status, offline: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Scraper Worker — owned pages, competitor pages, RSS/news.
 * One artifact per configured URL; policy decides whether each fetch is allowed at all.
 */
async function collect(db, source) {
  const config = json(source.config_json, {});
  const urls = config.urls || (config.url ? [config.url] : []);
  const runId = startRun(db, source, 'scraper');
  const started = Date.now();
  let items = 0;
  const skipped = [];

  try {
    for (const url of urls) {
      const verdict = fetchPolicy.check(source, url);
      if (!verdict.ok) {
        skipped.push({ url, reason: verdict.reason });
        log.warn('fetch skipped by policy', { url, reason: verdict.reason });
        continue;
      }
      const { body } = await fetchDocument(source, url);
      const text = extractText(body);
      const { duplicate } = writeArtifact(db, {
        sourceId: source.id,
        runId,
        uri: url,
        mediaType: 'text/html',
        raw: body,
        payload: {
          url,
          title: extractTitle(body) || url,
          headings: extractHeadings(body),
          text: text.slice(0, 20000),
          word_count: text.split(' ').length,
          fetched_at: now(),
        },
        parser: 'scraper.html',
        parserVersion: PARSER_VERSION,
        costCents: config.cost_cents_per_fetch || 0,
      });
      if (!duplicate) items += 1;
    }
    finishRun(db, runId, { status: 'ok', items, latencyMs: Date.now() - started });
    return { runId, items, skipped };
  } catch (err) {
    finishRun(db, runId, { status: 'failed', items, latencyMs: Date.now() - started, error: err.message });
    throw err;
  }
}

module.exports = { collect, extractText, extractTitle, extractHeadings, PARSER_VERSION };
