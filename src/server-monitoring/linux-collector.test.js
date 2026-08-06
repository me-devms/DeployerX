const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCollectorCommand, cpuUsage, parseCollectorOutput } = require('./linux-collector');

const firstSample = [
  '__DEPLOYERX_CPU__',
  'cpu  100 20 30 850 0 0 0 0 0 0',
  '__DEPLOYERX_LOAD__',
  '0.20 0.30 0.40 1/100 10',
  '__DEPLOYERX_UPTIME__',
  '3600.00 1000.00',
  '__DEPLOYERX_MEMORY__',
  'MemTotal:       1024000 kB',
  'MemFree:         200000 kB',
  'MemAvailable:    400000 kB',
  'Cached:          100000 kB',
  'SwapTotal:      204800 kB',
  'SwapFree:       102400 kB',
  '__DEPLOYERX_NETWORK__',
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0 0',
  '__DEPLOYERX_HOSTNAME__',
  'node-01',
  '__DEPLOYERX_OS__',
  'Ubuntu 24.04 LTS',
  '__DEPLOYERX_KERNEL__',
  'Linux 6.8.0 x86_64 GNU/Linux',
  '__DEPLOYERX_CORES__',
  '4',
  '__DEPLOYERX_STORAGE__',
  'Filesystem     Type 1024-blocks    Used Available Capacity Mounted on',
  '/dev/sda1      ext4     1000000  400000    600000      40% /',
  '__DEPLOYERX_PROCESSES__',
  '  12 node 12.5 4.2'
].join('\n');

test('builds a read-only collector command with optional sections', () => {
  const command = buildCollectorCommand({ includeStatic: true, includeStorage: true, includeProcesses: true });
  assert.match(command, /\/proc\/stat/);
  assert.match(command, /df -PkT/);
  assert.match(command, /ps -eo/);
  assert.doesNotMatch(command, /sudo|rm -rf|passwd/);
});

test('calculates CPU utilization from successive /proc/stat counters', () => {
  assert.equal(cpuUsage({ total: 1000, idle: 800 }, { total: 900, idle: 750 }), 50);
});

test('parses a complete Linux sample and computes rates on the next sample', () => {
  const first = parseCollectorOutput(firstSample, { sampledAt: 1000 });
  assert.equal(first.sample.system.hostname, 'node-01');
  assert.equal(first.sample.cpu.cores, 4);
  assert.equal(first.sample.memory.totalBytes, 1024000 * 1024);
  assert.equal(first.sample.storage[0].mount, '/');
  assert.equal(first.sample.processes[0].name, 'node');

  const secondOutput = firstSample.replace('cpu  100 20 30 850', 'cpu  110 20 30 860').replace('eth0: 1000', 'eth0: 3000').replace('2000 0 0 0 0 0 0 0 0', '5000 0 0 0 0 0 0 0 0');
  const second = parseCollectorOutput(secondOutput, { previousCounters: first.counters, previousSample: first.sample, sampledAt: 3000 });
  assert.equal(second.sample.cpu.usagePercent, 50);
  assert.equal(second.sample.network.receiveBytesPerSecond, 1000);
  assert.equal(second.sample.network.transmitBytesPerSecond, 1500);
});
