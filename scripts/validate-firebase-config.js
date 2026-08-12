'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateFirebaseConfig } = require('../src/firebase-config');

const configPath = path.resolve(process.argv[2] || 'firebase.config.json');
const requireGoogle = process.argv.includes('--require-google');

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`Unable to read Firebase configuration: ${error.message}`);
  process.exit(1);
}

const result = validateFirebaseConfig(parsed, { requireGoogle });
if (!result.valid) {
  console.error(`Firebase configuration validation failed: ${result.errors.join(' ')}`);
  process.exit(1);
}

console.log('Firebase and Google OAuth configuration is valid.');
