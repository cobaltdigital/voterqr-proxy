'use strict';
const { clamp, daysBetween, now, tokens } = require('../core/util');

/**
 * Classification, domain routing, and the trust/risk scores the promotion policy reads.
 *
 * Deliberately transparent and rule-based: a reviewer looking at a queued item can see exactly
 * why it scored the way it did. Swap any single function for a model call without touching the
 * curation worker — the contract is just numbers in 0..1 plus a reason list.
 */

const DOMAINS = {
  seo: ['seo', 'serp', 'organic', 'keyword', 'backlink', 'crawl', 'index', 'sitemap', 'schema', 'canonical', 'ranking', 'search console', 'featured snippet'],
  paid_ads: ['ads', 'ppc', 'cpc', 'cpm', 'roas', 'bid', 'campaign', 'ad group', 'impression share', 'conversion rate', 'budget', 'pmax', 'retargeting'],
  social: ['social', 'instagram', 'facebook', 'linkedin', 'tiktok', 'engagement rate', 'follower', 'reel', 'post', 'creator', 'community'],
  local_business: ['local', 'gbp', 'google business', 'map pack', 'local pack', 'citation', 'review', 'nap', 'service area', 'directions', 'call tracking'],
  ai: ['ai', 'llm', 'ai overview', 'generative', 'chatgpt', 'gemini', 'perplexity', 'prompt', 'retrieval', 'embedding', 'model', 'assistant'],
  web_design: ['web design', 'ux', 'ui', 'core web vitals', 'lcp', 'inp', 'cls', 'page speed', 'lighthouse', 'accessibility', 'layout', 'conversion rate optimization', 'landing page'],
};

const DOMAIN_LIST = Object.keys(DOMAINS);

/** Weighted keyword match. Multi-word phrases count double — they are far less ambiguous. */
function routeDomain(text) {
  const haystack = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const scores = {};
  for (const [domain, keywords] of Object.entries(DOMAINS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (!haystack.includes(` ${keyword}`)) continue;
      score += keyword.includes(' ') ? 2 : 1;
    }
    scores[domain] = score;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const runnerUp = ranked[1] ? ranked[1][1] : 0;

  // Require a real signal and a real margin; ties mean "a human should route this".
  if (topScore < 2 || topScore === runnerUp) return { domain: 'unrouted', score: 0, scores };
  return { domain: top, score: clamp(topScore / 8), scores };
}

function classifyKind(artifact, payload) {
  if (payload.kind) return payload.kind;
  if (artifact.parser.startsWith('connector.')) return 'signal';
  if (artifact.parser === 'client.indexer') return 'doc';
  if (artifact.parser === 'knowledge.markdown') return payload.type || 'fact';
  if (artifact.parser === 'file.table') return 'metric';
  return 'fact';
}

/**
 * Trust = source prior, adjusted for parser confidence, routing confidence and age.
 * A trusted source with an unroutable, six-month-old payload should not auto-promote.
 */
function scoreTrust({ source, artifact, domainScore = 0, payload = {}, domainRequired = true }) {
  const reasons = [];
  let trust = source.trust ?? 0.5;
  reasons.push(`source prior ${trust.toFixed(2)}`);

  if (artifact.parser === 'file.offload' || payload.extract_status === 'pending_offload') {
    trust -= 0.25;
    reasons.push('content not yet extracted (-0.25)');
  }
  if (domainScore >= 0.5) { trust += 0.1; reasons.push('confident domain routing (+0.10)'); }
  if (domainScore === 0 && domainRequired) { trust -= 0.15; reasons.push('unrouted (-0.15)'); }

  const ageDays = daysBetween(artifact.fetched_at || now(), now());
  if (ageDays > 180) { trust -= 0.2; reasons.push('stale source data (-0.20)'); }
  else if (ageDays > 30) { trust -= 0.05; reasons.push('aging source data (-0.05)'); }

  const body = `${payload.title || ''} ${payload.text || payload.body || ''}`;
  if (tokens(body).length < 8 && !payload.value) { trust -= 0.1; reasons.push('thin content (-0.10)'); }

  return { trust: clamp(trust), reasons };
}

// Content that must not be auto-promoted into a shared, client-facing knowledge base.
const RISK_RULES = [
  [/\b(guarantee|guaranteed|always|never|100%|risk[- ]free)\b/i, 0.35, 'absolute claim'],
  [/\b(lawsuit|legal|compliance|hipaa|gdpr|ccpa|liabilit|contract terms)\b/i, 0.4, 'legal exposure'],
  [/\b(price|pricing|retainer|invoice|salary|payroll|margin|discount)\b/i, 0.3, 'commercial terms'],
  [/\b(ssn|password|api[_ ]?key|credential|private key)\b/i, 0.6, 'possible secret'],
  [/\b(algorithm update|penalt|deindex|manual action|de-?ranked)\b/i, 0.25, 'high-consequence platform claim'],
  [/\b(confidential|internal only|do not share|nda)\b/i, 0.45, 'confidentiality marker'],
];

/** Risk = how much damage a wrong auto-promotion would do. Client-scoped content is riskier by default. */
function scoreRisk({ payload = {}, kind = 'fact', clientId = null, source = {} }) {
  const text = `${payload.title || ''} ${payload.text || payload.body || payload.summary || ''}`;
  const reasons = [];
  let risk = 0;

  for (const [pattern, weight, label] of RISK_RULES) {
    if (pattern.test(text)) { risk += weight; reasons.push(`${label} (+${weight})`); }
  }
  if (clientId) { risk += 0.15; reasons.push('client-identifiable content (+0.15)'); }
  if (kind === 'sop' || kind === 'playbook') { risk += 0.2; reasons.push('operational guidance (+0.20)'); }
  if (source.kind === 'public_web') { risk += 0.1; reasons.push('unvetted public source (+0.10)'); }
  if (kind === 'signal' || kind === 'metric') { risk -= 0.1; reasons.push('numeric observation (-0.10)'); }

  return { risk: clamp(risk), reasons };
}

module.exports = { DOMAINS, DOMAIN_LIST, routeDomain, classifyKind, scoreTrust, scoreRisk, RISK_RULES };
