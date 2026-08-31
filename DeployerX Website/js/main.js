(() => {
  'use strict';

  const root = document.documentElement;
  const body = document.body;
  const navbar = document.querySelector('.navbar');
  const themeButton = document.querySelector('.theme-toggle');
  const menuButton = document.querySelector('.menu-button');
  const menuOverlay = document.querySelector('.menu-overlay');
  const menuLinks = [...menuOverlay.querySelectorAll('a')];
  const downloadDialog = document.querySelector('#download-dialog');
  const downloadDialogClose = downloadDialog?.querySelector('.download-dialog-close');
  const releaseNotesDialog = document.querySelector('#release-notes-dialog');
  const releaseNotesDialogClose = releaseNotesDialog?.querySelector('.release-dialog-close');
  const releaseNotesContent = releaseNotesDialog?.querySelector('[data-release-notes-content]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let menuTrigger = null;
  let downloadTrigger = null;
  let currentRelease = null;
  let currentReleaseVerified = false;
  let releaseNotesTrigger = null;

  const releaseAssets = [
    { key: 'windows-portable', pattern: /portable.*\.exe$/i, platform: 'Windows x64' },
    { key: 'windows-setup', pattern: /(setup|installer).*\.exe$/i, platform: 'Windows x64' },
    { key: 'mac-arm64', pattern: /arm64\.dmg$/i, platform: 'macOS Apple Silicon' },
    { key: 'mac-x64', pattern: /(x64|x86_64|amd64)\.dmg$/i, platform: 'macOS Intel' },
    { key: 'linux-appimage', pattern: /\.appimage$/i, platform: 'Linux x86_64' },
    { key: 'linux-deb', pattern: /\.deb$/i, platform: 'Debian / Ubuntu x64' },
    { key: 'linux-rpm', pattern: /\.rpm$/i, platform: 'Fedora / RHEL x64' }
  ];

  const releaseFallback = {
    tag: 'v0.2.6',
    releaseName: 'DeployerX 0.2.6',
    releaseDate: '2026-08-31',
    page: 'https://github.com/me-devms/DeployerX/releases/tag/v0.2.6',
    body: `## What's new in v0.2.6\n\n- Prevents detached worker processes from cleaning up the live DeployerX desktop instance.\n- Publishes the current desktop and website build with synchronized release metadata for every supported platform.\n- Refreshes website cache-busting and download links so visitors receive the current release.`,
    assets: {
      'windows-portable': {
        name: 'DeployerX-0.2.6-Portable-x64.exe',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-Portable-x64.exe'
      },
      'windows-setup': {
        name: 'DeployerX-0.2.6-Setup-x64.exe',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-Setup-x64.exe'
      },
      'mac-arm64': {
        name: 'DeployerX-0.2.6-arm64.dmg',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-arm64.dmg'
      },
      'mac-x64': {
        name: 'DeployerX-0.2.6-x64.dmg',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-x64.dmg'
      },
      'linux-appimage': {
        name: 'DeployerX-0.2.6-x86_64.AppImage',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-x86_64.AppImage'
      },
      'linux-deb': {
        name: 'DeployerX-0.2.6-amd64.deb',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-amd64.deb'
      },
      'linux-rpm': {
        name: 'DeployerX-0.2.6-x86_64.rpm',
        url: 'https://github.com/me-devms/DeployerX/releases/download/v0.2.6/DeployerX-0.2.6-x86_64.rpm'
      }
    }
  };

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderLatestRelease(release, verified) {
    currentRelease = release;
    currentReleaseVerified = verified;
    document.querySelectorAll('[data-latest-version]').forEach((element) => {
      element.textContent = release.tag;
    });
    document.querySelectorAll('[data-latest-release-link]').forEach((link) => {
      link.href = release.page;
    });
    const releaseLink = document.querySelector('[data-release-notes-link]');
    if (releaseLink) releaseLink.href = release.page;
    releaseAssets.forEach(({ key, platform }) => {
      const asset = release.assets[key];
      const link = document.querySelector(`[data-release-asset="${key}"]`);
      const meta = document.querySelector(`[data-asset-meta="${key}"]`);
      if (!link || !meta) return;
      link.hidden = !asset;
      link.setAttribute('aria-disabled', asset ? 'false' : 'true');
      if (!asset) return;
      link.href = asset.url;
      link.setAttribute('download', asset.name);
      link.removeAttribute('aria-disabled');
      meta.textContent = `${platform}, ${formatFileSize(asset.size)}`;
    });
    document.querySelectorAll('[data-platform-group]').forEach((group) => {
      group.hidden = !group.querySelector('[data-release-asset]:not([hidden])');
    });
    const status = document.querySelector('[data-release-status]');
    const availableCount = Object.values(release.assets).filter(Boolean).length;
    if (status) status.textContent = verified ? `${availableCount} downloads verified from GitHub.` : 'Using the bundled latest-release links.';
  }

  async function fetchLatestRelease() {
    try {
      const response = await fetch('https://api.github.com/repos/me-devms/DeployerX/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) throw new Error('Latest release request failed.');
      const data = await response.json();
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const matchedAssets = Object.fromEntries(releaseAssets.map(({ key, pattern }) => {
        const asset = assets.find((candidate) => pattern.test(candidate.name));
        return [key, asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null];
      }));
      if (!data.tag_name || !Object.values(matchedAssets).some(Boolean)) throw new Error('No supported release assets were found.');
      const release = {
        tag: data.tag_name,
        releaseName: String(data.name || '').trim(),
        releaseDate: data.published_at || data.created_at || '',
        page: data.html_url || `https://github.com/me-devms/DeployerX/releases/tag/${data.tag_name}`,
        body: String(data.body || '').trim(),
        assets: matchedAssets
      };
      renderLatestRelease(release, true);
      return release;
    } catch {
      renderLatestRelease(releaseFallback, false);
      return releaseFallback;
    }
  }

  const latestReleasePromise = fetchLatestRelease();

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderReleaseMarkdown(markdown = '') {
    const lines = String(markdown || '').replace(/\r/g, '').split('\n');
    const output = [];
    let list = null;
    const inline = (value) => escapeHtml(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    const closeList = () => { if (list) { output.push(`</ul>`); list = null; } };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { closeList(); continue; }
      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (heading) { closeList(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
      const item = trimmed.match(/^[-*]\s+(.+)$/);
      if (item) { if (!list) { output.push('<ul>'); list = true; } output.push(`<li>${inline(item[1])}</li>`); continue; }
      closeList();
      output.push(`<p>${inline(trimmed)}</p>`);
    }
    closeList();
    return output.join('') || '<p>No release notes were published for this version.</p>';
  }

  async function openReleaseNotes(trigger) {
    if (!releaseNotesDialog) return;
    releaseNotesTrigger = trigger;
    if (typeof releaseNotesDialog.showModal === 'function') releaseNotesDialog.showModal();
    root.classList.add('release-notes-open');
    body.classList.add('release-notes-open');
    const title = releaseNotesDialog.querySelector('[data-release-notes-title]');
    const version = releaseNotesDialog.querySelector('[data-release-notes-version]');
    const meta = releaseNotesDialog.querySelector('[data-release-notes-meta]');
    const status = releaseNotesDialog.querySelector('[data-release-notes-status]');
    if (releaseNotesContent) releaseNotesContent.innerHTML = '<p class="release-notes-loading">Loading the latest release notes...</p>';
    const release = await latestReleasePromise;
    if (version) version.textContent = release.tag || 'Latest';
    if (title) title.textContent = release.releaseName || `What's new in ${release.tag || 'DeployerX'}`;
    if (meta) meta.textContent = release.releaseDate ? new Date(release.releaseDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'Latest published release';
    if (releaseNotesContent) releaseNotesContent.innerHTML = renderReleaseMarkdown(release.body);
    if (status) status.textContent = currentReleaseVerified ? 'Release notes fetched from GitHub.' : 'Showing the bundled release notes fallback.';
    releaseNotesDialogClose?.focus({ preventScroll: true });
  }

  function closeReleaseNotes() {
    if (!releaseNotesDialog?.open) return;
    releaseNotesDialog.close();
    root.classList.remove('release-notes-open');
    body.classList.remove('release-notes-open');
    releaseNotesTrigger?.focus({ preventScroll: true });
  }

  document.querySelectorAll('[data-release-notes-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => { event.preventDefault(); openReleaseNotes(trigger); });
  });
  releaseNotesDialogClose?.addEventListener('click', closeReleaseNotes);
  releaseNotesDialog?.addEventListener('click', (event) => { if (event.target === releaseNotesDialog) closeReleaseNotes(); });
  releaseNotesDialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeReleaseNotes(); });
  releaseNotesDialog?.addEventListener('close', () => {
    root.classList.remove('release-notes-open');
    body.classList.remove('release-notes-open');
    releaseNotesTrigger?.focus({ preventScroll: true });
  });

  async function openDownloadDialog(trigger) {
    if (!downloadDialog) return;
    downloadTrigger = trigger;
    downloadDialog.querySelectorAll('[data-release-asset]').forEach((link) => link.setAttribute('aria-disabled', 'true'));
    const status = downloadDialog.querySelector('[data-release-status]');
    if (status) status.textContent = 'Checking the latest GitHub release...';
    if (typeof downloadDialog.showModal === 'function') downloadDialog.showModal();
    body.classList.add('download-open');
    const release = await latestReleasePromise;
    renderLatestRelease(release, currentReleaseVerified);
    downloadDialogClose?.focus({ preventScroll: true });
  }

  function closeDownloadDialog() {
    if (!downloadDialog?.open) return;
    downloadDialog.close();
    body.classList.remove('download-open');
    downloadTrigger?.focus({ preventScroll: true });
  }

  document.querySelectorAll('[data-download-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', () => openDownloadDialog(trigger));
  });

  downloadDialogClose?.addEventListener('click', closeDownloadDialog);
  downloadDialog?.addEventListener('click', (event) => {
    if (event.target === downloadDialog) closeDownloadDialog();
  });
  downloadDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDownloadDialog();
  });
  downloadDialog?.addEventListener('close', () => {
    body.classList.remove('download-open');
    downloadTrigger?.focus({ preventScroll: true });
  });

  async function refreshGitHubStars() {
    const counts = [...document.querySelectorAll('[data-github-stars]')];
    if (!counts.length) return;
    try {
      const response = await fetch('https://api.github.com/repos/me-devms/DeployerX', {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) return;
      const repository = await response.json();
      if (!Number.isFinite(repository.stargazers_count)) return;
      const formatted = new Intl.NumberFormat('en', { notation: repository.stargazers_count >= 1000 ? 'compact' : 'standard' }).format(repository.stargazers_count);
      counts.forEach((count) => {
        count.textContent = formatted;
        count.closest('.github-stars')?.setAttribute('aria-label', `${repository.stargazers_count} GitHub stars`);
      });
    } catch {
      // The static fallback remains visible when GitHub is unavailable.
    }
  }

  refreshGitHubStars();

  async function refreshGitHubContributors() {
    const avatars = document.querySelector('[data-contributor-avatars]');
    const more = avatars?.querySelector('[data-contributor-more]');
    if (!avatars || !more) return;
    try {
      const response = await fetch('https://api.github.com/repos/me-devms/DeployerX/contributors?per_page=6&anon=0', {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) return;
      const contributors = (await response.json())
        .filter((contributor) => contributor?.login && contributor?.html_url && contributor?.avatar_url)
        .slice(0, 5);
      if (!contributors.length) return;

      const links = contributors.map((contributor) => {
        const link = document.createElement('a');
        link.href = contributor.html_url;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.setAttribute('aria-label', `${contributor.login} on GitHub`);
        const image = document.createElement('img');
        image.src = contributor.avatar_url;
        image.width = 56;
        image.height = 56;
        image.alt = contributor.login;
        image.loading = 'lazy';
        image.decoding = 'async';
        link.appendChild(image);
        return link;
      });
      avatars.replaceChildren(...links, more);
    } catch {
      // The local contributor portraits remain visible when GitHub is unavailable.
    }
  }

  refreshGitHubContributors();

  const storedTheme = localStorage.getItem('deployerx-theme');
  const preferredTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

  function setTheme(theme) {
    root.dataset.theme = theme;
    themeButton.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#0b1118' : '#f5f8fb');
  }

  setTheme(storedTheme || preferredTheme);

  themeButton.addEventListener('click', () => {
    const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('deployerx-theme', nextTheme);
  });

  function focusableMenuItems() {
    return [...menuOverlay.querySelectorAll('a[href], button:not([disabled])')];
  }

  function openMenu() {
    menuTrigger = document.activeElement;
    body.classList.add('menu-open');
    menuOverlay.classList.add('is-open');
    menuOverlay.setAttribute('aria-hidden', 'false');
    menuButton.setAttribute('aria-expanded', 'true');
    menuButton.setAttribute('aria-label', 'Close menu');
    window.setTimeout(() => {
      if (menuOverlay.classList.contains('is-open')) menuLinks[0]?.focus({ preventScroll: true });
    }, 280);
  }

  function closeMenu({ restoreFocus = true } = {}) {
    body.classList.remove('menu-open');
    menuOverlay.classList.remove('is-open');
    menuOverlay.setAttribute('aria-hidden', 'true');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open menu');
    if (restoreFocus) menuTrigger?.focus();
  }

  menuButton.addEventListener('click', () => {
    if (menuOverlay.classList.contains('is-open')) closeMenu();
    else openMenu();
  });

  menuLinks.forEach((link) => link.addEventListener('click', () => closeMenu({ restoreFocus: false })));

  document.addEventListener('keydown', (event) => {
    if (!menuOverlay.classList.contains('is-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableMenuItems();
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function updateHeader() {
    navbar.classList.toggle('is-scrolled', window.scrollY > 20);
  }
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];

  function selectTab(tab) {
    tabs.forEach((item) => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== tab.getAttribute('aria-controls');
    });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let targetIndex = index;
      if (event.key === 'ArrowLeft') targetIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') targetIndex = (index + 1) % tabs.length;
      if (event.key === 'Home') targetIndex = 0;
      if (event.key === 'End') targetIndex = tabs.length - 1;
      selectTab(tabs[targetIndex]);
      tabs[targetIndex].focus();
    });
  });

  const copyStatus = document.querySelector('.copy-status');
  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      const text = target?.innerText || '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('copy');
        selection.removeAllRanges();
      }
      const label = button.querySelector('span');
      label.textContent = 'Copied';
      button.querySelector('use').setAttribute('href', '#icon-check');
      copyStatus.textContent = 'Source commands copied to clipboard.';
      window.setTimeout(() => {
        label.textContent = 'Copy';
        button.querySelector('use').setAttribute('href', '#icon-copy');
      }, 1800);
    });
  });

  document.querySelectorAll('.faq-item button').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('.faq-item');
      const shouldOpen = !item.classList.contains('is-open');
      document.querySelectorAll('.faq-item').forEach((other) => {
        other.classList.remove('is-open');
        other.querySelector('button').setAttribute('aria-expanded', 'false');
      });
      if (shouldOpen) {
        item.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
      }
    });
  });

  const revealItems = document.querySelectorAll('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealItems.forEach((item) => revealObserver.observe(item));
  }

  document.getElementById('current-year').textContent = String(new Date().getFullYear());
})();
