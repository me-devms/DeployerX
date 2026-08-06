const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const hostRoot = path.join(__dirname, '..', '..', 'native', 'deployerx-db-host');
const packagePath = path.join(__dirname, '..', '..', 'package.json');
const packageJson = fs.readFileSync(packagePath, 'utf8');
const packageManifest = JSON.parse(packageJson);
const thirdPartyNotices = fs.readFileSync(path.join(__dirname, '..', '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
const apacheLicense = fs.readFileSync(path.join(__dirname, '..', '..', 'third_party_licenses', 'Apache-2.0.txt'), 'utf8');
const cargo = fs.readFileSync(path.join(hostRoot, 'Cargo.toml'), 'utf8');
const upstream = fs.readFileSync(path.join(hostRoot, 'UPSTREAM.md'), 'utf8');
const main = fs.readFileSync(path.join(hostRoot, 'src', 'main.rs'), 'utf8');
const protocol = fs.readFileSync(path.join(hostRoot, 'src', 'protocol.rs'), 'utf8');
const drivers = fs.readFileSync(path.join(hostRoot, 'src', 'drivers', 'mod.rs'), 'utf8');
const common = fs.readFileSync(path.join(hostRoot, 'src', 'drivers', 'common.rs'), 'utf8');
const postgresql = fs.readFileSync(path.join(hostRoot, 'src', 'drivers', 'postgresql.rs'), 'utf8');
const mysql = fs.readFileSync(path.join(hostRoot, 'src', 'drivers', 'mysql.rs'), 'utf8');
const sqlite = fs.readFileSync(path.join(hostRoot, 'src', 'drivers', 'sqlite.rs'), 'utf8');

test('pins the optional headless host and keeps fallback-only packaging runnable', () => {
  assert.match(cargo, /name = "deployerx-db-host"/);
  assert.match(cargo, /sqlx = \{ version = "0\.8\.6"/);
  assert.match(cargo, /"postgres"/);
  assert.match(cargo, /"mysql"/);
  assert.match(cargo, /"tls-rustls-ring-native-roots"/);
  assert.match(cargo, /"rust_decimal"/);
  assert.match(cargo, /zeroize = "=1\.8\.2"/);
  assert.doesNotMatch(cargo, /tauri/i);
  assert.match(upstream, /v0\.18\.0/);
  assert.match(upstream, /147777c59947178c54e1a9894d52f5abc9db9208/);
  assert.match(upstream, /Apache License 2\.0/);
  assert.equal(packageManifest.build.extraResources.some((resource) => String(resource?.from || '').includes('deployerx-db-host')), false);
  assert.equal(packageManifest.scripts['prepackage:win'], 'node --test src/database-manager/direct-driver-runtime.test.js');
  assert.match(packageManifest.dependencies.pg, /^\^8\./);
  assert.match(packageManifest.dependencies.mysql2, /^\^3\./);
  assert.equal(packageManifest.dependencies['sql.js'], '1.14.1');
});

test('packages complete upstream attribution, license text, inventory, and modification notices', () => {
  assert.match(thirdPartyNotices, /Copyright: 2026 Andrea Debernardi/);
  assert.match(thirdPartyNotices, /147777c59947178c54e1a9894d52f5abc9db9208/);
  assert.match(apacheLicense, /Apache License[\s\S]*Version 2\.0, January 2004/);
  assert.match(apacheLicense, /Copyright 2026 Andrea Debernardi/);
  assert.match(upstream, /Modified DeployerX File Inventory/);
  assert.match(upstream, /src\/drivers\/postgresql\.rs/);
  assert.ok(packageManifest.build.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(packageManifest.build.files.includes('third_party_licenses/**/*'));
  for (const source of [main, protocol, drivers, common, postgresql, mysql, sqlite]) {
    assert.match(source, /Modified by DeployerX/);
    assert.match(source, /Apache-2\.0/);
  }
});

test('implements bounded versioned RPC, cancellation, and secret-safe errors', () => {
  assert.match(protocol, /pub const PROTOCOL_VERSION: u32 = 1/);
  assert.match(main, /const MAX_INPUT_LINE_BYTES: usize = 16 \* 1024 \* 1024/);
  assert.match(main, /"request\.cancel"/);
  assert.match(main, /"connection\.open"/);
  assert.match(main, /"connection\.close"/);
  assert.match(main, /"connection\.status"/);
  assert.match(main, /"query\.execute_session"/);
  assert.match(main, /"schema\.snapshot_session"/);
  assert.match(main, /const MAX_SESSIONS: usize = 32/);
  assert.match(main, /SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs\(15 \* 60\)/);
  assert.match(main, /"connectionModes": \["physical-pool"\]/);
  assert.match(main, /struct HostedSession \{[\s\S]*driver: Arc<DriverSession>[\s\S]*active_requests: usize/);
  assert.match(main, /drivers::open_session\(&connection\)/);
  assert.match(main, /drivers::execute_session_query\(session\.driver\(\), &params\.request\)/);
  assert.match(main, /drivers::session_schema_snapshot\(session\.driver\(\), &params\.request\)/);
  assert.match(main, /session\.active_requests == 0/);
  assert.match(main, /acquire_session\(&sessions, &params\.session_id, true\)/);
  assert.match(main, /acquire_session\(sessions, session_id, false\)/);
  assert.match(main, /if touch_idle \{[\s\S]*session\.last_used_at_ms = epoch_millis\(\)/);
  assert.match(main, /session\.driver\(\)\.health\(\)\.await/);
  assert.match(main, /evict_session\(sessions, session_id, &session\.driver\)\.await/);
  assert.match(main, /session\.driver\.close\(\)\.await/);
  assert.doesNotMatch(main, /connection: Arc<Connection>/);
  assert.match(drivers, /pub enum DriverSession/);
  assert.match(drivers, /pub async fn open_session\(connection: &Connection\)/);
  for (const source of [postgresql, mysql, sqlite]) {
    assert.match(source, /pub struct Session \{[\s\S]*pool: sqlx::/);
    assert.match(source, /pub async fn execute_session_query\(/);
    assert.match(source, /pub async fn session_schema_snapshot\(/);
    assert.match(source, /self\.pool\.close\(\)\.await/);
    assert.match(source, /pub async fn health\(&self\) -> Result<\(\), HostError>/);
    assert.match(source, /query_scalar::<_, i(?:32|64)>\("SELECT 1"\)/);
  }
  assert.match(main, /"schema\.snapshot"/);
  assert.match(main, /task\.abort\(\)/);
  assert.match(main, /"system\.shutdown"/);
  assert.match(main, /"drivers": \["postgresql", "mysql", "sqlite"\]/);
  assert.match(protocol, /message: "Database driver operation failed\."/);
  assert.match(drivers, /impl Drop for Connection[\s\S]*clear_json_secrets/);
  assert.match(drivers, /secret\.zeroize\(\)/);
  for (const source of [main, protocol, drivers, common, postgresql, mysql, sqlite]) {
    assert.doesNotMatch(source, /println!|dbg!|format!\([^\n]*credentials/, 'host sources must not print request or credential values');
  }
});

test('implements a non-creating, read-only-aware SQLite connection and bounded typed pages', () => {
  assert.match(sqlite, /SqliteConnectOptions::new\(\)[\s\S]*\.filename\(path\)[\s\S]*\.create_if_missing\(false\)/);
  assert.match(sqlite, /\.read_only\(connection\.access_mode == "read-only"\)/);
  assert.match(sqlite, /PRAGMA quick_check/);
  assert.match(sqlite, /const MAX_PAGE_SIZE: u32 = 5_000/);
  assert.match(sqlite, /DATABASE_MANAGER_READ_ONLY_VIOLATION/);
  assert.match(sqlite, /"byteLength"[\s\S]*"base64"/);
  assert.match(sqlite, /rows\.len\(\) > request\.page_size as usize/);
  assert.match(sqlite, /sqlite_master/);
  assert.match(sqlite, /PRAGMA table_xinfo/);
  assert.match(sqlite, /request\.max_tables > 1_000/);
  assert.doesNotMatch(sqlite, /map_err\(\|error\|.*error\.to_string/s);
});

test('implements bounded PostgreSQL and MySQL or MariaDB built-in drivers', () => {
  assert.match(drivers, /"postgresql" => postgresql::test_connection/);
  assert.match(drivers, /"mysql" => mysql::test_connection/);
  assert.match(drivers, /"postgresql" => postgresql::execute_query/);
  assert.match(drivers, /"mysql" => mysql::execute_query/);
  assert.doesNotMatch(drivers, /DATABASE_MANAGER_DRIVER_NOT_IMPLEMENTED/);
  assert.match(common, /pub const MAX_PAGE_SIZE: u32 = 5_000/);
  assert.match(common, /pub const MAX_SCHEMA_TABLES: u32 = 1_000/);
  assert.match(common, /DATABASE_MANAGER_READ_ONLY_VIOLATION/);
  assert.match(postgresql, /PgPoolOptions::new\(\)[\s\S]*\.max_connections\(4\)/);
  assert.match(postgresql, /PgSslMode::VerifyFull/);
  assert.match(postgresql, /current_database\(\)/);
  assert.match(postgresql, /information_schema\.tables/);
  assert.match(postgresql, /"JSON" \| "JSONB"/);
  assert.match(postgresql, /"BYTEA" => binary_value/);
  assert.match(mysql, /MySqlPoolOptions::new\(\)[\s\S]*\.max_connections\(4\)/);
  assert.match(mysql, /MySqlSslMode::VerifyIdentity/);
  assert.match(mysql, /SELECT VERSION\(\) AS version, DATABASE\(\) AS database/);
  assert.match(mysql, /information_schema\.tables/);
  assert.match(mysql, /"JSON" =>/);
  assert.match(mysql, /"BLOB"/);
  for (const source of [postgresql, mysql]) {
    assert.match(source, /rows\.len\(\) > request\.page_size as usize/);
    assert.doesNotMatch(source, /map_err\(\|error\|.*error\.to_string/s);
  }
});
