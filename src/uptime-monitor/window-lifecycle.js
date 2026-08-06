function uptimeWindowCloseDisposition({ isAppQuitting = false, platform = process.platform } = {}) {
  if (isAppQuitting) {
    return {
      preventClose: false,
      hideWindow: false,
      hideDock: false
    };
  }
  return {
    preventClose: true,
    hideWindow: true,
    hideDock: platform === 'darwin'
  };
}

module.exports = { uptimeWindowCloseDisposition };
