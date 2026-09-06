'use strict';

/**
 * Programmatic entry point.
 *
 *   const observatory = require('observatory');
 *   const db = observatory.db.open();
 *   await observatory.pipeline.runAll(db);
 *   const answer = observatory.reasoning.ask(db, { question, principal });
 *
 * Every function takes the database handle explicitly — there is no ambient connection — so a
 * caller can run several databases (production, a replay, a test) in one process.
 */

module.exports = {
  db: require('./db'),
  policy: require('./core/policy'),
  jobs: require('./core/jobs'),
  audit: require('./core/audit'),
  util: require('./core/util'),

  collection: require('./collection'),
  connectors: require('./collection/connectors'),
  fetchPolicy: require('./collection/fetchPolicy'),

  curationWorker: require('./staging/curationWorker'),
  statusWorker: require('./staging/statusWorker'),
  trendsWorker: require('./staging/trendsWorker'),
  review: require('./staging/review'),
  promote: require('./staging/promote'),
  routing: require('./staging/routing'),

  domainKb: require('./stores/domainKb'),
  clientCorpus: require('./stores/clientCorpus'),
  evidenceLedger: require('./stores/evidenceLedger'),
  marketActivity: require('./stores/marketActivity'),
  inquiryStore: require('./stores/inquiryStore'),
  trendsStore: require('./stores/trendsStore'),
  knowledgeGraph: require('./stores/knowledgeGraph'),

  reasoning: require('./reasoning/reasoningLayer'),
  workflows: require('./reasoning/workflows'),
  annotations: require('./reasoning/annotations'),
  reporting: require('./reasoning/reporting'),
  strategy: require('./reasoning/strategy'),

  pipeline: require('./pipeline'),
  scheduler: require('./scheduler'),
  workers: require('./workers'),
  server: require('./server/app'),
};
