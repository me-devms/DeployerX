const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  REVIEW_REQUEST_PATH,
  createNativeLicenseReviewRequest,
  writeNativeLicenseReviewRequest
} = require('./native-license-review-request');
const { licenseReview } = require('./native-release-preflight');

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-native-review-request-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = '[package]\nname = "deployerx-db-host"\nversion = "0.1.0"\n\n[dependencies]\nbase64 = "0.22.1"\nserde = "1.0"\n';
  const lock = 'version = 3\n\n[[package]]\nname = "deployerx-db-host"\nversion = "0.1.0"\n\n[[package]]\nname = "base64"\nversion = "0.22.1"\n\n[[package]]\nname = "serde"\nversion = "1.0.219"\n';
  const inventory = {
    schemaVersion: 1,
    generatedFrom: 'native/deployerx-db-host/Cargo.lock',
    packageCount: 2,
    packages: [
      { name: 'base64', version: '0.22.1', license: 'MIT OR Apache-2.0', licenseFiles: ['third_party_licenses/database-manager-rust/base64-0.22.1-1-aaaaaaaaaaaa.txt'] },
      { name: 'serde', version: '1.0.219', license: 'MIT', licenseFiles: ['third_party_licenses/database-manager-rust/serde-1.0.219-1-bbbbbbbbbbbb.txt', 'third_party_licenses/database-manager-rust/serde-1.0.219-2-cccccccccccc.txt'] }
    ]
  };
  await fs.mkdir(path.join(root, 'native', 'deployerx-db-host'), { recursive: true });
  await fs.mkdir(path.join(root, 'third_party_licenses'), { recursive: true });
  await fs.writeFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.toml'), manifest);
  await fs.writeFile(path.join(root, 'native', 'deployerx-db-host', 'Cargo.lock'), lock);
  const inventorySource = `${JSON.stringify(inventory)}\n`;
  await fs.writeFile(path.join(root, 'third_party_licenses', 'database-manager-rust.json'), inventorySource);
  return { root, lock, inventory, inventorySource };
}

test('creates a deterministic pending request bound to the exact locked inventory', async (context) => {
  const values = await fixture(context);
  const first = await createNativeLicenseReviewRequest({ rootPath: values.root });
  const second = await createNativeLicenseReviewRequest({ rootPath: values.root });
  assert.deepEqual(second, first);
  assert.equal(first.status, 'pending-human-review');
  assert.equal(first.approvalOutputPath, 'third_party_licenses/database-manager-rust-review.json');
  assert.equal(first.lockSha256, crypto.createHash('sha256').update(values.lock).digest('hex'));
  assert.equal(first.inventorySha256, crypto.createHash('sha256').update(values.inventorySource).digest('hex'));
  assert.equal(first.packageCount, 2);
  assert.equal(first.licenseEvidenceFileCount, 3);
  assert.deepEqual(first.licenseExpressions, ['MIT', 'MIT OR Apache-2.0']);
  assert.equal(first.reviewChecklist.length, 6);
  assert.equal(licenseReview(first, { lockSource: values.lock, inventorySource: values.inventorySource, inventory: values.inventory.packages }), null);
});

test('writes only the pending request and never creates an approval', async (context) => {
  const values = await fixture(context);
  const request = await writeNativeLicenseReviewRequest({ rootPath: values.root });
  const published = JSON.parse(await fs.readFile(path.join(values.root, REVIEW_REQUEST_PATH), 'utf8'));
  assert.deepEqual(published, request);
  await assert.rejects(fs.access(path.join(values.root, request.approvalOutputPath)));
});

test('rejects stale inventory before creating a review request', async (context) => {
  const values = await fixture(context);
  values.inventory.packages.pop();
  values.inventory.packageCount = 1;
  await fs.writeFile(path.join(values.root, 'third_party_licenses', 'database-manager-rust.json'), JSON.stringify(values.inventory));
  await assert.rejects(createNativeLicenseReviewRequest({ rootPath: values.root }), /does not match the exact locked dependency graph/);
});

test('keeps the committed review request and package command current', async () => {
  const root = path.join(__dirname, '..', '..');
  const expected = await createNativeLicenseReviewRequest({ rootPath: root });
  const published = JSON.parse(await fs.readFile(path.join(root, REVIEW_REQUEST_PATH), 'utf8'));
  const packageConfig = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(published, expected);
  assert.equal(packageConfig.scripts['database-native:review-request'], 'node src/database-manager/native-license-review-request.js --write');
});
