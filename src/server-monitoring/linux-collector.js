const SECTION_PREFIX = '__DEPLOYERX_';
const MAX_OUTPUT_BYTES = 1024 * 1024;

function section(name, command) {
  return `printf '${SECTION_PREFIX}${name}__\\n'; ${command}`;
}

function buildCollectorCommand({ includeStatic = false, includeStorage = false, includeProcesses = false } = {}) {
  const commands = [
    'export LC_ALL=C',
    section('CPU', "grep '^cpu ' /proc/stat"),
    section('LOAD', 'cat /proc/loadavg'),
    section('UPTIME', 'cat /proc/uptime'),
    section('MEMORY', "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):' /proc/meminfo"),
    section('NETWORK', 'cat /proc/net/dev')
  ];

  if (includeStatic) {
    commands.push(
      section('HOSTNAME', 'hostname 2>/dev/null || cat /etc/hostname'),
      section('OS', ". /etc/os-release 2>/dev/null; printf '%s\\n' \"${PRETTY_NAME:-Linux}\""),
      section('KERNEL', 'uname -srmo'),
      section('CORES', 'getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c ^processor /proc/cpuinfo')
    );
  }
  if (includeStorage) commands.push(section('STORAGE', 'df -PkT 2>/dev/null || df -Pk'));
  if (includeProcesses) commands.push(section('PROCESSES', 'ps -eo pid=,comm=,pcpu=,pmem= --sort=-pcpu 2>/dev/null | head -n 8'));
  return commands.join('; ');
}

function splitSections(output = '') {
  const sections = {};
  let current = '';
  for (const line of String(output).split(/\r?\n/)) {
    const marker = line.match(/^__DEPLOYERX_([A-Z]+)__$/);
    if (marker) {
      current = marker[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()]));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, finite(value)));
}

function parseCpu(value = '') {
  const numbers = value.trim().split(/\s+/).slice(1).map(Number);
  if (numbers.length < 4 || numbers.some((number) => !Number.isFinite(number))) return null;
  const idle = numbers[3] + (numbers[4] || 0);
  return { idle, total: numbers.reduce((sum, number) => sum + number, 0) };
}

function cpuUsage(current, previous) {
  if (!current || !previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return clamp(((totalDelta - idleDelta) / totalDelta) * 100);
}

function parseMemory(value = '') {
  const values = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z]+):\s+(\d+)/);
    if (match) values[match[1]] = finite(match[2]) * 1024;
  }
  const totalBytes = values.MemTotal || 0;
  const availableBytes = values.MemAvailable || values.MemFree || 0;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swapTotalBytes = values.SwapTotal || 0;
  const swapFreeBytes = values.SwapFree || 0;
  return {
    totalBytes,
    usedBytes,
    availableBytes,
    cachedBytes: (values.Cached || 0) + (values.SReclaimable || 0),
    buffersBytes: values.Buffers || 0,
    usagePercent: totalBytes ? clamp((usedBytes / totalBytes) * 100) : 0,
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
    swapUsagePercent: swapTotalBytes ? clamp(((swapTotalBytes - swapFreeBytes) / swapTotalBytes) * 100) : 0
  };
}

function parseNetwork(value = '', previous = null, elapsedSeconds = 0) {
  const interfaces = [];
  for (const line of value.split(/\r?\n/).slice(2)) {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!match) continue;
    const columns = match[2].trim().split(/\s+/).map(Number);
    if (columns.length < 9 || columns.some((number) => !Number.isFinite(number))) continue;
    interfaces.push({ name: match[1].trim(), receivedBytes: columns[0], transmittedBytes: columns[8] });
  }
  const relevant = interfaces.filter((item) => item.name !== 'lo');
  const totals = relevant.reduce((result, item) => ({
    receivedBytes: result.receivedBytes + item.receivedBytes,
    transmittedBytes: result.transmittedBytes + item.transmittedBytes
  }), { receivedBytes: 0, transmittedBytes: 0 });
  const rate = (current, old) => previous && elapsedSeconds > 0 ? Math.max(0, (current - old) / elapsedSeconds) : null;
  return {
    ...totals,
    receiveBytesPerSecond: rate(totals.receivedBytes, previous?.receivedBytes || 0),
    transmitBytesPerSecond: rate(totals.transmittedBytes, previous?.transmittedBytes || 0),
    interfaces
  };
}

function parseStorage(value = '') {
  return value.split(/\r?\n/).slice(1).map((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 6) return null;
    const [filesystem, type, totalKb, usedKb, availableKb, percentage, ...mountParts] = columns;
    if (['tmpfs', 'devtmpfs', 'squashfs'].includes(type)) return null;
    return {
      filesystem,
      type,
      mount: mountParts.join(' '),
      totalBytes: finite(totalKb) * 1024,
      usedBytes: finite(usedKb) * 1024,
      availableBytes: finite(availableKb) * 1024,
      usagePercent: clamp(String(percentage || '').replace('%', ''))
    };
  }).filter(Boolean);
}

function parseProcesses(value = '') {
  return value.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)$/);
    return match ? { pid: Number(match[1]), name: match[2], cpuPercent: finite(match[3]), memoryPercent: finite(match[4]) } : null;
  }).filter(Boolean);
}

function parseCollectorOutput(output, { previousCounters = {}, previousSample = null, sampledAt = Date.now() } = {}) {
  const sections = splitSections(output);
  const cpuCounter = parseCpu(sections.CPU);
  const uptimeSeconds = finite(String(sections.UPTIME || '').split(/\s+/)[0]);
  const load = String(sections.LOAD || '').split(/\s+/).slice(0, 3).map(Number);
  const elapsedSeconds = previousCounters.sampledAt ? Math.max(0.001, (sampledAt - previousCounters.sampledAt) / 1000) : 0;
  const network = parseNetwork(sections.NETWORK, previousCounters.network, elapsedSeconds);
  const next = {
    ...(previousSample || {}),
    sampledAt: new Date(sampledAt).toISOString(),
    cpu: {
      usagePercent: cpuUsage(cpuCounter, previousCounters.cpu),
      cores: finite(sections.CORES, previousSample?.cpu?.cores || 0),
      load1: finite(load[0]),
      load5: finite(load[1]),
      load15: finite(load[2])
    },
    memory: parseMemory(sections.MEMORY),
    network,
    system: {
      ...(previousSample?.system || {}),
      hostname: sections.HOSTNAME || previousSample?.system?.hostname || '',
      os: sections.OS || previousSample?.system?.os || 'Linux',
      kernel: sections.KERNEL || previousSample?.system?.kernel || '',
      uptimeSeconds
    }
  };
  if (Object.prototype.hasOwnProperty.call(sections, 'STORAGE')) next.storage = parseStorage(sections.STORAGE);
  if (Object.prototype.hasOwnProperty.call(sections, 'PROCESSES')) next.processes = parseProcesses(sections.PROCESSES);
  return {
    sample: next,
    counters: {
      cpu: cpuCounter,
      network: { receivedBytes: network.receivedBytes, transmittedBytes: network.transmittedBytes },
      sampledAt
    }
  };
}

function executeCollectorCommand(connection, command, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        stream.close?.();
        finish(reject, new Error('The monitoring command timed out.'));
      }, timeoutMs);
      stream.on('data', (data) => {
        stdout += data.toString();
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          stream.close?.();
          finish(reject, new Error('The monitoring response exceeded the safety limit.'));
        }
      });
      stream.stderr?.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', (code) => {
        if (code === 0 || stdout.includes(SECTION_PREFIX)) finish(resolve, stdout);
        else finish(reject, new Error(stderr.trim() || `The monitoring command exited with code ${code}.`));
      });
    });
  });
}

module.exports = {
  buildCollectorCommand,
  cpuUsage,
  executeCollectorCommand,
  parseCollectorOutput,
  splitSections
};
