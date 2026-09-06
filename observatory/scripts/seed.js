'use strict';
const path = require('node:path');
const dbModule = require('../src/db');
const { id, now } = require('../src/core/util');

/**
 * Seeds sources and clients that exercise every collector and both promotion outcomes.
 * Deliberately includes material that must NOT auto-promote (pricing, guarantees, confidential
 * client notes) and a pair of documents that contradict each other, so a seeded run demonstrates
 * the review gate and the status worker rather than just a happy path.
 */

const root = (...parts) => path.join(__dirname, '..', ...parts);

const CLIENTS = [
  { id: 'northside-dental', name: 'Northside Dental', tier: 'growth' },
];

const SOURCES = [
  {
    id: 'src_internal_knowledge', kind: 'internal_knowledge', name: 'Internal knowledge base',
    collector: 'knowledge_import', trust: 0.85,
    config: { dir: root('fixtures', 'knowledge') },
  },
  {
    id: 'src_competitor_blog', kind: 'public_web', name: 'Competitor blog',
    collector: 'scraper', trust: 0.45, rateLimit: 10,
    config: {
      urls: ['https://competitor.example.com/blog/local-seo-quarter'],
      fixture: root('fixtures', 'pages', 'competitor-seo-post.html'),   // offline by default
      allow_hosts: ['competitor.example.com'],
    },
  },
  {
    id: 'src_client_exports', kind: 'files_media', name: 'Client exports (files)',
    collector: 'file_importer', trust: 0.7,
    config: { dir: root('fixtures', 'files') },
  },
  {
    id: 'src_market_signals', kind: 'marketing_api', name: 'Market signals (mock connector)',
    collector: 'api_connector', trust: 0.8,
    config: { connector: 'mock', days: 28, freshness_hours: 0 },
  },
  {
    id: 'src_pagespeed', kind: 'marketing_api', name: 'PageSpeed Insights', enabled: 0,
    collector: 'api_connector', trust: 0.9,
    config: { connector: 'pagespeed', urls: ['https://example.com/'], strategy: 'mobile' },
  },
  {
    id: 'src_northside_systems', kind: 'client_system', name: 'Northside Dental systems',
    collector: 'client_indexer', trust: 0.75, clientId: 'northside-dental',
    config: { dir: root('fixtures', 'client-docs'), client_id: 'northside-dental', system: 'mixed' },
  },
];

function seed(db = dbModule.open()) {
  const summary = { clients: 0, sources: 0, inquiries: 0 };

  for (const client of CLIENTS) {
    const exists = dbModule.get(db, 'SELECT id FROM clients WHERE id = ?', client.id);
    if (exists) continue;
    dbModule.run(db, 'INSERT INTO clients (id, name, tier, created_at) VALUES (?, ?, ?, ?)',
      client.id, client.name, client.tier, now());
    summary.clients += 1;
  }

  for (const source of SOURCES) {
    const exists = dbModule.get(db, 'SELECT id FROM sources WHERE id = ?', source.id);
    if (exists) continue;
    dbModule.run(db,
      `INSERT INTO sources (id, kind, name, collector, config_json, trust, rate_limit_per_min, enabled, client_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source.id, source.kind, source.name, source.collector, JSON.stringify(source.config || {}),
      source.trust ?? 0.5, source.rateLimit ?? 30, source.enabled ?? 1, source.clientId || null, now());
    summary.sources += 1;
  }

  // One human-submitted question, so the inquiry store is not empty before anyone uses the UI.
  const question = 'Is the local pack drop for cosmetic dentistry driven by the category change or by review velocity?';
  if (!dbModule.get(db, 'SELECT id FROM inquiries WHERE question = ?', question)) {
    dbModule.run(db, `INSERT INTO inquiries (id, question, origin, status, domain, client_id, created_by, created_at)
                      VALUES (?, ?, 'human', 'open', 'local_business', ?, 'seed', ?)`,
      id('inq'), question, 'northside-dental', now());
    summary.inquiries += 1;
  }

  return summary;
}

if (require.main === module) {
  const summary = seed();
  console.log(`seeded: ${summary.clients} clients, ${summary.sources} sources, ${summary.inquiries} inquiries`);
}

module.exports = { seed, SOURCES, CLIENTS };
