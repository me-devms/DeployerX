const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  INVENTORY_PATH,
  LOCK_PATH,
  REVIEW_PATH,
  inventoryPackages,
  parseLockPackages,
  parseManifest
} = require('./native-release-preflight');

const MANIFEST_PATH = 'native/deployerx-db-host/Cargo.toml';
const REVIEW_REQUEST_PATH = 'documentation/database-manager/NATIVE-LICENSE-REVIEW-REQUEST.json';
const MAX_REVIEW_SOURCE_BYTES = 16 * 1024 * 1024;
const REVIEW_CHECKLIST = Object.freeze([
  'Review every declared license expression and copied license or notice file.',
  'Review crate copyright and attribution obligations, including canonical-text fallbacks.',
  'Review target-specific and build-time dependencies in the complete locked graph.',
  'Review native-library, linking, redistribution, and source-offer obligations.',
  'Confirm the package count and sorted license-expression set match this request.',
  'Create the separate approval file only after completing the human legal review.'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readBoundedText(root, relativePath, fileSystem) {
  const absolutePath = path.join(root, relativePath);
  const stat = await fileSystem.stat(absolutePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_REVIEW_SOURCE_BYTES) throw new TypeError(`${relativePath} is not a bounded regular file.`);
  const source = await fileSystem.readFile(absolutePath, 'utf8');
  if (Buffer.byteLength(source, 'utf8') !== stat.size || source.includes('\0')) throw new TypeError(`${relativePath} is invalid.`);
  return source;
}

function exactPackageGraph(manifestSource, lockSource, inventorySource) {
  const manifest = parseManifest(manifestSource);
  const locked = parseLockPackages(lockSource);
  let inventoryDocument;
  try { inventoryDocument = JSON.parse(inventorySource); }
  catch { throw new TypeError(`${INVENTORY_PATH} is not valid JSON.`); }
  const inventory = inventoryPackages(inventoryDocument);
  if (!manifest.name || !manifest.version || !locked.length || !inventory || inventory.some((entry) => !entry)) {
    throw new TypeError('The native dependency graph or license inventory is invalid.');
  }
  const rootKey = `${manifest.name}@${manifest.version}`;
  const lockedKeys = locked.filter((entry) => entry.key !== rootKey).map((entry) => entry.key).sort();
  const inventoryKeys = inventory.map((entry) => entry.key).sort();
  if (lockedKeys.length !== inventoryKeys.length || lockedKeys.some((key, index) => key !== inventoryKeys[index])) {
    throw new TypeError('The native license inventory does not match the exact locked dependency graph.');
  }
  return inventory;
}

async function createNativeLicenseReviewRequest({
  rootPath = path.join(__dirname, '..', '..'),
  fileSystem = fs
} = {}) {
  const root = path.resolve(rootPath);
  const [manifestSource, lockSource, inventorySource] = await Promise.all([
    readBoundedText(root, MANIFEST_PATH, fileSystem),
    readBoundedText(root, LOCK_PATH, fileSystem),
    readBoundedText(root, INVENTORY_PATH, fileSystem)
  ]);
  const inventory = exactPackageGraph(manifestSource, lockSource, inventorySource);
  return Object.freeze({
    schemaVersion: 1,
    status: 'pending-human-review',
    approvalOutputPath: REVIEW_PATH,
    lockPath: LOCK_PATH,
    lockSha256: sha256(lockSource),
    inventoryPath: INVENTORY_PATH,
    inventorySha256: sha256(inventorySource),
    packageCount: inventory.length,
    licenseEvidenceFileCount: inventory.reduce((count, entry) => count + entry.licenseFiles.length, 0),
    licenseExpressions: Object.freeze([...new Set(inventory.map((entry) => entry.license))].sort()),
    reviewChecklist: REVIEW_CHECKLIST
  });
}

async function writeNativeLicenseReviewRequest(options = {}) {
  const root = path.resolve(options.rootPath || path.join(__dirname, '..', '..'));
  const fileSystem = options.fileSystem || fs;
  const request = await createNativeLicenseReviewRequest({ ...options, rootPath: root, fileSystem });
  const outputPath = path.join(root, REVIEW_REQUEST_PATH);
  await fileSystem.mkdir(path.dirname(outputPath), { recursive: true });
  await fileSystem.writeFile(outputPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return request;
}

async function runCli() {
  const request = process.argv.includes('--write')
    ? await writeNativeLicenseReviewRequest()
    : await createNativeLicenseReviewRequest();
  process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
}

if (require.main === module) runCli().catch((error) => {
  process.stderr.write(`${error.message || 'Native license review request failed.'}\n`);
  process.exitCode = 1;
});

module.exports = {
  MAX_REVIEW_SOURCE_BYTES,
  REVIEW_CHECKLIST,
  REVIEW_REQUEST_PATH,
  createNativeLicenseReviewRequest,
  exactPackageGraph,
  writeNativeLicenseReviewRequest
};
