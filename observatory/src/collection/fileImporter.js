'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { json } = require('../core/util');
const { logger } = require('../core/log');
const { startRun, finishRun, writeArtifact } = require('./artifacts');

const log = logger('file-importer');
const PARSER_VERSION = '1.0.0';

// Text formats are parsed inline. Binary formats (PDF, images, audio) are recorded as
// offload refs: the map's "OCR/transcription offload" — a downstream job fills in the text.
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html']);
const OFFLOAD_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.mp4', '.wav', '.m4a']);

function parseDelimited(text, delimiter) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(delimiter).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(delimiter);
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] || '').trim()]));
  });
  return { header, rows };
}

function parseFile(file) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);

  if (OFFLOAD_EXT.has(ext)) {
    const stat = fs.statSync(file);
    return {
      mediaType: ext === '.pdf' ? 'application/pdf' : 'application/octet-stream',
      rawRef: `file://${path.resolve(file)}`,
      payload: {
        title: base,
        extract_status: 'pending_offload',   // OCR / transcription job picks this up
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
      },
      raw: `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}`,
      parser: 'file.offload',
    };
  }

  if (!TEXT_EXT.has(ext)) return null;
  const text = fs.readFileSync(file, 'utf8');

  if (ext === '.csv' || ext === '.tsv') {
    const table = parseDelimited(text, ext === '.csv' ? ',' : '\t');
    return {
      mediaType: ext === '.csv' ? 'text/csv' : 'text/tab-separated-values',
      payload: { title: base, table_header: table.header, row_count: table.rows.length, rows: table.rows.slice(0, 500) },
      raw: text,
      parser: 'file.table',
    };
  }

  if (ext === '.json') {
    return { mediaType: 'application/json', payload: { title: base, data: JSON.parse(text) }, raw: text, parser: 'file.json' };
  }

  const title = (text.match(/^#\s+(.+)$/m) || [, base])[1];
  return { mediaType: 'text/plain', payload: { title, text: text.slice(0, 40000) }, raw: text, parser: 'file.text' };
}

function listFiles(dir, recursive) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? listFiles(full, recursive) : [];
    return [full];
  });
}

/** File Importer — PDF/text/table extraction, media offload refs. */
async function collect(db, source) {
  const config = json(source.config_json, {});
  const files = config.files || listFiles(config.dir || 'fixtures', config.recursive !== false);
  const runId = startRun(db, source, 'file_importer');
  const started = Date.now();
  let items = 0;

  try {
    for (const file of files) {
      const parsed = parseFile(file);
      if (!parsed) { log.debug('skipped unsupported file', { file }); continue; }
      const { duplicate } = writeArtifact(db, {
        sourceId: source.id,
        runId,
        uri: `file://${path.resolve(file)}`,
        mediaType: parsed.mediaType,
        payload: parsed.payload,
        raw: parsed.raw,
        rawRef: parsed.rawRef || null,
        parser: parsed.parser,
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

module.exports = { collect, parseFile, parseDelimited, listFiles, PARSER_VERSION };
