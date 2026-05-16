const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { Client } = require('ssh2');
const appPackage = require('../package.json');

const STORE_FILE = 'projects.json';
const SETTINGS_FILE = 'settings.json';
const APP_ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'deployerx-logo.ico' : 'deployerx-logo.png');
const AUTO_UPDATE_CHECK_DELAY_MS = 12000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let mainWindow;
const activeDeployments = new Map();
const activeTerminals = new Map();
const activeFtpSessions = new Map();
const activeTerminalUploads = new Map();
const TEMPLATE_CATEGORIES = ['Server', 'Laravel', 'Node.js', 'Database', 'Docker', 'Maintenance', 'Security', 'Hosting', 'Web Server', 'Cache', 'Control Panel', 'PaaS'];
const FIREBASE_AUTH_URL = 'https://identitytoolkit.googleapis.com/v1';
const FIREBASE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
let settingsCache = null;
let firebaseConfigCache = null;
let cloudUnlock = { teamId: '', key: null };
const pendingConfirmations = new Map();
const BUILT_IN_TEMPLATE_PREFIX = 'builtin:';
const githubReleaseSource = resolveGitHubReleaseSource();
const updateState = createDefaultUpdateState();
let updaterInitialized = false;
let autoUpdateTimer = null;
const BUILT_IN_TEMPLATES = [
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}ubuntu-host-bootstrap`,
    name: 'Ubuntu Direct Host Bootstrap',
    category: 'Server',
    commands: [
      'export DEBIAN_FRONTEND=noninteractive',
      'sudo apt-get update -y',
      'sudo apt-get upgrade -y',
      'sudo apt-get install -y curl git unzip ufw fail2ban software-properties-common',
      'sudo timedatectl set-timezone {{timezone}}',
      'sudo adduser --disabled-password --gecos "" {{deploy_user}} || true',
      'sudo usermod -aG sudo {{deploy_user}}',
      'sudo mkdir -p /home/{{deploy_user}}/.ssh',
      'sudo cp /root/.ssh/authorized_keys /home/{{deploy_user}}/.ssh/authorized_keys || true',
      'sudo chown -R {{deploy_user}}:{{deploy_user}} /home/{{deploy_user}}/.ssh',
      'sudo chmod 700 /home/{{deploy_user}}/.ssh',
      'sudo chmod 600 /home/{{deploy_user}}/.ssh/authorized_keys || true',
      'sudo ufw allow OpenSSH',
      'sudo ufw allow {{app_port}}/tcp',
      'sudo ufw --force enable',
      'sudo systemctl enable fail2ban',
      'sudo systemctl restart fail2ban'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}nodejs-pm2-nginx`,
    name: 'Node.js 22 + PM2 Direct Deploy',
    category: 'Node.js',
    commands: [
      'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
      'sudo apt-get install -y nodejs',
      'sudo npm install -g pm2',
      'cd {{app_path}}',
      'git fetch --all --prune',
      'git checkout {{branch}}',
      'git pull origin {{branch}}',
      'npm ci --omit=dev || npm install --omit=dev',
      'npm run migrate || true',
      'pm2 describe {{pm2_name}} >/dev/null 2>&1 && pm2 reload {{pm2_name}} --update-env || pm2 start {{start_command}} --name {{pm2_name}}',
      'pm2 save'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}laravel-queue-nginx`,
    name: 'Laravel Deploy + Queue Restart',
    category: 'Laravel',
    commands: [
      'cd {{app_path}}',
      'git fetch --all --prune',
      'git checkout {{branch}}',
      'git pull origin {{branch}}',
      'composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev',
      'php artisan down || true',
      'php artisan migrate --force',
      'php artisan config:cache',
      'php artisan route:cache',
      'php artisan view:cache',
      'php artisan queue:restart',
      'php artisan up',
      'sudo systemctl reload php{{php_version}}-fpm',
      'sudo systemctl reload nginx'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}docker-engine-compose-install`,
    name: 'Docker Engine + Compose Install (Ubuntu)',
    category: 'Docker',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y ca-certificates curl',
      'sudo install -m 0755 -d /etc/apt/keyrings',
      'sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
      'sudo chmod a+r /etc/apt/keyrings/docker.asc',
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${UBUNTU_CODENAME:-$VERSION_CODENAME}) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null',
      'sudo apt-get update -y',
      'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
      'sudo usermod -aG docker {{ssh_username}}',
      'docker --version',
      'docker compose version'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}docker-compose-refresh`,
    name: 'Docker Compose Pull + Recreate',
    category: 'Docker',
    commands: [
      'cd {{app_path}}',
      'docker compose pull',
      'docker compose up -d --remove-orphans',
      'docker image prune -f'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}postgres-backup-rotate`,
    name: 'PostgreSQL Backup + Retention',
    category: 'Database',
    commands: [
      'mkdir -p {{backup_dir}}',
      'export PGPASSWORD="{{db_password}}"',
      'pg_dump -h {{db_host}} -p {{db_port}} -U {{db_user}} -d {{db_name}} -F c -b -v -f {{backup_dir}}/{{db_name}}-$(date +%F-%H%M).dump',
      'find {{backup_dir}} -type f -name "*.dump" -mtime +{{retention_days}} -delete'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}mysql-backup-rotate`,
    name: 'MySQL Backup + Retention',
    category: 'Database',
    commands: [
      'mkdir -p {{backup_dir}}',
      'mysqldump -u {{db_user}} -p\'{{db_password}}\' {{db_name}} > {{backup_dir}}/{{db_name}}-$(date +%F-%H%M).sql',
      'find {{backup_dir}} -type f -name "*.sql" -mtime +{{retention_days}} -delete'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}mysql-create-db-user`,
    name: 'MySQL Create Database + User',
    category: 'Database',
    commands: [
      'sudo mysql -e "CREATE DATABASE IF NOT EXISTS \\`{{db_name}}\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"',
      'sudo mysql -e "CREATE USER IF NOT EXISTS \'{{db_user}}\'@\'localhost\' IDENTIFIED BY \'{{db_password}}\';"',
      'sudo mysql -e "GRANT ALL PRIVILEGES ON \\`{{db_name}}\\`.* TO \'{{db_user}}\'@\'localhost\'; FLUSH PRIVILEGES;"'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}postgres-create-db-user`,
    name: 'PostgreSQL Create Database + User',
    category: 'Database',
    commands: [
      'sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = \'{{db_user}}\'" | grep -q 1 || sudo -u postgres psql -c "CREATE USER {{db_user}} WITH PASSWORD \'{{db_password}}\';"',
      'sudo -u postgres psql -lqt | cut -d \\| -f 1 | grep -qw {{db_name}} || sudo -u postgres createdb -O {{db_user}} {{db_name}}'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}caddy-install`,
    name: 'Caddy Install (Ubuntu/Debian)',
    category: 'Web Server',
    commands: [
      'sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl',
      'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
      'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list',
      'sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
      'sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list',
      'sudo apt update',
      'sudo apt install -y caddy'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}caddy-reverse-proxy`,
    name: 'Caddy Reverse Proxy App',
    category: 'Web Server',
    commands: [
      'echo "{{domain}} { reverse_proxy 127.0.0.1:{{upstream_port}} }" | sudo tee /etc/caddy/Caddyfile',
      'sudo systemctl reload caddy'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}redis-install`,
    name: 'Redis Install (Official Repo)',
    category: 'Cache',
    commands: [
      'sudo apt-get install -y lsb-release curl gpg',
      'curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg',
      'sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg',
      'echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list',
      'sudo apt-get update',
      'sudo apt-get install -y redis',
      'sudo systemctl enable redis-server',
      'sudo systemctl start redis-server'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}redis-local-hardening`,
    name: 'Redis Local Hardening',
    category: 'Cache',
    commands: [
      'sudo sed -i "s/^bind .*/bind 127.0.0.1 ::1/" /etc/redis/redis.conf || true',
      'sudo sed -i "s/^protected-mode .*/protected-mode yes/" /etc/redis/redis.conf || true',
      'sudo systemctl restart redis-server'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}letsencrypt-nginx`,
    name: "Let's Encrypt SSL Install (Nginx)",
    category: 'Security',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y certbot python3-certbot-nginx',
      'sudo certbot --nginx -d {{domain}} --non-interactive --agree-tos -m {{email}} --redirect',
      'sudo systemctl reload nginx'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}certbot-renew-dry-run`,
    name: "Let's Encrypt Renew Dry Run",
    category: 'Security',
    commands: ['sudo certbot renew --dry-run']
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}wordpress-softaculous-prep`,
    name: 'Softaculous / WordPress Host Prep',
    category: 'Hosting',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y nginx mysql-server php-fpm php-mysql php-curl php-xml php-mbstring php-zip unzip rsync',
      'sudo mkdir -p {{site_root}}',
      'sudo chown -R {{ssh_username}}:{{ssh_username}} {{site_root}}',
      'curl -fsSL https://wordpress.org/latest.zip -o /tmp/wordpress.zip',
      'unzip -o /tmp/wordpress.zip -d /tmp',
      'rsync -av /tmp/wordpress/ {{site_root}}/',
      'sudo systemctl enable nginx',
      'sudo systemctl enable mysql',
      'sudo systemctl restart nginx',
      'sudo systemctl restart mysql'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}softaculous-wordpress-cli`,
    name: 'Softaculous CLI Install WordPress',
    category: 'Hosting',
    commands: [
      'php {{softaculous_php_bin}} {{softaculous_cli_path}} --install --panel_user=\'{{panel_user}}\' --panel_pass=\'{{panel_pass}}\' --soft=26 --softdirectory=\'{{soft_directory}}\' --admin_username=\'{{admin_username}}\' --admin_pass=\'{{admin_password}}\' --site_name=\'{{site_name}}\' --emailto=\'{{email}}\''
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}cloudpanel-install`,
    name: 'CloudPanel Install',
    category: 'Control Panel',
    commands: [
      'sudo apt update -y',
      'sudo apt -y upgrade',
      'sudo apt -y install curl wget sudo',
      'curl -sS https://installer.cloudpanel.io/ce/v2/install.sh -o install.sh',
      'echo "6eac061df80f08b75224fcd7fce2f115e201696d8a6122e31abf7259a813b462 install.sh" | sha256sum -c',
      'sudo DB_ENGINE={{cloudpanel_db_engine}} bash install.sh',
      'echo "Open https://$(hostname -I | awk \'{print $1}\'):8443 quickly to create the CloudPanel admin user."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}hestiacp-install`,
    name: 'HestiaCP Install (Interactive)',
    category: 'Control Panel',
    commands: [
      'sudo apt-get update',
      'sudo apt-get install -y ca-certificates wget',
      'wget https://raw.githubusercontent.com/hestiacp/hestiacp/release/install/hst-install.sh',
      'sudo bash hst-install.sh'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}cwp-install-el9`,
    name: 'CWP Install (EL9 / AlmaLinux 9)',
    category: 'Control Panel',
    commands: [
      'sudo hostnamectl set-hostname {{server_hostname}}',
      'sudo dnf install epel-release -y',
      'sudo dnf -y install wget',
      'sudo dnf -y update',
      'echo "CWP official docs recommend a fresh OS and a reboot after update before installation. Continue only if this server is clean."',
      'cd /usr/local/src',
      'sudo wget http://centos-webpanel.com/cwp-el9-latest',
      'sudo sh cwp-el9-latest -r yes',
      'echo "After install, login at http://$(hostname -I | awk \'{print $1}\'):2030/ with root and the server root password."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}coolify-install`,
    name: 'Coolify Install',
    category: 'PaaS',
    commands: [
      'curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash',
      'echo "Open http://$(hostname -I | awk \'{print $1}\'):8000 and create the admin account immediately."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}dokploy-install`,
    name: 'Dokploy Install',
    category: 'PaaS',
    commands: [
      'curl -sSL https://dokploy.com/install.sh | sh',
      'echo "Open http://$(hostname -I | awk \'{print $1}\'):3000 to finish Dokploy setup."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}dokku-install`,
    name: 'Dokku Install',
    category: 'PaaS',
    commands: [
      'wget -NP . https://dokku.com/install/v0.38.5/bootstrap.sh',
      'sudo DOKKU_TAG=v0.38.5 bash bootstrap.sh',
      'cat ~/.ssh/authorized_keys | sudo dokku ssh-keys:add admin || true',
      'sudo dokku domains:set-global {{dokku_domain}}'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}caprover-install`,
    name: 'CapRover Install',
    category: 'PaaS',
    commands: [
      'command -v docker >/dev/null 2>&1 && docker run -d --restart unless-stopped --name captain-captain -p 80:80 -p 443:443 -p 3000:3000 -e ACCEPTED_TERMS=true -v /var/run/docker.sock:/var/run/docker.sock -v /captain:/captain caprover/caprover || echo "Install Docker first with the Docker Engine + Compose template."',
      'echo "Login at http://$(hostname -I | awk \'{print $1}\'):3000 with the default password captain42, then complete CapRover server setup."'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}server-hardening-basics`,
    name: 'Server Hardening Basics',
    category: 'Security',
    commands: [
      'sudo apt-get update -y',
      'sudo apt-get install -y fail2ban unattended-upgrades',
      'sudo sed -i \'s/^#*PasswordAuthentication .*/PasswordAuthentication no/\' /etc/ssh/sshd_config',
      'sudo sed -i \'s/^#*PermitRootLogin .*/PermitRootLogin prohibit-password/\' /etc/ssh/sshd_config',
      'sudo systemctl restart ssh || sudo systemctl restart sshd',
      'sudo dpkg-reconfigure -f noninteractive unattended-upgrades',
      'sudo systemctl enable fail2ban',
      'sudo systemctl restart fail2ban'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}ufw-web-profile`,
    name: 'UFW Web Profile',
    category: 'Security',
    commands: [
      'sudo ufw allow OpenSSH',
      'sudo ufw allow 80/tcp',
      'sudo ufw allow 443/tcp',
      'sudo ufw --force enable',
      'sudo ufw status'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}swapfile-setup`,
    name: 'Swapfile Setup',
    category: 'Server',
    commands: [
      'sudo fallocate -l {{swap_size}} /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count={{swap_size_mb}}',
      'sudo chmod 600 /swapfile',
      'sudo mkswap /swapfile',
      'sudo swapon /swapfile',
      'grep -q "^/swapfile " /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab',
      'swapon --show'
    ]
  },
  {
    id: `${BUILT_IN_TEMPLATE_PREFIX}maintenance-cleanup`,
    name: 'Maintenance Cleanup + Health Check',
    category: 'Maintenance',
    commands: [
      'df -h',
      'free -m',
      'sudo apt-get autoremove -y',
      'sudo apt-get autoclean -y',
      'sudo journalctl --vacuum-time={{journal_retention}}',
      'sudo systemctl --failed',
      'uptime'
    ]
  }
];

function resolveGitHubReleaseSource(repository = appPackage.repository) {
  const rawUrl = typeof repository === 'string' ? repository : repository?.url;
  const normalized = String(rawUrl || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/i, '');
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    releasesUrl: `https://github.com/${owner}/${repo}/releases`
  };
}

function createDefaultUpdateState() {
  return {
    enabled: false,
    status: 'idle',
    currentVersion: appPackage.version || '0.0.0',
    availableVersion: '',
    downloadedVersion: '',
    releaseName: '',
    releaseDate: '',
    downloadPercent: 0,
    lastCheckedAt: '',
    releasePageUrl: githubReleaseSource?.releasesUrl || '',
    message: '',
    error: ''
  };
}

function publicUpdateState() {
  const status = updateState.status || 'idle';
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    releasePageUrl: githubReleaseSource?.releasesUrl || '',
    canCheck: Boolean(updateState.enabled) && !['checking', 'downloading'].includes(status),
    canInstall: status === 'downloaded'
  };
}

function sendUpdateStateToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:update-event', publicUpdateState());
}

function syncUpdateState(nextState = {}, notify = true) {
  Object.assign(updateState, nextState, {
    currentVersion: app.getVersion(),
    releasePageUrl: githubReleaseSource?.releasesUrl || ''
  });
  if (notify) sendUpdateStateToRenderer();
  return publicUpdateState();
}

function isPortableWindowsBuild() {
  return process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

function markUpdaterUnavailable(status, message) {
  return syncUpdateState({
    enabled: false,
    status,
    availableVersion: '',
    downloadedVersion: '',
    releaseName: '',
    releaseDate: '',
    downloadPercent: 0,
    message,
    error: ''
  });
}

async function checkForAppUpdates({ manual = false } = {}) {
  if (!updaterInitialized) initializeAutoUpdater();
  if (!updateState.enabled) return publicUpdateState();
  if (['checking', 'downloading'].includes(updateState.status)) return publicUpdateState();
  try {
    if (manual) {
      syncUpdateState({
        error: '',
        message: 'Checking GitHub releases for updates...'
      });
    }
    await autoUpdater.checkForUpdates();
  } catch (error) {
    syncUpdateState({
      status: 'error',
      lastCheckedAt: new Date().toISOString(),
      downloadPercent: 0,
      message: 'Could not check GitHub releases.',
      error: error?.message || String(error || 'Unknown error')
    });
  }
  return publicUpdateState();
}

function scheduleAutoUpdateChecks() {
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  setTimeout(() => {
    checkForAppUpdates().catch(() => {});
    autoUpdateTimer = setInterval(() => {
      checkForAppUpdates().catch(() => {});
    }, AUTO_UPDATE_INTERVAL_MS);
  }, AUTO_UPDATE_CHECK_DELAY_MS);
}

function initializeAutoUpdater() {
  if (updaterInitialized) {
    sendUpdateStateToRenderer();
    return;
  }
  updaterInitialized = true;

  if (!githubReleaseSource) {
    markUpdaterUnavailable('unconfigured', 'GitHub release tracking is not configured for this app yet.');
    return;
  }

  if (!app.isPackaged) {
    markUpdaterUnavailable('development', 'Auto updates are available in packaged builds. Use a packaged setup build to test release tracking.');
    return;
  }

  if (process.platform !== 'win32') {
    markUpdaterUnavailable('unsupported', 'Automatic updates are enabled for the Windows setup build only.');
    return;
  }

  if (isPortableWindowsBuild()) {
    markUpdaterUnavailable('portable', 'Portable builds cannot install updates automatically. Open GitHub releases to download the latest setup build.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    syncUpdateState({
      enabled: true,
      status: 'checking',
      availableVersion: '',
      downloadedVersion: '',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'Checking GitHub releases for updates...',
      error: ''
    });
  });

  autoUpdater.on('update-available', (info) => {
    syncUpdateState({
      enabled: true,
      status: 'available',
      availableVersion: info?.version || '',
      downloadedVersion: '',
      releaseName: info?.releaseName || '',
      releaseDate: info?.releaseDate || '',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: `Update ${info?.version || 'available'} found. Downloading now...`,
      error: ''
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    syncUpdateState({
      enabled: true,
      status: 'downloading',
      downloadPercent: Number(progress?.percent || 0),
      message: `Downloading version ${updateState.availableVersion || 'update'}...`,
      error: ''
    });
  });

  autoUpdater.on('update-not-available', () => {
    syncUpdateState({
      enabled: true,
      status: 'up-to-date',
      availableVersion: '',
      downloadedVersion: '',
      releaseName: '',
      releaseDate: '',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'You are already on the latest published release.',
      error: ''
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    syncUpdateState({
      enabled: true,
      status: 'downloaded',
      downloadedVersion: info?.version || updateState.availableVersion || '',
      releaseName: info?.releaseName || updateState.releaseName || '',
      releaseDate: info?.releaseDate || updateState.releaseDate || '',
      downloadPercent: 100,
      lastCheckedAt: new Date().toISOString(),
      message: `Version ${info?.version || updateState.availableVersion || 'update'} is ready. Restart DeployerX to install it.`,
      error: ''
    });
  });

  autoUpdater.on('error', (error) => {
    syncUpdateState({
      enabled: true,
      status: 'error',
      downloadPercent: 0,
      lastCheckedAt: new Date().toISOString(),
      message: 'Could not reach the GitHub release feed.',
      error: error?.message || String(error || 'Unknown error')
    });
  });

  syncUpdateState({
    enabled: true,
    status: 'idle',
    message: 'GitHub release tracking is enabled for this installed build.',
    error: ''
  });
  scheduleAutoUpdateChecks();
}

function requestInAppConfirmation({ message, detail = '', confirmLabel = 'Confirm' }) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);

  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(id);
      resolve(false);
    }, 120000);

    pendingConfirmations.set(id, { resolve, timer });

    try {
      mainWindow.webContents.send('ui:confirm-request', { id, message, detail, confirmLabel });
    } catch {
      clearTimeout(timer);
      pendingConfirmations.delete(id);
      resolve(false);
    }
  });
}

ipcMain.handle('ui:confirm-response', async (_event, payload = {}) => {
  const pending = pendingConfirmations.get(payload.id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingConfirmations.delete(payload.id);
  pending.resolve(Boolean(payload.confirmed));
  return true;
});

function normalizeTemplateCategory(category) {
  const value = String(category || '').trim();
  return TEMPLATE_CATEGORIES.includes(value) ? value : 'Server';
}

function normalizeStoredTemplate(template = {}) {
  const commands = Array.isArray(template.commands)
    ? template.commands.map((command) => String(command)).filter((command) => command.trim())
    : [];
  const variables =
    Array.isArray(template.variables) && template.variables.length
      ? template.variables.map((variable) => String(variable))
      : extractTemplateVariables(commands);

  return {
    ...template,
    category: normalizeTemplateCategory(template.category),
    commands,
    variables,
    builtIn: Boolean(template.builtIn),
    readOnly: Boolean(template.readOnly),
    source: template.source ? String(template.source) : template.builtIn ? 'library' : 'user'
  };
}

function buildBuiltInTemplates() {
  return BUILT_IN_TEMPLATES.map((template) =>
    normalizeStoredTemplate({
      ...template,
      builtIn: true,
      readOnly: true,
      source: 'library',
      updatedAt: '2026-05-16T00:00:00.000Z'
    })
  );
}

function mergeBuiltInTemplates(templates = []) {
  const items = (Array.isArray(templates) ? templates : [])
    .map(normalizeStoredTemplate)
    .filter((template) => !template.builtIn && !String(template.id || '').startsWith(BUILT_IN_TEMPLATE_PREFIX));

  return [...buildBuiltInTemplates(), ...items];
}

function stripBuiltInTemplates(templates = []) {
  return (Array.isArray(templates) ? templates : [])
    .map(normalizeStoredTemplate)
    .filter((template) => !template.builtIn && !String(template.id || '').startsWith(BUILT_IN_TEMPLATE_PREFIX))
    .map((template) => {
      const copy = { ...template };
      delete copy.builtIn;
      delete copy.readOnly;
      if (copy.source === 'user') delete copy.source;
      return copy;
    });
}

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function getUserFirebaseConfigPath() {
  return path.join(app.getPath('userData'), 'firebase.config.json');
}

function defaultSettings() {
  return {
    setupComplete: false,
    mode: '',
    activeTeamId: '',
    auth: null,
    projectLocalSettings: {}
  };
}

function normalizeProjectLocalSettings(projectLocalSettings = {}) {
  return {
    ftpLocalPath: String(projectLocalSettings?.ftpLocalPath || '').trim()
  };
}

function projectLocalSettingsMap(settings = {}) {
  if (!settings?.projectLocalSettings || typeof settings.projectLocalSettings !== 'object') return {};

  return Object.fromEntries(
    Object.entries(settings.projectLocalSettings).map(([projectId, value]) => [
      String(projectId || '').trim(),
      normalizeProjectLocalSettings(value)
    ])
  );
}

async function getProjectLocalSettings(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return normalizeProjectLocalSettings();
  const settings = await readSettings();
  return normalizeProjectLocalSettings(projectLocalSettingsMap(settings)[id]);
}

async function setProjectLocalSettings(projectId, nextSettings = {}) {
  const id = String(projectId || '').trim();
  if (!id) return normalizeProjectLocalSettings();
  const settings = await readSettings();
  const projectLocalSettings = projectLocalSettingsMap(settings);
  const normalized = normalizeProjectLocalSettings(nextSettings);

  if (normalized.ftpLocalPath) projectLocalSettings[id] = normalized;
  else delete projectLocalSettings[id];

  await writeSettings({
    ...settings,
    projectLocalSettings
  });

  return normalizeProjectLocalSettings(projectLocalSettings[id]);
}

async function deleteProjectLocalSettings(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return false;
  const settings = await readSettings();
  const projectLocalSettings = projectLocalSettingsMap(settings);
  if (!Object.prototype.hasOwnProperty.call(projectLocalSettings, id)) return false;
  delete projectLocalSettings[id];
  await writeSettings({
    ...settings,
    projectLocalSettings
  });
  return true;
}

async function readSettings() {
  if (settingsCache) return structuredClone(settingsCache);
  const settingsPath = getSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    settingsCache = {
      ...defaultSettings(),
      ...JSON.parse(raw)
    };
  } catch {
    settingsCache = defaultSettings();
  }
  return structuredClone(settingsCache);
}

async function writeSettings(nextSettings) {
  settingsCache = {
    ...defaultSettings(),
    ...nextSettings
  };
  await fs.writeFile(getSettingsPath(), JSON.stringify(settingsCache, null, 2));
  return structuredClone(settingsCache);
}

async function saveFirebaseConfig(config) {
  const normalized = {
    apiKey: String(config.apiKey || '').trim(),
    authDomain: String(config.authDomain || '').trim(),
    projectId: String(config.projectId || config.project_id || '').trim(),
    googleClientId: String(config.googleClientId || config.googleOAuthClientId || '').trim(),
    googleClientSecret: String(config.googleClientSecret || config.googleOAuthClientSecret || '').trim(),
    googleRedirectUri: String(config.googleRedirectUri || '').trim()
  };
  if (!normalized.apiKey || !normalized.projectId) {
    throw new Error('Firebase Web config must include apiKey and projectId.');
  }
  if (!normalized.authDomain) normalized.authDomain = `${normalized.projectId}.firebaseapp.com`;
  await fs.writeFile(getUserFirebaseConfigPath(), JSON.stringify(normalized, null, 2));
  firebaseConfigCache = null;
  return firebaseConfigStatus();
}

async function ensureStore() {
  const storePath = getStorePath();
  try {
    await fs.access(storePath);
  } catch {
    await fs.writeFile(storePath, JSON.stringify({ projects: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(getStorePath(), 'utf8');
  try {
    const data = JSON.parse(raw);
    return {
      projects: Array.isArray(data.projects) ? data.projects : [],
      templates: Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []
    };
  } catch {
    return { projects: [], templates: [] };
  }
}

async function writeStore(data) {
  const payload = {
    ...data,
    templates: stripBuiltInTemplates(data.templates)
  };
  await fs.writeFile(getStorePath(), JSON.stringify(payload, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = '') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}-${id}` : id;
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

function publicSession(auth) {
  if (!auth) return null;
  return {
    uid: auth.uid,
    email: auth.email,
    displayName: auth.displayName || '',
    emailVerified: Boolean(auth.emailVerified),
    provider: auth.provider || ''
  };
}

function authSessionChanged(currentAuth, nextAuth) {
  const fields = ['uid', 'email', 'displayName', 'idToken', 'refreshToken', 'expiresAt', 'emailVerified', 'provider'];
  return fields.some((field) => currentAuth?.[field] !== nextAuth?.[field]);
}

async function loadFirebaseConfig({ refresh = false } = {}) {
  if (!refresh && firebaseConfigCache !== null) return firebaseConfigCache;

  const envConfig =
    process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID
      ? {
          apiKey: process.env.FIREBASE_API_KEY,
          authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
          projectId: process.env.FIREBASE_PROJECT_ID,
          googleClientId: process.env.FIREBASE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
          googleClientSecret: process.env.FIREBASE_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
          googleRedirectUri: process.env.FIREBASE_GOOGLE_REDIRECT_URI || '',
          source: 'environment'
        }
      : null;
  if (envConfig) {
    firebaseConfigCache = envConfig;
    return firebaseConfigCache;
  }

  const candidatePaths = [
    path.join(app.getAppPath(), 'firebase.config.json'),
    path.join(app.getAppPath(), '..', 'firebase.config.json'),
    path.join(__dirname, 'firebase.config.json'),
    path.join(path.dirname(app.getPath('exe')), 'firebase.config.json'),
    path.join(app.getPath('userData'), 'firebase.config.json')
  ];

  for (const configPath of candidatePaths) {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
      if (parsed.apiKey && parsed.projectId) {
        firebaseConfigCache = {
          apiKey: String(parsed.apiKey),
          authDomain: String(parsed.authDomain || ''),
          projectId: String(parsed.projectId),
          googleClientId: String(parsed.googleClientId || parsed.googleOAuthClientId || ''),
          googleClientSecret: String(parsed.googleClientSecret || parsed.googleOAuthClientSecret || ''),
          googleRedirectUri: String(parsed.googleRedirectUri || ''),
          source: configPath
        };
        return firebaseConfigCache;
      }
    } catch {
      // Config is optional; setup UI will explain when it is missing.
    }
  }

  firebaseConfigCache = null;
  return firebaseConfigCache;
}

async function firebaseConfigStatus() {
  const config = await loadFirebaseConfig({ refresh: true });
  return {
    configured: Boolean(config?.apiKey && config?.projectId),
    googleConfigured: Boolean(config?.googleClientId),
    projectId: config?.projectId || '',
    source: config?.source || ''
  };
}

function requireFirebaseConfig(config) {
  if (!config?.apiKey || !config?.projectId) {
    throw new Error('Firebase Web config is missing. Add firebase.config.json with apiKey and projectId.');
  }
}

function firebaseErrorMessage(errorBody) {
  const firstArrayError = Array.isArray(errorBody)
    ? errorBody.find((item) => item?.error)?.error
    : null;
  const message =
    firstArrayError?.message ||
    firstArrayError?.status ||
    errorBody?.error_description ||
    errorBody?.error?.message ||
    errorBody?.error ||
    errorBody?.raw ||
    '';
  const normalized = String(message).replace(/_/g, ' ').toLowerCase();
  if (normalized.includes('email exists')) return 'An account already exists for this email.';
  if (normalized.includes('invalid login credentials') || normalized.includes('invalid password')) return 'Invalid email or password.';
  if (normalized.includes('email not found')) return 'No account was found for this email.';
  if (normalized.includes('invalid email')) return 'Enter a valid email address.';
  if (normalized.includes('weak password')) return 'Use a stronger password with at least 6 characters.';
  if (normalized.includes('too many attempts') || normalized.includes('quota exceeded')) {
    return 'Too many attempts. Please wait a little and try again.';
  }
  if (normalized.includes('user disabled')) return 'This account has been disabled.';
  if (normalized.includes('operation not allowed')) {
    return 'Email and password login is not enabled for this app.';
  }
  if (normalized.includes('expired oob code') || normalized.includes('invalid oob code')) {
    return 'That link is no longer valid. Request a new one and try again.';
  }
  if (normalized.includes('token expired') || normalized.includes('invalid id token')) {
    return 'Your session expired. Please login again.';
  }
  if (normalized.includes('api key')) return 'Firebase configuration is invalid. Check the app configuration and try again.';
  if (normalized.includes('client secret') || normalized.includes('client authentication')) {
    return 'Google rejected the token exchange. Add googleClientSecret to firebase.config.json for this Web OAuth client, or switch to a Desktop OAuth client.';
  }
  if (normalized.includes('cloud firestore api has not been used') || normalized.includes('firestore.googleapis.com')) {
    return 'Cloud Firestore is not enabled for this Firebase project. Open Firebase Console > Firestore Database, create a database, then retry after a few minutes.';
  }
  if (normalized.includes('permission denied') || normalized.includes('missing or insufficient permissions')) {
    return 'Firestore permissions are blocking cloud data. Deploy the included firestore.rules to this Firebase project, then try again.';
  }
  return message ? 'Firebase request failed. Please try again.' : 'Firebase request failed.';
}

function errorDetails(error) {
  const firstArrayError = Array.isArray(error?.body)
    ? error.body.find((item) => item?.error)?.error
    : null;

  return [
    error?.message,
    firstArrayError?.message,
    firstArrayError?.status,
    error?.body?.error_description,
    error?.body?.error?.message,
    error?.body?.error?.status,
    error?.body?.error,
    error?.body?.raw
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function isRecoverableCloudDataError(error) {
  const details = errorDetails(error);

  return (
    error?.status === 403 ||
    details.includes('missing or insufficient permissions') ||
    details.includes('permission denied') ||
    details.includes('cloud firestore api has not been used') ||
    details.includes('firestore.googleapis.com')
  );
}

function shouldClearStoredAuth(error) {
  const details = errorDetails(error);

  return (
    error?.status === 401 ||
    details.includes('login is required') ||
    details.includes('session expired') ||
    details.includes('token expired') ||
    details.includes('invalid id token') ||
    details.includes('invalid refresh token') ||
    details.includes('invalid grant') ||
    details.includes('user disabled') ||
    details.includes('user not found')
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(firebaseErrorMessage(body));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function firebaseAuthRequest(action, payload) {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  return fetchJson(`${FIREBASE_AUTH_URL}/${action}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function tryFirebaseHostingConfig(projectId) {
  if (!projectId) return null;
  const candidates = [
    `https://${projectId}.firebaseapp.com/__/firebase/init.json`,
    `https://${projectId}.web.app/__/firebase/init.json`
  ];
  for (const url of candidates) {
    try {
      const config = await fetchJson(url);
      if (config?.apiKey && config?.projectId) return config;
    } catch {
      // Hosting init config is optional and only works when Firebase Hosting is configured.
    }
  }
  return null;
}

function parseFirebaseConfigJson(parsed) {
  if (parsed?.apiKey && (parsed.projectId || parsed.project_id)) {
    return {
      apiKey: parsed.apiKey,
      authDomain: parsed.authDomain || '',
      projectId: parsed.projectId || parsed.project_id,
      googleClientId: parsed.googleClientId || parsed.googleOAuthClientId || '',
      googleClientSecret: parsed.googleClientSecret || parsed.googleOAuthClientSecret || '',
      googleRedirectUri: parsed.googleRedirectUri || ''
    };
  }

  if (parsed?.project_id && parsed?.client_email && parsed?.private_key) {
    return {
      adminProjectId: parsed.project_id
    };
  }

  return null;
}

function normalizeAuthSession(payload, displayName = '') {
  const expiresIn = Number(payload.expiresIn || 3600);
  return {
    uid: payload.localId || payload.user_id,
    email: payload.email || '',
    displayName,
    idToken: payload.idToken,
    refreshToken: payload.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60000,
    emailVerified: Boolean(payload.emailVerified),
    provider: payload.providerId || payload.providerUserInfo?.[0]?.providerId || ''
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

async function requestGoogleTokens(config) {
  if (!config.googleClientId) {
    throw new Error('Google login needs googleClientId in firebase.config.json.');
  }

  const state = base64Url(crypto.randomBytes(18));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  let settled = false;

  const redirectUri = config.googleRedirectUri || 'http://127.0.0.1:42813/oauth/google';
  const redirectUrl = new URL(redirectUri);
  if (redirectUrl.hostname !== '127.0.0.1' && redirectUrl.hostname !== 'localhost') {
    throw new Error('Google redirect URI must use localhost or 127.0.0.1 for desktop login.');
  }
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(redirectUrl.port || 80), redirectUrl.hostname, () => resolve());
  });

  const code = await new Promise((resolve, reject) => {
    let timeout = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(value);
    };

    server.on('request', (request, response) => {
      const url = new URL(request.url || '/', redirectUri);
      if (url.pathname !== '/oauth/google') {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<h1>Google login failed</h1><p>Invalid OAuth state.</p>');
        finish(new Error('Google login state did not match.'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<h1>Google login cancelled</h1><p>You can close this window.</p>');
        finish(new Error(`Google login failed: ${error}`));
        return;
      }

      const authCode = url.searchParams.get('code');
      if (!authCode) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('<h1>Google login failed</h1><p>No authorization code was returned.</p>');
        finish(new Error('Google login did not return an authorization code.'));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<h1>Google login complete</h1><p>You can close this browser tab and return to DeployerX.</p>');
      finish(null, authCode);
    });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', config.googleClientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'select_account');

    timeout = setTimeout(() => finish(new Error('Google login timed out. Please try again.')), 180000);
    shell.openExternal(authUrl.toString()).catch(finish);
  });

  const tokenBody = new URLSearchParams({
    code,
    client_id: config.googleClientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  if (config.googleClientSecret) {
    tokenBody.set('client_secret', config.googleClientSecret);
  }

  return fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString()
  });
}

async function signInWithGoogle() {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  const googleTokens = await requestGoogleTokens(config);
  const credential =
    googleTokens.id_token
      ? `id_token=${encodeURIComponent(googleTokens.id_token)}&providerId=google.com`
      : `access_token=${encodeURIComponent(googleTokens.access_token)}&providerId=google.com`;

  const firebaseAuth = await firebaseAuthRequest('accounts:signInWithIdp', {
    postBody: credential,
    requestUri: 'http://localhost',
    returnIdpCredential: true,
    returnSecureToken: true
  });

  return normalizeAuthSession(firebaseAuth, firebaseAuth.displayName || '');
}

async function lookupAuthUser(auth) {
  if (!auth?.idToken) return auth;
  const lookup = await firebaseAuthRequest('accounts:lookup', { idToken: auth.idToken });
  const user = lookup?.users?.[0] || {};
  const provider = user.providerUserInfo?.[0]?.providerId || auth.provider || '';
  return {
    ...auth,
    email: user.email || auth.email || '',
    displayName: user.displayName || auth.displayName || '',
    emailVerified: Boolean(user.emailVerified),
    provider
  };
}

function needsEmailVerification(auth) {
  return Boolean(auth?.email && auth.provider !== 'google.com' && !auth.emailVerified);
}

async function refreshAuthSession(settings, options = {}) {
  const { forceLookup = false } = options;
  if (!settings.auth?.refreshToken) throw new Error('Login is required.');
  if (settings.auth.idToken && settings.auth.expiresAt > Date.now()) {
    if (!forceLookup) return settings.auth;
    const checkedAuth = await lookupAuthUser(settings.auth);
    if (authSessionChanged(settings.auth, checkedAuth)) {
      await writeSettings({ ...settings, auth: checkedAuth });
    }
    return checkedAuth;
  }

  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: settings.auth.refreshToken
  });
  const refreshed = await fetchJson(`${FIREBASE_TOKEN_URL}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const auth = normalizeAuthSession(
    {
      ...refreshed,
      localId: refreshed.user_id,
      idToken: refreshed.id_token,
      refreshToken: refreshed.refresh_token,
      expiresIn: refreshed.expires_in,
      email: settings.auth.email,
      emailVerified: settings.auth.emailVerified,
      provider: settings.auth.provider
    },
    settings.auth.displayName || ''
  );
  const nextAuth = forceLookup ? await lookupAuthUser(auth) : auth;
  if (authSessionChanged(settings.auth, nextAuth)) {
    await writeSettings({ ...settings, auth: nextAuth });
  }
  return nextAuth;
}

async function requireAuthSession() {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') throw new Error('Cloud mode is not enabled.');
  const auth = await refreshAuthSession(settings);
  if (!auth?.idToken || !auth.uid) throw new Error('Login is required.');
  return auth;
}

async function firestoreBaseUrl() {
  const config = await loadFirebaseConfig();
  requireFirebaseConfig(config);
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents`;
}

function encodePath(segments) {
  return segments.map((segment) => encodeURIComponent(String(segment))).join('/');
}

function displayFirestorePath(segments) {
  return segments.map((segment) => String(segment)).join('/');
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.entries(value).reduce((fields, [key, childValue]) => {
          fields[key] = toFirestoreValue(childValue);
          return fields;
        }, {})
      }
    };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (!value || Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, 'timestampValue')) return value.timestampValue;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(fromFirestoreValue);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) {
    return Object.entries(value.mapValue.fields || {}).reduce((object, [key, childValue]) => {
      object[key] = fromFirestoreValue(childValue);
      return object;
    }, {});
  }
  return null;
}

function toFirestoreDocument(data) {
  return {
    fields: Object.entries(data || {}).reduce((fields, [key, value]) => {
      if (String(key).startsWith('__')) return fields;
      fields[key] = toFirestoreValue(value);
      return fields;
    }, {})
  };
}

function fromFirestoreDocument(document) {
  const data = Object.entries(document?.fields || {}).reduce((object, [key, value]) => {
    object[key] = fromFirestoreValue(value);
    return object;
  }, {});
  const id = String(document?.name || '').split('/').pop();
  return {
    ...data,
    id: data.id || id,
    __path: document?.name || ''
  };
}

async function firestoreFetch(segments, options = {}) {
  const auth = await requireAuthSession();
  const baseUrl = await firestoreBaseUrl();
  const url = `${baseUrl}/${encodePath(segments)}`;
  try {
    return await fetchJson(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    error.firestorePath = displayFirestorePath(segments);
    error.firestoreMethod = options.method || 'GET';
    if (error.status === 403 && !String(error.message || '').includes(error.firestorePath)) {
      error.message = `${error.message} Blocked ${error.firestoreMethod} ${error.firestorePath}.`;
    }
    throw error;
  }
}

async function getDoc(segments) {
  try {
    return fromFirestoreDocument(await firestoreFetch(segments));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function patchDoc(segments, data) {
  return fromFirestoreDocument(
    await firestoreFetch(segments, {
      method: 'PATCH',
      body: JSON.stringify(toFirestoreDocument(data))
    })
  );
}

async function deleteDoc(segments) {
  try {
    await firestoreFetch(segments, { method: 'DELETE' });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function listCollection(segments) {
  try {
    const body = await firestoreFetch(segments);
    return (body.documents || []).map(fromFirestoreDocument);
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

function firestoreDocumentId(document) {
  return String(document?.__path || '').split('/').pop() || document?.id;
}

async function deleteCollectionDocuments(segments) {
  const documents = await listCollection(segments);
  for (const document of documents) {
    await deleteDoc([...segments, firestoreDocumentId(document)]);
  }
}

function inviteInboxPath(email, inviteId = '') {
  const segments = ['inviteInboxes', emailKey(email), 'items'];
  return inviteId ? [...segments, inviteId] : segments;
}

function normalizeInviteInboxDocument(invite = {}) {
  const email = emailKey(invite.emailLower || invite.email);
  return {
    id: String(invite.id || ''),
    teamId: String(invite.teamId || ''),
    teamName: String(invite.teamName || 'Team'),
    email,
    emailLower: email,
    role: 'member',
    status: invite.status || 'pending',
    createdAt: invite.createdAt || nowIso(),
    updatedAt: invite.updatedAt || nowIso()
  };
}

async function syncInviteInboxDocument(invite = {}) {
  const inboxInvite = normalizeInviteInboxDocument(invite);
  if (!inboxInvite.id || !inboxInvite.emailLower || !inboxInvite.teamId) return;
  await patchDoc(inviteInboxPath(inboxInvite.emailLower, inboxInvite.id), inboxInvite);
}

async function deleteInviteInboxDocument(invite = {}) {
  const email = emailKey(invite.emailLower || invite.email);
  const inviteId = String(invite.id || '');
  if (!email || !inviteId) return;
  await deleteDoc(inviteInboxPath(email, inviteId));
}

async function deleteTeamMemberDocuments(teamId, ownerUid) {
  const members = await listCollection(['teams', teamId, 'members']);
  members.sort((left, right) => {
    const leftIsOwner = firestoreDocumentId(left) === ownerUid;
    const rightIsOwner = firestoreDocumentId(right) === ownerUid;
    return Number(leftIsOwner) - Number(rightIsOwner);
  });
  for (const member of members) {
    await deleteDoc(['teams', teamId, 'members', firestoreDocumentId(member)]);
  }
}

async function runFirestoreQuery(structuredQuery) {
  const auth = await requireAuthSession();
  const baseUrl = await firestoreBaseUrl();
  const body = await fetchJson(`${baseUrl}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ structuredQuery })
  });
  return body.filter((row) => row.document).map((row) => fromFirestoreDocument(row.document));
}

function deriveWorkspaceKey(team = {}) {
  const seed = String(team.secretSeed || team.secretSalt || team.id || '');
  if (!seed) throw new Error('This workspace cannot encrypt cloud secrets.');
  return crypto
    .createHash('sha256')
    .update(`deployerx-workspace-key-v2:${team.id || ''}:${seed}`)
    .digest();
}

function encryptWithKey(value, key) {
  if (!String(value || '')) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  };
}

function decryptWithKey(payload, key) {
  if (!payload?.data || !payload?.iv || !payload?.tag) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
}

function encryptJsonWithKey(value, key) {
  return encryptWithKey(JSON.stringify(value || {}), key);
}

function decryptJsonWithKey(payload, key) {
  const raw = decryptWithKey(payload, key);
  return raw ? JSON.parse(raw) : {};
}

async function ensureActiveTeamUnlocked() {
  const settings = await readSettings();
  if (settings.mode !== 'cloud') return null;
  if (!settings.activeTeamId) throw new Error('Select or create a workspace before syncing data.');
  if (cloudUnlock.teamId === settings.activeTeamId && cloudUnlock.key) return settings.activeTeamId;
  const auth = await requireAuthSession();
  const [team, member] = await Promise.all([
    getDoc(['teams', settings.activeTeamId]),
    getDoc(['teams', settings.activeTeamId, 'members', auth.uid])
  ]);
  if (!team || !member) throw new Error('You do not have access to this workspace.');
  cloudUnlock = { teamId: settings.activeTeamId, key: deriveWorkspaceKey(team) };
  return settings.activeTeamId;
}

async function readUserProfile(uid) {
  return (await getDoc(['users', uid])) || null;
}

async function writeUserProfile(auth, patch = {}) {
  const existing = (await readUserProfile(auth.uid)) || {};
  const profile = {
    ...existing,
    ...patch,
    uid: auth.uid,
    email: auth.email || existing.email || '',
    emailLower: emailKey(auth.email || existing.email),
    displayName: auth.displayName || existing.displayName || '',
    teams: Array.isArray(patch.teams) ? patch.teams : Array.isArray(existing.teams) ? existing.teams : [],
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await patchDoc(['users', auth.uid], profile);
  return profile;
}

async function updateUserTeamRef(uid, teamRef) {
  const user = (await readUserProfile(uid)) || { uid, teams: [] };
  const teams = Array.isArray(user.teams) ? [...user.teams] : [];
  const index = teams.findIndex((item) => item.teamId === teamRef.teamId);
  if (index >= 0) teams[index] = { ...teams[index], ...teamRef };
  else teams.push(teamRef);
  await patchDoc(['users', uid], {
    ...user,
    teams,
    updatedAt: nowIso()
  });
}

async function removeUserTeamRef(uid, teamId) {
  const user = await readUserProfile(uid);
  if (!user) return;
  await patchDoc(['users', uid], {
    ...user,
    teams: (Array.isArray(user.teams) ? user.teams : []).filter((item) => item.teamId !== teamId),
    updatedAt: nowIso()
  });
}

async function currentMember(teamId) {
  const auth = await requireAuthSession();
  return getDoc(['teams', teamId, 'members', auth.uid]);
}

async function ensureTeamManager(teamId) {
  const member = await currentMember(teamId);
  if (member?.role !== 'owner') throw new Error('Only the workspace owner can manage members.');
  return member;
}

function prepareCloudProjectForSave(project) {
  const copy = JSON.parse(JSON.stringify(project || {}));
  return {
    id: String(copy.id || ''),
    updatedAt: copy.updatedAt || nowIso(),
    encryptedPayload: encryptJsonWithKey(copy, cloudUnlock.key),
    secretStorage: 'workspace-auth-v2'
  };
}

function prepareCloudProjectForRead(project) {
  if (project?.encryptedPayload && cloudUnlock.key) {
    try {
      return normalizeProjectImport(decryptJsonWithKey(project.encryptedPayload, cloudUnlock.key));
    } catch {
      return normalizeProjectImport({ id: project.id, name: 'Encrypted project', commands: [] });
    }
  }

  const copy = JSON.parse(JSON.stringify(project || {}));
  const ssh = { ...(copy.ssh || {}) };
  if (copy.encryptedSsh && cloudUnlock.key) {
    for (const field of ['password', 'privateKey', 'passphrase']) {
      try {
        ssh[field] = decryptWithKey(copy.encryptedSsh[field], cloudUnlock.key);
      } catch {
        ssh[field] = '';
      }
    }
  }
  delete copy.encryptedSsh;
  delete copy.secretStorage;
  return {
    ...copy,
    ssh
  };
}

function prepareCloudTemplateForSave(template) {
  const normalized = normalizeStoredTemplate(template);
  return {
    id: String(normalized.id || ''),
    updatedAt: normalized.updatedAt || nowIso(),
    encryptedPayload: encryptJsonWithKey(normalized, cloudUnlock.key),
    secretStorage: 'workspace-auth-v2'
  };
}

function prepareCloudTemplateForRead(template) {
  if (template?.encryptedPayload && cloudUnlock.key) {
    try {
      return normalizeStoredTemplate(decryptJsonWithKey(template.encryptedPayload, cloudUnlock.key));
    } catch {
      return normalizeStoredTemplate({ id: template.id, name: 'Encrypted template', commands: [] });
    }
  }
  return normalizeStoredTemplate(template);
}

async function readCloudStore() {
  const teamId = await ensureActiveTeamUnlocked();
  const [projects, templates] = await Promise.all([
    listCollection(['teams', teamId, 'projects']),
    listCollection(['teams', teamId, 'templates'])
  ]);
  return {
    projects: projects.map(prepareCloudProjectForRead),
    templates: templates.map(prepareCloudTemplateForRead)
  };
}

async function writeCloudStore(data) {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const templates = stripBuiltInTemplates(Array.isArray(data.templates) ? data.templates : []);
  const existingProjects = await listCollection(['teams', teamId, 'projects']);
  const existingTemplates = await listCollection(['teams', teamId, 'templates']);
  const nextProjectIds = new Set(projects.map((project) => String(project.id)));
  const nextTemplateIds = new Set(templates.map((template) => String(template.id)));

  for (const project of existingProjects) {
    if (!nextProjectIds.has(String(project.id))) {
      await deleteDoc(['teams', teamId, 'projects', project.id]);
    }
  }
  for (const template of existingTemplates) {
    if (!nextTemplateIds.has(String(template.id))) {
      await deleteDoc(['teams', teamId, 'templates', template.id]);
    }
  }

  for (const project of projects) {
    await patchDoc(['teams', teamId, 'projects', project.id], prepareCloudProjectForSave(project));
  }
  for (const template of templates) {
    await patchDoc(['teams', teamId, 'templates', template.id], prepareCloudTemplateForSave(template));
  }
}

async function mergeLocalStoreIntoCloud(localData) {
  const teamId = await ensureActiveTeamUnlocked();
  const projects = Array.isArray(localData.projects) ? localData.projects : [];
  const templates = Array.isArray(localData.templates) ? localData.templates : [];

  for (const project of projects) {
    await patchDoc(['teams', teamId, 'projects', project.id], prepareCloudProjectForSave(project));
  }
  for (const template of templates) {
    await patchDoc(['teams', teamId, 'templates', template.id], prepareCloudTemplateForSave(template));
  }
}

async function readCurrentStore() {
  const settings = await readSettings();
  return settings.mode === 'cloud' ? readCloudStore() : readStore();
}

async function writeCurrentStore(data) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') return writeCloudStore(data);
  return writeStore(data);
}

async function deleteProjectFromCurrentStore(id) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await deleteDoc(['teams', teamId, 'projects', id]);
    await deleteProjectLocalSettings(id);
    return;
  }
  const data = await readStore();
  data.projects = data.projects.filter((project) => project.id !== id);
  await writeStore(data);
  await deleteProjectLocalSettings(id);
}

async function deleteTemplateFromCurrentStore(id) {
  const settings = await readSettings();
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await deleteDoc(['teams', teamId, 'templates', id]);
    return;
  }
  const data = await readStore();
  data.templates = data.templates.filter((template) => template.id !== id);
  await writeStore(data);
}

async function queryPendingInvites(email) {
  const emailLower = emailKey(email);
  if (!emailLower) return [];
  let invites = [];
  try {
    invites = await listCollection(inviteInboxPath(emailLower));
  } catch {
    invites = [];
  }

  try {
    const collectionGroupInvites = await runFirestoreQuery({
      from: [{ collectionId: 'invites', allDescendants: true }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'emailLower' },
          op: 'EQUAL',
          value: { stringValue: emailLower }
        }
      }
    });
    invites.push(...collectionGroupInvites);
  } catch {
    // Older Firestore rules or missing collection-group permissions can block this path.
  }

  const seen = new Set();
  return invites
    .filter((invite) => invite.status === 'pending')
    .map((invite) => {
      const parts = String(invite.__path || '').split('/');
      const teamIndex = parts.indexOf('teams');
      return {
        ...invite,
        teamId: teamIndex >= 0 ? parts[teamIndex + 1] : invite.teamId
      };
    })
    .filter((invite) => {
      const key = `${invite.teamId || ''}:${invite.id || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function teamSnapshot(options = {}) {
  const auth = options.auth || (await requireAuthSession());
  const settings = options.settings || (await readSettings());
  const profile = options.profile || (await readUserProfile(auth.uid)) || (await writeUserProfile(auth));
  const teamRefs = Array.isArray(profile.teams) ? profile.teams : [];
  const teams = (
    await Promise.all(
      teamRefs.map(async (teamRef) => {
        const [team, member] = await Promise.all([
          getDoc(['teams', teamRef.teamId]),
          getDoc(['teams', teamRef.teamId, 'members', auth.uid])
        ]);
        if (!team || !member) return null;
        return {
          id: team.id,
          name: team.name || teamRef.name || 'Team',
          role: member.role === 'owner' ? 'owner' : 'member',
          createdAt: team.createdAt || ''
        };
      })
    )
  ).filter(Boolean);

  let activeTeamId = settings.activeTeamId;
  if (activeTeamId && !teams.some((team) => team.id === activeTeamId)) activeTeamId = '';
  if (!activeTeamId && teams.length) activeTeamId = teams[0].id;
  if (activeTeamId !== settings.activeTeamId) {
    await writeSettings({ ...settings, activeTeamId });
  }

  const activeTeam = teams.find((team) => team.id === activeTeamId) || null;
  const canManageTeam = activeTeam?.role === 'owner';
  const [activeTeamDoc, members, teamInvites] = await Promise.all([
    activeTeamId ? getDoc(['teams', activeTeamId]) : Promise.resolve(null),
    activeTeamId
      ? listCollection(['teams', activeTeamId, 'members']).then((items) =>
          items.map((member) => ({
            ...member,
            role: member.role === 'owner' ? 'owner' : 'member'
          }))
        )
      : Promise.resolve([]),
    activeTeamId && canManageTeam ? listCollection(['teams', activeTeamId, 'invites']) : Promise.resolve([])
  ]);
  if (activeTeamId && activeTeamDoc) {
    cloudUnlock = { teamId: activeTeamId, key: deriveWorkspaceKey(activeTeamDoc) };
  } else {
    cloudUnlock = { teamId: '', key: null };
  }
  const memberEmails = new Set(members.map((member) => emailKey(member.emailLower || member.email)));
  const pendingTeamInvites = teamInvites.filter((invite) =>
    invite.status === 'pending' && !memberEmails.has(emailKey(invite.emailLower || invite.email))
  );
  if (pendingTeamInvites.length) {
    await Promise.allSettled(pendingTeamInvites.map(syncInviteInboxDocument));
  }
  const joinedTeamIds = new Set(teams.map((team) => String(team.id || '')));
  const invites = (await queryPendingInvites(auth.email)).filter((invite) => !joinedTeamIds.has(String(invite.teamId || '')));

  return {
    teams,
    activeTeamId,
    activeTeam,
    members,
    teamInvites: pendingTeamInvites,
    invites,
    unlocked: Boolean(activeTeamId && activeTeamDoc)
  };
}

function emptyTeamSnapshot(cloudError = '') {
  return {
    teams: [],
    activeTeamId: '',
    activeTeam: null,
    members: [],
    teamInvites: [],
    invites: [],
    unlocked: false,
    cloudError
  };
}

async function safeTeamSnapshot(options = {}) {
  try {
    return await teamSnapshot(options);
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
    return emptyTeamSnapshot(error.message || 'Cloud data is blocked by Firebase setup.');
  }
}

async function finishCloudAuth(auth, profilePatch = {}) {
  auth = await lookupAuthUser(auth);
  const settings = await writeSettings({ ...(await readSettings()), setupComplete: true, mode: 'cloud', auth });
  if (needsEmailVerification(auth)) {
    return { session: publicSession(auth), requiresEmailVerification: true };
  }
  try {
    const profile = await writeUserProfile(auth, profilePatch);
    return { session: publicSession(auth), teams: await teamSnapshot({ auth, settings, profile }) };
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
    return { session: publicSession(auth), teams: emptyTeamSnapshot(error.message), cloudError: error.message };
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: 'DeployerX',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    sendUpdateStateToRenderer();
  });
}

function toConnectionConfig(project) {
  const ssh = project.ssh || {};
  const config = {
    host: ssh.host,
    port: Number(ssh.port || 22),
    username: ssh.username,
    readyTimeout: Number(ssh.timeout || 20000)
  };

  if (ssh.authType === 'key') {
    config.privateKey = ssh.privateKey;
    if (ssh.passphrase) config.passphrase = ssh.passphrase;
  } else {
    config.password = ssh.password;
  }

  return config;
}

function toFtpConnectionConfig(project) {
  const ssh = project.ssh || {};
  const ftp = project.ftp || {};
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
    readyTimeout: Number(ssh.timeout || 20000)
  };

  if (authType === 'key') {
    config.privateKey = ftp.privateKey || ssh.privateKey;
    if (ftp.passphrase || ssh.passphrase) config.passphrase = ftp.passphrase || ssh.passphrase;
  } else {
    config.password = ftp.password || ssh.password;
  }

  return config;
}

function validateProject(project) {
  const connectionError = validateConnectionProject(project);
  if (connectionError) return connectionError;
  if (!Array.isArray(project.commands) || project.commands.length === 0) {
    return 'At least one command is required.';
  }
  return null;
}

function validateConnectionProject(project) {
  const ssh = project.ssh || {};
  if (!project.name) return 'Project name is required.';
  if (!ssh.host) return 'Server host is required.';
  if (!ssh.username) return 'SSH username is required.';
  if (ssh.authType === 'key' && !ssh.privateKey) return 'SSH private key is required.';
  if (ssh.authType !== 'key' && !ssh.password) return 'SSH password is required.';
  return null;
}

function extractTemplateVariables(commands = []) {
  const variables = new Set();
  for (const command of commands) {
    const matches = String(command).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g);
    for (const match of matches) variables.add(match[1]);
  }
  return [...variables];
}

function normalizeProjectImport(project) {
  const commands = Array.isArray(project?.commands)
    ? project.commands.map((command) => String(command)).filter((command) => command.trim())
    : typeof project?.commands === 'string'
      ? project.commands
          .split('\n')
          .map((command) => command.trim())
          .filter(Boolean)
      : [];
  const ssh = project?.ssh || {};
  const ftp = project?.ftp || {};

  return {
    ...project,
    id: project?.id ? String(project.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(project?.name || 'Imported project').trim() || 'Imported project',
    serverType: project?.serverType || 'ubuntu',
    commands,
    variables: project?.variables && typeof project.variables === 'object' ? project.variables : {},
    ssh: {
      host: ssh.host || '',
      port: Number(ssh.port || 22),
      username: ssh.username || '',
      authType: ssh.authType || 'password',
      password: ssh.password || '',
      privateKey: ssh.privateKey || '',
      passphrase: ssh.passphrase || '',
      timeout: Number(ssh.timeout || 20000)
    },
    ftp: {
      host: ftp.host || '',
      port: ftp.port === '' || ftp.port == null ? '' : Number(ftp.port || 22),
      username: ftp.username || '',
      authType: ftp.authType || '',
      password: ftp.password || '',
      privateKey: ftp.privateKey || '',
      passphrase: ftp.passphrase || ''
    },
    updatedAt: new Date().toISOString()
  };
}

function readProjectImportFile(raw) {
  const parsed = JSON.parse(raw);
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) throw new Error('Import file must contain projects.');
  return projects.map(normalizeProjectImport).filter((project) => project.name);
}

function normalizeTemplateImport(template) {
  const commands = Array.isArray(template?.commands)
    ? template.commands.map((command) => String(command)).filter((command) => command.trim())
    : typeof template?.commands === 'string'
      ? template.commands
          .split('\n')
          .map((command) => command.trim())
          .filter(Boolean)
    : [];
  const variables =
    Array.isArray(template?.variables) && template.variables.length
      ? template.variables.map((variable) => String(variable))
      : extractTemplateVariables(commands);

  return {
    ...template,
    id: template?.id ? String(template.id) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: String(template?.name || 'Imported template').trim() || 'Imported template',
    category: normalizeTemplateCategory(template?.category),
    commands,
    variables,
    updatedAt: new Date().toISOString()
  };
}

function readTemplateImportFile(raw) {
  const parsed = JSON.parse(raw);
  const templates = Array.isArray(parsed) ? parsed : parsed.templates;
  if (!Array.isArray(templates)) throw new Error('Import file must contain templates.');
  return templates.map(normalizeTemplateImport).filter((template) => template.commands.length).map(normalizeStoredTemplate);
}

function readAccountImportFile(raw) {
  const parsed = JSON.parse(raw);
  const projects = Array.isArray(parsed?.projects) ? parsed.projects.map(normalizeProjectImport) : [];
  const templates = Array.isArray(parsed?.templates) ? parsed.templates.map(normalizeTemplateImport) : [];

  if (!projects.length && !templates.length) {
    throw new Error('Import file must contain projects or templates.');
  }

  return {
    projects: projects.filter((project) => project.name),
    templates: templates.filter((template) => template.commands.length).map(normalizeStoredTemplate)
  };
}

function importNameKey(item) {
  return String(item?.name || '').trim().toLowerCase();
}

function duplicateNames(existingItems, importedItems) {
  const existingNames = new Set(existingItems.map(importNameKey).filter(Boolean));
  const importedNameCounts = new Map();
  for (const item of importedItems) {
    const key = importNameKey(item);
    if (key) importedNameCounts.set(key, (importedNameCounts.get(key) || 0) + 1);
  }

  const names = importedItems
    .filter((item) => {
      const key = importNameKey(item);
      return key && (existingNames.has(key) || importedNameCounts.get(key) > 1);
    })
    .map((item) => String(item.name || '').trim())
    .filter(Boolean);

  return [...new Set(names)];
}

async function shouldReplaceDuplicateNames(itemLabel, names) {
  if (!names.length) return false;

  const preview = names.slice(0, 8).map((name) => `- ${name}`).join('\n');
  const overflow = names.length > 8 ? `\n- and ${names.length - 8} more` : '';
  return requestInAppConfirmation({
    message: `${names.length} duplicate ${itemLabel} name${names.length === 1 ? '' : 's'} found`,
    detail: `Replace will overwrite the duplicate ${itemLabel}${names.length === 1 ? '' : 's'}. Cancel will skip only these duplicates and import the rest.\n\n${preview}${overflow}`,
    confirmLabel: 'Replace'
  });
}

async function mergeImportsByName(existingItems, importedItems, itemLabel, normalizeItem = (item) => item) {
  const items = [...existingItems];
  const duplicates = duplicateNames(items, importedItems);
  const replaceDuplicates = await shouldReplaceDuplicateNames(itemLabel, duplicates);
  const stats = { added: 0, replaced: 0, skipped: 0, duplicates: duplicates.length };

  for (const importedItem of importedItems) {
    const item = normalizeItem(importedItem);
    const name = importNameKey(item);
    const nameIndex = items.findIndex((existingItem) => importNameKey(existingItem) === name);

    if (nameIndex >= 0) {
      if (!replaceDuplicates) {
        stats.skipped += 1;
        continue;
      }
      items[nameIndex] = item;
      stats.replaced += 1;
      continue;
    }

    const idIndex = item.id ? items.findIndex((existingItem) => String(existingItem.id) === String(item.id)) : -1;
    if (idIndex >= 0) {
      items[idIndex] = item;
      stats.replaced += 1;
    } else {
      items.unshift(item);
      stats.added += 1;
    }
  }

  return { items, stats };
}

function emitDeployment(runId, type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deployment:event', { runId, type, payload });
  }
}

function emitTerminal(sessionId, type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal:event', { sessionId, type, payload });
  }
}

function runCommand(connection, command, runId, deploymentState) {
  return new Promise((resolve, reject) => {
    emitDeployment(runId, 'log', `$ ${command}\n`);
    connection.exec(command, { pty: true }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      deploymentState.currentStream = stream;
      stream.on('close', (code) => {
        deploymentState.currentStream = null;
        if (deploymentState.stopped) {
          reject(new Error('Deployment stopped.'));
          return;
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command exited with code ${code}: ${command}`));
        }
      });

      stream.on('data', (data) => emitDeployment(runId, 'log', data.toString()));
      stream.stderr.on('data', (data) => emitDeployment(runId, 'error', data.toString()));
    });
  });
}

function uploadFile(connection, upload, runId) {
  return new Promise((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }

      emitDeployment(runId, 'log', `Uploading ${upload.localPath} to ${upload.remotePath}\n`);
      sftp.fastPut(upload.localPath, upload.remotePath, (uploadError) => {
        if (uploadError) {
          reject(uploadError);
          return;
        }

        emitDeployment(runId, 'log', `Upload completed: ${upload.remotePath}\n`);
        resolve();
      });
    });
  });
}

async function executeDeployment(project, upload, runId) {
  const validationError = validateProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const deploymentState = { connection, currentStream: null, stopped: false };
  activeDeployments.set(runId, deploymentState);

  return new Promise((resolve, reject) => {
    connection.on('ready', async () => {
      emitDeployment(runId, 'log', 'SSH connected.\n');
      try {
        if (upload && upload.localPath && upload.remotePath) {
          await uploadFile(connection, upload, runId);
        }

        for (const command of project.commands) {
          if (deploymentState.stopped) throw new Error('Deployment stopped.');
          if (command.trim()) await runCommand(connection, command.trim(), runId, deploymentState);
        }

        emitDeployment(runId, 'done', 'Deployment completed.');
        activeDeployments.delete(runId);
        connection.end();
        resolve();
      } catch (error) {
        emitDeployment(runId, 'failed', error.message);
        activeDeployments.delete(runId);
        connection.end();
        reject(error);
      }
    });

    connection.on('error', (error) => {
      emitDeployment(runId, 'failed', error.message);
      activeDeployments.delete(runId);
      reject(error);
    });

    connection.on('close', () => {
      activeDeployments.delete(runId);
    });

    connection.connect(toConnectionConfig(project));
  });
}

function startTerminal(project, sessionId, size = {}) {
  const validationError = validateConnectionProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const terminalState = { connection, stream: null };
  activeTerminals.set(sessionId, terminalState);

  connection.on('ready', () => {
    emitTerminal(sessionId, 'log', 'SSH connected.\r\n');
    const cols = Math.max(Number(size.cols || 120), 80);
    const rows = Math.max(Number(size.rows || 34), 24);
    const width = cols * 9;
    const height = rows * 18;
    connection.shell(
      {
        term: 'xterm-256color',
        cols,
        rows,
        width,
        height
      },
      (error, stream) => {
        if (error) {
          emitTerminal(sessionId, 'failed', error.message);
          activeTerminals.delete(sessionId);
          connection.end();
          return;
        }

        terminalState.stream = stream;
        stream.write(`stty sane cols ${cols} rows ${rows}\n`);
        emitTerminal(sessionId, 'connected', 'Terminal connected.');

        stream.on('data', (data) => emitTerminal(sessionId, 'log', data.toString()));
        if (stream.stderr) {
          stream.stderr.on('data', (data) => emitTerminal(sessionId, 'error', data.toString()));
        }
        stream.on('close', () => {
          emitTerminal(sessionId, 'closed', 'Terminal closed.');
          activeTerminals.delete(sessionId);
          connection.end();
        });
      }
    );
  });

  connection.on('error', (error) => {
    emitTerminal(sessionId, 'failed', error.message);
    activeTerminals.delete(sessionId);
  });

  connection.on('close', () => {
    if (activeTerminals.has(sessionId)) {
      emitTerminal(sessionId, 'closed', 'Terminal closed.');
      activeTerminals.delete(sessionId);
    }
  });

  connection.connect(toConnectionConfig(project));
}

function resizeTerminal(sessionId, cols, rows) {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal || !terminal.stream || !terminal.stream.setWindow) return false;
  const nextRows = Math.max(Number(rows || 34), 24);
  const nextCols = Math.max(Number(cols || 120), 80);
  terminal.stream.setWindow(nextRows, nextCols, nextRows * 18, nextCols * 9);
  return true;
}

function terminalSessionOrThrow(sessionId) {
  const terminal = activeTerminals.get(sessionId);
  if (!terminal?.connection) throw new Error('SSH session is not connected.');
  return terminal;
}

function execOnTerminalConnection(connection, command) {
  return new Promise((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => {
        stdout += data.toString();
      });
      if (stream.stderr) {
        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }
      stream.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}.`));
      });
    });
  });
}

function normalizeRemotePath(remotePath = '.') {
  const value = String(remotePath || '.').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  return value || '.';
}

function remoteBaseName(remotePath = '') {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return '';
  return normalized.split('/').filter(Boolean).pop() || '';
}

function joinRemotePath(parentPath, childName) {
  const parent = normalizeRemotePath(parentPath);
  const child = String(childName || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  if (!child) return parent;
  if (parent === '.') return child;
  if (parent === '/') return `/${child}`;
  return `${parent.replace(/\/$/, '')}/${child}`;
}

function parentRemotePath(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  if (normalized === '/' || normalized === '.') return normalized;
  const absolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  if (!parts.length) return absolute ? '/' : '.';
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function normalizeLocalPath(localPath = '') {
  return path.resolve(String(localPath || app.getPath('home')));
}

function localKind(dirent, filePath) {
  if (dirent.isDirectory()) return 'folder';
  const extension = path.extname(filePath).replace('.', '').toLowerCase();
  return extension || 'file';
}

function assertPlainFileName(fileName, message = 'Enter a name.') {
  const name = String(fileName || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error(message);
  return name;
}

async function listLocalDirectory(localPath = '') {
  const normalizedPath = normalizeLocalPath(localPath);
  const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const itemPath = path.join(normalizedPath, entry.name);
      let stats = null;
      try {
        stats = await fs.stat(itemPath);
      } catch {
        stats = null;
      }

      const isDirectory = entry.isDirectory();
      return {
        name: entry.name,
        path: itemPath,
        type: isDirectory ? 'directory' : 'file',
        size: isDirectory ? 0 : Number(stats?.size || 0),
        modifiedAt: stats?.mtime ? stats.mtime.toISOString() : '',
        mode: localKind(entry, itemPath)
      };
    })
  );

  return {
    path: normalizedPath,
    parentPath: path.dirname(normalizedPath),
    items: items.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
  };
}

async function makeLocalDirectory(localDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const folderPath = path.join(normalizeLocalPath(localDirectory), name);
  await fs.mkdir(folderPath);
  return { path: folderPath };
}

async function openLocalEntry(entry) {
  if (!entry?.path) throw new Error('Choose a local item to open.');
  const result = await shell.openPath(normalizeLocalPath(entry.path));
  if (result) throw new Error(result);
  return true;
}

async function openLocalEntryWith(entry) {
  if (!entry?.path) throw new Error('Choose a local item to open.');
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', normalizeLocalPath(entry.path)], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return true;
  }
  return openLocalEntry(entry);
}

async function renameLocalEntry(entry, nextName) {
  if (!entry?.path) throw new Error('Choose a local item to rename.');
  const name = assertPlainFileName(nextName);
  const currentPath = normalizeLocalPath(entry.path);
  const nextPath = path.join(path.dirname(currentPath), name);
  await fs.rename(currentPath, nextPath);
  return { path: nextPath };
}

async function deleteLocalEntry(entry) {
  if (!entry?.path) throw new Error('Choose a local item to delete.');
  const targetPath = normalizeLocalPath(entry?.path);
  const stats = await fs.stat(targetPath);
  await fs.rm(targetPath, { recursive: stats.isDirectory(), force: false });
  return true;
}

function sftpReaddir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(error);
      else resolve(list || []);
    });
  });
}

function sftpFastPut(sftp, localPath, remotePath, options = {}) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpFastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpMkdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRmdir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpRename(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sftpEnsureMkdir(sftp, remotePath) {
  try {
    await sftpMkdir(sftp, remotePath);
  } catch (error) {
    try {
      await sftpReaddir(sftp, remotePath);
    } catch {
      throw error;
    }
  }
}

async function uploadLocalPath(sftp, localPath, remoteDirectory) {
  const stats = await fs.stat(localPath);
  const remotePath = joinRemotePath(remoteDirectory || '.', path.basename(localPath));

  if (stats.isDirectory()) {
    await sftpEnsureMkdir(sftp, remotePath);
    const entries = await fs.readdir(localPath, { withFileTypes: true });
    for (const entry of entries) {
      await uploadLocalPath(sftp, path.join(localPath, entry.name), remotePath);
    }
    return remotePath;
  }

  await sftpFastPut(sftp, localPath, remotePath);
  return remotePath;
}

async function downloadRemotePath(sftp, remotePath, entryType, localDirectory) {
  const localPath = path.join(normalizeLocalPath(localDirectory), remoteBaseName(remotePath) || 'download');

  if (entryType === 'directory') {
    await fs.mkdir(localPath, { recursive: true });
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const childPath = joinRemotePath(remotePath, entry.filename);
      const childType = entry.attrs?.isDirectory?.() ? 'directory' : 'file';
      await downloadRemotePath(sftp, childPath, childType, localPath);
    }
    return localPath;
  }

  await sftpFastGet(sftp, remotePath, localPath);
  return localPath;
}

async function deleteRemotePath(sftp, remotePath, entryType) {
  if (entryType === 'directory') {
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const childPath = joinRemotePath(remotePath, entry.filename);
      const childType = entry.attrs?.isDirectory?.() ? 'directory' : 'file';
      await deleteRemotePath(sftp, childPath, childType);
    }
    await sftpRmdir(sftp, remotePath);
    return;
  }

  await sftpUnlink(sftp, remotePath);
}

function ftpSessionOrThrow(sessionId) {
  const session = activeFtpSessions.get(sessionId);
  if (!session || !session.sftp) throw new Error('FTP session is not connected.');
  return session;
}

function connectFtp(project, sessionId) {
  const validationError = validateConnectionProject(project);
  if (validationError) throw new Error(validationError);

  const connection = new Client();
  const ftpState = { connection, sftp: null };
  activeFtpSessions.set(sessionId, ftpState);

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      activeFtpSessions.delete(sessionId);
      connection.end();
      reject(error);
    };

    connection.on('ready', () => {
      connection.sftp((error, sftp) => {
        if (error) {
          fail(error);
          return;
        }

        ftpState.sftp = sftp;
        resolve({ sessionId, path: '.' });
      });
    });

    connection.on('error', fail);
    connection.on('close', () => {
      activeFtpSessions.delete(sessionId);
    });
    connection.connect(toFtpConnectionConfig(project));
  });
}

async function listFtpDirectory(sessionId, remotePath = '.') {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const normalizedPath = normalizeRemotePath(remotePath);
  const items = await sftpReaddir(sftp, normalizedPath);
  return {
    path: normalizedPath,
    parentPath: parentRemotePath(normalizedPath),
    items: items
      .map((item) => {
        const attrs = item.attrs || {};
        const isDirectory = Boolean(attrs.isDirectory?.());
        return {
          name: item.filename,
          path: joinRemotePath(normalizedPath, item.filename),
          type: isDirectory ? 'directory' : 'file',
          size: Number(attrs.size || 0),
          modifiedAt: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : '',
          mode: attrs.mode ? attrs.mode.toString(8) : ''
        };
      })
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
  };
}

async function uploadFtpFile(sessionId, localPath, remoteDirectory) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const fileName = path.basename(localPath || '');
  if (!fileName) throw new Error('Choose a local file to upload.');
  const remotePath = await uploadLocalPath(sftp, localPath, remoteDirectory || '.');
  return { remotePath };
}

async function readTerminalHomeDirectory(sessionId) {
  const { connection } = terminalSessionOrThrow(sessionId);
  const result = await execOnTerminalConnection(connection, 'pwd');
  const currentPath = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  if (!currentPath) throw new Error('Could not determine the SSH home directory.');
  return { path: normalizeRemotePath(currentPath) };
}

async function uploadTerminalFile(sessionId, localPath, remoteDirectory) {
  const terminal = terminalSessionOrThrow(sessionId);
  if (activeTerminalUploads.has(sessionId)) throw new Error('An upload is already in progress.');
  const normalizedLocalPath = path.resolve(String(localPath || ''));
  const fileName = path.basename(normalizedLocalPath);
  if (!fileName) throw new Error('Choose a local file to upload.');

  const stats = await fs.stat(normalizedLocalPath);
  if (!stats.isFile()) throw new Error('Choose a file to upload.');

  const remotePath = joinRemotePath(remoteDirectory || '.', fileName);
  const uploadState = {
    sessionId,
    fileName,
    remotePath,
    canceled: false,
    sftp: null
  };
  activeTerminalUploads.set(sessionId, uploadState);
  emitTerminal(sessionId, 'upload-started', {
    fileName,
    remotePath,
    totalBytes: stats.size
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (uploadState.sftp) {
        try {
          uploadState.sftp.end();
        } catch {}
      }
      activeTerminalUploads.delete(sessionId);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    terminal.connection.sftp((error, sftp) => {
      if (error) {
        finish(error);
        return;
      }

      uploadState.sftp = sftp;
      if (uploadState.canceled) {
        finish(new Error('Upload canceled.'));
        return;
      }

      sftpFastPut(sftp, normalizedLocalPath, remotePath, {
        step: (transferredBytes, _chunk, totalBytes) => {
          const total = Number(totalBytes || stats.size || 0);
          const transferred = Number(transferredBytes || 0);
          emitTerminal(sessionId, 'upload-progress', {
            fileName,
            remotePath,
            transferredBytes: transferred,
            totalBytes: total,
            percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0
          });
        }
      })
        .then(() => {
          if (uploadState.canceled) {
            finish(new Error('Upload canceled.'));
            return;
          }
          emitTerminal(sessionId, 'upload-complete', {
            fileName,
            remotePath,
            totalBytes: stats.size
          });
          finish(null, { remotePath });
        })
        .catch((uploadError) => {
          finish(uploadState.canceled ? new Error('Upload canceled.') : uploadError);
        });
    });
  });
}

function cancelTerminalUpload(sessionId) {
  const upload = activeTerminalUploads.get(sessionId);
  if (!upload) return false;
  upload.canceled = true;
  if (upload.sftp) {
    try {
      upload.sftp.end();
    } catch {}
  }
  return true;
}

async function downloadFtpFile(sessionId, remotePath, localPath) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  await sftpFastGet(sftp, normalizeRemotePath(remotePath), localPath);
  return { localPath };
}

async function downloadFtpEntryToDirectory(sessionId, entry, localDirectory) {
  if (!entry?.path) throw new Error('Choose a server item to download.');
  const { sftp } = ftpSessionOrThrow(sessionId);
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, localDirectory);
  return { localPath };
}

async function makeFtpDirectory(sessionId, remoteDirectory, folderName) {
  const name = assertPlainFileName(folderName, 'Enter a folder name.');
  const remotePath = joinRemotePath(remoteDirectory || '.', name);
  const { sftp } = ftpSessionOrThrow(sessionId);
  await sftpMkdir(sftp, remotePath);
  return { remotePath };
}

async function renameFtpEntry(sessionId, entry, nextName) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to rename.');
  const name = assertPlainFileName(nextName);
  const nextPath = joinRemotePath(parentRemotePath(remotePath), name);
  await sftpRename(sftp, remotePath, nextPath);
  return { remotePath: nextPath };
}

async function openFtpEntry(sessionId, entry) {
  if (!entry?.path) throw new Error('Choose a server item to open.');
  const { sftp } = ftpSessionOrThrow(sessionId);
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'ftp-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, tempRoot);
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function openFtpEntryWith(sessionId, entry) {
  if (!entry?.path) throw new Error('Choose a server item to open.');
  const { sftp } = ftpSessionOrThrow(sessionId);
  const tempRoot = path.join(app.getPath('temp'), 'DeployerX', 'ftp-open', String(sessionId));
  await fs.mkdir(tempRoot, { recursive: true });
  const localPath = await downloadRemotePath(sftp, normalizeRemotePath(entry.path), entry.type, tempRoot);
  if (process.platform === 'win32') {
    const child = execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', localPath], {
      detached: true,
      windowsHide: false
    });
    child.unref();
    return { localPath };
  }
  const result = await shell.openPath(localPath);
  if (result) throw new Error(result);
  return { localPath };
}

async function deleteFtpEntry(sessionId, entry) {
  const { sftp } = ftpSessionOrThrow(sessionId);
  const remotePath = normalizeRemotePath(entry?.path);
  if (!remotePath || remotePath === '.' || remotePath === '/') throw new Error('Choose a file or folder to delete.');
  await deleteRemotePath(sftp, remotePath, entry?.type);
  return true;
}

function disconnectFtp(sessionId) {
  const session = activeFtpSessions.get(sessionId);
  if (!session) return false;
  session.connection.end();
  activeFtpSessions.delete(sessionId);
  return true;
}

function stopDeployment(runId) {
  const deployment = activeDeployments.get(runId);
  if (!deployment) return false;
  deployment.stopped = true;
  if (deployment.currentStream) deployment.currentStream.close();
  deployment.connection.end();
  activeDeployments.delete(runId);
  emitDeployment(runId, 'failed', 'Emergency stop requested.');
  return true;
}

function stopTerminal(sessionId) {
  cancelTerminalUpload(sessionId);
  const terminal = activeTerminals.get(sessionId);
  if (!terminal) return false;
  if (terminal.stream) terminal.stream.close();
  terminal.connection.end();
  activeTerminals.delete(sessionId);
  emitTerminal(sessionId, 'closed', 'Terminal stopped.');
  return true;
}

function emergencyStop() {
  for (const runId of [...activeDeployments.keys()]) {
    stopDeployment(runId);
  }
  for (const sessionId of [...activeTerminals.keys()]) {
    stopTerminal(sessionId);
  }
  for (const sessionId of [...activeTerminalUploads.keys()]) {
    cancelTerminalUpload(sessionId);
  }
  for (const sessionId of [...activeFtpSessions.keys()]) {
    disconnectFtp(sessionId);
  }
}

app.whenReady().then(async () => {
  await ensureStore();
  createWindow();
  initializeAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
});

ipcMain.handle('app:metadata', async () => ({
  name: app.getName(),
  version: app.getVersion(),
  updates: publicUpdateState()
}));

ipcMain.handle('app:update-state', async () => publicUpdateState());

ipcMain.handle('app:update-check', async () => checkForAppUpdates({ manual: true }));

ipcMain.handle('app:update-open-releases', async () => {
  if (!githubReleaseSource?.releasesUrl) return false;
  await shell.openExternal(githubReleaseSource.releasesUrl);
  return true;
});

ipcMain.handle('app:update-install', async () => {
  if (updateState.status !== 'downloaded') {
    throw new Error('There is no downloaded update ready to install yet.');
  }
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});

ipcMain.handle('setup:get', async () => {
  const settings = await readSettings();
  return {
    setupComplete: settings.setupComplete,
    mode: settings.mode,
    activeTeamId: settings.activeTeamId,
    firebase: await firebaseConfigStatus(),
    session: publicSession(settings.auth),
    unlocked: Boolean(settings.activeTeamId)
  };
});

ipcMain.handle('setup:setMode', async (_event, mode) => {
  if (!['offline', 'cloud'].includes(mode)) throw new Error('Choose Cloud or Offline mode.');
  const current = await readSettings();
  if (mode === 'offline') {
    cloudUnlock = { teamId: '', key: null };
    const settings = await writeSettings({ ...current, setupComplete: true, mode: 'offline', activeTeamId: '', auth: null });
    return { ...settings, firebase: await firebaseConfigStatus() };
  }
  const settings = await writeSettings({ ...current, setupComplete: true, mode: 'cloud' });
  return { ...settings, firebase: await firebaseConfigStatus() };
});

ipcMain.handle('setup:select-firebase-config', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Firebase Web Config',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, firebase: await firebaseConfigStatus() };

  const parsed = parseFirebaseConfigJson(JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')));
  if (!parsed) throw new Error('Selected JSON is not a Firebase Web config.');

  if (parsed.adminProjectId) {
    const discovered = await tryFirebaseHostingConfig(parsed.adminProjectId);
    if (!discovered) {
      throw new Error(
        'That file is a Firebase Admin SDK service account. It does not include the Web API key needed for Firebase Auth. Download the Firebase Web App config from Firebase Console > Project settings > Your apps, or enable Firebase Hosting init config.'
      );
    }
    return { canceled: false, firebase: await saveFirebaseConfig(discovered) };
  }

  return { canceled: false, firebase: await saveFirebaseConfig(parsed) };
});

ipcMain.handle('auth:register', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  const password = String(payload.password || '');
  const firstName = String(payload.firstName || '').trim();
  const lastName = String(payload.lastName || '').trim();
  const displayName = String(payload.displayName || `${firstName} ${lastName}`.trim()).trim();
  if (!email || !password) throw new Error('Email and password are required.');

  const registered = await firebaseAuthRequest('accounts:signUp', {
    email,
    password,
    returnSecureToken: true
  });
  let auth = normalizeAuthSession(registered, displayName);
  if (displayName) {
    const updated = await firebaseAuthRequest('accounts:update', {
      idToken: auth.idToken,
      displayName,
      returnSecureToken: false
    });
    auth = {
      ...auth,
      displayName: updated.displayName || displayName
    };
  }

  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken
  });

  return finishCloudAuth(auth, { displayName, firstName, lastName, emailVerified: false });
});

ipcMain.handle('auth:login', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  const password = String(payload.password || '');
  if (!email || !password) throw new Error('Email and password are required.');

  const signedIn = await firebaseAuthRequest('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true
  });
  const auth = normalizeAuthSession(signedIn, signedIn.displayName || '');
  return finishCloudAuth(auth);
});

ipcMain.handle('auth:forgotPassword', async (_event, payload = {}) => {
  const email = emailKey(payload.email);
  if (!email) throw new Error('Enter your email address first.');
  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'PASSWORD_RESET',
    email
  });
  return true;
});

ipcMain.handle('auth:resendVerification', async () => {
  const auth = await requireAuthSession();
  await firebaseAuthRequest('accounts:sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken
  });
  return true;
});

ipcMain.handle('auth:google', async () => {
  const auth = await signInWithGoogle();
  return finishCloudAuth(auth);
});

ipcMain.handle('auth:logout', async () => {
  const settings = await readSettings();
  cloudUnlock = { teamId: '', key: null };
  await writeSettings({ ...settings, auth: null, activeTeamId: '' });
  return true;
});

ipcMain.handle('auth:session', async () => {
  const settings = await readSettings();
  if (settings.mode !== 'cloud' || !settings.auth) return { session: null };
  let auth;
  try {
    auth = await refreshAuthSession(settings);
  } catch (error) {
    if (shouldClearStoredAuth(error)) {
      cloudUnlock = { teamId: '', key: null };
      await writeSettings({ ...settings, auth: null, activeTeamId: '' });
      return { session: null };
    }

    return {
      session: publicSession(settings.auth),
      cloudError: error.message || 'Could not refresh your cloud session right now.',
      stale: true
    };
  }

  if (needsEmailVerification(auth)) {
    return { session: publicSession(auth), requiresEmailVerification: true };
  }
  return { session: publicSession(auth), teams: await safeTeamSnapshot() };
});

ipcMain.handle('teams:list', async () => safeTeamSnapshot());

ipcMain.handle('teams:create', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Team name is required.');

  const teamId = createId('team');
  const team = {
    id: teamId,
    name,
    ownerUid: auth.uid,
    secretSeed: crypto.randomBytes(32).toString('base64'),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const member = {
    uid: auth.uid,
    email: auth.email,
    emailLower: emailKey(auth.email),
    displayName: auth.displayName || '',
    role: 'owner',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await patchDoc(['teams', teamId], team);
  await patchDoc(['teams', teamId, 'members', auth.uid], member);
  await updateUserTeamRef(auth.uid, { teamId, name, role: 'owner' });

  const settings = await readSettings();
  cloudUnlock = { teamId, key: deriveWorkspaceKey(team) };
  await writeSettings({ ...settings, activeTeamId: teamId });
  return teamSnapshot();
});

ipcMain.handle('teams:switch', async (_event, teamId) => {
  const auth = await requireAuthSession();
  const team = await getDoc(['teams', teamId]);
  const member = team ? await getDoc(['teams', teamId, 'members', auth.uid]) : null;
  if (!team || !member) throw new Error('You do not have access to this team.');
  const settings = await readSettings();
  cloudUnlock = { teamId, key: deriveWorkspaceKey(team) };
  await writeSettings({ ...settings, activeTeamId: teamId });
  return teamSnapshot();
});

ipcMain.handle('teams:invite', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const email = emailKey(payload.email);
  const role = 'member';
  if (!teamId) throw new Error('Select a team first.');
  if (!email) throw new Error('Invite email is required.');
  await ensureTeamManager(teamId);
  const team = await getDoc(['teams', teamId]);
  const inviteId = createId('invite');
  const invite = {
    id: inviteId,
    teamId,
    teamName: team?.name || 'Team',
    email,
    emailLower: email,
    role,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await patchDoc(['teams', teamId, 'invites', inviteId], invite);
  await syncInviteInboxDocument(invite).catch(() => {});
  return teamSnapshot();
});

ipcMain.handle('teams:revokeInvite', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const inviteId = String(payload.inviteId || payload.id || '');
  if (!teamId || !inviteId) throw new Error('Invite is missing.');
  await ensureTeamManager(teamId);
  const invite = await getDoc(['teams', teamId, 'invites', inviteId]);
  if (!invite || invite.status !== 'pending') throw new Error('Invite is no longer pending.');
  await deleteDoc(['teams', teamId, 'invites', inviteId]);
  await deleteInviteInboxDocument(invite).catch(() => {});
  return teamSnapshot();
});

ipcMain.handle('teams:acceptInvite', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const teamId = String(payload.teamId || '');
  const inviteId = String(payload.inviteId || payload.id || '');
  if (!teamId || !inviteId) throw new Error('Invite is missing.');
  const invite = await getDoc(['teams', teamId, 'invites', inviteId]);
  if (!invite || invite.status !== 'pending') throw new Error('Invite is no longer available.');
  if (emailKey(invite.emailLower || invite.email) !== emailKey(auth.email)) throw new Error('This invite belongs to another email.');

  const acceptedAt = nowIso();
  const member = {
    uid: auth.uid,
    email: auth.email,
    emailLower: emailKey(auth.email),
    displayName: auth.displayName || '',
    role: 'member',
    acceptedInviteId: inviteId,
    createdAt: acceptedAt,
    updatedAt: acceptedAt
  };
  await patchDoc(['teams', teamId, 'members', auth.uid], member);
  const team = await getDoc(['teams', teamId]).catch(() => null);
  await updateUserTeamRef(auth.uid, { teamId, name: team?.name || invite.teamName || 'Team', role: member.role });
  await writeSettings({ ...(await readSettings()), activeTeamId: teamId });
  if (team) cloudUnlock = { teamId, key: deriveWorkspaceKey(team) };
  const acceptedInvite = { ...invite, status: 'accepted', acceptedBy: auth.uid, updatedAt: acceptedAt };
  await patchDoc(['teams', teamId, 'invites', inviteId], acceptedInvite).catch(() => {});
  await deleteInviteInboxDocument(acceptedInvite).catch(() => {});
  return teamSnapshot();
});

ipcMain.handle('teams:removeMember', async (_event, payload = {}) => {
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  const uid = String(payload.uid || '');
  if (!teamId || !uid) throw new Error('Member is required.');
  await ensureTeamManager(teamId);
  const member = await getDoc(['teams', teamId, 'members', uid]);
  if (member?.role === 'owner') throw new Error('Owner cannot be removed.');
  await deleteDoc(['teams', teamId, 'members', uid]);
  return teamSnapshot();
});

ipcMain.handle('teams:delete', async (_event, payload = {}) => {
  const auth = await requireAuthSession();
  const settings = await readSettings();
  const teamId = String(payload.teamId || settings.activeTeamId || '');
  if (!teamId) throw new Error('Select a workspace first.');

  const team = await getDoc(['teams', teamId]);
  if (!team) throw new Error('Workspace was not found.');
  const member = await getDoc(['teams', teamId, 'members', auth.uid]);
  if (team.ownerUid !== auth.uid || member?.role !== 'owner') {
    throw new Error('Only the workspace owner can delete this workspace.');
  }

  await deleteCollectionDocuments(['teams', teamId, 'projects']);
  await deleteCollectionDocuments(['teams', teamId, 'templates']);
  await deleteCollectionDocuments(['teams', teamId, 'invites']);
  await deleteTeamMemberDocuments(teamId, auth.uid);
  await deleteDoc(['teams', teamId]);
  try {
    await removeUserTeamRef(auth.uid, teamId);
  } catch (error) {
    if (!isRecoverableCloudDataError(error)) throw error;
  }

  if (settings.activeTeamId === teamId) {
    cloudUnlock = { teamId: '', key: null };
    await writeSettings({ ...settings, activeTeamId: '' });
  }
  return safeTeamSnapshot();
});

ipcMain.handle('cloud:import-local', async () => {
  await ensureActiveTeamUnlocked();
  const localData = await readStore();
  if (!localData.projects.length && !localData.templates.length) {
    return { projectCount: 0, templateCount: 0, projects: [], templates: buildBuiltInTemplates() };
  }
  await mergeLocalStoreIntoCloud(localData);
  const cloudData = await readCloudStore();
  return {
    projectCount: localData.projects.length,
    templateCount: localData.templates.length,
    projects: cloudData.projects,
    templates: mergeBuiltInTemplates(cloudData.templates)
  };
});

ipcMain.handle('projects:list', async () => {
  const data = await readCurrentStore();
  return {
    ...data,
    templates: mergeBuiltInTemplates(data.templates)
  };
});

ipcMain.handle('projects:save', async (_event, project) => {
  const settings = await readSettings();
  const id = project.id || `${Date.now()}`;
  const normalized = {
    ...project,
    id,
    updatedAt: nowIso()
  };
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await patchDoc(['teams', teamId, 'projects', id], prepareCloudProjectForSave(normalized));
    return normalized;
  }
  const data = await readStore();
  const index = data.projects.findIndex((item) => item.id === id);
  if (index >= 0) data.projects[index] = normalized;
  else data.projects.unshift(normalized);
  await writeStore(data);
  return normalized;
});

ipcMain.handle('projects:delete', async (_event, id) => {
  await deleteProjectFromCurrentStore(id);
  return true;
});

ipcMain.handle('projects:export', async (_event, projectIds) => {
  const data = await readCurrentStore();
  const selectedIds = Array.isArray(projectIds) ? new Set(projectIds.map(String)) : null;
  const projects = selectedIds ? (data.projects || []).filter((project) => selectedIds.has(String(project.id))) : data.projects || [];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Projects',
    defaultPath: 'deployerx-projects.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'projects',
    exportedAt: nowIso(),
    projects
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, count: payload.projects.length };
});

ipcMain.handle('projects:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Projects',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const importedProjects = readProjectImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  if (!importedProjects.length) throw new Error('No projects were found in that file.');

  const data = await readCurrentStore();
  const mergedProjects = await mergeImportsByName(
    Array.isArray(data.projects) ? [...data.projects] : [],
    importedProjects,
    'project'
  );
  const projects = mergedProjects.items;

  data.projects = projects;
  await writeCurrentStore(data);
  return {
    canceled: false,
    count: mergedProjects.stats.added + mergedProjects.stats.replaced,
    skippedDuplicateCount: mergedProjects.stats.skipped,
    replacedDuplicateCount: mergedProjects.stats.replaced,
    projects
  };
});

ipcMain.handle('account:export', async () => {
  const data = await readCurrentStore();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Account',
    defaultPath: 'deployerx-account.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'account',
    exportedAt: nowIso(),
    projects: data.projects || [],
    templates: stripBuiltInTemplates(data.templates || []).map(normalizeStoredTemplate)
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return {
    canceled: false,
    projectCount: payload.projects.length,
    templateCount: payload.templates.length
  };
});

ipcMain.handle('account:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Account',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const imported = readAccountImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  const data = await readCurrentStore();
  const mergedProjects = await mergeImportsByName(
    Array.isArray(data.projects) ? [...data.projects] : [],
    imported.projects,
    'project'
  );
  const mergedTemplates = await mergeImportsByName(
    stripBuiltInTemplates(Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []),
    imported.templates,
    'template',
    normalizeStoredTemplate
  );
  const projects = mergedProjects.items;
  const templates = mergedTemplates.items;

  data.projects = projects;
  data.templates = templates;
  await writeCurrentStore(data);

  return {
    canceled: false,
    projectCount: mergedProjects.stats.added + mergedProjects.stats.replaced,
    templateCount: mergedTemplates.stats.added + mergedTemplates.stats.replaced,
    skippedProjectDuplicateCount: mergedProjects.stats.skipped,
    skippedTemplateDuplicateCount: mergedTemplates.stats.skipped,
    replacedProjectDuplicateCount: mergedProjects.stats.replaced,
    replacedTemplateDuplicateCount: mergedTemplates.stats.replaced,
    projects,
    templates
  };
});

ipcMain.handle('templates:save', async (_event, template) => {
  const settings = await readSettings();
  const incomingId = String(template.id || '');
  const id = !incomingId || incomingId.startsWith(BUILT_IN_TEMPLATE_PREFIX) ? `${Date.now()}` : incomingId;
  const category = TEMPLATE_CATEGORIES.includes(String(template.category || '').trim()) ? String(template.category).trim() : '';
  if (!category) throw new Error('Template category is required.');
  const normalized = normalizeStoredTemplate({
    ...template,
    id,
    category,
    builtIn: false,
    readOnly: false,
    source: 'user',
    updatedAt: new Date().toISOString()
  });
  if (settings.mode === 'cloud') {
    const teamId = await ensureActiveTeamUnlocked();
    await patchDoc(['teams', teamId, 'templates', id], prepareCloudTemplateForSave(normalized));
    return normalized;
  }
  const data = await readStore();
  const index = data.templates.findIndex((item) => item.id === id);
  if (index >= 0) data.templates[index] = normalized;
  else data.templates.unshift(normalized);
  await writeStore(data);
  return normalized;
});

ipcMain.handle('templates:delete', async (_event, id) => {
  if (String(id || '').startsWith(BUILT_IN_TEMPLATE_PREFIX)) {
    throw new Error('Built-in library templates cannot be deleted. Duplicate one to customize it.');
  }
  await deleteTemplateFromCurrentStore(id);
  return true;
});

ipcMain.handle('templates:export', async (_event, templateIds) => {
  const data = await readCurrentStore();
  const selectedIds = Array.isArray(templateIds) ? new Set(templateIds.map(String)) : null;
  const templates = selectedIds
    ? stripBuiltInTemplates((data.templates || []).filter((template) => selectedIds.has(String(template.id))))
    : stripBuiltInTemplates(data.templates || []);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Command Templates',
    defaultPath: 'deployerx-command-templates.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  const payload = {
    app: 'DeployerX',
    type: 'command-templates',
    exportedAt: nowIso(),
    templates: templates.map(normalizeStoredTemplate)
  };

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2));
  return { canceled: false, count: payload.templates.length };
});

ipcMain.handle('templates:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Command Templates',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const importedTemplates = readTemplateImportFile(await fs.readFile(result.filePaths[0], 'utf8'));
  if (!importedTemplates.length) throw new Error('No command templates were found in that file.');

  const data = await readCurrentStore();
  const mergedTemplates = await mergeImportsByName(
    stripBuiltInTemplates(Array.isArray(data.templates) ? data.templates.map(normalizeStoredTemplate) : []),
    importedTemplates,
    'template',
    normalizeStoredTemplate
  );
  const templates = mergedTemplates.items;

  data.templates = templates;
  await writeCurrentStore(data);
  return {
    canceled: false,
    count: mergedTemplates.stats.added + mergedTemplates.stats.replaced,
    skippedDuplicateCount: mergedTemplates.stats.skipped,
    replacedDuplicateCount: mergedTemplates.stats.replaced,
    templates
  };
});

ipcMain.handle('dialog:select-key', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select SSH Private Key',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return fs.readFile(result.filePaths[0], 'utf8');
});

ipcMain.handle('dialog:select-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select File to Upload',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-ftp-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select FTP Upload File',
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-local-folder', async (_event, defaultPath = '') => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Local Folder',
    defaultPath: String(defaultPath || '').trim() || undefined,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:select-ftp-download', async (_event, defaultName = 'download') => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save FTP Download',
    defaultPath: String(defaultName || 'download')
  });

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('deployment:run', async (_event, payload) => {
  const runId = payload.runId || `${Date.now()}`;
  executeDeployment(payload.project, payload.upload, runId).catch(() => {});
  return { runId };
});

ipcMain.handle('deployment:stop', async (_event, runId) => stopDeployment(runId));

ipcMain.handle('terminal:start', async (_event, payload) => {
  const sessionId = payload.sessionId || `${Date.now()}`;
  startTerminal(payload.project, sessionId, { cols: payload.cols, rows: payload.rows });
  return { sessionId };
});

ipcMain.handle('terminal:home-directory', async (_event, sessionId) => readTerminalHomeDirectory(sessionId));

ipcMain.handle('terminal:upload', async (_event, payload) =>
  uploadTerminalFile(payload.sessionId, payload.localPath, payload.remoteDirectory)
);

ipcMain.handle('terminal:upload-cancel', async (_event, sessionId) => cancelTerminalUpload(sessionId));

ipcMain.handle('terminal:input', async (_event, payload) => {
  const terminal = activeTerminals.get(payload.sessionId);
  if (!terminal || !terminal.stream) return false;
  terminal.stream.write(payload.input);
  return true;
});

ipcMain.on('terminal:input:send', (_event, payload) => {
  const terminal = activeTerminals.get(payload.sessionId);
  if (!terminal || !terminal.stream) return;
  terminal.stream.write(payload.input);
});

ipcMain.handle('terminal:resize', async (_event, payload) => resizeTerminal(payload.sessionId, payload.cols, payload.rows));

ipcMain.handle('terminal:stop', async (_event, sessionId) => stopTerminal(sessionId));

ipcMain.handle('local:list', async (_event, payload = {}) => listLocalDirectory(payload.path || app.getPath('home')));

ipcMain.handle('project-local-settings:get', async (_event, projectId) => getProjectLocalSettings(projectId));

ipcMain.handle('project-local-settings:set', async (_event, projectId, payload = {}) =>
  setProjectLocalSettings(projectId, payload)
);

ipcMain.handle('project-local-settings:delete', async (_event, projectId) => deleteProjectLocalSettings(projectId));

ipcMain.handle('local:open', async (_event, payload = {}) => openLocalEntry(payload.entry));

ipcMain.handle('local:open-with', async (_event, payload = {}) => openLocalEntryWith(payload.entry));

ipcMain.handle('local:mkdir', async (_event, payload = {}) => makeLocalDirectory(payload.directory, payload.name));

ipcMain.handle('local:rename', async (_event, payload = {}) => renameLocalEntry(payload.entry, payload.name));

ipcMain.handle('local:delete', async (_event, payload = {}) => deleteLocalEntry(payload.entry));

ipcMain.handle('ftp:connect', async (_event, payload) => {
  const sessionId = payload.sessionId || `${Date.now()}`;
  return connectFtp(payload.project, sessionId);
});

ipcMain.handle('ftp:list', async (_event, payload) => listFtpDirectory(payload.sessionId, payload.path));

ipcMain.handle('ftp:upload', async (_event, payload) => uploadFtpFile(payload.sessionId, payload.localPath, payload.remoteDirectory));

ipcMain.handle('ftp:download', async (_event, payload) => downloadFtpFile(payload.sessionId, payload.remotePath, payload.localPath));

ipcMain.handle('ftp:download-to-directory', async (_event, payload) =>
  downloadFtpEntryToDirectory(payload.sessionId, payload.entry, payload.localDirectory)
);

ipcMain.handle('ftp:open', async (_event, payload) => openFtpEntry(payload.sessionId, payload.entry));

ipcMain.handle('ftp:open-with', async (_event, payload) => openFtpEntryWith(payload.sessionId, payload.entry));

ipcMain.handle('ftp:mkdir', async (_event, payload) => makeFtpDirectory(payload.sessionId, payload.remoteDirectory, payload.name));

ipcMain.handle('ftp:rename', async (_event, payload) => renameFtpEntry(payload.sessionId, payload.entry, payload.name));

ipcMain.handle('ftp:delete', async (_event, payload) => deleteFtpEntry(payload.sessionId, payload.entry));

ipcMain.handle('ftp:disconnect', async (_event, sessionId) => disconnectFtp(sessionId));

ipcMain.handle('emergency:stop', async () => {
  emergencyStop();
  return true;
});
