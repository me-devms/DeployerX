const http = require('node:http');
const crypto = require('node:crypto');

// One authenticated loopback endpoint per run, bound to that run's SSH connection.
async function createDeploymentSshBridge(execute) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    const authorization = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (authorization.length !== expected.length || !crypto.timingSafeEqual(authorization, expected)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/exec') {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) throw new Error('SSH command is too large.');
      }
      const { command, timeoutMs = 300000 } = JSON.parse(body);
      if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('An SSH command is required.');
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const result = await execute(command, Math.max(1000, Math.min(900000, Number(timeoutMs) || 300000)), (stream, text) => {
        if (!response.destroyed) response.write(`${JSON.stringify({ stream, text })}\n`);
      });
      response.end(`${JSON.stringify({ result })}\n`);
    } catch (error) {
      response.end(`${JSON.stringify({ error: error.message })}\n`);
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    env: { DEPLOYERX_SSH_PORT: String(server.address().port), DEPLOYERX_SSH_TOKEN: token },
    close() { server.close(); server.closeAllConnections(); }
  };
}

function executeDeploymentSsh(connection, command, timeoutMs, onOutput) {
  return new Promise((resolve, reject) => {
    let stream;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.removeListener('close', closed);
      connection.removeListener('error', closed);
      if (error) reject(error);
      else resolve(result);
    };
    const closed = () => finish(new Error('Deployment SSH connection closed.'));
    const timer = setTimeout(() => {
      stream?.close();
      finish(new Error(`SSH command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    connection.once('close', closed);
    connection.once('error', closed);
    connection.exec(command, (error, channel) => {
      if (error) return finish(error);
      if (settled) { channel.close(); return; }
      stream = channel;
      channel.on('data', (data) => onOutput('stdout', data.toString()));
      channel.stderr?.on('data', (data) => onOutput('stderr', data.toString()));
      channel.once('error', (failure) => finish(failure));
      channel.once('close', (exitCode, signal) => finish(null, { exitCode, signal }));
    });
  });
}

async function main() {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const saved = await fs.readFile(path.join(__dirname, '.deployment-ssh.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const port = Number(process.env.DEPLOYERX_SSH_PORT || saved.DEPLOYERX_SSH_PORT);
  const token = process.env.DEPLOYERX_SSH_TOKEN || saved.DEPLOYERX_SSH_TOKEN;
  if (!port || !token) throw new Error('This SSH helper is only available inside its deployment session.');
  let command = process.argv[2] || '';
  if (!command) for await (const chunk of process.stdin) command += chunk;
  await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/exec',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Deployment SSH access was rejected.')); return; }
      let buffer = '';
      let completed = false;
      response.setEncoding('utf8');
      response.on('data', (data) => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.stream) (event.stream === 'stderr' ? process.stderr : process.stdout).write(event.text);
            if (event.error) { completed = true; reject(new Error(event.error)); }
            if (event.result) { completed = true; process.exitCode = Number.isInteger(event.result.exitCode) ? event.result.exitCode : 1; }
          } catch (error) { reject(error); }
        }
      });
      response.on('end', () => completed ? resolve() : reject(new Error('Deployment SSH response was interrupted.')));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(JSON.stringify({ command }));
  });
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { createDeploymentSshBridge, executeDeploymentSsh };
