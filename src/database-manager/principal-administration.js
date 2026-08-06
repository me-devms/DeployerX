const crypto = require('node:crypto');
const { DEFINITION_CLASSIFICATION } = require('./definition-executor');
const { enforceSqlPolicy } = require('./sql-safety');

const BUILT_IN_PRINCIPAL_ACTIONS = Object.freeze({
  postgresql: Object.freeze(['create-principal', 'alter-principal', 'rename-principal', 'drop-principal', 'grant', 'revoke', 'grant-role', 'revoke-role']),
  mysql: Object.freeze(['create-principal', 'alter-principal', 'rename-principal', 'drop-principal', 'lock-principal', 'unlock-principal', 'grant', 'revoke'])
});

const POSTGRESQL_PRIVILEGES = Object.freeze({
  database: Object.freeze(['CONNECT', 'CREATE', 'TEMPORARY']),
  schema: Object.freeze(['USAGE', 'CREATE']),
  table: Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  'all-tables': Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  sequence: Object.freeze(['USAGE', 'SELECT', 'UPDATE']),
  'all-sequences': Object.freeze(['USAGE', 'SELECT', 'UPDATE'])
});

const MYSQL_PRIVILEGES = Object.freeze({
  global: Object.freeze(['ALL PRIVILEGES', 'ALTER', 'CREATE', 'CREATE USER', 'DELETE', 'DROP', 'EXECUTE', 'INDEX', 'INSERT', 'REFERENCES', 'SELECT', 'SHOW DATABASES', 'TRIGGER', 'UPDATE']),
  database: Object.freeze(['ALL PRIVILEGES', 'ALTER', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX', 'INSERT', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE']),
  table: Object.freeze(['ALL PRIVILEGES', 'ALTER', 'CREATE VIEW', 'DELETE', 'DROP', 'INDEX', 'INSERT', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'])
});

const BOOLEAN_ROLE_OPTIONS = Object.freeze(['login', 'superuser', 'createDatabase', 'createRole', 'inherit', 'replication', 'bypassRls']);
const PRINCIPAL_LIST_QUERIES = Object.freeze({
  postgresql: 'SELECT rolname AS principal, rolcanlogin AS can_login, rolsuper AS is_superuser, rolcreatedb AS can_create_database, rolcreaterole AS can_create_role, rolinherit AS inherits_privileges, rolreplication AS can_replicate, rolbypassrls AS bypasses_row_security, rolvaliduntil::text AS valid_until FROM pg_catalog.pg_roles ORDER BY rolname LIMIT 500',
  mysql: 'SELECT User AS principal, Host AS account_host FROM mysql.user ORDER BY User, Host LIMIT 500'
});

function administrationError(message, code) {
  return Object.assign(new Error(message), { code, category: 'database-manager', retryable: false });
}

function requiredText(value, label, maximumLength = 200) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maximumLength || text.includes('\0')) throw administrationError(`${label} is invalid.`, 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
  return text;
}

function optionalText(value, label, maximumLength = 200) {
  if (value === null || value === undefined || value === '') return null;
  return requiredText(value, label, maximumLength);
}

function quoteIdentifier(driverId, value) {
  const text = requiredText(value, 'Database identifier', 512);
  return driverId === 'mysql' ? `\`${text.replaceAll('`', '``')}\`` : `"${text.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  const text = String(value ?? '');
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw administrationError('Database principal password is invalid.', 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_INVALID');
  }
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function quotePostgresqlLiteral(value) {
  const text = String(value ?? '');
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw administrationError('Database principal password is invalid.', 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_INVALID');
  }
  let tag = `deployerx_${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  while (text.includes(`$${tag}$`)) tag += '_x';
  return `$${tag}$${text}$${tag}$`;
}

function normalizeBooleanOptions(input = {}) {
  const options = {};
  for (const key of BOOLEAN_ROLE_OPTIONS) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw administrationError('Database role option is invalid.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
      options[key] = input[key];
    }
  }
  return Object.freeze(options);
}

function normalizePrivileges(input, allowed) {
  if (!Array.isArray(input) || !input.length || input.length > allowed.length) {
    throw administrationError('Select at least one supported database privilege.', 'DATABASE_MANAGER_PRIVILEGE_INVALID');
  }
  const allowedSet = new Set(allowed);
  const values = [...new Set(input.map((value) => String(value || '').trim().toUpperCase()))];
  if (values.some((value) => !allowedSet.has(value))) throw administrationError('A selected database privilege is not supported for this scope.', 'DATABASE_MANAGER_PRIVILEGE_INVALID');
  return Object.freeze(values);
}

function normalizeScope(driverId, input = {}) {
  const type = requiredText(input.type, 'Database privilege scope', 40).toLowerCase();
  const allowed = driverId === 'postgresql' ? POSTGRESQL_PRIVILEGES[type] : MYSQL_PRIVILEGES[type];
  if (!allowed) throw administrationError('Database privilege scope is not supported.', 'DATABASE_MANAGER_PRIVILEGE_SCOPE_INVALID');
  if (driverId === 'postgresql') {
    if (type === 'database') return Object.freeze({ type, database: requiredText(input.database, 'Database name', 512), allowed });
    if (type === 'schema' || type === 'all-tables' || type === 'all-sequences') return Object.freeze({ type, schema: requiredText(input.schema, 'Schema name', 512), allowed });
    return Object.freeze({ type, schema: requiredText(input.schema, 'Schema name', 512), objectName: requiredText(input.objectName, 'Database object name', 512), allowed });
  }
  if (type === 'global') return Object.freeze({ type, allowed });
  if (type === 'database') return Object.freeze({ type, database: requiredText(input.database, 'Database name', 512), allowed });
  return Object.freeze({ type, database: requiredText(input.database, 'Database name', 512), objectName: requiredText(input.objectName, 'Table name', 512), allowed });
}

function normalizePrincipalActionInput(input = {}, profile = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw administrationError('Database principal action is invalid.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
  if (Object.hasOwn(input, 'password') || Object.hasOwn(input, 'credentials')) {
    throw administrationError('Use a saved SecretRef for database principal credentials.', 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_INLINE_FORBIDDEN');
  }
  const driverId = String(profile.driverId || '').trim().toLowerCase();
  const action = requiredText(input.action, 'Database principal action', 60).toLowerCase();
  if (!(BUILT_IN_PRINCIPAL_ACTIONS[driverId] || []).includes(action)) throw administrationError('Database principal action is not supported by this driver.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_UNSUPPORTED');
  const principal = requiredText(input.principal, driverId === 'postgresql' ? 'Role name' : 'User name', 512);
  const normalized = { action, principal };
  if (driverId === 'mysql') normalized.host = optionalText(input.host, 'Database user host', 255) || '%';
  if (action === 'rename-principal') normalized.newName = requiredText(input.newName, 'New principal name', 512);
  if (['create-principal', 'alter-principal'].includes(action)) {
    normalized.options = normalizeBooleanOptions(input.options);
    normalized.passwordSecretRefId = optionalText(input.passwordSecretRefId, 'Password SecretRef ID', 200);
    normalized.clearPassword = input.clearPassword === true;
    if (normalized.passwordSecretRefId && normalized.clearPassword) throw administrationError('Choose a saved password or clear the password, not both.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
    if (driverId === 'mysql' && action === 'alter-principal' && !normalized.passwordSecretRefId) {
      throw administrationError('Choose a saved password for this MySQL user change.', 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_REQUIRED');
    }
    if (driverId === 'mysql' && normalized.clearPassword) throw administrationError('Clearing a MySQL password is not supported.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_UNSUPPORTED');
    if (driverId === 'postgresql') {
      normalized.validUntil = optionalText(input.validUntil, 'Role expiry', 100);
      if (normalized.validUntil && !Number.isFinite(Date.parse(normalized.validUntil))) throw administrationError('Role expiry is invalid.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
      if (normalized.validUntil) normalized.validUntil = new Date(normalized.validUntil).toISOString();
      if (action === 'alter-principal' && !Object.keys(normalized.options).length && !normalized.passwordSecretRefId && !normalized.clearPassword && !normalized.validUntil) {
        throw administrationError('Choose at least one role change.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
      }
    }
  }
  if (['grant', 'revoke'].includes(action)) {
    normalized.scope = normalizeScope(driverId, input.scope);
    normalized.privileges = normalizePrivileges(input.privileges, normalized.scope.allowed);
    normalized.grantOption = input.grantOption === true;
  }
  if (['grant-role', 'revoke-role'].includes(action)) {
    normalized.role = requiredText(input.role, 'Granted role name', 512);
    normalized.adminOption = input.adminOption === true;
  }
  normalized.ifExists = input.ifExists === true;
  return Object.freeze(normalized);
}

function postgresqlRoleOptions(action) {
  const keywords = {
    login: ['LOGIN', 'NOLOGIN'], superuser: ['SUPERUSER', 'NOSUPERUSER'], createDatabase: ['CREATEDB', 'NOCREATEDB'],
    createRole: ['CREATEROLE', 'NOCREATEROLE'], inherit: ['INHERIT', 'NOINHERIT'], replication: ['REPLICATION', 'NOREPLICATION'], bypassRls: ['BYPASSRLS', 'NOBYPASSRLS']
  };
  return Object.entries(action.options || {}).map(([key, enabled]) => keywords[key][enabled ? 0 : 1]);
}

function principalTarget(driverId, action) {
  if (driverId === 'postgresql') return quoteIdentifier(driverId, action.principal);
  return `${quoteLiteral(action.principal)}@${quoteLiteral(action.host)}`;
}

function privilegeScopeSql(driverId, scope) {
  if (driverId === 'mysql') {
    if (scope.type === 'global') return '*.*';
    if (scope.type === 'database') return `${quoteIdentifier(driverId, scope.database)}.*`;
    return `${quoteIdentifier(driverId, scope.database)}.${quoteIdentifier(driverId, scope.objectName)}`;
  }
  if (scope.type === 'database') return `DATABASE ${quoteIdentifier(driverId, scope.database)}`;
  if (scope.type === 'schema') return `SCHEMA ${quoteIdentifier(driverId, scope.schema)}`;
  if (scope.type === 'all-tables') return `ALL TABLES IN SCHEMA ${quoteIdentifier(driverId, scope.schema)}`;
  if (scope.type === 'all-sequences') return `ALL SEQUENCES IN SCHEMA ${quoteIdentifier(driverId, scope.schema)}`;
  return `${scope.type === 'sequence' ? 'SEQUENCE' : 'TABLE'} ${quoteIdentifier(driverId, scope.schema)}.${quoteIdentifier(driverId, scope.objectName)}`;
}

function buildPrincipalAdministrationSql(driverIdValue, input = {}, password = null) {
  const driverId = String(driverIdValue || '').trim().toLowerCase();
  const action = normalizePrincipalActionInput(input, { driverId });
  const target = principalTarget(driverId, action);
  if (driverId === 'postgresql') {
    if (action.action === 'create-principal' || action.action === 'alter-principal') {
      const options = postgresqlRoleOptions(action);
      if (action.passwordSecretRefId) options.push(`PASSWORD ${quotePostgresqlLiteral(password)}`);
      else if (action.clearPassword) options.push('PASSWORD NULL');
      if (action.validUntil) options.push(`VALID UNTIL ${quoteLiteral(action.validUntil)}`);
      return `${action.action === 'create-principal' ? 'CREATE' : 'ALTER'} ROLE ${target}${options.length ? ` ${options.join(' ')}` : ''}`;
    }
    if (action.action === 'rename-principal') return `ALTER ROLE ${target} RENAME TO ${quoteIdentifier(driverId, action.newName)}`;
    if (action.action === 'drop-principal') return `DROP ROLE ${action.ifExists ? 'IF EXISTS ' : ''}${target}`;
    if (action.action === 'grant-role') return `GRANT ${quoteIdentifier(driverId, action.role)} TO ${target}${action.adminOption ? ' WITH ADMIN OPTION' : ''}`;
    if (action.action === 'revoke-role') return `REVOKE ${action.adminOption ? 'ADMIN OPTION FOR ' : ''}${quoteIdentifier(driverId, action.role)} FROM ${target}`;
  } else {
    if (action.action === 'create-principal' || action.action === 'alter-principal') {
      const passwordSql = action.passwordSecretRefId ? ` IDENTIFIED BY ${quoteLiteral(password)}` : '';
      return `${action.action === 'create-principal' ? 'CREATE' : 'ALTER'} USER ${target}${passwordSql}`;
    }
    if (action.action === 'rename-principal') return `RENAME USER ${target} TO ${quoteLiteral(action.newName)}@${quoteLiteral(action.host)}`;
    if (action.action === 'drop-principal') return `DROP USER ${action.ifExists ? 'IF EXISTS ' : ''}${target}`;
    if (action.action === 'lock-principal' || action.action === 'unlock-principal') return `ALTER USER ${target} ACCOUNT ${action.action === 'lock-principal' ? 'LOCK' : 'UNLOCK'}`;
  }
  if (action.action === 'grant') return `GRANT ${action.privileges.join(', ')} ON ${privilegeScopeSql(driverId, action.scope)} TO ${target}${action.grantOption ? ' WITH GRANT OPTION' : ''}`;
  if (action.action === 'revoke') return `REVOKE ${driverId === 'postgresql' && action.grantOption ? 'GRANT OPTION FOR ' : ''}${action.privileges.join(', ')} ON ${privilegeScopeSql(driverId, action.scope)} FROM ${target}`;
  throw administrationError('Database principal action is invalid.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
}

function principalAdministrationCapabilities(profile = {}) {
  const driverId = String(profile.driverId || '').trim().toLowerCase();
  const readOnly = profile.accessMode === 'read-only';
  const privileges = driverId === 'postgresql' ? POSTGRESQL_PRIVILEGES : driverId === 'mysql' ? MYSQL_PRIVILEGES : {};
  return Object.freeze({
    driverId,
    available: !readOnly && Boolean(BUILT_IN_PRINCIPAL_ACTIONS[driverId]),
    inventoryAvailable: !readOnly && Boolean(PRINCIPAL_LIST_QUERIES[driverId]),
    readOnly,
    actions: Object.freeze(readOnly ? [] : [...(BUILT_IN_PRINCIPAL_ACTIONS[driverId] || [])]),
    privileges: Object.freeze(Object.fromEntries(Object.entries(privileges).map(([scope, values]) => [scope, [...values]])))
  });
}

function resultColumnIndex(result, name) {
  return (result.columns || []).findIndex((column) => String(column.name || '').toLowerCase() === name);
}

function booleanValue(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'yes' || String(value || '').toLowerCase() === 'y';
}

function normalizePrincipalInventory(driverId, execution) {
  const result = execution?.result || {};
  const index = (name) => resultColumnIndex(result, name);
  const value = (row, name) => {
    const columnIndex = index(name);
    return columnIndex < 0 ? null : row[columnIndex];
  };
  const principals = (result.rows || []).slice(0, 500).map((row) => {
    const common = { name: requiredText(value(row, 'principal'), 'Database principal name', 512) };
    if (driverId === 'mysql') return Object.freeze({
      ...common,
      host: String(value(row, 'account_host') ?? '%').slice(0, 255),
      locked: booleanValue(value(row, 'is_locked')),
      credentialExpired: booleanValue(value(row, 'credential_expired'))
    });
    return Object.freeze({
      ...common,
      login: booleanValue(value(row, 'can_login')),
      superuser: booleanValue(value(row, 'is_superuser')),
      createDatabase: booleanValue(value(row, 'can_create_database')),
      createRole: booleanValue(value(row, 'can_create_role')),
      inherit: booleanValue(value(row, 'inherits_privileges')),
      replication: booleanValue(value(row, 'can_replicate')),
      bypassRls: booleanValue(value(row, 'bypasses_row_security')),
      validUntil: value(row, 'valid_until') === null ? null : String(value(row, 'valid_until')).slice(0, 100)
    });
  });
  return Object.freeze({ driverId, principals: Object.freeze(principals), truncated: (result.rows || []).length >= 500 });
}

function buildPrincipalGrantInventoryQuery(driverIdValue, input = {}) {
  const driverId = String(driverIdValue || '').trim().toLowerCase();
  const principal = requiredText(input.principal, 'Database principal name', 512);
  if (driverId === 'postgresql') {
    const target = quotePostgresqlLiteral(principal);
    return `SELECT privilege_type, scope_type, object_scope, is_grantable FROM (`
      + `SELECT privilege_type, 'table' AS scope_type, table_schema || '.' || table_name AS object_scope, is_grantable FROM information_schema.role_table_grants WHERE grantee = ${target} `
      + `UNION ALL SELECT privilege_type, CASE object_type WHEN 'SEQUENCE' THEN 'sequence' WHEN 'DOMAIN' THEN 'domain' ELSE 'usage-object' END AS scope_type, object_schema || '.' || object_name AS object_scope, is_grantable FROM information_schema.role_usage_grants WHERE grantee = ${target} `
      + `UNION ALL SELECT privilege_type, 'routine' AS scope_type, routine_schema || '.' || routine_name AS object_scope, is_grantable FROM information_schema.role_routine_grants WHERE grantee = ${target} `
      + `UNION ALL SELECT 'MEMBER' AS privilege_type, 'role' AS scope_type, granted_role.rolname AS object_scope, CASE membership.admin_option WHEN true THEN 'YES' ELSE 'NO' END AS is_grantable FROM pg_catalog.pg_auth_members membership JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member WHERE member_role.rolname = ${target}`
      + `) AS principal_grants ORDER BY scope_type, object_scope, privilege_type LIMIT 1000`;
  }
  if (driverId === 'mysql') {
    const host = optionalText(input.host, 'Database user host', 255) || '%';
    const grantee = `CONCAT(QUOTE(${quoteLiteral(principal)}), '@', QUOTE(${quoteLiteral(host)}))`;
    return `SELECT privilege_type, scope_type, object_scope, is_grantable FROM (`
      + `SELECT PRIVILEGE_TYPE AS privilege_type, 'global' AS scope_type, '*.*' AS object_scope, IS_GRANTABLE AS is_grantable FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${grantee} `
      + `UNION ALL SELECT PRIVILEGE_TYPE, 'database', CONCAT(TABLE_SCHEMA, '.*'), IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${grantee} `
      + `UNION ALL SELECT PRIVILEGE_TYPE, 'table', CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ${grantee}`
      + `) AS principal_grants ORDER BY scope_type, object_scope, privilege_type LIMIT 1000`;
  }
  throw administrationError('Database privilege inventory is not supported by this driver.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_UNSUPPORTED');
}

function normalizePrincipalGrantInventory(driverId, execution, input = {}) {
  const result = execution?.result || {};
  const indexes = {
    privilege: resultColumnIndex(result, 'privilege_type'),
    scope: resultColumnIndex(result, 'scope_type'),
    object: resultColumnIndex(result, 'object_scope'),
    grantable: resultColumnIndex(result, 'is_grantable')
  };
  if (Object.values(indexes).some((index) => index < 0)) throw administrationError('Database privilege inventory response is invalid.', 'DATABASE_MANAGER_PRIVILEGE_INVENTORY_INVALID');
  const grants = (result.rows || []).slice(0, 1000).map((row) => {
    const privilege = requiredText(row[indexes.privilege], 'Database privilege', 120).toUpperCase();
    const scope = requiredText(row[indexes.scope], 'Database privilege scope', 40).toLowerCase();
    const object = requiredText(row[indexes.object], 'Database privilege object', 1024);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(scope)) throw administrationError('Database privilege inventory scope is invalid.', 'DATABASE_MANAGER_PRIVILEGE_INVENTORY_INVALID');
    return Object.freeze({ privilege, scope, object, grantable: booleanValue(row[indexes.grantable]) });
  });
  return Object.freeze({
    driverId,
    principal: requiredText(input.principal, 'Database principal name', 512),
    host: driverId === 'mysql' ? (optionalText(input.host, 'Database user host', 255) || '%') : null,
    grants: Object.freeze(grants),
    truncated: (result.rows || []).length >= 1000
  });
}

function publicAction(action) {
  const { passwordSecretRefId, scope, ...safe } = action;
  const { allowed: _allowed, ...safeScope } = scope || {};
  return Object.freeze({ ...safe, usesPasswordSecret: Boolean(passwordSecretRefId), ...(scope ? { scope: Object.freeze(safeScope) } : {}) });
}

class DatabasePrincipalAdministrationService {
  constructor({ profileService, queryService, taskService, definitionExecutor } = {}) {
    if (!profileService?.get) throw new TypeError('Database principal administration requires the profile service.');
    if (!queryService?.executeReadPage) throw new TypeError('Database principal administration requires the query service.');
    if (!taskService?.create || !taskService?.start || !taskService?.complete) throw new TypeError('Database principal administration requires the task service.');
    if (!definitionExecutor?.execute || !definitionExecutor?.executePrepared || !definitionExecutor?.cancel) throw new TypeError('Database principal administration requires the opaque definition executor.');
    this.profileService = profileService;
    this.queryService = queryService;
    this.taskService = taskService;
    this.definitionExecutor = definitionExecutor;
  }

  async capabilities(workspaceId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const profile = await this.profileService.get(tenant, requiredText(profileId, 'Database profile ID'));
    if (!profile) throw administrationError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    return principalAdministrationCapabilities(profile);
  }

  async list(workspaceId, actorId, profileId) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const id = requiredText(profileId, 'Database profile ID');
    const profile = await this.profileService.get(tenant, id);
    if (!profile) throw administrationError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (profile.accessMode === 'read-only') throw administrationError('This profile is read only and cannot administer users or privileges.', 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
    const query = PRINCIPAL_LIST_QUERIES[profile.driverId];
    if (!query) throw administrationError('Database principal inventory is not supported by this driver.', 'DATABASE_MANAGER_PRINCIPAL_ACTION_UNSUPPORTED');
    const execution = await this.queryService.executeReadPage(tenant, actor, {
      requestId: `dbp_list_${crypto.randomUUID()}`,
      profileId: id,
      query,
      page: 1,
      pageSize: 500,
      batch: false,
      source: 'schema'
    });
    return normalizePrincipalInventory(profile.driverId, execution);
  }

  async inspect(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const profileId = requiredText(input.profileId, 'Database profile ID');
    const profile = await this.profileService.get(tenant, profileId);
    if (!profile) throw administrationError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (profile.accessMode === 'read-only') throw administrationError('This profile is read only and cannot administer users or privileges.', 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
    const target = {
      principal: requiredText(input.principal, 'Database principal name', 512),
      ...(profile.driverId === 'mysql' ? { host: optionalText(input.host, 'Database user host', 255) || '%' } : {})
    };
    const query = buildPrincipalGrantInventoryQuery(profile.driverId, target);
    const execution = await this.queryService.executeReadPage(tenant, actor, {
      requestId: `dbp_grants_${crypto.randomUUID()}`,
      profileId,
      query,
      page: 1,
      pageSize: 1000,
      batch: false,
      source: 'schema'
    });
    return normalizePrincipalGrantInventory(profile.driverId, execution, target);
  }

  async execute(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID');
    const actor = requiredText(actorId || 'system', 'Actor ID');
    const profileId = requiredText(input.profileId, 'Database profile ID');
    const profile = await this.profileService.get(tenant, profileId);
    if (!profile) throw administrationError('Database profile was not found.', 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
    if (profile.accessMode === 'read-only') throw administrationError('This profile is read only and cannot administer users or privileges.', 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
    const action = normalizePrincipalActionInput(input, profile);
    const requestId = requiredText(input.requestId || `dbp_${crypto.randomUUID()}`, 'Database principal action request ID');
    const previewQuery = buildPrincipalAdministrationSql(profile.driverId, action, action.passwordSecretRefId ? '[saved password]' : null);
    enforceSqlPolicy({ profile, classification: DEFINITION_CLASSIFICATION, approval: input.approval, batch: false });
    const executorInput = { requestId, profileId, query: previewQuery, approval: input.approval };
    const task = await this.taskService.create(tenant, actor, { profileId, type: 'administration', label: `${action.action}: ${action.principal}`, canCancel: true });
    let current = await this.taskService.start(tenant, actor, task.id, task.revision);
    const unregister = this.taskService.registerCancellation(tenant, task.id, () => this.definitionExecutor.cancel(tenant, actor, requestId));
    try {
      const execution = action.passwordSecretRefId
        ? await this.definitionExecutor.executePrepared(tenant, actor, executorInput, {
          secretRefId: action.passwordSecretRefId,
          secretType: 'password',
          buildQuery: (password) => buildPrincipalAdministrationSql(profile.driverId, action, password)
        })
        : await this.definitionExecutor.execute(tenant, actor, executorInput);
      current = await this.taskService.complete(tenant, actor, task.id, { expectedRevision: current.revision });
      return Object.freeze({ action: publicAction(action), task: current, execution });
    } catch (error) {
      const latest = await this.taskService.get(tenant, task.id);
      if (latest && ['queued', 'running', 'interrupted'].includes(latest.state)) {
        await this.taskService.complete(tenant, actor, task.id, { state: 'failed', safeMessage: 'Database user or privilege operation failed.', expectedRevision: latest.revision });
      }
      throw error;
    } finally {
      unregister();
    }
  }
}

module.exports = {
  BUILT_IN_PRINCIPAL_ACTIONS,
  MYSQL_PRIVILEGES,
  POSTGRESQL_PRIVILEGES,
  PRINCIPAL_LIST_QUERIES,
  DatabasePrincipalAdministrationService,
  buildPrincipalGrantInventoryQuery,
  buildPrincipalAdministrationSql,
  normalizePrincipalActionInput,
  normalizePrincipalGrantInventory,
  normalizePrincipalInventory,
  principalAdministrationCapabilities
};
