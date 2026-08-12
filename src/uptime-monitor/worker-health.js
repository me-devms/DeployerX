const DEFAULT_STALE_AFTER_MS = 60000;

function evaluateWorkerHeartbeat(heartbeats = [], { now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const latest = [...heartbeats].sort((left, right) => String(right?.heartbeatAt || '').localeCompare(String(left?.heartbeatAt || '')))[0] || null;
  const heartbeatMs = Date.parse(latest?.heartbeatAt || '');
  const ageMs = Number.isFinite(heartbeatMs) ? Math.max(0, Number(now) - heartbeatMs) : null;
  const active = latest?.state === 'active' && ageMs != null && ageMs <= staleAfterMs;
  return { heartbeat: latest, heartbeatMs: Number.isFinite(heartbeatMs) ? heartbeatMs : null, ageMs, active, stale: latest?.state === 'active' && !active };
}

function workerHealthEvent(heartbeat, occurredAt) {
  if (!heartbeat?.probeId || !heartbeat?.heartbeatAt) return null;
  return {
    type: 'uptime.worker-health',
    eventKey: `uptime.worker-health:stale:${heartbeat.probeId}:${heartbeat.heartbeatAt}`,
    occurredAt: new Date(occurredAt).toISOString(),
    severity: 'critical',
    title: 'Uptime worker offline',
    body: `The local monitoring worker has not reported since ${heartbeat.heartbeatAt}.`,
    details: { probeId: heartbeat.probeId, heartbeatAt: heartbeat.heartbeatAt }
  };
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  evaluateWorkerHeartbeat,
  workerHealthEvent
};
