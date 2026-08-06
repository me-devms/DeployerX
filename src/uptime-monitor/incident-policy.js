const { createId } = require('./domain');

function eventForTransition(type, monitor, incident, check, clock) {
  const labels = {
    'uptime.warning': `Warning: ${monitor.name}`,
    'uptime.incident.opened': `Down: ${monitor.name}`,
    'uptime.incident.escalated': `Incident escalated: ${monitor.name}`,
    'uptime.incident.acknowledged': `Incident acknowledged: ${monitor.name}`,
    'uptime.incident.resolved': `Recovered: ${monitor.name}`,
    'uptime.tls-expiry': `TLS certificate warning: ${monitor.name}`
  };
  return {
    type,
    eventKey: `${type}:${incident?.id || monitor.id}:${check.completedAt}`,
    occurredAt: check.completedAt || clock(),
    severity: incident?.severity === 'critical' || check.outcome === 'down' ? 'critical' : 'warning',
    title: labels[type] || monitor.name,
    body: check.summary || `Review ${monitor.name} in DeployerX.`,
    monitorId: monitor.id,
    incidentId: incident?.id || null,
    projectId: monitor.projectId || null,
    details: {
      outcome: check.outcome,
      failureCategory: check.failureCategory || '',
      latencyMs: check.latencyMs,
      probeId: check.probeId
    },
    routeIds: [...(monitor.notificationRouteIds || [])]
  };
}

class UptimeIncidentPolicyService {
  constructor({ controlDatabase, notifier = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase) throw new TypeError('Uptime control database is required.');
    this.controlDatabase = controlDatabase;
    this.notifier = notifier;
    this.clock = clock;
  }

  async processCheck(workspaceId, actorId, monitorInput, result, options = {}) {
    let monitor = monitorInput?.id ? await this.controlDatabase.getMonitor(workspaceId, monitorInput.id) : null;
    if (!monitor) throw Object.assign(new Error('Monitor was not found.'), { code: 'UPTIME_MONITOR_NOT_FOUND' });
    const completedAt = result.completedAt || this.clock();
    const maintenance = Boolean(options.maintenance);
    const outcome = maintenance ? 'maintenance' : result.outcome;
    const check = await this.controlDatabase.recordCheck(workspaceId, {
      id: result.id || createId('check'),
      monitorId: monitor.id,
      probeId: result.probeId || monitor.probeId,
      scheduledAt: result.scheduledAt || result.startedAt || completedAt,
      startedAt: result.startedAt || completedAt,
      completedAt,
      outcome,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      failureCategory: result.failureCategory,
      summary: result.summary,
      details: result.details
    });
    const runtime = { ...monitor.runtime, lastCheckAt: completedAt, lastLatencyMs: check.latencyMs, lastSummary: check.summary };
    const emittedEvents = [];
    let incident = await this.controlDatabase.getActiveIncident(workspaceId, monitor.id);

    if (maintenance) {
      runtime.status = 'maintenance';
      runtime.consecutiveFailures = 0;
      runtime.consecutiveSuccesses = 0;
    } else if (check.outcome === 'up') {
      runtime.status = 'up';
      runtime.lastSuccessAt = completedAt;
      runtime.consecutiveSuccesses = Number(runtime.consecutiveSuccesses || 0) + 1;
      runtime.consecutiveFailures = 0;
      if (incident && runtime.consecutiveSuccesses >= monitor.alertPolicy.recoveryThreshold) {
        incident = await this.controlDatabase.updateIncident(workspaceId, actorId, incident.id, {
          state: 'resolved',
          resolvedAt: completedAt,
          events: [...(incident.events || []), { type: 'resolved', at: completedAt, summary: check.summary }]
        }, incident.revision);
        runtime.activeIncidentId = null;
        if (monitor.alertPolicy.notifyOnRecovery) emittedEvents.push(eventForTransition('uptime.incident.resolved', monitor, incident, check, this.clock));
      }
    } else {
      runtime.lastFailureAt = completedAt;
      runtime.consecutiveFailures = Number(runtime.consecutiveFailures || 0) + 1;
      runtime.consecutiveSuccesses = 0;
      const thresholdReached = runtime.consecutiveFailures >= monitor.alertPolicy.failureThreshold;
      const severity = check.outcome === 'down' ? 'critical' : 'warning';
      runtime.status = thresholdReached ? check.outcome : 'warning';
      if (monitor.type === 'tls' && check.failureCategory === 'tls-expiry' && runtime.consecutiveFailures === 1) {
        emittedEvents.push(eventForTransition('uptime.tls-expiry', monitor, incident, check, this.clock));
      }
      if (!thresholdReached && monitor.alertPolicy.notifyOnWarning && runtime.consecutiveFailures === 1) {
        emittedEvents.push(eventForTransition('uptime.warning', monitor, null, check, this.clock));
      }
      if (thresholdReached && !incident) {
        incident = await this.controlDatabase.createIncident(workspaceId, actorId, {
          monitorId: monitor.id,
          state: 'open',
          severity,
          openedAt: completedAt,
          summary: check.summary,
          failureCategory: check.failureCategory,
          consecutiveFailures: runtime.consecutiveFailures,
          events: [{ type: 'opened', at: completedAt, outcome: check.outcome, summary: check.summary }]
        });
        runtime.activeIncidentId = incident.id;
        emittedEvents.push(eventForTransition('uptime.incident.opened', monitor, incident, check, this.clock));
      } else if (incident && incident.severity === 'warning' && severity === 'critical') {
        incident = await this.controlDatabase.updateIncident(workspaceId, actorId, incident.id, {
          severity: 'critical',
          summary: check.summary,
          failureCategory: check.failureCategory,
          consecutiveFailures: runtime.consecutiveFailures,
          events: [...(incident.events || []), { type: 'escalated', at: completedAt, summary: check.summary }]
        }, incident.revision);
        emittedEvents.push(eventForTransition('uptime.incident.escalated', monitor, incident, check, this.clock));
      }
    }

    monitor = await this.controlDatabase.updateMonitor(workspaceId, actorId, monitor.id, {
      runtime,
      nextCheckAt: monitor.state === 'enabled' ? new Date(Date.parse(completedAt) + monitor.intervalSec * 1000).toISOString() : null
    }, monitor.revision);
    if (typeof this.notifier === 'function') {
      for (const event of emittedEvents) await this.notifier(event);
    }
    return { monitor, check, incident, events: emittedEvents };
  }

  async acknowledge(workspaceId, actorId, incidentId, expectedRevision, note = '') {
    const incidents = await this.controlDatabase.listIncidents(workspaceId, { limit: 10000 });
    const incident = incidents.find((candidate) => candidate.id === incidentId);
    if (!incident) return null;
    if (incident.state === 'resolved') return incident;
    const at = this.clock();
    const updated = await this.controlDatabase.updateIncident(workspaceId, actorId, incident.id, {
      state: 'acknowledged',
      acknowledgedAt: at,
      events: [...(incident.events || []), { type: 'acknowledged', at, actorId, note: String(note || '').trim().slice(0, 1000) }]
    }, expectedRevision);
    const monitor = await this.controlDatabase.getMonitor(workspaceId, incident.monitorId);
    if (monitor && typeof this.notifier === 'function') {
      await this.notifier(eventForTransition('uptime.incident.acknowledged', monitor, updated, { outcome: monitor.runtime.status, completedAt: at, summary: note || 'Incident acknowledged.', probeId: monitor.probeId, latencyMs: monitor.runtime.lastLatencyMs }, this.clock));
    }
    return updated;
  }
}

module.exports = {
  UptimeIncidentPolicyService,
  eventForTransition
};
