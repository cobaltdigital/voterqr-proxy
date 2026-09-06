# Observatory

A marketing-intelligence pipeline: everything the agency collects flows left to right through
**collection → staging + curation → curated stores → reasoning + outputs**, with a human review
gate in the middle and an evidence ledger underneath.

Zero dependencies. Node 22's built-in `node:sqlite` and `node:http` do the work, so it runs the
moment you clone it — no install step, no services to stand up.

```bash
node scripts/demo.js          # full pipeline, end to end, with commentary
npm test                      # 69 tests
npm start                     # dashboard + API on http://localhost:4000
```

## What it does today

`node scripts/demo.js` runs the whole map against the bundled fixtures and prints what happened.
On a clean database that is:

- **123 artifacts** collected from five sources (internal knowledge, a competitor page, file
  exports, a mock marketing-API connector, and a client's systems).
- **118 auto-promoted, 5 held for a human** — with the reason and the score attached to each.
- **1 contradiction detected** between two knowledge-base entries that state different LCP
  thresholds for the same thing.
- **7 trend detections** — one anomaly (escalated to review), three sustained patterns
  (watchlisted), three cross-domain correlations (opened as experiments, never as facts).
- A cited answer, draft actions, a weekly market brief, and a public-safe opportunity brief.

## The five stages

| Stage | What runs | Where it lands |
|---|---|---|
| **Source systems** | public web, files + media, marketing APIs, client systems, internal knowledge | `sources` |
| **Collection** | scraper, file importer, API connectors, client indexer, knowledge import | `staging_artifacts`, `collection_runs`, `source_health` |
| **Staging + curation** | curation worker, human review, status worker, trends worker | `candidates`, `review_queue`, `promotion_audit` |
| **Curated stores** | domain KB, client corpus, evidence ledger, market activity, inquiries, trends | `kb_entries`, `client_corpus`, `claims`/`citations`, `market_activity`, `inquiries`, `trend_detections` |
| **Reasoning + outputs** | reasoning layer, workflows, annotations, reporting, strategy, knowledge graph | `reasoning_runs`, `workflow_drafts`, `annotations`, `reports`, `opportunity_briefs`, `graph_*` |

`ARCHITECTURE.md` explains the decisions behind each one.

## Four rules the code actually enforces

1. **Nothing is promoted silently.** Every state transition writes a row to `promotion_audit`
   with the actor and the reason. Auto-promotion happens only when a candidate is well-sourced
   (trust ≥ 0.75), low-risk (≤ 0.25) and confidently routed. Everything else waits for a person.
2. **No claim without a citation.** `evidenceLedger.assert()` throws on an uncited claim, so the
   reasoning layer can treat any uncited statement as a defect and report it in `unsupported`
   rather than presenting it as an answer.
3. **Client isolation lives in the store.** Every corpus read takes a principal and passes through
   the access policy — a caller cannot forget to scope a query.
4. **Machines detect, humans decide.** The status worker finds contradictions but never flips a
   status; the trends worker opens experiments but never writes a fact; workflow drafts always
   require approval before dispatch.

## Try it

```bash
node bin/observatory.js seed          # demo clients and sources
node bin/observatory.js pipeline      # collect → curate → status → trends → graph
node bin/observatory.js review        # what is waiting on a human, and why
node bin/observatory.js review-decide <id> accepted_with_detail --detail="Service-area businesses only"
node bin/observatory.js ask "how do we recover local pack rankings?"
node bin/observatory.js report --safe # weekly brief with client identity removed
node bin/observatory.js serve         # dashboard at :4000
```

The dashboard renders the map itself: each box shows its live count, and clicking one opens the
rows behind it. The review queue is operable from there — accept, accept with detail, decline,
mark legacy, escalate.

## Connecting real sources

Connectors declare their credentials, per-call cost, freshness budget and target domain up front.
`pagespeed` is fully implemented as the worked example; `dataforseo`, `gsc`, `ga4`, `google_ads`,
`gbp`, `crux`, `callrail`, `meta_ads` and `social` are declared stubs that fail loudly with the
exact next step rather than silently returning nothing.

```bash
node bin/observatory.js connectors    # what is implemented, what each one needs
```

To implement one, replace `fetch()` in `src/collection/connectors/stubs.js` so it returns
`{ records, costCents }` in the registry's record shape, and drop `implemented: false`.
Credentials are read from the environment per call and never stored in the database.

A source is a row in `sources`: kind, collector, trust prior, rate limit, and a JSON config.
See `scripts/seed.js` for one of each collector.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OBSERVATORY_DB` | `./data/observatory.db` | database file (`:memory:` works) |
| `OBSERVATORY_OFFLINE` | unset | force collectors to use fixtures instead of the network |
| `OBSERVATORY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORT` | `4000` | server port |
| `OBSERVATORY_DEV_ACTOR` / `_ROLE` / `_CLIENTS` | `dev@local` / `admin` / all | identity when no headers are sent |

## Known limits

These are deliberate for a skeleton, and each is a single seam to replace:

- **Identity comes from HTTP headers.** Replace `principalFrom()` in `src/server/app.js` with real
  session or SSO lookup; every store already takes a principal, so nothing downstream changes.
- **Retrieval is lexical**, using query-term coverage rather than embeddings. Swap the body of
  `domainKb.search()` for FTS5 or a vector index behind the same signature.
- **Classification and risk scoring are rule-based.** That keeps them explainable — a reviewer can
  see exactly why something scored as it did. Replace either function with a model call when the
  volume justifies it; the contract is just numbers in 0..1 plus a reason list.
- **Finance is deliberately out of scope** — no finance sources, stores or boundary code.
- **SQLite, single process.** The schema is written to port to Postgres (TEXT ids, ISO-8601
  timestamps, no AUTOINCREMENT). The job queue is a table; swap it for a real broker behind
  `enqueue`/`claim`/`complete`/`fail`.
