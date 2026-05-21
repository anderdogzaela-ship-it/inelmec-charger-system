'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  if (meta && Object.keys(meta).length) {
    return `${base} ${JSON.stringify(meta)}`;
  }
  return base;
}

function make(level) {
  return (msg, meta) => {
    if (LEVELS[level] > LEVEL) return;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(fmt(level, msg, meta) + '\n');
  };
}

module.exports = {
  error: make('error'),
  warn: make('warn'),
  info: make('info'),
  debug: make('debug'),
};
