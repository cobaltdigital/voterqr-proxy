#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
'use strict';
const dbModule = require('../src/db');
const policy = require('../src/core/policy');
const pipeline = require('../src/pipeline');
const collection = require('../src/collection');
const connectors = require('../src/collection/connectors');
const curationWorker = require('../src/staging/curationWorker');
const statusWorker = require('../src/staging/statusWorker');
const trendsWorker = require('../src/staging/trendsWorker');
const review = require('../src/staging/review');
const reasoningLayer = require('../src/reasoning/reasoningLayer');
const workflows = require('../src/reasoning/workflows');
const reporting = require('../src/reasoning/reporting');
const strategy = require('../src/reasoning/strategy');
const knowledgeGraph = require('../src/stores/knowledgeGraph');
const { seed } = require('../scripts/seed');

const args = process.argv.slice(2);
const command = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => {
  const [key, value] = a.replace(/^--/, '').split('=');
  return [key, value === undefined ? true : value];
}));

const actor = () => policy.principal({
  id: flags.actor || process.env.OBSERVATORY_ACTOR || 'cli',
  role: flags.role || 'admin',
  clientScope: ['*'],
});

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const USAGE = `observatory <command>

  migrate                      apply schema migrations
  seed                         insert demo clients and sources
  collect [sourceId] [--force] run collectors (all sources, or one)
  curate                       curation worker: dedupe, classify, route, promote or queue
  status                       status worker: contradictions and supersessions
  trends                       trends worker: anomalies, patterns, correlations
  pipeline [--skip-collection] run the full left-to-right pass
  review                       list open review items
  review-decide <id> <decision> [--detail=] [--rationale=] [--supersedes=]
                               decisions: ${review.DECISIONS.join(' | ')}
  ask "<question>" [--client=] [--draft]
                               reasoning layer, with citations
  report [--safe]              weekly market brief
  brief [--client=] [--public] opportunity brief
  graph "<query>"              federated search
  connectors                   list connectors, credentials and cost
  overview                     live counts for every stage
  serve [--port=4000]          dashboard + JSON API

Environment: OBSERVATORY_DB (default ./data/observatory.db), OBSERVATORY_OFFLINE=1 to force fixtures.`;

async function main() {
  const db = dbModule.open();

  switch (command) {
    case 'migrate':
      return print('schema up to date');

    case 'seed':
      return print(seed(db));

    case 'collect': {
      const result = positional[0]
        ? await collection.collectSource(db, positional[0], { force: Boolean(flags.force) })
        : await collection.collectAll(db, { force: Boolean(flags.force) });
      return print(result);
    }

    case 'curate': return print(curationWorker.run(db));
    case 'status': return print(statusWorker.run(db));
    case 'trends': return print(trendsWorker.run(db));

    case 'pipeline':
      return print(await pipeline.runAll(db, { skipCollection: Boolean(flags['skip-collection']) }));

    case 'review': {
      const items = review.open(db, { severity: flags.severity || null });
      if (!items.length) return print('review queue is empty');
      return print(items.map((i) => ({
        id: i.id, severity: i.severity, reason: i.reason, title: i.title,
        domain: i.domain, trust: i.trust, risk: i.risk, detail: i.detail,
      })));
    }

    case 'review-decide': {
      const [reviewId, decision] = positional;
      if (!reviewId || !decision) return print('usage: review-decide <id> <decision>');
      return print(review.decide(db, reviewId, {
        principal: actor(), decision,
        detail: flags.detail || null, rationale: flags.rationale || null,
        supersedesId: flags.supersedes || null,
      }));
    }

    case 'ask': {
      const question = positional.join(' ');
      if (!question) return print('usage: ask "<question>"');
      const result = reasoningLayer.ask(db, { question, principal: actor(), clientId: flags.client || null });
      print(reasoningLayer.render(result));
      if (flags.draft) {
        const drafts = workflows.fromReasoning(db, result, { clientId: flags.client || null });
        print(`\n${drafts.length} workflow draft(s) created: ${drafts.join(', ')}`);
      }
      return;
    }

    case 'report': return print(reporting.weeklyBrief(db, { safe: Boolean(flags.safe) }).body);

    case 'brief':
      return print(strategy.opportunityBrief(db, {
        principal: actor(), clientId: flags.client || null,
        domain: flags.domain || null, publicSafe: Boolean(flags.public),
      }).body);

    case 'graph': {
      const query = positional.join(' ');
      if (!query) return print(knowledgeGraph.stats(db));
      return print(knowledgeGraph.search(db, query));
    }

    case 'connectors': return print(connectors.list());
    case 'overview': return print(pipeline.overview(db));

    case 'serve': {
      require('../src/server/app').start({ port: flags.port || process.env.PORT || 4000, db });
      return;   // keep the process alive
    }

    default:
      return print(USAGE);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
