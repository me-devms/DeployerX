const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findCommandRunner } = require('./mcp-clients');

const execFileAsync = promisify(execFile);
const definitions = [
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'claude-code', name: 'Claude Code', command: 'claude' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode' }
];

function compareVersions(left, right) {
  const a = String(left).match(/\d+/g) || [];
  const b = String(right).match(/\d+/g) || [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = Number(a[index] || 0) - Number(b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

async function runningAgentPaths() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe' OR Name = 'claude.exe' OR Name = 'gemini.exe' OR Name = 'opencode.exe'\" | Select-Object -ExpandProperty ExecutablePath"],
      { windowsHide: true, timeout: 5000 });
      return [...new Set(stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
    }
    const { stdout } = await execFileAsync('ps', ['-axo', 'comm='], { timeout: 3000 });
    return stdout.split('\n').map((item) => item.trim()).filter((item) => /\/(codex|claude|gemini|opencode)$/.test(item));
  } catch { return []; }
}

async function listLocalAgents() {
  const running = await runningAgentPaths();
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return Promise.all(definitions.map(async (definition) => {
    const runner = await findCommandRunner([definition.command]);
    const candidates = runner.commandPath ? [runner] : [];
    const add = (commandPath, commandArgs = []) => candidates.push({ commandPath, commandArgs });
    running.filter((item) => path.basename(item) === `${definition.command}${process.platform === 'win32' ? '.exe' : ''}`)
      .forEach((item) => add(item));
    if (process.platform === 'win32') {
      add(path.join(os.homedir(), '.local', 'bin', `${definition.command}.exe`));
      if (definition.id === 'codex') {
        add(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
        add(path.join(local, 'Programs', 'Codex', 'resources', 'codex.exe'));
        const root = path.join(local, 'OpenAI', 'Codex', 'bin');
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
          if (entry.isDirectory()) add(path.join(root, entry.name, 'codex.exe'));
        }
      }
      // npm shims may call node through a variable, which cannot be executed with shell:false.
      const { stdout = '' } = await execFileAsync('where.exe', [`${definition.command}.cmd`], { windowsHide: true, timeout: 3000 }).catch(() => ({}));
      for (const shim of stdout.split(/\r?\n/).filter(Boolean)) {
        const source = await fs.readFile(shim.trim(), 'utf8').catch(() => '');
        const script = source.match(/"(?:%~?dp0%?)[\\/]([^"\r\n]+\.(?:js|cjs|mjs))"/i)?.[1];
        if (script) {
          const node = await findCommandRunner(['node']);
          if (node.commandPath) add(node.commandPath, [path.resolve(path.dirname(shim.trim()), script)]);
        }
      }
    } else {
      for (const folder of ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')]) add(path.join(folder, definition.command));
      if (definition.id === 'codex' && process.platform === 'darwin') add('/Applications/Codex.app/Contents/Resources/codex');
    }
    const unique = [...new Map(candidates.map((item) => [JSON.stringify(item), item])).values()];
    const available = (await Promise.all(unique.map(async (candidate) => {
      try {
        await fs.access(candidate.commandPath);
        const { stdout } = await execFileAsync(candidate.commandPath, [...candidate.commandArgs, '--version'], { windowsHide: true, timeout: 5000, maxBuffer: 64000 });
        return { ...candidate, version: stdout.trim().split(/\r?\n/)[0].slice(0, 120) };
      } catch { return null; }
    }))).filter(Boolean).sort((a, b) => compareVersions(b.version, a.version));
    const selected = available[0];
    return { ...definition, ...selected, installed: Boolean(selected), runnable: Boolean(selected),
      active: running.some((item) => path.basename(item).toLowerCase() === `${definition.command}${process.platform === 'win32' ? '.exe' : ''}`) };
  }));
}

module.exports = { listLocalAgents, compareVersions };
