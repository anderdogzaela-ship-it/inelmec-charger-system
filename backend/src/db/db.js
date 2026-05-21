'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../utils/logger');

let _db = null;

function db() {
  if (_db) return _db;

  const dbPath = path.resolve(process.cwd(), config.db.path);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  logger.info('Database connection opened', { path: dbPath });
  return _db;
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { db, close };
