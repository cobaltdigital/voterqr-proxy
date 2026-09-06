'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.OBSERVATORY_LOG_LEVEL] || LEVELS.info;

function emit(level, scope, message, fields) {
  if (LEVELS[level] < threshold) return;
  const extra = fields && Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
    : '';
  // Everything goes to stderr so stdout carries only the command's actual output —
  // `observatory overview | jq` has to work.
  process.stderr.write(`[${level}] ${scope}: ${message}${extra}\n`);
}

function logger(scope) {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
  };
}

module.exports = { logger };
