const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TABULARIS_RELEASE = Object.freeze({
  version: '0.18.0',
  filename: 'tabularis_0.18.0_x64-portable.exe',
  url: 'https://github.com/TabularisDB/tabularis/releases/download/v0.18.0/tabularis_0.18.0_x64-portable.exe',
  size: 32299520,
  sha256: 'a77ee7d29c384191f7d025a33f0991cc0e118e8ffb55463a5b6490d85e36bcc3'
});

function launcherError(code, message, retryable = false) {
  return Object.assign(new Error(message), {
    code,
    safeMessage: message,
    category: 'tabularis',
    retryable
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

class TabularisLauncher {
  constructor({
    rootPath,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    platform = process.platform,
    arch = process.arch,
    release = TABULARIS_RELEASE
  } = {}) {
    if (!rootPath || typeof rootPath !== 'string') throw new TypeError('Tabularis cache path is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('Tabularis launcher requires fetch.');
    if (typeof spawnImpl !== 'function') throw new TypeError('Tabularis launcher requires a process spawner.');
    this.rootPath = rootPath;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.platform = platform;
    this.arch = arch;
    this.release = release;
    this.installPromise = null;
  }

  executablePath() {
    return path.join(this.rootPath, `v${this.release.version}`, this.release.filename);
  }

  async matchesRelease(executablePath) {
    try {
      const stat = await fs.stat(executablePath);
      if (!stat.isFile() || stat.size !== this.release.size) return false;
      return sha256(await fs.readFile(executablePath)) === this.release.sha256;
    } catch {
      return false;
    }
  }

  async ensureInstalled() {
    if (this.platform !== 'win32' || this.arch !== 'x64') {
      throw launcherError('TABULARIS_PLATFORM_UNSUPPORTED', 'The bundled Tabularis handoff currently supports Windows x64 only.');
    }
    if (!this.installPromise) {
      this.installPromise = this.#ensureInstalled().finally(() => { this.installPromise = null; });
    }
    return this.installPromise;
  }

  async #ensureInstalled() {
    const executablePath = this.executablePath();
    if (await this.matchesRelease(executablePath)) return { executablePath, downloaded: false };

    let response;
    try {
      response = await this.fetch(this.release.url, {
        redirect: 'follow',
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'DeployerX-Tabularis-Launcher' }
      });
    } catch {
      throw launcherError('TABULARIS_DOWNLOAD_FAILED', 'Could not download Tabularis from its official GitHub release.', true);
    }
    if (!response?.ok || typeof response.arrayBuffer !== 'function') {
      throw launcherError('TABULARIS_DOWNLOAD_FAILED', 'Could not download Tabularis from its official GitHub release.', true);
    }

    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > 0 && declaredSize !== this.release.size) {
      throw launcherError('TABULARIS_INTEGRITY_FAILED', 'The downloaded Tabularis release did not match the reviewed artifact.');
    }
    const payload = Buffer.from(await response.arrayBuffer());
    if (payload.length !== this.release.size || sha256(payload) !== this.release.sha256) {
      throw launcherError('TABULARIS_INTEGRITY_FAILED', 'The downloaded Tabularis release did not match the reviewed artifact.');
    }

    const directory = path.dirname(executablePath);
    const temporaryPath = path.join(directory, `${this.release.filename}.${crypto.randomUUID()}.download`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporaryPath, payload, { flag: 'wx', mode: 0o700 });
      await fs.rm(executablePath, { force: true });
      await fs.rename(temporaryPath, executablePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw launcherError('TABULARIS_INSTALL_FAILED', 'Tabularis could not be prepared on this device.', true);
    }
    return { executablePath, downloaded: true };
  }

  async launch() {
    const installed = await this.ensureInstalled();
    try {
      const child = this.spawn(installed.executablePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } catch {
      throw launcherError('TABULARIS_LAUNCH_FAILED', 'Tabularis could not be opened on this device.', true);
    }
    return Object.freeze({ status: 'launched', version: this.release.version, downloaded: installed.downloaded });
  }
}

module.exports = {
  TABULARIS_RELEASE,
  TabularisLauncher,
  launcherError,
  sha256
};
