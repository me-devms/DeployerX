const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const nodemailer = require('nodemailer');
const { BackupControlDatabase } = require('../backup-manager/control-database');
const { BackupNotificationService } = require('../backup-manager/notifications');

class MemorySecretStore {
  constructor() {
    this.sequence = 0;
    this.values = new Map();
  }

  async create(input) {
    this.sequence += 1;
    const id = `notification-secret-${this.sequence}`;
    this.values.set(`${input.workspaceId}:${id}`, input.value);
    return {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      provider: 'electron-safe-storage',
      providerKey: id,
      secretType: input.secretType,
      scope: input.scope,
      version: 1,
      revision: 1,
      createdAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:00.000Z',
      createdBy: input.actorId,
      updatedBy: input.actorId
    };
  }

  async resolve({ workspaceId, id }) {
    return this.values.get(`${workspaceId}:${id}`);
  }

  async delete({ workspaceId, id }) {
    this.values.delete(`${workspaceId}:${id}`);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function createSmtpReceiver(messages) {
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost DeployerX acceptance SMTP\r\n');
    let buffer = '';
    let dataMode = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer) {
        if (dataMode) {
          const terminator = buffer.indexOf('\r\n.\r\n');
          if (terminator < 0) return;
          messages.push(buffer.slice(0, terminator));
          buffer = buffer.slice(terminator + 5);
          dataMode = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) return;
        const command = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        if (/^(EHLO|HELO)\b/i.test(command)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (/^(MAIL FROM|RCPT TO|RSET|NOOP)\b/i.test(command)) socket.write('250 2.1.0 ok\r\n');
        else if (/^DATA\b/i.test(command)) {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT\b/i.test(command)) {
          socket.end('221 2.0.0 bye\r\n');
        } else socket.write('250 2.0.0 ok\r\n');
      }
    });
  });
}

test('delivers an Uptime incident through real local email, webhook, Slack, and Teams transports', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-uptime-channel-test-'));
  const database = new BackupControlDatabase({ rootPath, clock: () => '2026-08-04T12:00:00.000Z' });
  await database.initialize();
  const httpDeliveries = [];
  const httpServer = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      httpDeliveries.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
      response.writeHead(204);
      response.end();
    });
  });
  const smtpMessages = [];
  const smtpServer = createSmtpReceiver(smtpMessages);
  const [httpPort, smtpPort] = await Promise.all([listen(httpServer), listen(smtpServer)]);
  context.after(async () => {
    await database.close();
    await Promise.all([
      new Promise((resolve) => httpServer.close(resolve)),
      new Promise((resolve) => smtpServer.close(resolve))
    ]);
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const service = new BackupNotificationService({
    controlDatabase: database,
    secretStore: new MemorySecretStore(),
    mailerFactory: (configuration) => nodemailer.createTransport(configuration),
    fetchImpl: global.fetch,
    clock: () => '2026-08-04T12:00:00.000Z',
    now: () => Date.parse('2026-08-04T12:00:00.000Z')
  });
  const common = { events: ['uptime.incident.opened'] };
  const routes = await Promise.all([
    service.createRoute('local', 'acceptance', { ...common, name: 'Local email', type: 'email', smtpHost: '127.0.0.1', smtpPort, smtpSecure: false, from: 'deployerx@example.test', to: 'operator@example.test' }),
    service.createRoute('local', 'acceptance', { ...common, name: 'Local webhook', type: 'webhook', webhookUrl: `http://127.0.0.1:${httpPort}/webhook`, allowInsecure: true }),
    service.createRoute('local', 'acceptance', { ...common, name: 'Local Slack', type: 'slack', webhookUrl: `http://127.0.0.1:${httpPort}/slack`, allowInsecure: true }),
    service.createRoute('local', 'acceptance', { ...common, name: 'Local Teams', type: 'teams', webhookUrl: `http://127.0.0.1:${httpPort}/teams`, allowInsecure: true })
  ]);

  const results = await service.dispatchEventToRoutes('local', routes.map((route) => route.id), {
    type: 'uptime.incident.opened',
    eventKey: 'acceptance:incident-1:opened',
    occurredAt: '2026-08-04T12:00:00.000Z',
    severity: 'critical',
    title: 'Incident opened: Checkout API',
    body: 'Checkout API failed two consecutive checks.',
    monitorId: 'monitor-checkout',
    incidentId: 'incident-1'
  });

  assert.equal(results.length, 4);
  assert.equal(results.every((result) => result.status === 'succeeded'), true);
  assert.equal(httpDeliveries.length, 3);
  assert.equal(httpDeliveries.every((delivery) => delivery.headers['x-deployerx-event'] === 'uptime.incident.opened'), true);
  assert.equal(httpDeliveries.find((delivery) => delivery.url === '/webhook').body.resource.incidentId, 'incident-1');
  assert.equal(typeof httpDeliveries.find((delivery) => delivery.url === '/slack').body.text, 'string');
  assert.equal(httpDeliveries.find((delivery) => delivery.url === '/teams').body.type, 'message');
  assert.equal(smtpMessages.length, 1);
  assert.match(smtpMessages[0], /Subject: Incident opened: Checkout API/);
  assert.match(smtpMessages[0], /uptime\.incident\.opened/);
  assert.equal((await service.listDeliveries('local')).length, 4);
});
