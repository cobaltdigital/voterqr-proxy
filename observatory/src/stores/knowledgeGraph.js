'use strict';
const { id, similarity, coverage } = require('../core/util');
const { run, all, get } = require('../db');

/**
 * Knowledge Graph — federated search + links across KB entries, clients, sources, claims,
 * trends and inquiries. Nodes are references into the stores, never copies of their content.
 */

function upsertNode(db, { type, refId, label }) {
  const existing = get(db, 'SELECT id FROM graph_nodes WHERE type = ? AND ref_id = ?', type, refId);
  if (existing) {
    run(db, 'UPDATE graph_nodes SET label = ? WHERE id = ?', label, existing.id);
    return existing.id;
  }
  const nodeId = id('gn');
  run(db, 'INSERT INTO graph_nodes (id, type, ref_id, label) VALUES (?, ?, ?, ?)', nodeId, type, refId, label);
  return nodeId;
}

function link(db, srcNodeId, dstNodeId, rel, weight = 1) {
  const existing = get(db, 'SELECT id FROM graph_edges WHERE src_id = ? AND dst_id = ? AND rel = ?', srcNodeId, dstNodeId, rel);
  if (existing) {
    run(db, 'UPDATE graph_edges SET weight = ? WHERE id = ?', weight, existing.id);
    return existing.id;
  }
  const edgeId = id('ge');
  run(db, 'INSERT INTO graph_edges (id, src_id, dst_id, rel, weight) VALUES (?, ?, ?, ?, ?)',
    edgeId, srcNodeId, dstNodeId, rel, weight);
  return edgeId;
}

/** Rebuilds the graph from the stores. Cheap enough to run after each pipeline pass. */
function rebuild(db) {
  const counts = { nodes: 0, edges: 0 };
  const node = (type, refId, label) => { counts.nodes += 1; return upsertNode(db, { type, refId, label }); };
  const edge = (a, b, rel, weight) => { counts.edges += 1; return link(db, a, b, rel, weight); };

  const sourceNodes = new Map();
  for (const source of all(db, 'SELECT id, name FROM sources')) {
    sourceNodes.set(source.id, node('source', source.id, source.name));
  }
  for (const client of all(db, 'SELECT id, name FROM clients')) {
    node('client', client.id, client.name);
  }

  for (const entry of all(db, `SELECT id, title, domain, client_scope FROM kb_entries WHERE status = 'current'`)) {
    const entryNode = node('kb_entry', entry.id, entry.title);
    if (entry.client_scope !== 'shared') {
      const clientNode = get(db, `SELECT id FROM graph_nodes WHERE type = 'client' AND ref_id = ?`, entry.client_scope);
      if (clientNode) edge(entryNode, clientNode, 'scoped_to');
    }
    for (const claim of all(db, 'SELECT id, statement FROM claims WHERE kb_entry_id = ?', entry.id)) {
      const claimNode = node('claim', claim.id, claim.statement.slice(0, 120));
      edge(entryNode, claimNode, 'supported_by');
      for (const citation of all(db, 'SELECT source_id FROM citations WHERE claim_id = ?', claim.id)) {
        const src = sourceNodes.get(citation.source_id);
        if (src) edge(claimNode, src, 'cites');
      }
    }
  }

  for (const trend of all(db, 'SELECT id, subject, summary, domain FROM trend_detections')) {
    const trendNode = node('trend', trend.id, trend.summary.slice(0, 120));
    for (const entry of all(db, `SELECT id, title FROM kb_entries WHERE status = 'current' AND domain = ?`, trend.domain || '')) {
      if (similarity(trend.subject, entry.title) >= 0.2) {
        const entryNode = upsertNode(db, { type: 'kb_entry', refId: entry.id, label: entry.title });
        edge(trendNode, entryNode, 'relates_to');
      }
    }
  }

  for (const inquiry of all(db, 'SELECT id, question FROM inquiries')) {
    node('inquiry', inquiry.id, inquiry.question.slice(0, 120));
  }

  return counts;
}

/** Federated search: one ranked list across every node type. */
const search = (db, query, { limit = 15, type = null } = {}) =>
  all(db, 'SELECT * FROM graph_nodes WHERE (? IS NULL OR type = ?)', type, type)
    .map((n) => ({ ...n, score: coverage(query, n.label) }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

function neighbours(db, nodeId) {
  const outgoing = all(db, `SELECT e.rel, e.weight, n.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.dst_id WHERE e.src_id = ?`, nodeId);
  const incoming = all(db, `SELECT e.rel, e.weight, n.* FROM graph_edges e JOIN graph_nodes n ON n.id = e.src_id WHERE e.dst_id = ?`, nodeId);
  return { outgoing, incoming };
}

const stats = (db) => ({
  nodes: all(db, 'SELECT type, COUNT(*) AS n FROM graph_nodes GROUP BY type'),
  edges: all(db, 'SELECT rel, COUNT(*) AS n FROM graph_edges GROUP BY rel'),
});

module.exports = { upsertNode, link, rebuild, search, neighbours, stats };
