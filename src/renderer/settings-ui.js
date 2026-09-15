// Presentation-only settings controls. Data operations remain in renderer.js.
(() => {
  document.querySelectorAll('[data-settings-tabs]').forEach(container => {
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const activate = selected => {
      tabs.forEach(tab => {
        const active = tab === selected;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        document.getElementById(tab.getAttribute('aria-controls')).classList.toggle('hidden', !active);
        document.getElementById(tab.dataset.settingsTabAction)?.classList.toggle('hidden', !active);
      });
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        activate(tabs[next]);
        tabs[next].focus();
      });
    });
  });

  document.querySelectorAll('[data-settings-dialog]').forEach(trigger => {
    const dialog = document.getElementById(trigger.dataset.settingsDialog);
    trigger.addEventListener('click', () => dialog.showModal());
    dialog.querySelectorAll('[data-settings-dialog-close]').forEach(button => {
      button.addEventListener('click', () => dialog.close());
    });
    dialog.addEventListener('close', () => trigger.focus());
  });
})();
