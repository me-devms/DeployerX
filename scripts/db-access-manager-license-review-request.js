#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  REVIEW_PATH,
  REVIEW_SCHEMA_VERSION,
  auditDbAccessManagerLicenseCompliance,
} = require('./db-access-manager-license-compliance');

const REVIEW_REQUEST_PATH = 'documentation/database-manager/DB-ACCESS-MANAGER-LICENSE-REVIEW-REQUEST.json';
const REVIEW_CHECKLIST = Object.freeze([
  'Review every Rust and frontend package, declared license expression, and copied license or notice file.',
  'Review copyright, attribution, notice, source-offer, linking, native-library, and redistribution obligations.',
  'Confirm the Cargo inventory covers the exact Cargo.lock graph except the companion root package.',
  'Confirm the frontend inventory covers only the complete production pnpm closure, including production workspace links and optional runtime dependencies.',
  'Confirm the exact companion revision, Tabularis license, DeployerX notice, production workspace manifests, and every license-evidence hash match this request.',
  'Confirm package counts, accepted license expressions, lock hashes, package hash, and inventory hashes match this request.',
  'Create the separate approval file only after completing the human legal review.',
]);

function createDbAccessManagerLicenseReviewRequest(options = {}) {
  const root = path.resolve(options.projectRoot || path.resolve(__dirname, '..'));
  const audit = auditDbAccessManagerLicenseCompliance({
    projectRoot: root,
    ...(options.companionRevision ? { companionRevision: options.companionRevision } : {}),
    ...(options.runGitCommand ? { runGitCommand: options.runGitCommand } : {}),
  });
  const nonReviewErrors = audit.errors.filter((entry) => ![
    'DB_ACCESS_LICENSE_REVIEW_MISSING',
    'DB_ACCESS_LICENSE_REVIEW_INVALID',
  ].includes(entry.code));
  if (nonReviewErrors.length) {
    throw new TypeError(`Cannot create a review request until dependency evidence is valid: ${nonReviewErrors[0].detail}`);
  }

  const binding = audit.reviewBinding;
  if (!binding) throw new TypeError('DB Access Manager license review binding is unavailable.');
  return Object.freeze({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    status: 'pending-human-review',
    approvalOutputPath: REVIEW_PATH,
    ...binding,
    reviewChecklist: REVIEW_CHECKLIST,
  });
}

function writeDbAccessManagerLicenseReviewRequest(options = {}) {
  const root = path.resolve(options.projectRoot || path.resolve(__dirname, '..'));
  const request = createDbAccessManagerLicenseReviewRequest({ ...options, projectRoot: root });
  const outputPath = path.join(root, ...REVIEW_REQUEST_PATH.split('/'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return request;
}

function runCli() {
  const request = process.argv.includes('--write')
    ? writeDbAccessManagerLicenseReviewRequest()
    : createDbAccessManagerLicenseReviewRequest();
  process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message || 'DB Access Manager license review request failed.'}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  REVIEW_CHECKLIST,
  REVIEW_REQUEST_PATH,
  createDbAccessManagerLicenseReviewRequest,
  writeDbAccessManagerLicenseReviewRequest,
};
