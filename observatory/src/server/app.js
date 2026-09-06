'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const dbModule = require('../db');
const { logger } = require('../core/log');
const policy = require('../core/policy');
const pipeline = require('../pipeline');
const collection = require('../collection');
const connectors = require('../collection/connectors');
const review = require('../staging/review');
const domainKb = require('../stores/domainKb');
const clientCorpus = require('../stores/clientCorpus');
const evidence = require('../stores/evidenceLedger');
const marketActivity = require('../stores/marketActivity');
const trendsStore = require('../stores/trendsStore');
const inquiryStore = require('../stores/inquiryStore');
const knowledgeGraph = require('../stores/knowledgeGraph');
const reasoningLayer = require('../reasoning/reasoningLayer');
const workflows = require('../reasoning/workflows');
const annotations = require('../reasoning/annotations');
const reporting = require('../reasoning/reporting');
const strategy = require('../reasoning/strategy');
const audit = require('../core/audit');

const log = logger('server');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Identity comes from headers in this skeleton so the whole surface is exercisable with curl.
 * Swap `principalFrom` for real session/SSO lookup — nothing downstream changes, because every
 * store already takes a principal rather than trusting its caller.
 */
function principalFrom(req) {
  const headers = req.headers;
  const clients = (headers['x-observatory-clients'] || process.env.OBSERVATORY_DEV_CLIENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return policy.principal({
    id: headers['x-observatory-actor'] || process.env.OBSERVATORY_DEV_ACTOR || 'dev@local',
    role: headers['x-observatory-role'] || process.env.OBSERVATORY_DEV_ROLE || 'admin',
    clientScope: clients.length ? clients : ['*'],
  });
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 2_000_000) { reject(new Error('request body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error(`invalid JSON body: ${err.message}`)); }
  });
  req.on('error', reject);
});

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
  return true;
}

/** Routes are `[method, pattern, handler]`; `:param` segments land in `params`. */
function match(pattern, pathname) {
  const p = pattern.split('/');
  const s = pathname.split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

function buildRoutes(db) {
  return [
    ['GET', '/api/health', () => ({ ok: true, db: db.__file })],
    ['GET', '/api/overview', () => pipeline.overview(db)],

    ['GET', '/api/sources', () => ({
      sources: dbModule.all(db, 'SELECT * FROM sources ORDER BY kind, name'),
      connectors: connectors.list(),
    })],
    ['POST', '/api/collect', async (ctx) => (ctx.body.sourceId
      ? collection.collectSource(db, ctx.body.sourceId, { force: ctx.body.force })
      : collection.collectAll(db, { kind: ctx.body.kind, force: ctx.body.force }))],
    ['POST', '/api/pipeline', async (ctx) => pipeline.runAll(db, { skipCollection: ctx.body.skipCollection })],

    ['GET', '/api/review', (ctx) => ({ items: review.open(db, { severity: ctx.query.get('severity') }) })],
    ['GET', '/api/review/:id', (ctx) => ({
      item: review.byId(db, ctx.params.id),
      decisions: review.decisionsFor(db, ctx.params.id),
    })],
    ['POST', '/api/review/:id/decide', (ctx) => review.decide(db, ctx.params.id, {
      principal: ctx.principal,
      decision: ctx.body.decision,
      detail: ctx.body.detail,
      rationale: ctx.body.rationale,
      supersedesId: ctx.body.supersedesId,
    })],

    ['GET', '/api/kb', (ctx) => ({
      entries: ctx.query.get('q')
        ? domainKb.search(db, ctx.query.get('q'), { domain: ctx.query.get('domain'), limit: 25 })
        : domainKb.current(db, { domain: ctx.query.get('domain'), type: ctx.query.get('type'), limit: 100 }),
      stats: domainKb.stats(db),
    })],
    ['GET', '/api/kb/:id', (ctx) => ({
      entry: domainKb.byId(db, ctx.params.id),
      evidence: evidence.forEntry(db, ctx.params.id),
      annotations: annotations.forObject(db, 'kb_entry', ctx.params.id),
      audit: audit.history(db, 'kb_entry', ctx.params.id),
    })],

    ['GET', '/api/corpus/:clientId', (ctx) => ({
      rows: clientCorpus.forClient(db, ctx.principal, ctx.params.clientId, { limit: 100 }),
    })],
    ['GET', '/api/evidence/:claimId', (ctx) => evidence.chain(db, ctx.params.claimId)],
    ['GET', '/api/market', (ctx) => (ctx.query.get('subject')
      ? { series: marketActivity.series(db, ctx.query.get('subject'), ctx.query.get('signal')) }
      : { subjects: marketActivity.subjects(db), recent: marketActivity.recent(db, 25) })],
    ['GET', '/api/trends', () => ({ detections: trendsStore.recent(db, 50), watchlist: trendsStore.watchlist(db) })],

    ['GET', '/api/inquiries', () => ({ open: inquiryStore.open(db, { limit: 100 }), stats: inquiryStore.stats(db) })],
    ['POST', '/api/inquiries', (ctx) => ({
      inquiryId: inquiryStore.ask(db, {
        question: ctx.body.question, origin: 'human', domain: ctx.body.domain,
        clientId: ctx.body.clientId, createdBy: ctx.principal.id,
      }),
    })],

    ['POST', '/api/ask', (ctx) => {
      const result = reasoningLayer.ask(db, {
        question: ctx.body.question, principal: ctx.principal,
        clientId: ctx.body.clientId, domain: ctx.body.domain,
      });
      const drafts = ctx.body.draftActions ? workflows.fromReasoning(db, result, { clientId: ctx.body.clientId }) : [];
      return { ...result, rendered: reasoningLayer.render(result), drafts };
    }],

    ['GET', '/api/workflows', (ctx) => ({ drafts: workflows.list(db, { status: ctx.query.get('status') }) })],
    ['POST', '/api/workflows/:id/approve', (ctx) => ({
      draftId: workflows.approve(db, ctx.params.id, { principal: ctx.principal, note: ctx.body.note }),
    })],
    ['POST', '/api/workflows/:id/reject', (ctx) => ({
      draftId: workflows.reject(db, ctx.params.id, { principal: ctx.principal, note: ctx.body.note }),
    })],

    ['POST', '/api/annotations', (ctx) => ({
      annotationId: annotations.add(db, {
        objectType: ctx.body.objectType, objectId: ctx.body.objectId,
        kind: ctx.body.kind, note: ctx.body.note, actor: ctx.principal.id,
      }),
    })],
    ['GET', '/api/annotations/:type/:id', (ctx) => ({ annotations: annotations.forObject(db, ctx.params.type, ctx.params.id) })],

    ['GET', '/api/reports', () => ({ reports: reporting.list(db) })],
    ['POST', '/api/reports/weekly', (ctx) => reporting.weeklyBrief(db, { safe: Boolean(ctx.body.safe), actor: ctx.principal.id })],
    ['POST', '/api/briefs', (ctx) => strategy.opportunityBrief(db, {
      principal: ctx.principal, clientId: ctx.body.clientId,
      domain: ctx.body.domain, publicSafe: Boolean(ctx.body.publicSafe),
    })],

    ['GET', '/api/graph', (ctx) => (ctx.query.get('q')
      ? { results: knowledgeGraph.search(db, ctx.query.get('q'), { type: ctx.query.get('type') }) }
      : knowledgeGraph.stats(db))],
    ['GET', '/api/graph/:nodeId', (ctx) => knowledgeGraph.neighbours(db, ctx.params.nodeId)],
    ['GET', '/api/audit/:type/:id', (ctx) => ({ history: audit.history(db, ctx.params.type, ctx.params.id) })],
  ];
}

function createServer(db) {
  const routes = buildRoutes(db);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && !pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return;

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const params = match(pattern, pathname);
      if (!params) continue;
      try {
        const ctx = {
          params,
          query: url.searchParams,
          body: method === 'GET' ? {} : await readBody(req),
          principal: principalFrom(req),
          req,
        };
        return json(res, 200, await handler(ctx));
      } catch (err) {
        const status = err.status || (err instanceof policy.PolicyError ? 403 : 400);
        log.warn('request failed', { path: pathname, error: err.message });
        return json(res, status, { error: err.message, code: err.code || 'error' });
      }
    }
    return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  });
}

function start({ port = process.env.PORT || 4000, db = dbModule.open() } = {}) {
  const server = createServer(db);
  server.listen(port, () => log.info(`observatory listening on http://localhost:${port}`));
  return server;
}

module.exports = { createServer, start, principalFrom };
