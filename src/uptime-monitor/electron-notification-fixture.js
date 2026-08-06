const { app, Notification } = require('electron');

async function main() {
  if (process.platform === 'win32') app.setAppUserModelId('com.everythingx.deployerx');
  await app.whenReady();
  if (!Notification.isSupported()) {
    process.stdout.write(`${JSON.stringify({ supported: false, shown: false })}\n`);
    app.quit();
    return;
  }

  const notification = new Notification({
    title: 'DeployerX Uptime acceptance',
    body: 'Windows desktop notification delivery is working.',
    silent: true
  });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ supported: true, shown: false, reason: 'timeout' }), 5000);
    notification.once('show', () => {
      clearTimeout(timer);
      resolve({ supported: true, shown: true });
    });
    notification.once('failed', (_event, error) => {
      clearTimeout(timer);
      resolve({ supported: true, shown: false, reason: String(error || 'failed') });
    });
    notification.show();
  });
  notification.close();
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  app.exit(1);
});
