#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const logger = require('../utils/logger');

function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db().exec(schema);
  logger.info('Schema applied');
}

if (require.main === module) {
  try {
    migrate();
    process.exit(0);
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    process.exit(1);
  }
}

module.exports = { migrate };
