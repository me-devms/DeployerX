const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const CLIENT_DEFINITIONS = [
  { id: 'codex', name: 'Codex', format: 'toml', commands: ['codex'], relativePath: ['.codex', 'config.toml'], description: 'OpenAI Codex app and CLI.' },
  { id: 'claude', name: 'Claude Desktop', format: 'json-mcpServers', relativePath: ['AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'], description: 'Anthropic Claude Desktop.' },
  { id: 'claude-code', name: 'Claude Code', format: 'json-mcpServers', commands: ['claude'], relativePath: ['.claude.json'], description: 'Anthropic Claude Code CLI.' },
  { id: 'opencode', name: 'OpenCode', format: 'json-mcp', commands: ['opencode'], relativePath: ['.config', 'opencode', 'opencode.json'], description: 'OpenCode local agent.' },
  { id: 'cursor', name: 'Cursor', format: 'json-mcpServers', commands: ['cursor'], relativePath: ['AppData', 'Roaming', 'Cursor', 'User', 'mcp.json'], description: 'Cursor code editor.' },
  { id: 'windsurf', name: 'Windsurf', format: 'json-mcpServers', commands: ['windsurf'], relativePath: ['.codeium', 'windsurf', 'mcp_config.json'], description: 'Windsurf code editor.' },
  { id: 'cline', name: 'Cline', format: 'json-mcpServers', extensionPrefixes: ['saoudrizwan.claude-dev-'], relativePath: ['AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'], description: 'Cline coding agent extension.' },
  { id: 'vscode', name: 'VS Code', format: 'json-servers', commands: ['code'], relativePath: ['AppData', 'Roaming', 'Code', 'User', 'mcp.json'], description: 'Visual Studio Code.' }
];

function homePath(parts) {
  const home = os.homedir();
  if (process.platform === 'win32' && parts[0] === 'AppData') return path.join(home, ...parts);
  if (parts[0] === 'AppData') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), ...parts.slice(2));
  return path.join(home, ...parts);
}

function definitionPath(definition) {
  if (definition.id === 'codex') return path.join(os.homedir(), '.codex', 'config.toml');
  if (definition.id === 'claude') return process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (definition.id === 'cursor') return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json')
    : process.platform === 'linux' ? path.join(os.homedir(), '.config', 'Cursor', 'User', 'mcp.json') : homePath(definition.relativePath);
  if (definition.id === 'vscode') return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    : process.platform === 'linux' ? path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json') : homePath(definition.relativePath);
  return homePath(definition.relativePath);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function knownInstallPaths(definition) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform !== 'win32') return [];
  const paths = {
    codex: [path.join(local, 'Programs', 'Codex', 'Codex.exe')],
    claude: [path.join(local, 'AnthropicClaude', 'Claude.exe'), path.join(local, 'Programs', 'Claude', 'Claude.exe')],
    cursor: [path.join(local, 'Programs', 'cursor', 'Cursor.exe'), path.join(local, 'Programs', 'Cursor', 'Cursor.exe')],
    windsurf: [path.join(local, 'Programs', 'Windsurf', 'Windsurf.exe')],
    vscode: [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')]
  };
  return paths[definition.id] || [];
}

async function findCommand(commands = []) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(finder, [command], { windowsHide: true, timeout: 3000 });
      const candidates = String(stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (process.platform === 'win32' && command === 'codex') {
        const packagedCli = candidates.find((item) => /\\app\\resources\\codex\.exe$/i.test(item));
        const packageRoot = packagedCli ? path.dirname(path.dirname(path.dirname(packagedCli))) : '';
        const packagedLogo = packageRoot ? path.join(packageRoot, 'assets', 'Square44x44Logo.png') : '';
        if (packagedLogo && await exists(packagedLogo)) return packagedLogo;
        const packagedApp = packagedCli ? path.join(path.dirname(path.dirname(packagedCli)), 'Codex.exe') : '';
        if (packagedApp && await exists(packagedApp)) return packagedApp;
      }
      const candidate = candidates[0];
      if (candidate) return candidate;
    } catch { /* Continue through supported command names. */ }
  }
  return '';
}

async function findKnownInstall(definition) {
  for (const candidate of knownInstallPaths(definition)) if (await exists(candidate)) return candidate;
  return findCommand(definition.commands);
}

async function findExtensionAsset(prefixes = []) {
  const roots = ['.vscode', '.cursor', '.windsurf'].map((folder) => path.join(os.homedir(), folder, 'extensions'));
  for (const root of roots) {
    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    const match = entries.find((entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix)));
    if (!match) continue;
    const extensionPath = path.join(root, match.name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'package.json'), 'utf8'));
      const iconPath = manifest.icon ? path.join(extensionPath, manifest.icon) : '';
      return { installPath: extensionPath, iconPath: iconPath && await exists(iconPath) ? iconPath : '' };
    } catch { return { installPath: extensionPath, iconPath: '' }; }
  }
  return { installPath: '', iconPath: '' };
}

async function configConnected(definition, configPath) {
  let source = '';
  try { source = await fs.readFile(configPath, 'utf8'); } catch { return false; }
  if (definition.format === 'toml') {
    return isTomlConfigStructurallyValid(source) && /(^|\n)\[mcp_servers\.deployerx\]/m.test(source);
  }
  try {
    const config = JSON.parse(source);
    if (definition.format === 'json-mcp') return Boolean(config?.mcp?.deployerx);
    if (definition.format === 'json-servers') return Boolean(config?.servers?.deployerx);
    return Boolean(config?.mcpServers?.deployerx);
  } catch { return false; }
}

function jsonServer(url, token) {
  return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
}

function codexConfig(url, token) {
  return `[mcp_servers.deployerx]\nurl = "${url}"\nbearer_token_env_var = "DEPLOYERX_MCP_TOKEN"\ndefault_tools_approval_mode = "prompt"\ntool_timeout_sec = 300`;
}

function normalizeCodexConfig(source, block) {
  const normalized = String(source || '').replace(/\r\n/g, '\n');
  const section = /(^|\n)\[mcp_servers\.deployerx\][\s\S]*?(?=\n\[|$)/m;
  const orphanedDeployerxSettings = /^url = "http:\/\/127\.0\.0\.1:\d+\/mcp"\nbearer_token_env_var = "DEPLOYERX_MCP_TOKEN"\ndefault_tools_approval_mode = "prompt"\ntool_timeout_sec = 300\n?/gm;
  const cleaned = normalized
    .replace(section, '$1')
    .replace(orphanedDeployerxSettings, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${cleaned ? `${cleaned}\n\n` : ''}${block ? `${block}\n` : ''}`;
}

function isTomlConfigStructurallyValid(source) {
  let section = '';
  const keys = new Set();
  for (const rawLine of String(source || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!keyMatch) continue;
    const key = `${section}:${keyMatch[1]}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

async function persistCodexToken(token) {
  process.env.DEPLOYERX_MCP_TOKEN = token;
  if (process.platform === 'win32') {
    try { await execFileAsync('setx.exe', ['DEPLOYERX_MCP_TOKEN', token], { windowsHide: true, timeout: 5000 }); } catch { /* The config remains usable for processes inheriting this environment. */ }
  }
}

async function clearCodexToken() {
  delete process.env.DEPLOYERX_MCP_TOKEN;
  if (process.platform === 'win32') {
    try { await execFileAsync('reg.exe', ['delete', 'HKCU\\Environment', '/v', 'DEPLOYERX_MCP_TOKEN', '/f'], { windowsHide: true, timeout: 5000 }); } catch { /* The variable may not have been persisted yet. */ }
  }
}

async function writeJsonConfig(filePath, format, url, token) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not parse ${path.basename(filePath)}. Fix its JSON, then retry.`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) current = {};
  const server = jsonServer(url, token);
  if (format === 'json-mcp') current.mcp = { ...(current.mcp || {}), deployerx: { type: 'remote', url, headers: server.headers } };
  else if (format === 'json-servers') current.servers = { ...(current.servers || {}), deployerx: server };
  else current.mcpServers = { ...(current.mcpServers || {}), deployerx: server };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

async function disconnectJsonConfig(filePath, format) {
  let current;
  try {
    current = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`Could not parse ${path.basename(filePath)}. Fix its JSON, then retry.`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
  const containerKey = format === 'json-mcp' ? 'mcp' : format === 'json-servers' ? 'servers' : 'mcpServers';
  const container = current[containerKey];
  if (!container || typeof container !== 'object' || !Object.prototype.hasOwnProperty.call(container, 'deployerx')) return false;
  delete container.deployerx;
  await fs.writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return true;
}

async function listMcpClients() {
  const clients = await Promise.all(CLIENT_DEFINITIONS.map(async (definition) => {
    const configPath = definitionPath(definition);
    const configExists = await exists(configPath);
    const executablePath = await findKnownInstall(definition);
    const extension = await findExtensionAsset(definition.extensionPrefixes);
    const installed = configExists || Boolean(executablePath || extension.installPath);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      configPath,
      format: definition.format,
      installed,
      connected: installed && await configConnected(definition, configPath),
      iconPath: extension.iconPath || executablePath || ''
    };
  }));
  return clients.filter((client) => client.installed);
}

function tokenFromAuthorization(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function readCodexEnvironmentToken() {
  if (process.env.DEPLOYERX_MCP_TOKEN) return String(process.env.DEPLOYERX_MCP_TOKEN).trim();
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'DEPLOYERX_MCP_TOKEN'], { windowsHide: true, timeout: 5000 });
    return String(stdout).match(/DEPLOYERX_MCP_TOKEN\s+REG_SZ\s+(.+)/i)?.[1]?.trim() || '';
  } catch {
    return '';
  }
}

async function readMcpClientToken() {
  const codexToken = await readCodexEnvironmentToken();
  if (codexToken) return codexToken;
  for (const definition of CLIENT_DEFINITIONS) {
    if (definition.format === 'toml') continue;
    let current;
    try { current = JSON.parse(await fs.readFile(definitionPath(definition), 'utf8')); } catch { continue; }
    const containerKey = definition.format === 'json-mcp' ? 'mcp' : definition.format === 'json-servers' ? 'servers' : 'mcpServers';
    const server = current?.[containerKey]?.deployerx;
    const token = tokenFromAuthorization(server?.headers?.Authorization || server?.headers?.authorization);
    if (token) return token;
  }
  return '';
}

async function connectMcpClient(clientId, { url, token }) {
  const definition = CLIENT_DEFINITIONS.find((item) => item.id === String(clientId));
  if (!definition) throw new Error('Unknown MCP client.');
  if (!url || !token) throw new Error('MCP must be running before connecting a client.');
  const configPath = definitionPath(definition);
  if (definition.format === 'toml') {
    await persistCodexToken(token);
    let current = '';
    try { current = await fs.readFile(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const block = codexConfig(url, token);
    current = normalizeCodexConfig(current, block);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, current, 'utf8');
  } else await writeJsonConfig(configPath, definition.format, url, token);
  if (!await configConnected(definition, configPath)) throw new Error(`${definition.name} did not accept the DeployerX MCP configuration.`);
  return { id: definition.id, name: definition.name, connected: true };
}

async function disconnectMcpClient(clientId) {
  const definition = CLIENT_DEFINITIONS.find((item) => item.id === String(clientId));
  if (!definition) throw new Error('Unknown MCP client.');
  const configPath = definitionPath(definition);
  let disconnected = false;
  if (definition.format === 'toml') {
    let current = '';
    try { current = await fs.readFile(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const section = /(^|\n)\[mcp_servers\.deployerx\][\s\S]*?(?=\n\[|$)/m;
    disconnected = section.test(current);
    if (disconnected) {
      current = normalizeCodexConfig(current, '');
      await fs.writeFile(configPath, current === '\n' ? '' : current, 'utf8');
    }
  } else disconnected = await disconnectJsonConfig(configPath, definition.format);
  if (definition.id === 'codex') await clearCodexToken();
  return { id: definition.id, name: definition.name, disconnected };
}

module.exports = { listMcpClients, connectMcpClient, disconnectMcpClient, readMcpClientToken, CLIENT_DEFINITIONS };
