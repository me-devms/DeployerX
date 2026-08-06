# Uptime Monitor Implementation Plan

## Objective

Deliver a complete local-first Uptime Monitor for DeployerX that can monitor multiple standalone or server-linked targets in the Windows background, preserve operational history, create incidents, produce reports, and notify shared desktop, email, webhook, Slack, and Microsoft Teams routes.

The architecture must remain ready for hosted and multi-region probes without requiring the local monitor, check-result, incident, or reporting contracts to be replaced.

## Product Decisions

- Monitors belong to a workspace and may optionally link to a DeployerX server.
- The first release uses the local Windows device as the probe.
- Core monitor engines are HTTP/API, TCP, and TLS certificate checks.
- Website, API, and keyword monitors are guided configurations of the HTTP engine.
- Incidents open after two consecutive failures and resolve after one successful check by default.
- Raw checks are retained for 90 days; daily reporting rollups are retained for 13 months.
- Reports include interactive views, CSV exports, and printable PDF exports.
- Notification destinations are managed centrally in Settings and shared by Backup Manager and Uptime Monitor.
- Maintenance checks continue to run, but incident transitions and notifications are suppressed and maintenance time is excluded from availability.
- Unknown periods caused by the local worker being offline are reported as monitoring-coverage gaps, never as successful uptime.

## Delivery Tasks

### 1. Documentation and Work Log

- Maintain this decision-complete implementation plan.
- Update `PROGRESS.md` after every completed task with changes, verification, remaining work, decisions, and errors.

### 2. Uptime Domain and Storage

- Create an `uptime-monitor` module rather than adding more domain logic to `main.js`.
- Add a versioned SQLite control store under `userData/uptime-monitor/control.db`.
- Store workspace-scoped monitors, checks, incidents, maintenance windows, daily rollups, worker heartbeats, notification-route assignments, and migration markers.
- Add revision-based updates, workspace isolation, indexed time-range queries, integrity checks, and safe concurrent persistence.
- Import existing project-embedded monitors and their NDJSON history/incidents once; retain legacy files as recovery evidence after migration.

### 3. Monitor Engines and Policy

- HTTP supports GET, HEAD, POST, PUT, PATCH, DELETE, redirects, headers, request bodies, expected status ranges, header rules, contains/not-contains rules, JSONPath assertions, latency thresholds, and TLS verification.
- TCP validates connection establishment and latency.
- TLS validates handshake, hostname, issuer, validity, and expiry thresholds.
- Store sensitive request values through encrypted secret references and redact them from results, logs, notifications, and exports.
- Implement configurable failure/recovery thresholds, warning versus critical conditions, per-monitor timeouts, and sanitized diagnostic evidence.

### 4. Background Worker

- Replace the inline sequential loop with a tested scheduled worker service.
- Persist `nextCheckAt`, prevent overlapping runs for the same monitor, cap concurrency at eight, and run at most one missed check after restart.
- Record worker heartbeat and coverage gaps, reconcile interrupted work, and survive individual check failures.
- Preserve Windows start-at-login behavior, expose its state in Settings, and make notification clicks open the relevant incident.
- Keep Backup Manager scheduling operational while the Uptime worker is refactored.

### 5. Shared Notifications

- Generalize the existing Backup notification service while preserving route IDs, secrets, event selections, retries, and delivery history.
- Add Uptime events for warning, incident opened, escalated, acknowledged, resolved, TLS expiry, and worker health.
- Add idempotent delivery, bounded retry/backoff, route testing, enable/disable, event filters, and safe delivery evidence.
- Move route management to `Settings > Notifications`; Backup Manager keeps route assignment but no longer owns destination management.

### 6. Electron Interfaces and Migration

- Expose preload APIs for monitor CRUD, run-now, history, incident acknowledgement, maintenance CRUD, reports, exports, worker status, and notification routes.
- Return stable error codes and safe messages across IPC.
- Emit identity/state events and reload authoritative records rather than trusting event payloads as stored state.
- Migrate legacy monitor configuration without duplicate imports or destructive cleanup.

### 7. Uptime User Interface

- Use a full-width operational shell matching Backup Manager with Overview, Monitors, Incidents, Reports, and Maintenance tabs.
- Add fleet KPIs for health, availability, latency, incidents, and monitoring coverage.
- Add searchable, filterable, sortable monitor tables and bulk run/pause/resume/delete actions.
- Replace raw JSON inputs with a three-step editor for target, conditions, and schedule/alerts, including a test-before-save action.
- Add monitor detail charts, checks, incidents, configuration, and notification-delivery evidence.
- Add incident acknowledgement and maintenance scheduling workflows.
- Add `Settings > Notifications` and `Settings > Monitoring` panels.

### 8. Reports and Exports

- Support 24-hour, 7-day, 30-day, and custom report ranges with workspace, group, server, and monitor filters.
- Calculate availability from confirmed incident duration over eligible monitored time.
- Calculate coverage separately and exclude paused, maintenance, and unknown periods from availability.
- Include downtime, incident counts, p50/p95/p99 latency, failure categories, daily trends, and monitor comparisons.
- Export explicit CSV datasets for summaries, checks, incidents, and daily rollups.
- Generate stable PDF reports with the selected period, filters, charts, incidents, SLA result, coverage, and methodology.

### 9. Verification and Acceptance

- Unit-test validation, all check engines, assertions, incidents, maintenance, rollups, retention, coverage, reports, redaction, and migrations.
- Test worker concurrency, duplicate prevention, restart reconciliation, missed schedules, stale heartbeats, and workspace isolation with controlled clocks.
- Extend notification tests for all Uptime events, filters, retry, idempotency, and preserved Backup behavior.
- Add Electron tests for monitor creation, test-before-save, bulk actions, incidents, maintenance, Settings routes, reports, and exports.
- Verify multiple targets run independently after the window closes, Windows and configured channel alerts are delivered, recoveries resolve incidents, and dashboard/PDF/CSV metrics agree.

## Deferred After Core Release

- Hosted multi-region probes and cloud scheduling.
- DNS, ICMP/ping, UDP, domain expiry, heartbeat/cron, page-speed, and server-resource monitoring.
- Playwright browser journeys, screenshots, video, traces, and monitoring as code.
- Real-user monitoring, public status pages, subscribers, SMS, voice, and on-call rotations.

## Constraints

- Do not run `npm run dev`, any development server, or build commands.
- Preserve existing user changes and Backup Manager behavior.
- Use targeted Node and Electron tests in proportion to each completed subsystem.
- A task is complete only when implementation and task-specific verification evidence are recorded in `PROGRESS.md`.
