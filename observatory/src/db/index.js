'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let handle = null;

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
  }
  return files.length;
}

/** Open (or reuse) the process-wide database handle. */
function open(file) {
  const target = file || process.env.OBSERVATORY_DB || path.join(process.cwd(), 'data', 'observatory.db');
  if (handle && handle.__file === target) return handle;
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  db.__file = target;
  handle = db;
  return db;
}

/** A throwaway in-memory database, migrated and isolated. Used by the test suite. */
function openEphemeral() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  db.__file = ':memory:';
  return db;
}

function close() {
  if (handle) { handle.close(); handle = null; }
}

// node:sqlite rows are null-prototype objects; plain objects serialise and spread predictably.
const plain = (row) => (row ? { ...row } : row);

const all = (db, sql, ...params) => db.prepare(sql).all(...params).map(plain);
const get = (db, sql, ...params) => plain(db.prepare(sql).get(...params));
const run = (db, sql, ...params) => db.prepare(sql).run(...params);
const count = (db, sql, ...params) => {
  const row = db.prepare(sql).get(...params);
  return row ? Number(Object.values(row)[0]) : 0;
};

module.exports = { open, openEphemeral, close, migrate, all, get, run, count, plain };
