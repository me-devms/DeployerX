const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const initSqlJs = require('sql.js/dist/sql-asm.js');

const CONTROL_DATABASE_VERSION = 7;
const RECORD_SCHEMA_VERSION = 1;
const DATABASE_FILE_NAME = 'control.db';
const DATABASE_LOCK_FILE_NAME = 'control.db.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 30000;
const DEFAULT_LOCK_RETRY_MS = 10;
const SQL = initSqlJs();

function assertNativeMediaDeletionClaimMutationAllowed(current, options = {}) {
  const claim = current?.retention?.nativeMediaDeletionClaim;
  if (claim === undefined || claim === null) return;
  const claimId = typeof claim === 'object' && !Array.isArray(claim) ? claim.claimId : null;
  if (typeof claimId === 'string' && claimId.length > 0 && options.nativeMediaDeletionClaimId === claimId) return;
  throw new ControlDatabaseError(
    'RecoveryPoint native media is claimed by an active deletion operation.',
    'BACKUP_CONTROL_NATIVE_MEDIA_DELETION_CLAIM_ACTIVE'
  );
}

const RUN_STATE_TRANSITIONS = Object.freeze({
  queued: new Set(['preparing', 'failed', 'canceled', 'interrupted']),
  preparing: new Set(['running', 'failed', 'canceled', 'interrupted']),
  running: new Set(['verifying', 'failed', 'canceled', 'interrupted']),
  verifying: new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']),
  interrupted: new Set(['failed', 'canceled']),
  succeeded: new Set(),
  warning: new Set(),
  failed: new Set(),
  canceled: new Set()
});

const EXECUTION_GROUP_STATE_TRANSITIONS = Object.freeze({
  pending: new Set(['running', 'succeeded', 'warning', 'failed', 'canceled']),
  running: new Set(['succeeded', 'warning', 'failed', 'canceled']),
  succeeded: new Set(),
  warning: new Set(),
  failed: new Set(),
  canceled: new Set()
});

const RESTORE_RUN_STATE_TRANSITIONS = Object.freeze({
  queued: new Set(['preparing', 'failed', 'canceled', 'interrupted']),
  preparing: new Set(['running', 'failed', 'canceled', 'interrupted']),
  running: new Set(['validating', 'failed', 'canceled', 'interrupted']),
  validating: new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']),
  interrupted: new Set(['failed', 'canceled']),
  succeeded: new Set(),
  warning: new Set(),
  failed: new Set(),
  canceled: new Set()
});

const VERIFICATION_RUN_STATE_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed', 'canceled', 'interrupted']),
  running: new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']),
  interrupted: new Set(['failed', 'canceled']),
  succeeded: new Set(),
  warning: new Set(),
  failed: new Set(),
  canceled: new Set()
});

const ENTITY_SPECS = Object.freeze({
  connection: { table: 'connections', prefix: 'conn', named: true, mutable: true },
  databaseProfile: { table: 'database_profiles', prefix: 'dbp', named: true, mutable: true },
  databaseSavedQuery: { table: 'database_saved_queries', prefix: 'dbsq', named: true, mutable: true },
  databaseQueryHistory: { table: 'database_query_history', prefix: 'dbqh' },
  databaseNotebook: { table: 'database_notebooks', prefix: 'dbnb', named: true, mutable: true },
  databaseTask: { table: 'database_tasks', prefix: 'dbtask', mutable: true },
  source: { table: 'sources', prefix: 'src', named: true, mutable: true },
  repository: { table: 'repositories', prefix: 'repo', named: true, mutable: true },
  policy: { table: 'policies', prefix: 'pol', named: true, mutable: true },
  backupJob: { table: 'backup_jobs', prefix: 'job', named: true, mutable: true },
  executionGroup: { table: 'execution_groups', prefix: 'group' },
  run: { table: 'runs', prefix: 'run' },
  recoveryPoint: { table: 'recovery_points', prefix: 'rp' },
  artifact: { table: 'artifacts', prefix: 'art' },
  restoreRun: { table: 'restore_runs', prefix: 'restore' },
  verificationRun: { table: 'verification_runs', prefix: 'verify' },
  secretRef: { table: 'secret_refs', prefix: 'sec', named: true, mutable: true },
  notificationRoute: { table: 'notification_routes', prefix: 'notify', named: true, mutable: true },
  workerRegistration: { table: 'worker_registrations', prefix: 'worker', named: true, mutable: true }
});

const REQUIRED_INDEXES = Object.freeze([
  'idx_backup_jobs_workspace_state',
  'idx_runs_workspace_state_created',
  'idx_runs_job_created',
  'idx_recovery_points_job_captured',
  'idx_recovery_points_source_captured',
  'idx_restore_runs_workspace_state_created',
  'idx_verification_runs_workspace_state_created',
  'idx_database_profiles_workspace_driver',
  'idx_database_profiles_shared_connection',
  'uq_database_profiles_active_name',
  'uq_database_saved_queries_active_name',
  'idx_database_saved_queries_workspace_profile_updated',
  'idx_database_query_history_workspace_profile_created',
  'uq_database_notebooks_active_name',
  'idx_database_notebooks_workspace_profile_updated',
  'idx_database_tasks_workspace_profile_state_updated',
  'uq_execution_groups_idempotency',
  'uq_recovery_point_repository_snapshot'
]);

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    description: 'Create the Backup Manager control-plane schema.',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local','ssh','winrm','database','cloud','kubernetes','storage')),
        adapter_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id)
      );
      CREATE UNIQUE INDEX uq_connections_active_name ON connections(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('files','database','kubernetes','volume','virtual-machine')),
        adapter_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_sources_active_name ON sources(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        connection_id TEXT,
        adapter_id TEXT NOT NULL,
        engine_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_repositories_active_name ON repositories(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        backup_mode TEXT NOT NULL CHECK (backup_mode IN ('full','incremental','differential','forever-incremental','native')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id)
      );
      CREATE UNIQUE INDEX uq_policies_active_name ON policies(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE backup_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        worker_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('draft','enabled','paused','disabled')),
        next_run_at TEXT,
        last_successful_run_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, policy_id) REFERENCES policies(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_backup_jobs_active_name ON backup_jobs(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
      CREATE INDEX idx_backup_jobs_workspace_state ON backup_jobs(workspace_id, state, next_run_at);

      CREATE TABLE execution_groups (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_revision INTEGER NOT NULL CHECK (job_revision >= 1),
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','schedule','policy','api')),
        scheduled_for TEXT,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','warning','failed','canceled')),
        latest_run_id TEXT,
        terminal_run_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, job_id) REFERENCES backup_jobs(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_execution_groups_idempotency ON execution_groups(workspace_id, idempotency_key);
      CREATE UNIQUE INDEX uq_execution_groups_schedule ON execution_groups(workspace_id, job_id, scheduled_for) WHERE scheduled_for IS NOT NULL;

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        execution_group_id TEXT NOT NULL,
        scheduled_for TEXT,
        idempotency_key TEXT NOT NULL,
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','schedule','retry','policy','api')),
        worker_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','preparing','running','verifying','succeeded','warning','failed','canceled','interrupted')),
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        parent_run_id TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        UNIQUE (workspace_id, idempotency_key),
        FOREIGN KEY (workspace_id, job_id) REFERENCES backup_jobs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, execution_group_id) REFERENCES execution_groups(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, parent_run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX idx_runs_workspace_state_created ON runs(workspace_id, state, created_at);
      CREATE INDEX idx_runs_job_created ON runs(workspace_id, job_id, created_at);

      CREATE TABLE recovery_points (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        point_type TEXT NOT NULL CHECK (point_type IN ('full','incremental','differential','synthetic-full','log','snapshot')),
        consistency TEXT NOT NULL CHECK (consistency IN ('application','crash','filesystem','unknown')),
        chain_root_id TEXT NOT NULL,
        parent_recovery_point_id TEXT,
        captured_from TEXT NOT NULL,
        captured_to TEXT NOT NULL,
        retention_expire_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, job_id) REFERENCES backup_jobs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, chain_root_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (workspace_id, parent_recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX idx_recovery_points_job_captured ON recovery_points(workspace_id, job_id, captured_to);
      CREATE INDEX idx_recovery_points_source_captured ON recovery_points(workspace_id, source_id, captured_to);
      CREATE INDEX idx_recovery_points_retention ON recovery_points(workspace_id, retention_expire_at);

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        recovery_point_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('manifest','data','database-dump','physical-backup','transaction-log','schema','metadata','index')),
        locator TEXT NOT NULL,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE restore_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_connection_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','preparing','running','validating','succeeded','warning','failed','canceled','interrupted')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, target_connection_id) REFERENCES connections(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_restore_runs_workspace_state_created ON restore_runs(workspace_id, state, created_at);

      CREATE TABLE verification_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('repository','job','recovery-point')),
        scope_id TEXT NOT NULL,
        recovery_point_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','warning','failed','canceled','interrupted')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_verification_runs_workspace_state_created ON verification_runs(workspace_id, state, created_at);

      CREATE TABLE secret_refs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('electron-safe-storage','workspace-vault','external-vault')),
        scope TEXT NOT NULL CHECK (scope IN ('device','workspace')),
        provider_key TEXT NOT NULL,
        secret_type TEXT NOT NULL CHECK (secret_type IN ('password','private-key','token','access-key','encryption-key','certificate')),
        secret_version INTEGER NOT NULL CHECK (secret_version >= 1),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id)
      );
      CREATE UNIQUE INDEX uq_secret_refs_active_name ON secret_refs(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE notification_routes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        route_type TEXT NOT NULL CHECK (route_type IN ('desktop','email','webhook','slack','teams')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id)
      );
      CREATE UNIQUE INDEX uq_notification_routes_active_name ON notification_routes(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE worker_registrations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('online','draining','offline','disabled','incompatible')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        UNIQUE (workspace_id, worker_id)
      );
      CREATE UNIQUE INDEX uq_worker_registrations_active_name ON worker_registrations(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

      CREATE TABLE connection_secret_refs (
        workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, secret_ref_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, connection_id, secret_ref_id),
        FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE repository_secret_refs (
        workspace_id TEXT NOT NULL, repository_id TEXT NOT NULL, secret_ref_id TEXT NOT NULL, role TEXT NOT NULL,
        PRIMARY KEY (workspace_id, repository_id, secret_ref_id, role),
        FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE notification_route_secret_refs (
        workspace_id TEXT NOT NULL, notification_route_id TEXT NOT NULL, secret_ref_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, notification_route_id, secret_ref_id),
        FOREIGN KEY (workspace_id, notification_route_id) REFERENCES notification_routes(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE policy_notification_routes (
        workspace_id TEXT NOT NULL, policy_id TEXT NOT NULL, notification_route_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, policy_id, notification_route_id),
        FOREIGN KEY (workspace_id, policy_id) REFERENCES policies(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, notification_route_id) REFERENCES notification_routes(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE backup_job_repositories (
        workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, repository_id TEXT NOT NULL, binding_order INTEGER NOT NULL,
        binding_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, job_id, repository_id),
        FOREIGN KEY (workspace_id, job_id) REFERENCES backup_jobs(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE restore_run_recovery_points (
        workspace_id TEXT NOT NULL, restore_run_id TEXT NOT NULL, recovery_point_id TEXT NOT NULL, chain_order INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, restore_run_id, recovery_point_id),
        FOREIGN KEY (workspace_id, restore_run_id) REFERENCES restore_runs(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE TABLE recovery_point_repository_copies (
        workspace_id TEXT NOT NULL, recovery_point_id TEXT NOT NULL, repository_id TEXT NOT NULL,
        engine_snapshot_id TEXT NOT NULL, copy_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, recovery_point_id, repository_id),
        FOREIGN KEY (workspace_id, recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_recovery_point_repository_snapshot
        ON recovery_point_repository_copies(workspace_id, repository_id, engine_snapshot_id);
    `
  },
  {
    version: 2,
    description: 'Allow native physical backup Artifacts.',
    sql: `
      CREATE TABLE artifacts_v2 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        recovery_point_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('manifest','data','database-dump','physical-backup','transaction-log','schema','metadata','index')),
        locator TEXT NOT NULL,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE RESTRICT
      );
      INSERT INTO artifacts_v2 SELECT * FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_v2 RENAME TO artifacts;
    `
  },
  {
    version: 3,
    description: 'Allow interrupted verification drills with operator-action-required cleanup evidence.',
    sql: `
      CREATE TABLE verification_runs_v3 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('repository','job','recovery-point')),
        scope_id TEXT NOT NULL,
        recovery_point_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','warning','failed','canceled','interrupted')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, recovery_point_id) REFERENCES recovery_points(workspace_id, id) ON DELETE RESTRICT
      );
      INSERT INTO verification_runs_v3 SELECT * FROM verification_runs;
      DROP TABLE verification_runs;
      ALTER TABLE verification_runs_v3 RENAME TO verification_runs;
      CREATE INDEX idx_verification_runs_workspace_state_created ON verification_runs(workspace_id, state, created_at);
    `
  },
  {
    version: 4,
    description: 'Add shared Database Manager profiles and credential-slot bindings.',
    sql: `
      CREATE TABLE database_profiles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        shared_connection_id TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('development','staging','production','unclassified')),
        access_mode TEXT NOT NULL CHECK (access_mode IN ('read-write','read-only')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, shared_connection_id) REFERENCES connections(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_database_profiles_active_name ON database_profiles(workspace_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
      CREATE INDEX idx_database_profiles_workspace_driver ON database_profiles(workspace_id, driver_id, created_at);
      CREATE INDEX idx_database_profiles_shared_connection ON database_profiles(workspace_id, shared_connection_id);

      CREATE TABLE database_profile_secret_refs (
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        secret_ref_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, profile_id, slot_id),
        FOREIGN KEY (workspace_id, profile_id) REFERENCES database_profiles(workspace_id, id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id, secret_ref_id) REFERENCES secret_refs(workspace_id, id) ON DELETE RESTRICT
      );
    `
  },
  {
    version: 5,
    description: 'Add device-local Database Manager saved queries and bounded query history.',
    sql: `
      CREATE TABLE database_saved_queries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, profile_id) REFERENCES database_profiles(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_database_saved_queries_active_name ON database_saved_queries(workspace_id, profile_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
      CREATE INDEX idx_database_saved_queries_workspace_profile_updated ON database_saved_queries(workspace_id, profile_id, updated_at DESC);

      CREATE TABLE database_query_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, profile_id) REFERENCES database_profiles(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_database_query_history_workspace_profile_created ON database_query_history(workspace_id, profile_id, created_at DESC);
    `
  },
  {
    version: 6,
    description: 'Add revisioned device-local Database Manager notebooks.',
    sql: `
      CREATE TABLE database_notebooks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, profile_id) REFERENCES database_profiles(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX uq_database_notebooks_active_name ON database_notebooks(workspace_id, profile_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;
      CREATE INDEX idx_database_notebooks_workspace_profile_updated ON database_notebooks(workspace_id, profile_id, updated_at DESC);
    `
  },
  {
    version: 7,
    description: 'Add persistent Database Manager task progress records.',
    sql: `
      CREATE TABLE database_tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK (task_type IN ('import','dump','explain','schema','administration')),
        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','canceled','interrupted')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, data_json TEXT NOT NULL,
        UNIQUE (workspace_id, id),
        FOREIGN KEY (workspace_id, profile_id) REFERENCES database_profiles(workspace_id, id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_database_tasks_workspace_profile_state_updated ON database_tasks(workspace_id, profile_id, state, updated_at DESC);
    `
  }
]);

class ControlDatabaseError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class ControlDatabaseCorruptionError extends ControlDatabaseError {
  constructor(message, options) {
    super(message, 'BACKUP_CONTROL_DB_CORRUPT', options);
  }
}

class ControlDatabaseCompatibilityError extends ControlDatabaseError {
  constructor(message) {
    super(message, 'BACKUP_CONTROL_DB_NEWER_SCHEMA');
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > maximumLength) throw new TypeError(`${label} is too long.`);
  return normalized;
}

function optionalText(value, label, maximumLength = 4096) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function booleanInteger(value, fallback) {
  return (value === undefined ? fallback : Boolean(value)) ? 1 : 0;
}

function processIsRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value < 1) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function generateUuidV7() {
  const bytes = crypto.randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseJson(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new ControlDatabaseCorruptionError(`Backup Manager ${label} contains invalid JSON.`, { cause: error });
  }
}

function assertSafeRecord(value, trail = []) {
  if (!value || typeof value !== 'object') return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new TypeError(`Binary secret material is not allowed in Backup Manager records (${trail.join('.') || 'record'}).`);
  }
  for (const [key, nested] of Object.entries(value)) {
    const compactKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isReference = compactKey.includes('secretref') || compactKey === 'providerkey' || compactKey === 'fingerprint';
    const forbidden = /^(password|passwd|passphrase|privatekey|secret|secretvalue|token|accesstoken|refreshtoken|apikey|authorization|credential|encryptionkey)$/.test(compactKey);
    if (forbidden && !isReference && nested !== null && nested !== '') {
      throw new TypeError(`Plaintext credential field "${[...trail, key].join('.')}" is not allowed; store a SecretRef ID instead.`);
    }
    assertSafeRecord(nested, [...trail, key]);
  }
}

function valuesFromRows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function oneValue(database, sql, parameters = []) {
  const rows = valuesFromRows(database, sql, parameters);
  if (!rows.length) return undefined;
  return Object.values(rows[0])[0];
}

function commonRecord(spec, input, clock) {
  const workspaceId = requiredText(input.workspaceId, 'Workspace ID', 200);
  const actorId = requiredText(input.actorId || input.createdBy || 'system', 'Actor ID', 200);
  const createdAt = clock();
  const record = {
    ...structuredClone(input),
    id: optionalText(input.id, 'Record ID', 200) || `${spec.prefix}_${generateUuidV7()}`,
    workspaceId,
    schemaVersion: RECORD_SCHEMA_VERSION,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    createdBy: actorId,
    updatedBy: actorId,
    deletedAt: null,
    labels: input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? structuredClone(input.labels) : {}
  };
  delete record.actorId;
  if (spec.named) record.name = requiredText(input.name, 'Name', 200);
  assertSafeRecord(record);
  return record;
}

function entityColumns(type, record) {
  const common = [
    record.id, record.workspaceId, record.revision, record.schemaVersion,
    record.createdAt, record.updatedAt, record.createdBy, record.updatedBy, record.deletedAt
  ];
  switch (type) {
    case 'connection':
      return { names: ['id','workspace_id','name','kind','adapter_id','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, requiredText(record.kind, 'Connection kind', 40), requiredText(record.adapterId, 'Adapter ID', 200), ...common.slice(2), JSON.stringify(record)] };
    case 'databaseProfile':
      return { names: ['id','workspace_id','name','shared_connection_id','driver_id','environment','access_mode','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, requiredText(record.sharedConnectionId, 'Shared connection ID', 200), requiredText(record.driverId, 'Database driver ID', 100), requiredText(record.environment, 'Database environment', 40), requiredText(record.accessMode, 'Database access mode', 40), ...common.slice(2), JSON.stringify(record)] };
    case 'databaseSavedQuery':
      return { names: ['id','workspace_id','profile_id','name','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.profileId, 'Database profile ID', 200), record.name, ...common.slice(2), JSON.stringify(record)] };
    case 'databaseQueryHistory':
      return { names: ['id','workspace_id','profile_id','status','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.profileId, 'Database profile ID', 200), requiredText(record.status, 'Database query status', 40), ...common.slice(2), JSON.stringify(record)] };
    case 'databaseNotebook':
      return { names: ['id','workspace_id','profile_id','name','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.profileId, 'Database profile ID', 200), record.name, ...common.slice(2), JSON.stringify(record)] };
    case 'databaseTask':
      return { names: ['id','workspace_id','profile_id','task_type','state','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.profileId, 'Database profile ID', 200), requiredText(record.type, 'Database task type', 40), requiredText(record.state, 'Database task state', 40), ...common.slice(2), JSON.stringify(record)] };
    case 'source':
      return { names: ['id','workspace_id','name','connection_id','source_type','adapter_id','enabled','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, requiredText(record.connectionId, 'Connection ID', 200), requiredText(record.sourceType, 'Source type', 40), requiredText(record.adapterId, 'Adapter ID', 200), booleanInteger(record.enabled, true), ...common.slice(2), JSON.stringify(record)] };
    case 'repository':
      return { names: ['id','workspace_id','name','connection_id','adapter_id','engine_id','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, optionalText(record.connectionId, 'Connection ID', 200), requiredText(record.adapterId, 'Adapter ID', 200), requiredText(record.engineId, 'Engine ID', 200), ...common.slice(2), JSON.stringify(record)] };
    case 'policy':
      return { names: ['id','workspace_id','name','enabled','backup_mode','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, booleanInteger(record.enabled, true), requiredText(record.backupMode, 'Backup mode', 40), ...common.slice(2), JSON.stringify(record)] };
    case 'backupJob':
      return { names: ['id','workspace_id','name','source_id','policy_id','worker_id','state','next_run_at','last_successful_run_id','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, requiredText(record.sourceId, 'Source ID', 200), requiredText(record.policyId, 'Policy ID', 200), optionalText(record.workerId, 'Worker ID', 200), requiredText(record.state, 'Job state', 40), optionalText(record.nextRunAt, 'Next run time', 100), optionalText(record.lastSuccessfulRunId, 'Last successful run ID', 200), ...common.slice(2), JSON.stringify(record)] };
    case 'executionGroup':
      return { names: ['id','workspace_id','job_id','job_revision','trigger_type','scheduled_for','idempotency_key','state','latest_run_id','terminal_run_id','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.jobId, 'Job ID', 200), Number(record.jobRevision), requiredText(record.trigger, 'Trigger', 40), optionalText(record.scheduledFor, 'Scheduled time', 100), requiredText(record.idempotencyKey, 'Idempotency key', 300), requiredText(record.state, 'Execution group state', 40), optionalText(record.latestRunId, 'Latest run ID', 200), optionalText(record.terminalRunId, 'Terminal run ID', 200), ...common.slice(2), JSON.stringify(record)] };
    case 'run':
      return { names: ['id','workspace_id','job_id','execution_group_id','scheduled_for','idempotency_key','trigger_type','worker_id','state','attempt','parent_run_id','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.jobId, 'Job ID', 200), requiredText(record.executionGroupId, 'Execution group ID', 200), optionalText(record.scheduledFor, 'Scheduled time', 100), requiredText(record.idempotencyKey, 'Idempotency key', 300), requiredText(record.trigger, 'Trigger', 40), requiredText(record.workerId, 'Worker ID', 200), requiredText(record.state, 'Run state', 40), Number(record.attempt), optionalText(record.parentRunId, 'Parent run ID', 200), ...common.slice(2), JSON.stringify(record)] };
    case 'recoveryPoint':
      return { names: ['id','workspace_id','job_id','source_id','run_id','point_type','consistency','chain_root_id','parent_recovery_point_id','captured_from','captured_to','retention_expire_at','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.jobId, 'Job ID', 200), requiredText(record.sourceId, 'Source ID', 200), requiredText(record.runId, 'Run ID', 200), requiredText(record.type, 'Recovery point type', 40), requiredText(record.consistency, 'Consistency', 40), requiredText(record.chainRootId, 'Chain root ID', 200), optionalText(record.parentRecoveryPointId, 'Parent recovery point ID', 200), requiredText(record.capturedFrom, 'Captured-from time', 100), requiredText(record.capturedTo, 'Captured-to time', 100), optionalText(record.retention?.expireAt, 'Retention expiry', 100), ...common.slice(2), JSON.stringify(record)] };
    case 'artifact':
      return { names: ['id','workspace_id','recovery_point_id','repository_id','kind','locator','size_bytes','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.recoveryPointId, 'Recovery point ID', 200), requiredText(record.repositoryId, 'Repository ID', 200), requiredText(record.kind, 'Artifact kind', 40), requiredText(record.locator, 'Artifact locator'), record.sizeBytes === null || record.sizeBytes === undefined ? null : Number(record.sizeBytes), ...common.slice(2), JSON.stringify(record)] };
    case 'restoreRun':
      return { names: ['id','workspace_id','target_connection_id','state','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.targetConnectionId, 'Target connection ID', 200), requiredText(record.state, 'Restore state', 40), ...common.slice(2), JSON.stringify(record)] };
    case 'verificationRun':
      return { names: ['id','workspace_id','scope_type','scope_id','recovery_point_id','state','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.scopeType, 'Verification scope type', 40), requiredText(record.scopeId, 'Verification scope ID', 200), optionalText(record.recoveryPointId, 'Recovery point ID', 200), requiredText(record.state, 'Verification state', 40), ...common.slice(2), JSON.stringify(record)] };
    case 'secretRef':
      return { names: ['id','workspace_id','name','provider','scope','provider_key','secret_type','secret_version','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, requiredText(record.provider, 'Secret provider', 80), requiredText(record.scope, 'Secret scope', 40), requiredText(record.providerKey, 'Provider key', 300), requiredText(record.secretType, 'Secret type', 40), Number(record.version), ...common.slice(2), JSON.stringify(record)] };
    case 'notificationRoute':
      return { names: ['id','workspace_id','name','route_type','enabled','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, record.name, requiredText(record.type, 'Notification route type', 40), booleanInteger(record.enabled, true), ...common.slice(2), JSON.stringify(record)] };
    case 'workerRegistration':
      return { names: ['id','workspace_id','worker_id','device_id','name','state','revision','schema_version','created_at','updated_at','created_by','updated_by','deleted_at','data_json'], values: [record.id, record.workspaceId, requiredText(record.workerId, 'Worker ID', 200), requiredText(record.deviceId, 'Device ID', 200), record.name, requiredText(record.state, 'Worker state', 40), ...common.slice(2), JSON.stringify(record)] };
    default:
      throw new TypeError(`Unknown Backup Manager entity type: ${type}`);
  }
}

class EntityRepository {
  constructor(controlDatabase, type) {
    this.controlDatabase = controlDatabase;
    this.type = type;
  }

  create(input) {
    return this.controlDatabase.transaction((transaction) => transaction.create(this.type, input));
  }

  get(workspaceId, id, options) {
    return this.controlDatabase.read((transaction) => transaction.get(this.type, workspaceId, id, options));
  }

  list(workspaceId, options) {
    return this.controlDatabase.read((transaction) => transaction.list(this.type, workspaceId, options));
  }

  update(workspaceId, id, changes, options) {
    return this.controlDatabase.transaction((transaction) => transaction.update(this.type, workspaceId, id, changes, options));
  }

  softDelete(workspaceId, id, options) {
    return this.controlDatabase.transaction((transaction) => transaction.softDelete(this.type, workspaceId, id, options));
  }
}

class ControlTransaction {
  constructor(database, clock) {
    this.database = database;
    this.clock = clock;
    this.changedRecords = [];
  }

  changes() {
    return this.changedRecords.map((change) => structuredClone(change));
  }

  upsertSnapshot(type, workspaceId, snapshot) {
    const spec = ENTITY_SPECS[type];
    if (!spec) throw new TypeError(`Unknown Backup Manager entity type: ${type}`);
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const record = structuredClone(snapshot);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Backup Manager snapshot is invalid.');
    if (requiredText(record.workspaceId, 'Workspace ID', 200) !== tenant) throw new TypeError('Backup Manager snapshot workspace does not match.');
    requiredText(record.id, 'Record ID', 200);
    if (!Number.isInteger(Number(record.revision)) || Number(record.revision) < 1) throw new TypeError('Backup Manager snapshot revision is invalid.');
    if (!Number.isInteger(Number(record.schemaVersion)) || Number(record.schemaVersion) < 1) throw new TypeError('Backup Manager snapshot schema version is invalid.');
    requiredText(record.createdAt, 'Created time', 100);
    requiredText(record.updatedAt, 'Updated time', 100);
    requiredText(record.createdBy, 'Created by', 200);
    requiredText(record.updatedBy, 'Updated by', 200);
    if (record.deletedAt !== null && record.deletedAt !== undefined) requiredText(record.deletedAt, 'Deleted time', 100);
    if (spec.named) record.name = requiredText(record.name, 'Name', 200);
    assertSafeRecord(record);
    const existing = this.get(type, tenant, record.id, { includeDeleted: true });
    const { names, values } = entityColumns(type, record);
    if (!existing) {
      this.database.run(`INSERT INTO ${spec.table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, values);
    } else {
      const assignments = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => `${name} = ?`);
      const updateValues = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => values[names.indexOf(name)]);
      this.database.run(`UPDATE ${spec.table} SET ${assignments.join(',')} WHERE workspace_id = ? AND id = ?`, [...updateValues, tenant, record.id]);
    }
    this.#syncRelations(type, record);
    return structuredClone(record);
  }

  create(type, input = {}) {
    const spec = ENTITY_SPECS[type];
    if (!spec) throw new TypeError(`Unknown Backup Manager entity type: ${type}`);
    const record = commonRecord(spec, input, this.clock);
    const { names, values } = entityColumns(type, record);
    const placeholders = names.map(() => '?').join(',');
    this.database.run(`INSERT INTO ${spec.table} (${names.join(',')}) VALUES (${placeholders})`, values);
    this.#syncRelations(type, record);
    this.#recordChange(type, record, null);
    return structuredClone(record);
  }

  get(type, workspaceId, id, options = {}) {
    const spec = ENTITY_SPECS[type];
    if (!spec) throw new TypeError(`Unknown Backup Manager entity type: ${type}`);
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recordId = requiredText(id, 'Record ID', 200);
    const activeClause = options.includeDeleted ? '' : ' AND deleted_at IS NULL';
    const rows = valuesFromRows(this.database, `SELECT data_json FROM ${spec.table} WHERE workspace_id = ? AND id = ?${activeClause}`, [tenant, recordId]);
    return rows.length ? parseJson(rows[0].data_json, `${type} record`) : null;
  }

  list(type, workspaceId, options = {}) {
    const spec = ENTITY_SPECS[type];
    if (!spec) throw new TypeError(`Unknown Backup Manager entity type: ${type}`);
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const activeClause = options.includeDeleted ? '' : ' AND deleted_at IS NULL';
    const maximumLimit = type === 'recoveryPoint' ? 60001 : 1000;
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), maximumLimit);
    return valuesFromRows(this.database, `SELECT data_json FROM ${spec.table} WHERE workspace_id = ?${activeClause} ORDER BY created_at DESC, id DESC LIMIT ?`, [tenant, limit])
      .map((row) => parseJson(row.data_json, `${type} record`));
  }

  pruneDatabaseQueryHistory(workspaceId, keep = 500) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const retained = Number(keep);
    if (!Number.isInteger(retained) || retained < 1 || retained > 5000) throw new TypeError('Database query history retention is invalid.');
    const stale = valuesFromRows(this.database, 'SELECT id FROM database_query_history WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', [tenant, retained]);
    for (const row of stale) this.database.run('DELETE FROM database_query_history WHERE workspace_id = ? AND id = ?', [tenant, row.id]);
    return stale.length;
  }

  clearDatabaseQueryHistory(workspaceId, profileId = null) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const profile = optionalText(profileId, 'Database profile ID', 200);
    const count = Number(oneValue(this.database, `SELECT COUNT(*) FROM database_query_history WHERE workspace_id = ?${profile ? ' AND profile_id = ?' : ''}`, profile ? [tenant, profile] : [tenant]) || 0);
    this.database.run(`DELETE FROM database_query_history WHERE workspace_id = ?${profile ? ' AND profile_id = ?' : ''}`, profile ? [tenant, profile] : [tenant]);
    return count;
  }

  update(type, workspaceId, id, changes = {}, options = {}) {
    const spec = ENTITY_SPECS[type];
    if (!spec?.mutable) throw new TypeError(`${type} records cannot be changed through ordinary CRUD.`);
    const current = this.get(type, workspaceId, id);
    if (!current) throw new ControlDatabaseError(`${type} record was not found.`, 'BACKUP_CONTROL_RECORD_NOT_FOUND');
    const expectedRevision = Number(options.expectedRevision ?? current.revision);
    if (current.revision !== expectedRevision) {
      throw new ControlDatabaseError(`${type} revision conflict.`, 'BACKUP_CONTROL_REVISION_CONFLICT');
    }
    const actorId = requiredText(options.actorId || changes.actorId || 'system', 'Actor ID', 200);
    const record = {
      ...current,
      ...structuredClone(changes),
      id: current.id,
      workspaceId: current.workspaceId,
      schemaVersion: current.schemaVersion,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: this.clock(),
      updatedBy: actorId,
      deletedAt: current.deletedAt
    };
    delete record.actorId;
    if (spec.named) record.name = requiredText(record.name, 'Name', 200);
    assertSafeRecord(record);
    const { names, values } = entityColumns(type, record);
    const assignments = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => `${name} = ?`);
    const updateValues = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => values[names.indexOf(name)]);
    const result = this.database.run(`UPDATE ${spec.table} SET ${assignments.join(',')} WHERE workspace_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`, [...updateValues, current.workspaceId, current.id, expectedRevision]);
    if (this.database.getRowsModified() !== 1) throw new ControlDatabaseError(`${type} revision conflict.`, 'BACKUP_CONTROL_REVISION_CONFLICT');
    this.#syncRelations(type, record);
    this.#recordChange(type, record, current);
    return structuredClone(record);
  }

  projectExecution(type, workspaceId, id, changes = {}, options = {}) {
    if (!['run', 'executionGroup', 'restoreRun', 'verificationRun'].includes(type)) throw new TypeError('Only Run, ExecutionGroup, RestoreRun, and VerificationRun records support execution projection.');
    const current = this.get(type, workspaceId, id);
    if (!current) throw new ControlDatabaseError(`${type} record was not found.`, 'BACKUP_CONTROL_RECORD_NOT_FOUND');
    const expectedRevision = Number(options.expectedRevision ?? current.revision);
    if (current.revision !== expectedRevision) throw new ControlDatabaseError(`${type} revision conflict.`, 'BACKUP_CONTROL_REVISION_CONFLICT');
    const transitions = type === 'run'
      ? RUN_STATE_TRANSITIONS
      : type === 'restoreRun'
        ? RESTORE_RUN_STATE_TRANSITIONS
        : type === 'verificationRun'
          ? VERIFICATION_RUN_STATE_TRANSITIONS
        : EXECUTION_GROUP_STATE_TRANSITIONS;
    const nextState = changes.state === undefined ? current.state : requiredText(changes.state, 'Execution state', 40);
    if (nextState !== current.state && !transitions[current.state]?.has(nextState)) throw new ControlDatabaseError(`Invalid ${type} state transition from ${current.state} to ${nextState}.`, 'BACKUP_CONTROL_STATE_TRANSITION_INVALID');
    if (!transitions[current.state] || (transitions[current.state].size === 0 && Object.keys(changes).some((key) => key !== 'state'))) throw new ControlDatabaseError(`Terminal ${type} records cannot be changed.`, 'BACKUP_CONTROL_RECORD_TERMINAL');
    const actorId = requiredText(options.actorId || changes.actorId || 'system', 'Actor ID', 200);
    const record = {
      ...current,
      ...structuredClone(changes),
      id: current.id,
      workspaceId: current.workspaceId,
      schemaVersion: current.schemaVersion,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      updatedAt: this.clock(),
      updatedBy: actorId,
      deletedAt: current.deletedAt,
      state: nextState
    };
    delete record.actorId;
    assertSafeRecord(record);
    const { names, values } = entityColumns(type, record);
    const assignments = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => `${name} = ?`);
    const updateValues = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => values[names.indexOf(name)]);
    this.database.run(`UPDATE ${ENTITY_SPECS[type].table} SET ${assignments.join(',')} WHERE workspace_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`, [...updateValues, current.workspaceId, current.id, expectedRevision]);
    if (this.database.getRowsModified() !== 1) throw new ControlDatabaseError(`${type} revision conflict.`, 'BACKUP_CONTROL_REVISION_CONFLICT');
    this.#recordChange(type, record, current);
    return structuredClone(record);
  }

  projectRecoveryPointRetention(workspaceId, id, retention, options = {}) {
    const current = this.get('recoveryPoint', workspaceId, id);
    if (!current) throw new ControlDatabaseError('recoveryPoint record was not found.', 'BACKUP_CONTROL_RECORD_NOT_FOUND');
    const expectedRevision = Number(options.expectedRevision ?? current.revision);
    if (current.revision !== expectedRevision) throw new ControlDatabaseError('recoveryPoint revision conflict.', 'BACKUP_CONTROL_REVISION_CONFLICT');
    assertNativeMediaDeletionClaimMutationAllowed(current, options);
    const actorId = requiredText(options.actorId || 'system', 'Actor ID', 200);
    const record = {
      ...current,
      retention: structuredClone(retention),
      revision: current.revision + 1,
      updatedAt: this.clock(),
      updatedBy: actorId
    };
    assertSafeRecord(record);
    const { names, values } = entityColumns('recoveryPoint', record);
    const assignments = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => `${name} = ?`);
    const updateValues = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => values[names.indexOf(name)]);
    this.database.run(`UPDATE ${ENTITY_SPECS.recoveryPoint.table} SET ${assignments.join(',')} WHERE workspace_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`, [...updateValues, current.workspaceId, current.id, expectedRevision]);
    if (this.database.getRowsModified() !== 1) throw new ControlDatabaseError('recoveryPoint revision conflict.', 'BACKUP_CONTROL_REVISION_CONFLICT');
    this.#recordChange('recoveryPoint', record, current);
    return structuredClone(record);
  }

  projectRecoveryPointRepositoryCopies(workspaceId, id, repositoryCopies, options = {}) {
    const current = this.get('recoveryPoint', workspaceId, id);
    if (!current) throw new ControlDatabaseError('recoveryPoint record was not found.', 'BACKUP_CONTROL_RECORD_NOT_FOUND');
    const expectedRevision = Number(options.expectedRevision ?? current.revision);
    if (current.revision !== expectedRevision) throw new ControlDatabaseError('recoveryPoint revision conflict.', 'BACKUP_CONTROL_REVISION_CONFLICT');
    assertNativeMediaDeletionClaimMutationAllowed(current, options);
    if (!Array.isArray(repositoryCopies) || repositoryCopies.length !== (current.repositoryCopies || []).length) {
      throw new ControlDatabaseError('Recovery-point repository copies are invalid.', 'BACKUP_CONTROL_PROJECTION_INVALID');
    }
    const currentIds = (current.repositoryCopies || []).map((copy) => copy.repositoryId).sort();
    const nextIds = repositoryCopies.map((copy) => requiredText(copy?.repositoryId, 'Repository copy ID', 200)).sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(nextIds)) throw new ControlDatabaseError('Recovery-point repository-copy identity cannot change.', 'BACKUP_CONTROL_PROJECTION_INVALID');
    const actorId = requiredText(options.actorId || 'system', 'Actor ID', 200);
    const record = {
      ...current,
      repositoryCopies: structuredClone(repositoryCopies),
      revision: current.revision + 1,
      updatedAt: this.clock(),
      updatedBy: actorId
    };
    assertSafeRecord(record);
    const { names, values } = entityColumns('recoveryPoint', record);
    const assignments = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => `${name} = ?`);
    const updateValues = names.filter((name) => !['id', 'workspace_id'].includes(name)).map((name) => values[names.indexOf(name)]);
    this.database.run(`UPDATE ${ENTITY_SPECS.recoveryPoint.table} SET ${assignments.join(',')} WHERE workspace_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`, [...updateValues, current.workspaceId, current.id, expectedRevision]);
    if (this.database.getRowsModified() !== 1) throw new ControlDatabaseError('recoveryPoint revision conflict.', 'BACKUP_CONTROL_REVISION_CONFLICT');
    this.#syncRelations('recoveryPoint', record);
    this.#recordChange('recoveryPoint', record, current);
    return structuredClone(record);
  }

  softDelete(type, workspaceId, id, options = {}) {
    const spec = ENTITY_SPECS[type];
    if (!spec?.mutable) throw new TypeError(`${type} records cannot be deleted through ordinary CRUD.`);
    const current = this.get(type, workspaceId, id);
    if (!current) throw new ControlDatabaseError(`${type} record was not found.`, 'BACKUP_CONTROL_RECORD_NOT_FOUND');
    const expectedRevision = Number(options.expectedRevision ?? current.revision);
    const deletedAt = this.clock();
    const actorId = requiredText(options.actorId || 'system', 'Actor ID', 200);
    this.#assertSoftDeleteAllowed(type, current);
    const record = { ...current, revision: current.revision + 1, updatedAt: deletedAt, updatedBy: actorId, deletedAt };
    const result = this.database.run(`UPDATE ${spec.table} SET revision = ?, updated_at = ?, updated_by = ?, deleted_at = ?, data_json = ? WHERE workspace_id = ? AND id = ? AND revision = ? AND deleted_at IS NULL`, [record.revision, record.updatedAt, record.updatedBy, record.deletedAt, JSON.stringify(record), current.workspaceId, current.id, expectedRevision]);
    if (this.database.getRowsModified() !== 1) throw new ControlDatabaseError(`${type} revision conflict.`, 'BACKUP_CONTROL_REVISION_CONFLICT');
    if (type === 'connection' || type === 'databaseProfile' || type === 'repository' || type === 'notificationRoute') this.#syncRelations(type, record);
    this.#recordChange(type, record, current);
    return structuredClone(record);
  }

  #recordChange(type, record, previous) {
    this.changedRecords.push({
      type,
      record: structuredClone(record),
      previous: previous ? structuredClone(previous) : null
    });
  }

  #assertSoftDeleteAllowed(type, record) {
    const checks = {
      connection: [
        ['SELECT COUNT(*) FROM sources WHERE workspace_id = ? AND connection_id = ? AND deleted_at IS NULL', 'Connection is referenced by an active source.'],
        ['SELECT COUNT(*) FROM repositories WHERE workspace_id = ? AND connection_id = ? AND deleted_at IS NULL', 'Connection is referenced by an active repository.'],
        ['SELECT COUNT(*) FROM database_profiles WHERE workspace_id = ? AND shared_connection_id = ? AND deleted_at IS NULL', 'Connection is referenced by an active database profile.']
      ],
      source: [
        ["SELECT COUNT(*) FROM backup_jobs WHERE workspace_id = ? AND source_id = ? AND state = 'enabled' AND deleted_at IS NULL", 'Source is referenced by an enabled backup job.']
      ],
      repository: [
        ["SELECT COUNT(*) FROM backup_job_repositories bindings JOIN backup_jobs jobs ON jobs.workspace_id = bindings.workspace_id AND jobs.id = bindings.job_id WHERE bindings.workspace_id = ? AND bindings.repository_id = ? AND jobs.state = 'enabled' AND jobs.deleted_at IS NULL", 'Repository is referenced by an enabled backup job.'],
        ['SELECT COUNT(*) FROM recovery_point_repository_copies WHERE workspace_id = ? AND repository_id = ?', 'Repository contains retained recovery-point copies.']
      ],
      policy: [
        ["SELECT COUNT(*) FROM backup_jobs WHERE workspace_id = ? AND policy_id = ? AND state = 'enabled' AND deleted_at IS NULL", 'Policy is referenced by an enabled backup job.']
      ],
      secretRef: [
        ['SELECT COUNT(*) FROM connection_secret_refs WHERE workspace_id = ? AND secret_ref_id = ?', 'SecretRef is referenced by a connection.'],
        ['SELECT COUNT(*) FROM database_profile_secret_refs WHERE workspace_id = ? AND secret_ref_id = ?', 'SecretRef is referenced by a database profile.'],
        ['SELECT COUNT(*) FROM repository_secret_refs WHERE workspace_id = ? AND secret_ref_id = ?', 'SecretRef is referenced by a repository.'],
        ['SELECT COUNT(*) FROM notification_route_secret_refs WHERE workspace_id = ? AND secret_ref_id = ?', 'SecretRef is referenced by a notification route.']
      ],
      notificationRoute: [
        ['SELECT COUNT(*) FROM policy_notification_routes WHERE workspace_id = ? AND notification_route_id = ?', 'Notification route is referenced by a policy.']
      ],
      workerRegistration: [
        ["SELECT COUNT(*) FROM backup_jobs WHERE workspace_id = ? AND worker_id = ? AND state = 'enabled' AND deleted_at IS NULL", 'Worker is assigned to an enabled backup job.']
      ]
    };
    for (const [sql, message] of checks[type] || []) {
      const referenceId = type === 'workerRegistration' ? record.workerId : record.id;
      if (Number(oneValue(this.database, sql, [record.workspaceId, referenceId])) > 0) {
        throw new ControlDatabaseError(message, 'BACKUP_CONTROL_RECORD_REFERENCED');
      }
    }
  }

  #syncRelations(type, record) {
    const workspaceId = record.workspaceId;
    const replaceList = (table, ownerColumn, values, insert) => {
      this.database.run(`DELETE FROM ${table} WHERE workspace_id = ? AND ${ownerColumn} = ?`, [workspaceId, record.id]);
      values.forEach(insert);
    };
    if (type === 'connection') {
      replaceList('connection_secret_refs', 'connection_id', record.deletedAt ? [] : record.secretRefIds || [], (secretRefId) => {
        this.database.run('INSERT INTO connection_secret_refs VALUES (?,?,?)', [workspaceId, record.id, requiredText(secretRefId, 'SecretRef ID', 200)]);
      });
    } else if (type === 'databaseProfile') {
      const bindings = record.deletedAt ? [] : record.credentialSecretRefs || [];
      replaceList('database_profile_secret_refs', 'profile_id', bindings, ({ slotId, secretRefId }) => {
        this.database.run('INSERT INTO database_profile_secret_refs VALUES (?,?,?,?)', [workspaceId, record.id, requiredText(slotId, 'Credential slot ID', 100), requiredText(secretRefId, 'SecretRef ID', 200)]);
      });
    } else if (type === 'repository') {
      const refs = record.deletedAt ? [] : [
        ...(record.secretRefIds || []).map((secretRefId) => ({ secretRefId, role: 'transport' })),
        ...(record.encryptionKeyRefId ? [{ secretRefId: record.encryptionKeyRefId, role: 'encryption-key' }] : [])
      ];
      replaceList('repository_secret_refs', 'repository_id', refs, ({ secretRefId, role }) => {
        this.database.run('INSERT INTO repository_secret_refs VALUES (?,?,?,?)', [workspaceId, record.id, requiredText(secretRefId, 'SecretRef ID', 200), role]);
      });
    } else if (type === 'notificationRoute') {
      replaceList('notification_route_secret_refs', 'notification_route_id', record.deletedAt ? [] : record.secretRefIds || [], (secretRefId) => {
        this.database.run('INSERT INTO notification_route_secret_refs VALUES (?,?,?)', [workspaceId, record.id, requiredText(secretRefId, 'SecretRef ID', 200)]);
      });
    } else if (type === 'policy') {
      replaceList('policy_notification_routes', 'policy_id', record.notificationRouteIds || [], (routeId) => {
        this.database.run('INSERT INTO policy_notification_routes VALUES (?,?,?)', [workspaceId, record.id, requiredText(routeId, 'Notification route ID', 200)]);
      });
    } else if (type === 'backupJob') {
      replaceList('backup_job_repositories', 'job_id', record.repositoryBindings || [], (binding, index) => {
        this.database.run('INSERT INTO backup_job_repositories VALUES (?,?,?,?,?)', [workspaceId, record.id, requiredText(binding.repositoryId, 'Repository binding ID', 200), index, JSON.stringify(binding)]);
      });
    } else if (type === 'restoreRun') {
      replaceList('restore_run_recovery_points', 'restore_run_id', record.recoveryPointIds || [], (recoveryPointId, index) => {
        this.database.run('INSERT INTO restore_run_recovery_points VALUES (?,?,?,?)', [workspaceId, record.id, requiredText(recoveryPointId, 'Recovery point ID', 200), index]);
      });
    } else if (type === 'recoveryPoint') {
      replaceList('recovery_point_repository_copies', 'recovery_point_id', record.repositoryCopies || [], (copy) => {
        this.database.run('INSERT INTO recovery_point_repository_copies VALUES (?,?,?,?,?)', [workspaceId, record.id, requiredText(copy.repositoryId, 'Repository copy ID', 200), requiredText(copy.engineSnapshotId, 'Engine snapshot ID', 400), JSON.stringify(copy)]);
      });
    }
  }
}

class BackupControlDatabase {
  constructor({ rootPath, clock = () => new Date().toISOString(), lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, lockRetryMs = DEFAULT_LOCK_RETRY_MS, onChange = null } = {}) {
    this.rootPath = requiredText(rootPath, 'Control database root path');
    this.databasePath = path.join(this.rootPath, DATABASE_FILE_NAME);
    this.lockPath = path.join(this.rootPath, DATABASE_LOCK_FILE_NAME);
    this.clock = clock;
    this.lockTimeoutMs = Number(lockTimeoutMs);
    this.lockRetryMs = Number(lockRetryMs);
    if (onChange !== null && typeof onChange !== 'function') throw new TypeError('Control database change handler is invalid.');
    this.onChange = onChange;
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 100 || this.lockTimeoutMs > 120000) throw new TypeError('Control database lock timeout is invalid.');
    if (!Number.isInteger(this.lockRetryMs) || this.lockRetryMs < 1 || this.lockRetryMs > 1000) throw new TypeError('Control database lock retry interval is invalid.');
    this.database = null;
    this.initialized = false;
    this.operationQueue = Promise.resolve();
    this.repositories = Object.fromEntries(Object.keys(ENTITY_SPECS).map((type) => [type, new EntityRepository(this, type)]));
  }

  async initialize() {
    if (this.initialized) return this;
    await fs.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    return this.#withFileLock(async () => {
      const SqlJs = await SQL;
      let existingBytes = null;
      try { existingBytes = await fs.readFile(this.databasePath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { this.database = existingBytes ? new SqlJs.Database(existingBytes) : new SqlJs.Database(); }
      catch (error) { throw new ControlDatabaseCorruptionError('Backup Manager control.db is not a readable SQLite database.', { cause: error }); }
      this.database.run('PRAGMA foreign_keys = ON');
      try {
        this.#verifyIntegrity();
        const currentVersion = Number(oneValue(this.database, 'PRAGMA user_version') || 0);
        if (currentVersion > CONTROL_DATABASE_VERSION) throw new ControlDatabaseCompatibilityError(`Backup Manager control.db schema ${currentVersion} is newer than supported schema ${CONTROL_DATABASE_VERSION}.`);
        if (currentVersion < CONTROL_DATABASE_VERSION) {
          if (existingBytes) await this.#createMigrationBackup(currentVersion);
          await this.#migrate(currentVersion);
        } else this.#verifySchema();
        this.initialized = true;
        return this;
      } catch (error) {
        this.database.close();
        this.database = null;
        if (error instanceof ControlDatabaseError) throw error;
        if (/malformed|not a database|file is encrypted|disk image/i.test(error.message)) throw new ControlDatabaseCorruptionError('Backup Manager control.db failed its integrity checks.', { cause: error });
        throw error;
      }
    });
  }

  repository(type) {
    if (!this.repositories[type]) throw new TypeError(`Unknown Backup Manager entity type: ${type}`);
    return this.repositories[type];
  }

  read(operation) {
    return this.#enqueue(async () => {
      this.#assertInitialized();
      return this.#withFileLock(async () => {
        await this.#reload();
        return operation(new ControlTransaction(this.database, this.clock));
      });
    });
  }

  transaction(operation) {
    return this.#enqueue(async () => {
      this.#assertInitialized();
      const outcome = await this.#withFileLock(async () => {
        await this.#reload();
        const SqlJs = await SQL;
        const before = this.database.export();
        this.database.run('PRAGMA foreign_keys = ON');
        this.database.run('BEGIN IMMEDIATE');
        try {
          const transaction = new ControlTransaction(this.database, this.clock);
          const result = await operation(transaction);
          this.#assertForeignKeys();
          this.database.run('COMMIT');
          await this.#persist();
          return { result, changes: transaction.changes() };
        } catch (error) {
          try { this.database.run('ROLLBACK'); } catch {}
          try { this.database.close(); } catch {}
          this.database = new SqlJs.Database(before);
          this.database.run('PRAGMA foreign_keys = ON');
          throw error;
        }
      });
      if (outcome.changes.length && this.onChange) {
        Promise.resolve().then(() => this.onChange(outcome.changes)).catch(() => {});
      }
      return outcome.result;
    });
  }

  upsertSnapshot(type, workspaceId, snapshot) {
    return this.transaction((transaction) => transaction.upsertSnapshot(type, workspaceId, snapshot));
  }

  async close() {
    await this.operationQueue;
    if (this.database) this.database.close();
    this.database = null;
    this.initialized = false;
  }

  #enqueue(operation) {
    const pending = this.operationQueue.then(operation, operation);
    this.operationQueue = pending.catch(() => {});
    return pending;
  }

  async #migrate(currentVersion) {
    const before = this.database.export();
    this.database.run('BEGIN IMMEDIATE');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version <= currentVersion) continue;
        const idempotentSql = migration.sql
          .replace(/\bCREATE TABLE (?!IF NOT EXISTS)/g, 'CREATE TABLE IF NOT EXISTS ')
          .replace(/\bCREATE UNIQUE INDEX (?!IF NOT EXISTS)/g, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
          .replace(/\bCREATE INDEX (?!IF NOT EXISTS)/g, 'CREATE INDEX IF NOT EXISTS ');
        this.database.run(idempotentSql);
        this.database.run('INSERT OR REPLACE INTO schema_migrations(version, description, applied_at) VALUES (?,?,?)', [migration.version, migration.description, this.clock()]);
        this.database.run(`PRAGMA user_version = ${migration.version}`);
      }
      this.#verifySchema();
      this.database.run('COMMIT');
      await this.#persist();
    } catch (error) {
      try { this.database.run('ROLLBACK'); } catch {}
      const SqlJs = await SQL;
      try { this.database.close(); } catch {}
      this.database = new SqlJs.Database(before);
      this.database.run('PRAGMA foreign_keys = ON');
      throw error;
    }
  }

  #verifyIntegrity() {
    const result = oneValue(this.database, 'PRAGMA integrity_check');
    if (result !== 'ok') throw new ControlDatabaseCorruptionError(`Backup Manager control.db integrity check failed: ${result || 'unknown error'}.`);
  }

  #assertForeignKeys() {
    const violation = valuesFromRows(this.database, 'PRAGMA foreign_key_check')[0];
    if (violation) throw new ControlDatabaseCorruptionError(`Backup Manager control.db contains an invalid foreign key in ${violation.table}.`);
  }

  #verifySchema() {
    this.#assertForeignKeys();
    const indexes = new Set(valuesFromRows(this.database, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name));
    for (const indexName of REQUIRED_INDEXES) {
      if (!indexes.has(indexName)) throw new ControlDatabaseCorruptionError(`Backup Manager control.db is missing required index ${indexName}.`);
    }
    const sample = valuesFromRows(this.database, `
      SELECT data_json FROM connections UNION ALL SELECT data_json FROM database_profiles
      UNION ALL SELECT data_json FROM database_saved_queries UNION ALL SELECT data_json FROM database_query_history
      UNION ALL SELECT data_json FROM database_notebooks UNION ALL SELECT data_json FROM database_tasks
      UNION ALL SELECT data_json FROM sources
      UNION ALL SELECT data_json FROM repositories UNION ALL SELECT data_json FROM policies LIMIT 1
    `)[0];
    if (sample) parseJson(sample.data_json, 'configuration record');
  }

  async #createMigrationBackup(version) {
    const stamp = this.clock().replace(/[^0-9]/g, '').slice(0, 17);
    const backupName = `${DATABASE_FILE_NAME}.pre-migration-v${version}-${stamp}-${crypto.randomBytes(3).toString('hex')}.bak`;
    await fs.copyFile(this.databasePath, path.join(this.rootPath, backupName), fs.constants.COPYFILE_EXCL);
  }

  async #persist() {
    const temporaryPath = path.join(this.rootPath, `.${DATABASE_FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(Buffer.from(this.database.export()));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, this.databasePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #reload() {
    let bytes;
    try { bytes = await fs.readFile(this.databasePath); }
    catch (error) {
      if (error.code === 'ENOENT') throw new ControlDatabaseCorruptionError('Backup Manager control.db disappeared after initialization.');
      throw error;
    }
    const SqlJs = await SQL;
    let next;
    try { next = new SqlJs.Database(bytes); }
    catch (error) { throw new ControlDatabaseCorruptionError('Backup Manager control.db is not a readable SQLite database.', { cause: error }); }
    next.run('PRAGMA foreign_keys = ON');
    const previous = this.database;
    this.database = next;
    try {
      this.#verifyIntegrity();
      const version = Number(oneValue(this.database, 'PRAGMA user_version') || 0);
      if (version !== CONTROL_DATABASE_VERSION) throw new ControlDatabaseCompatibilityError(`Backup Manager control.db schema ${version} does not match supported schema ${CONTROL_DATABASE_VERSION}.`);
      this.#verifySchema();
    } catch (error) {
      this.database = previous;
      next.close();
      throw error;
    }
    if (previous) previous.close();
  }

  async #withFileLock(operation) {
    const token = crypto.randomUUID();
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })); }
        finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch {}
        if (!processIsRunning(owner?.pid)) {
          await fs.rm(this.lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) throw new ControlDatabaseError('Timed out waiting for the Backup Manager control database lock.', 'BACKUP_CONTROL_DB_LOCK_TIMEOUT');
        await delay(this.lockRetryMs);
      }
    }
    try { return await operation(); }
    finally {
      try {
        const owner = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
        if (owner.token === token) await fs.rm(this.lockPath, { force: true });
      } catch {}
    }
  }

  #assertInitialized() {
    if (!this.initialized || !this.database) throw new ControlDatabaseError('Backup Manager control database is not initialized.', 'BACKUP_CONTROL_DB_NOT_INITIALIZED');
  }
}

module.exports = {
  BackupControlDatabase,
  CONTROL_DATABASE_VERSION,
  DATABASE_LOCK_FILE_NAME,
  ControlDatabaseCompatibilityError,
  ControlDatabaseCorruptionError,
  ControlDatabaseError,
  ENTITY_TYPES: Object.freeze(Object.keys(ENTITY_SPECS)),
  generateUuidV7
};
