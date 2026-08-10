const MIN_DISPLAY_WIDTH = 640;
const MIN_DISPLAY_HEIGHT = 480;

function positiveInteger(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizedScreen(screen, index, framebufferWidth, framebufferHeight) {
  const x = Math.max(0, Math.round(Number(screen?.x) || 0));
  const y = Math.max(0, Math.round(Number(screen?.y) || 0));
  const width = Math.min(positiveInteger(screen?.width), Math.max(0, framebufferWidth - x));
  const height = Math.min(positiveInteger(screen?.height), Math.max(0, framebufferHeight - y));
  if (!width || !height) return null;
  return {
    id: String(screen?.id ?? index + 1),
    x,
    y,
    width,
    height,
    label: `Display ${index + 1}`,
    inferred: false
  };
}

function inferHorizontalDisplays(width, height) {
  if (height < MIN_DISPLAY_HEIGHT || width / height < 3) return [];
  for (let count = 2; count <= 4; count += 1) {
    if (width % count !== 0) continue;
    const displayWidth = width / count;
    const aspectRatio = displayWidth / height;
    if (displayWidth < MIN_DISPLAY_WIDTH || aspectRatio < 1.2 || aspectRatio > 2.45) continue;
    return Array.from({ length: count }, (_, index) => ({
      id: `inferred-${index + 1}`,
      x: index * displayWidth,
      y: 0,
      width: displayWidth,
      height,
      label: `Display ${index + 1}`,
      inferred: true
    }));
  }
  return [];
}

export function resolveVncDisplays(screens, framebufferWidth, framebufferHeight) {
  const width = positiveInteger(framebufferWidth);
  const height = positiveInteger(framebufferHeight);
  if (!width || !height) return [];
  const exact = (Array.isArray(screens) ? screens : [])
    .map((screen, index) => normalizedScreen(screen, index, width, height))
    .filter(Boolean);
  if (exact.length) return exact.length > 1 ? exact : [];
  return inferHorizontalDisplays(width, height);
}
