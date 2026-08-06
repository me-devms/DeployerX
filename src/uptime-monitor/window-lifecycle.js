function uptimeWindowCloseDisposition({ isAppQuitting = false, platform = process.platform, hasTray = false, hasShownTrayNotice = false } = {}) {
  if (isAppQuitting) {
    return {
      preventClose: false,
      hideWindow: false,
      hideDock: false,
      showTrayNotice: false
    };
  }
  return {
    preventClose: true,
    hideWindow: true,
    hideDock: platform === 'darwin',
    showTrayNotice: platform === 'win32' && Boolean(hasTray) && !hasShownTrayNotice
  };
}

module.exports = { uptimeWindowCloseDisposition };
