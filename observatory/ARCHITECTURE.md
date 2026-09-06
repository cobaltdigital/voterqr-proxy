# Architecture

Why each part works the way it does, and where to change it.

## The shape

```
SOURCE SYSTEMS      COLLECTION           STAGING + CURATION        CURATED STORES        REASONING + OUTPUTS
─────────────       ──────────           ──────────────────        ──────────────        ───────────────────
public web      →   scraper          ┐                         ┌→  domain KB         →   reasoning layer
files + media   →   file importer    │                         │   client corpus     →   workflows
marketing APIs  →   API connectors   ├→  staging artifacts     ├→  evidence ledger   →   annotation ledger
client systems  →   client indexer   │        ↓                │   market activity   →   reporting
internal knowl. →   knowledge import ┘   curation worker  ─────┤   inquiry store     →   strategy + sales
                                              ↓    ↑           │   trends schema     →   knowledge graph
                                        human review ──────────┘
                                              ↑
                                    status worker, trends worker
```

Data only moves left to right. Each stage reads the stage before it and writes its own tables;
nothing reaches back. That is what makes any single stage replaceable.

## Decisions

### Raw stays in staging

`staging_artifacts` holds the payload. Curated stores hold snippets and refs (`source_ref`,
`artifact_id`). So the client corpus can be rebuilt from staging, a parser fix can be replayed
without re-fetching, and a citation always resolves to the exact bytes a claim came from.

### One road into the curated stores

`src/staging/promote.js` is the only module that inserts into `kb_entries`, `client_corpus` or
`claims`. Auto-promotion and human acceptance both call it, so a record accepted by a person and
one promoted by policy are written and audited identically. Changing what promotion means is a
one-file change.

If no store claims a candidate's kind, `promote()` throws `UnhandledKindError` and the curation
worker queues it for review. The alternative — marking it promoted while writing nothing — is
silent data loss, which is the failure mode this design exists to prevent.

### Trust and risk are separate numbers

Trust asks "how much do we believe this?" (source prior, parser confidence, routing confidence,
age). Risk asks "how much damage would a wrong auto-promotion do?" (absolute claims, legal
exposure, commercial terms, secrets, confidentiality markers, client-identifiable content).

Keeping them apart is what lets a *highly trusted* internal document about pricing still land in
critical review: `trust 0.95, risk 0.75`. Collapsing them into one score loses that.

Both functions return a reason list, and those reasons are written into the review item — the
reviewer sees `trust 0.55 (source prior 0.45; confident domain routing (+0.10))`, not a bare number.

### Three different similarity measures, deliberately

Text comparison shows up in four places with genuinely different requirements, and using one
measure everywhere produced wrong answers in three of them:

| Use | Measure | Why |
|---|---|---|
| Retrieval (`search`) | **coverage** — shared ÷ query terms | A 4-word question against an 800-word SOP scores ~0.04 by Jaccard however well the SOP answers it. Coverage stays stable as documents grow. |
| Dedupe | **Jaccard** — shared ÷ union | Symmetric and strict. Two texts must be substantially the same, not merely related. |
| Same-source re-fetch | **containment** + length ratio | A page re-collected after gaining a sentence is a duplicate. Restricted to one source: a *different* source restating our content with extra detail is a second opinion worth reviewing. |
| Contradiction (`status worker`) | **overlap coefficient** — shared ÷ smaller | "Do these cover the same ground?" A short revision note and a full SOP about the same metric score 0.27 by Jaccard but 0.43 here. Wants recall; a false pair costs one dismissed review item, a missed one leaves two conflicting beliefs live. |

### Contradictions need units

The status worker only compares numbers that carry a unit (`2.5s` vs `4s`). Bare integers in prose
— "two to three weeks", step numbers, years — collide constantly and produce contradictions that
are not real. This one rule removed every false positive in the fixtures.

### Detection and decision are separate

The status worker flags contradictions but never flips a status. The trends worker records
detections but never writes a KB fact — a correlation opens an *inquiry* (`status: experiment`),
because a correlation is a hypothesis. Anomalies go to the review queue at critical severity.
Workflow drafts always start as `draft` and require an approval that is recorded against a
principal.

The system's judgement is about *what deserves attention*. What is true stays a human call.

### The evidence ledger cannot hold an uncited claim

`assert()` throws without at least one citation. That single constraint is what makes the reasoning
layer's contract enforceable: it can present only cited points, and report everything else as
`unsupported`. A KB entry with no claim behind it is reported as a defect rather than used.

Confidence decays with evidence age (180-day half-life), so a year-old citation stops reading as
fresh certainty without anyone having to remember to re-check it.

### Append-only market activity

`marketActivity` exposes `append` but no update or delete, and a test asserts that no mutating
method exists. A correction is a new observation. The trends worker can therefore always see what
was believed and when, which is the whole point of a neutral recorder.

### Policy is a module, not a convention

`src/core/policy.js` holds the principal shape, role ordering, client-scope rules, row-level
access filtering, the promotion thresholds and the report-safe filter. Stores call it; callers
cannot forget to. `clientCorpus.forClient()` throws before touching the database on a scope miss.

### Client records are filed by client, not by domain

A meeting note has no "SEO vs paid ads" answer. Client record kinds are exempt from the domain
requirement *and* from the unrouted trust penalty — penalising a meeting note for lacking a
marketing domain was a bug, not a policy. They are not exempt from risk: the confidential renewal
note in the fixtures still lands in critical review.

### Scheduling is separate from execution

`scheduler.js` decides what is due and enqueues it; `workers.js` drains the queue. Neither knows
how the other is deployed, so the same code runs as a single process (`serve --with-workers`), as
a separate worker fleet, or inline in a test.

Cadence lives on the source, not in the scheduler, so a connector polled hourly and a document
import run quarterly coexist without either dictating the other's rhythm. A source already holding
a pending job is skipped, which makes the scheduler safe to run on a short interval.

Retry backoff matters more than it looks: without pushing `run_after` into the future on failure,
one drain loop re-claims the failing job immediately and spends all three attempts in the moment a
transient error has had no time to clear. Jobs whose type has no handler skip retries entirely —
they will not succeed later.

### Drafts carry provenance

`workflow_drafts.ref_type`/`ref_id` name what produced a draft, with a unique index over
`(kind, ref_type, ref_id)`. That is what lets the trends worker run every hour without producing a
new site-change record for the same detection each time. Idempotence by construction beats
remembering to check.

## Extending it

| To change | Touch | Everything else stays |
|---|---|---|
| Add a vendor | `src/collection/connectors/` — implement `fetch()`, return `{ records, costCents }` | yes |
| Add a collector | `src/collection/`, register in `COLLECTORS` | yes |
| Change promotion rules | `PROMOTION` + `routeCandidate` in `policy.js` | yes |
| Better classification | `routing.js` — `routeDomain`, `scoreTrust`, `scoreRisk` | yes |
| Better retrieval | `domainKb.search` body | yes |
| Real auth | `principalFrom` in `server/app.js` | yes |
| Postgres | `src/db/index.js` + parameter placeholders | schema ports as written |
| Real queue | `enqueue`/`claim`/`complete`/`fail` in `core/jobs.js` | yes |

## Testing

81 tests, no fixtures on disk, each with its own in-memory database. They assert behaviour rather
than implementation: risky content escalates however trusted its source; a viewer cannot decide a
review item over HTTP; one client's search never returns another's rows; a correlation opens a
question instead of asserting a cause; a second pipeline pass is a no-op; a candidate no store can
hold is queued rather than lost; a failing job backs off instead of burning its retries in one
pass; the same trend detection does not produce a second draft.
