const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { buildCollectorCommand, executeCollectorCommand, parseCollectorOutput } = require('./server-monitoring/linux-collector');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, '2025-03-26']);
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

const MONITOR_PROPERTIES = {
  name: { type: 'string', description: 'Human-readable monitor name.' },
  projectId: { type: ['string', 'null'], description: 'Optional saved DeployerX server ID to link this monitor to.' },
  group: { type: 'string', description: 'Optional monitor group.' },
  tags: { type: 'array', items: { type: 'string' } },
  type: { type: 'string', enum: ['http', 'tcp', 'tls'] },
  state: { type: 'string', enum: ['enabled', 'paused', 'disabled'], default: 'enabled' },
  intervalSec: { type: 'integer', minimum: 30, maximum: 86400, default: 60 },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 10000 },
  config: {
    type: 'object',
    description: 'Type-specific configuration. HTTP uses url, method, headers, secretHeaders, body, followRedirects, verifyTls, expectedStatusRanges, and assertions. TCP uses host and port. TLS uses host, port, serverName, verifyTls, expiryWarningDays, and expiryCriticalDays.',
    additionalProperties: true
  },
  alertPolicy: {
    type: 'object',
    description: 'Optional thresholds: failureThreshold, recoveryThreshold, repeatEveryMinutes, latencyWarningMs, latencyCriticalMs, notifyOnWarning, and notifyOnRecovery.',
    additionalProperties: true
  },
  notificationRouteIds: { type: 'array', items: { type: 'string' } }
};

const LIST_LIMIT_PROPERTY = { type: 'integer', minimum: 1, maximum: 10000, default: 500 };

const TOOLS = [
  {
    name: 'deployerx_list_servers',
    title: 'List DeployerX servers',
    description: 'List saved SSH/SFTP server aliases and opaque IDs. Connection details and credentials are never returned.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_get_server_metrics',
    title: 'Get live server metrics',
    description: 'Collect a current Linux server health snapshot over SSH, including CPU, memory, load, network, storage, processes, OS, and system uptime.',
    inputSchema: {
      type: 'object',
      properties: { server_id: { type: 'string', description: 'Opaque ID from deployerx_list_servers.' } },
      required: ['server_id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_ssh_execute',
    title: 'Run an SSH command',
    description: 'Run a command through a DeployerX-managed SSH connection. Credentials remain inside DeployerX and command output is streamed live to the MCP client and DeployerX terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string', description: 'Opaque ID from deployerx_list_servers.' },
        command: { type: 'string', description: 'Shell command to execute.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, default: 120000 }
      },
      required: ['server_id', 'command'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_sftp_list',
    title: 'List a remote directory',
    description: 'List files and directories over SFTP without revealing server credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string' },
        path: { type: 'string', default: '.' }
      },
      required: ['server_id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_sftp_read',
    title: 'Read a remote file',
    description: 'Read a remote SFTP file as UTF-8 text or base64. Files are limited to 2 MiB per call.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string' },
        path: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' }
      },
      required: ['server_id', 'path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_sftp_write',
    title: 'Write a remote file',
    description: 'Create or replace a remote SFTP file. Content may be UTF-8 text or base64 and is limited to 2 MiB.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
        overwrite: { type: 'boolean', default: true },
        create_parents: { type: 'boolean', default: false }
      },
      required: ['server_id', 'path', 'content'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_sftp_mkdir',
    title: 'Create a remote directory',
    description: 'Create a directory over SFTP, optionally including missing parents.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string' },
        path: { type: 'string' },
        recursive: { type: 'boolean', default: true }
      },
      required: ['server_id', 'path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_sftp_move',
    title: 'Move a remote item',
    description: 'Rename or move a remote SFTP file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string' },
        source_path: { type: 'string' },
        destination_path: { type: 'string' }
      },
      required: ['server_id', 'source_path', 'destination_path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_sftp_delete',
    title: 'Delete a remote item',
    description: 'Delete a remote SFTP file or directory. Non-empty directories require recursive=true.',
    inputSchema: {
      type: 'object',
      properties: {
        server_id: { type: 'string' },
        path: { type: 'string' },
        recursive: { type: 'boolean', default: false }
      },
      required: ['server_id', 'path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_status',
    title: 'Get Uptime status',
    description: 'Get the Uptime worker health, current monitor states, and active incidents in one current snapshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_list_monitors',
    title: 'List uptime monitors',
    description: 'List uptime monitors and their latest runtime status.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['enabled', 'paused', 'disabled'] },
        projectId: { type: 'string' },
        includeDeleted: { type: 'boolean', default: false },
        limit: LIST_LIMIT_PROPERTY
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_get_monitor',
    title: 'Get an uptime monitor',
    description: 'Get one uptime monitor, including configuration, revision, and current runtime status.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, includeDeleted: { type: 'boolean', default: false } },
      required: ['id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_create_monitor',
    title: 'Create an uptime monitor',
    description: 'Create an HTTP, TCP, or TLS uptime monitor. Enabled monitors run an initial persisted health check immediately. Sensitive HTTP header values belong in config.secretHeaders.',
    inputSchema: {
      type: 'object',
      properties: MONITOR_PROPERTIES,
      required: ['name', 'type', 'config'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'deployerx_uptime_update_monitor',
    title: 'Update an uptime monitor',
    description: 'Update an existing uptime monitor. Supply the current revision returned by get or list to prevent overwriting concurrent changes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, ...MONITOR_PROPERTIES },
      required: ['id', 'revision'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'deployerx_uptime_delete_monitor',
    title: 'Delete an uptime monitor',
    description: 'Soft-delete an uptime monitor and remove its stored sensitive-header references.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 } },
      required: ['id', 'revision'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_test_monitor',
    title: 'Test an uptime monitor',
    description: 'Run a non-persisted test of a new monitor definition or an existing monitor with optional changes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, ...MONITOR_PROPERTIES },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'deployerx_uptime_run_monitor_now',
    title: 'Run an uptime monitor now',
    description: 'Queue an enabled uptime monitor for an immediate persisted check.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'deployerx_uptime_list_checks',
    title: 'List uptime checks',
    description: 'List persisted check results for one monitor.',
    inputSchema: {
      type: 'object',
      properties: {
        monitorId: { type: 'string' },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        outcome: { type: 'string', enum: ['up', 'warning', 'down', 'unknown', 'maintenance'] },
        limit: { type: 'integer', minimum: 1, maximum: 100000, default: 500 }
      },
      required: ['monitorId'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_list_incidents',
    title: 'List uptime incidents',
    description: 'List uptime incidents, optionally filtered by monitor, state, or time range.',
    inputSchema: {
      type: 'object',
      properties: {
        monitorId: { type: 'string' },
        state: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        limit: LIST_LIMIT_PROPERTY
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_acknowledge_incident',
    title: 'Acknowledge an uptime incident',
    description: 'Acknowledge an open incident using its current revision.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, note: { type: 'string', maxLength: 1000 } },
      required: ['id', 'revision'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_list_maintenance',
    title: 'List uptime maintenance windows',
    description: 'List maintenance windows, including active, future, or deleted entries.',
    inputSchema: {
      type: 'object',
      properties: { activeAt: { type: 'string', format: 'date-time' }, includeDeleted: { type: 'boolean', default: false }, limit: LIST_LIMIT_PROPERTY },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_create_maintenance',
    title: 'Create an uptime maintenance window',
    description: 'Create a maintenance window scoped to the workspace, group, project, or selected monitors.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, state: { type: 'string', enum: ['enabled', 'disabled'], default: 'enabled' },
        startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' },
        timezone: { type: 'string', default: 'UTC' }, reason: { type: 'string' },
        scope: { type: 'object', description: 'Scope object with type workspace, group, project, or monitors and the corresponding identifiers.', additionalProperties: true },
        recurrence: { type: ['object', 'null'], additionalProperties: true }
      },
      required: ['name', 'startsAt', 'endsAt', 'scope'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_update_maintenance',
    title: 'Update an uptime maintenance window',
    description: 'Update a maintenance window using its current revision.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, name: { type: 'string' },
        state: { type: 'string', enum: ['enabled', 'disabled'] }, startsAt: { type: 'string', format: 'date-time' },
        endsAt: { type: 'string', format: 'date-time' }, timezone: { type: 'string' }, reason: { type: 'string' },
        scope: { type: 'object', additionalProperties: true }, recurrence: { type: ['object', 'null'], additionalProperties: true }
      },
      required: ['id', 'revision'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_delete_maintenance',
    title: 'Delete an uptime maintenance window',
    description: 'Soft-delete a maintenance window using its current revision.',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 } },
      required: ['id', 'revision'], additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_worker_status',
    title: 'Get uptime worker status',
    description: 'Get scheduling worker heartbeat, concurrency, autostart, and error status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_get_settings',
    title: 'Get uptime settings',
    description: 'Get uptime worker autostart, concurrency, retention, and minimum interval settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_update_settings',
    title: 'Update uptime settings',
    description: 'Update uptime worker autostart and maximum check concurrency.',
    inputSchema: {
      type: 'object',
      properties: { autostartEnabled: { type: 'boolean' }, maximumConcurrency: { type: 'integer', minimum: 1, maximum: 32 } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'deployerx_uptime_get_report',
    title: 'Get an uptime report',
    description: 'Calculate an uptime, latency, checks, incidents, and maintenance report for a time range.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
        monitorId: { type: 'string' }, projectId: { type: 'string' }, group: { type: 'string' }, includeDeleted: { type: 'boolean', default: false }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function asNonEmptyString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function connectionConfig(project, useSftp = false) {
  const ssh = project.ssh || {};
  const ftp = project.ftp || {};
  if (!useSftp) {
    const config = {
      host: ssh.host,
      port: Number(ssh.port || 22),
      username: ssh.username,
      readyTimeout: clamp(ssh.timeout, 1000, 120000, 20000),
      keepaliveInterval: 10000,
      keepaliveCountMax: 3
    };
    if (ssh.authType === 'key') {
      config.privateKey = ssh.privateKey;
      if (ssh.passphrase) config.passphrase = ssh.passphrase;
    } else {
      config.password = ssh.password;
    }
    return config;
  }

  const hasFtpKey = String(ftp.privateKey || '').trim() !== '';
  const hasFtpPassword = String(ftp.password || '').trim() !== '';
  const hasSshKey = String(ssh.privateKey || '').trim() !== '';
  const hasSshPassword = String(ssh.password || '').trim() !== '';
  let authType = ssh.authType || 'password';
  if (ftp.authType === 'key') authType = hasFtpKey || hasSshKey ? 'key' : hasSshPassword ? 'password' : 'key';
  else if (ftp.authType === 'password') authType = hasFtpPassword || hasSshPassword ? 'password' : hasSshKey ? 'key' : 'password';
  else if (hasFtpKey) authType = 'key';
  else if (hasFtpPassword) authType = 'password';

  const config = {
    host: ftp.host || ssh.host,
    port: Number(ftp.port || ssh.port || 22),
    username: ftp.username || ssh.username,
    readyTimeout: clamp(ssh.timeout, 1000, 120000, 20000),
    keepaliveInterval: 10000,
    keepaliveCountMax: 3
  };

  if (authType === 'key') {
    config.privateKey = ftp.privateKey || ssh.privateKey;
    const passphrase = ftp.passphrase || ssh.passphrase;
    if (passphrase) config.passphrase = passphrase;
  } else {
    config.password = ftp.password || ssh.password;
  }
  return config;
}

function connect(project, useSftp = false) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const fail = (error) => {
      client.end();
      reject(error);
    };
    client.once('ready', () => {
      client.removeListener('error', fail);
      resolve(client);
    });
    client.once('error', fail);
    client.connect(connectionConfig(project, useSftp));
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

function isMissingSftpError(error) {
  return Number(error?.code) === 2 || /no such file/i.test(String(error?.message || ''));
}

async function pathExists(sftp, remotePath) {
  try {
    return await sftpCall(sftp, 'lstat', remotePath);
  } catch (error) {
    if (isMissingSftpError(error)) return null;
    throw error;
  }
}

async function ensureRemoteDirectory(sftp, remotePath) {
  const normalized = path.posix.normalize(String(remotePath || '.').replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '/') return;
  const parent = path.posix.dirname(normalized);
  if (parent !== normalized) await ensureRemoteDirectory(sftp, parent);
  if (await pathExists(sftp, normalized)) return;
  await sftpCall(sftp, 'mkdir', normalized);
}

async function deleteRemoteItem(sftp, remotePath, recursive) {
  const stats = await sftpCall(sftp, 'lstat', remotePath);
  if (!stats.isDirectory()) {
    await sftpCall(sftp, 'unlink', remotePath);
    return { type: 'file' };
  }
  const entries = await sftpCall(sftp, 'readdir', remotePath);
  if (entries.length && !recursive) throw new Error('Directory is not empty. Set recursive=true to delete it.');
  for (const entry of entries) {
    await deleteRemoteItem(sftp, path.posix.join(remotePath, entry.filename), true);
  }
  await sftpCall(sftp, 'rmdir', remotePath);
  return { type: 'directory' };
}

async function withSftp(project, operation) {
  const client = await connect(project, true);
  try {
    const sftp = await openSftp(client);
    try {
      return await operation(sftp);
    } finally {
      sftp.end();
    }
  } finally {
    client.end();
  }
}

function appendLimited(chunks, data, currentBytes) {
  const buffer = Buffer.from(data);
  const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - currentBytes);
  if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
  return currentBytes + buffer.length;
}

async function executeSshCommand(project, command, timeoutMs) {
  const client = await connect(project, false);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`SSH command timed out after ${timeoutMs} ms.`)), timeoutMs);

    client.exec(command, (error, stream) => {
      if (error) {
        finish(error);
        return;
      }
      stream.on('data', (data) => {
        stdoutBytes = appendLimited(stdout, data, stdoutBytes);
      });
      stream.stderr.on('data', (data) => {
        stderrBytes = appendLimited(stderr, data, stderrBytes);
      });
      stream.on('close', (exitCode, signal) => {
        finish(null, {
          exit_code: Number.isInteger(exitCode) ? exitCode : null,
          signal: signal || null,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          stdout_truncated: stdoutBytes > MAX_COMMAND_OUTPUT_BYTES,
          stderr_truncated: stderrBytes > MAX_COMMAND_OUTPUT_BYTES
        });
      });
      stream.on('error', (streamError) => finish(streamError));
    });
  });
}

async function collectServerMetrics(project) {
  const client = await connect(project, false);
  try {
    const firstOutput = await executeCollectorCommand(client, buildCollectorCommand(), { timeoutMs: 10000 });
    const first = parseCollectorOutput(firstOutput, { sampledAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const secondOutput = await executeCollectorCommand(
      client,
      buildCollectorCommand({ includeStatic: true, includeStorage: true, includeProcesses: true }),
      { timeoutMs: 10000 }
    );
    return parseCollectorOutput(secondOutput, {
      previousCounters: first.counters,
      previousSample: first.sample,
      sampledAt: Date.now()
    }).sample;
  } finally {
    client.end();
  }
}

function publicServer(project) {
  return {
    id: String(project.id),
    name: String(project.name || 'Unnamed server'),
    protocols: ['ssh', 'sftp']
  };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result
  };
}

class DeployerXMcpServer {
  constructor({ getProjects, uptimeOperations = {}, sshOperations = {} }) {
    this.getProjects = getProjects;
    this.uptimeOperations = uptimeOperations;
    this.sshOperations = sshOperations;
    this.server = null;
    this.port = 0;
    this.token = '';
    this.lastError = '';
  }

  status() {
    return {
      running: Boolean(this.server?.listening),
      port: this.port,
      url: this.port ? `http://127.0.0.1:${this.port}/mcp` : '',
      lastError: this.lastError
    };
  }

  tools() {
    return TOOLS.map(({ name, title, description }) => ({ name, title, description }));
  }

  async start({ port, token }) {
    await this.stop();
    this.port = clamp(port, 1024, 65535, 43821);
    this.token = asNonEmptyString(token, 'MCP token');
    this.lastError = '';
    this.server = http.createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        this.lastError = String(error?.message || error);
        if (!response.headersSent) this.sendJson(response, 500, { error: 'Internal MCP server error.' });
        else response.end();
      });
    });
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    this.server.on('error', (error) => {
      this.lastError = String(error?.message || error);
    });

    await new Promise((resolve, reject) => {
      const fail = (error) => {
        this.lastError = String(error?.message || error);
        reject(error);
      };
      this.server.once('error', fail);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', fail);
        resolve();
      });
    });
    return this.status();
  }

  async stop() {
    const current = this.server;
    this.server = null;
    if (!current?.listening) return;
    await new Promise((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections?.();
    });
  }

  tokenMatches(request) {
    const authorization = String(request.headers.authorization || '');
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const expected = this.token;
    if (!supplied || supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
  }

  startEventStream(response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
  }

  sendEvent(response, payload) {
    if (!response.destroyed && !response.writableEnded) {
      response.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  async readBody(request) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) throw new Error('MCP request exceeds the 4 MiB limit.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async handleHttp(request, response) {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/mcp') {
      this.sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (!this.tokenMatches(request)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="DeployerX MCP"');
      this.sendJson(response, 401, { error: 'A valid DeployerX MCP bearer token is required.' });
      return;
    }
    const origin = String(request.headers.origin || '');
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      this.sendJson(response, 403, { error: 'Browser origins are not allowed.' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      this.sendJson(response, 405, { error: 'Use POST for stateless Streamable HTTP MCP requests.' });
      return;
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      this.sendJson(response, 415, { error: 'MCP requests must use Content-Type: application/json.' });
      return;
    }

    let payload;
    try {
      payload = await this.readBody(request);
    } catch (error) {
      this.sendJson(response, 400, jsonRpcError(null, -32700, 'Parse error', String(error?.message || error)));
      return;
    }
    const acceptsEvents = String(request.headers.accept || '').toLowerCase().includes('text/event-stream');
    if (acceptsEvents) this.startEventStream(response);
    const responsePayload = await this.handleRpc(payload, {
      notify: acceptsEvents ? (notification) => this.sendEvent(response, notification) : null
    });
    if (responsePayload === null) {
      if (!acceptsEvents) response.writeHead(202, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (acceptsEvents) {
      this.sendEvent(response, responsePayload);
      response.end();
    } else {
      this.sendJson(response, 200, responsePayload);
    }
  }

  async projects() {
    const projects = await this.getProjects();
    return (Array.isArray(projects) ? projects : []).filter((project) => !['vnc', 'rdp'].includes(project?.serverType) && project?.ssh?.host);
  }

  async projectById(serverId) {
    const id = asNonEmptyString(serverId, 'server_id');
    const project = (await this.projects()).find((item) => String(item.id) === id);
    if (!project) throw new Error('No accessible DeployerX SSH server matches that server_id.');
    return project;
  }

  redactError(error, project) {
    let message = String(error?.message || error || 'Tool call failed.');
    const sshUsers = Array.isArray(project?.ssh?.users) ? project.ssh.users : [];
    const secrets = [
      project?.ssh?.host,
      project?.ssh?.username,
      project?.ssh?.password,
      project?.ssh?.privateKey,
      project?.ssh?.passphrase,
      project?.ftp?.host,
      project?.ftp?.username,
      project?.ftp?.password,
      project?.ftp?.privateKey,
      project?.ftp?.passphrase,
      project?.proxy?.username,
      project?.proxy?.password,
      ...sshUsers.flatMap((user) => [user?.username, user?.password, user?.privateKey, user?.passphrase])
    ];
    for (const secret of secrets) {
      if (secret) message = message.split(String(secret)).join('[redacted]');
    }
    return message;
  }

  async callTool(name, args = {}, context = {}) {
    if (name === 'deployerx_list_servers') {
      return { servers: (await this.projects()).map(publicServer) };
    }

    const uptimeOperationNames = {
      deployerx_uptime_status: 'getStatus',
      deployerx_uptime_list_monitors: 'listMonitors',
      deployerx_uptime_get_monitor: 'getMonitor',
      deployerx_uptime_create_monitor: 'createMonitor',
      deployerx_uptime_update_monitor: 'updateMonitor',
      deployerx_uptime_delete_monitor: 'deleteMonitor',
      deployerx_uptime_test_monitor: 'testMonitor',
      deployerx_uptime_run_monitor_now: 'runMonitorNow',
      deployerx_uptime_list_checks: 'listChecks',
      deployerx_uptime_list_incidents: 'listIncidents',
      deployerx_uptime_acknowledge_incident: 'acknowledgeIncident',
      deployerx_uptime_list_maintenance: 'listMaintenance',
      deployerx_uptime_create_maintenance: 'createMaintenance',
      deployerx_uptime_update_maintenance: 'updateMaintenance',
      deployerx_uptime_delete_maintenance: 'deleteMaintenance',
      deployerx_uptime_worker_status: 'getWorkerStatus',
      deployerx_uptime_get_settings: 'getSettings',
      deployerx_uptime_update_settings: 'updateSettings',
      deployerx_uptime_get_report: 'getReport'
    };
    const uptimeOperationName = uptimeOperationNames[name];
    if (uptimeOperationName) {
      const operation = this.uptimeOperations[uptimeOperationName];
      if (typeof operation !== 'function') throw new Error('Uptime monitoring is not available yet. Keep DeployerX open and try again.');
      const result = await operation(args);
      const collectionKeys = {
        deployerx_uptime_list_monitors: 'monitors',
        deployerx_uptime_get_monitor: 'monitor',
        deployerx_uptime_list_checks: 'checks',
        deployerx_uptime_list_incidents: 'incidents',
        deployerx_uptime_list_maintenance: 'maintenance'
      };
      return collectionKeys[name] ? { [collectionKeys[name]]: result } : result;
    }

    const project = await this.projectById(args.server_id);
    try {
      if (name === 'deployerx_get_server_metrics') {
        return { server_id: String(project.id), sample: await collectServerMetrics(project) };
      }
      if (name === 'deployerx_ssh_execute') {
        const command = asNonEmptyString(args.command, 'command');
        const timeoutMs = clamp(args.timeout_ms, 1000, 300000, 120000);
        const execute = typeof this.sshOperations.execute === 'function'
          ? this.sshOperations.execute
          : executeSshCommand;
        const onOutput = (stream, chunk) => {
          if (typeof context.notify !== 'function' || !chunk) return;
          context.notify({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: {
              level: stream === 'stderr' ? 'warning' : 'info',
              logger: 'deployerx.ssh',
              data: { server_id: String(project.id), stream, chunk: String(chunk) }
            }
          });
        };
        return {
          server_id: String(project.id),
          ...(await execute(project, command, timeoutMs, { onOutput }))
        };
      }
      if (name === 'deployerx_sftp_list') {
        const remotePath = String(args.path || '.').trim() || '.';
        return withSftp(project, async (sftp) => {
          const entries = await sftpCall(sftp, 'readdir', remotePath);
          return {
            server_id: String(project.id),
            path: remotePath,
            entries: entries.map((entry) => ({
              name: entry.filename,
              type: entry.attrs?.isDirectory?.() ? 'directory' : entry.attrs?.isSymbolicLink?.() ? 'symlink' : 'file',
              size: Number(entry.attrs?.size || 0),
              modified_at: entry.attrs?.mtime ? new Date(entry.attrs.mtime * 1000).toISOString() : null,
              mode: entry.attrs?.mode ? (entry.attrs.mode & 0o7777).toString(8).padStart(4, '0') : null
            }))
          };
        });
      }
      if (name === 'deployerx_sftp_read') {
        const remotePath = asNonEmptyString(args.path, 'path');
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
        return withSftp(project, async (sftp) => {
          const stats = await sftpCall(sftp, 'stat', remotePath);
          if (stats.isDirectory()) throw new Error('The requested SFTP path is a directory.');
          if (Number(stats.size) > MAX_FILE_BYTES) throw new Error('Remote file exceeds the 2 MiB MCP read limit.');
          const content = Buffer.from(await sftpCall(sftp, 'readFile', remotePath));
          if (content.length > MAX_FILE_BYTES) throw new Error('Remote file exceeds the 2 MiB MCP read limit.');
          return { server_id: String(project.id), path: remotePath, encoding, size: content.length, content: content.toString(encoding) };
        });
      }
      if (name === 'deployerx_sftp_write') {
        const remotePath = asNonEmptyString(args.path, 'path');
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
        const content = Buffer.from(String(args.content ?? ''), encoding);
        if (content.length > MAX_FILE_BYTES) throw new Error('Content exceeds the 2 MiB MCP write limit.');
        return withSftp(project, async (sftp) => {
          if (args.overwrite === false && (await pathExists(sftp, remotePath))) throw new Error('Remote path already exists and overwrite is false.');
          if (args.create_parents) await ensureRemoteDirectory(sftp, path.posix.dirname(remotePath));
          await sftpCall(sftp, 'writeFile', remotePath, content);
          return { server_id: String(project.id), path: remotePath, bytes_written: content.length };
        });
      }
      if (name === 'deployerx_sftp_mkdir') {
        const remotePath = asNonEmptyString(args.path, 'path');
        return withSftp(project, async (sftp) => {
          if (args.recursive === false) await sftpCall(sftp, 'mkdir', remotePath);
          else await ensureRemoteDirectory(sftp, remotePath);
          return { server_id: String(project.id), path: remotePath, created: true };
        });
      }
      if (name === 'deployerx_sftp_move') {
        const sourcePath = asNonEmptyString(args.source_path, 'source_path');
        const destinationPath = asNonEmptyString(args.destination_path, 'destination_path');
        return withSftp(project, async (sftp) => {
          await sftpCall(sftp, 'rename', sourcePath, destinationPath);
          return { server_id: String(project.id), source_path: sourcePath, destination_path: destinationPath };
        });
      }
      if (name === 'deployerx_sftp_delete') {
        const remotePath = asNonEmptyString(args.path, 'path');
        if (remotePath === '/' || remotePath === '.') throw new Error('Refusing to delete the remote root or current directory.');
        return withSftp(project, async (sftp) => ({
          server_id: String(project.id),
          path: remotePath,
          ...(await deleteRemoteItem(sftp, remotePath, args.recursive === true)),
          deleted: true
        }));
      }
      throw new Error(`Unknown MCP tool: ${name}`);
    } catch (error) {
      throw new Error(this.redactError(error, project));
    }
  }

  async handleRpc(payload, context = {}) {
    if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
      return jsonRpcError(payload?.id, -32600, 'Invalid Request');
    }
    const isNotification = payload.id === undefined;
    if (payload.method === 'notifications/initialized' || payload.method.startsWith('notifications/')) return null;
    if (isNotification) return null;

    try {
      if (payload.method === 'initialize') {
        const requestedVersion = String(payload.params?.protocolVersion || '');
        return {
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false }, logging: {} },
            serverInfo: { name: 'DeployerX', title: 'DeployerX servers and uptime monitoring', version: '1.1.0' },
            instructions: 'Use server IDs from deployerx_list_servers for SSH, SFTP, and live metrics. Uptime tools manage monitors, checks, incidents, maintenance, worker settings, and reports without exposing stored credentials.'
          }
        };
      }
      if (payload.method === 'ping') return { jsonrpc: '2.0', id: payload.id, result: {} };
      if (payload.method === 'tools/list') return { jsonrpc: '2.0', id: payload.id, result: { tools: TOOLS } };
      if (payload.method === 'tools/call') {
        const toolName = asNonEmptyString(payload.params?.name, 'Tool name');
        try {
          const result = await this.callTool(toolName, payload.params?.arguments || {}, context);
          return { jsonrpc: '2.0', id: payload.id, result: toolResult(result) };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              content: [{ type: 'text', text: String(error?.message || error) }],
              isError: true
            }
          };
        }
      }
      return jsonRpcError(payload.id, -32601, 'Method not found');
    } catch (error) {
      return jsonRpcError(payload.id, -32603, 'Internal error', String(error?.message || error));
    }
  }
}

module.exports = { DeployerXMcpServer, MCP_PROTOCOL_VERSION };
