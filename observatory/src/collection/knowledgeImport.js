'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { json } = require('../core/util');
const { startRun, finishRun, writeArtifact } = require('./artifacts');
const { listFiles } = require('./fileImporter');
const { routeDomain } = require('../staging/routing');

const PARSER_VERSION = '1.0.0';

/**
 * Knowledge Import — SOPs, tests, docs, case studies, playbooks, with domain routing.
 *
 * Front matter wins when present; otherwise the domain is inferred from the text. Anything
 * that cannot be routed confidently is left `unrouted`, which the curation worker turns into
 * a human review item rather than filing it in the wrong domain.
 */

// Minimal `---\nkey: value\n---` front matter reader; keeps the importer dependency-free.
function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2].trim();
    meta[kv[1]] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : value;
  }
  return { meta, body: text.slice(match[0].length) };
}

const TYPE_BY_HINT = [
  [/\bsop\b|standard operating|checklist|procedure/i, 'sop'],
  [/\bexperiment\b|hypothesis|a\/b test|variant/i, 'experiment'],
  [/case study|client result|outcome/i, 'case_study'],
  [/playbook|strategy guide/i, 'playbook'],
];

function inferType(title, body) {
  for (const [pattern, type] of TYPE_BY_HINT) {
    if (pattern.test(title) || pattern.test(body.slice(0, 800))) return type;
  }
  return 'fact';
}

async function collect(db, source) {
  const config = json(source.config_json, {});
  const dir = config.dir || 'fixtures/knowledge';
  const files = config.files || listFiles(dir, config.recursive !== false).filter((f) => /\.(md|txt)$/i.test(f));

  const runId = startRun(db, source, 'knowledge_import');
  const started = Date.now();
  let items = 0;

  try {
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontMatter(text);
      const title = meta.title || (body.match(/^#\s+(.+)$/m) || [, path.basename(file)])[1];
      const domain = meta.domain || routeDomain(`${title}\n${body}`).domain;

      const { duplicate } = writeArtifact(db, {
        sourceId: source.id,
        runId,
        uri: `file://${path.resolve(file)}`,
        mediaType: 'text/markdown',
        payload: {
          title,
          domain,
          type: meta.type || inferType(title, body),
          status: meta.status || 'current',
          supersedes: meta.supersedes || null,
          owner: meta.owner || null,
          tags: meta.tags || [],
          text: body.trim(),
        },
        raw: text,
        parser: 'knowledge.markdown',
        parserVersion: PARSER_VERSION,
      });
      if (!duplicate) items += 1;
    }
    finishRun(db, runId, { status: 'ok', items, latencyMs: Date.now() - started });
    return { runId, items };
  } catch (err) {
    finishRun(db, runId, { status: 'failed', items, latencyMs: Date.now() - started, error: err.message });
    throw err;
  }
}

module.exports = { collect, parseFrontMatter, inferType, PARSER_VERSION };
