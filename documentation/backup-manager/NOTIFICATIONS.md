# Backup Manager Notifications

## Status

- Task: `BM-207`
- Status: Implemented
- Last updated: 2026-08-03

## Scope

Backup Manager routes terminal backup outcomes, overdue recovery-point-objective events, and terminal repository/recovery verification outcomes. Notification delivery is operational side work: a provider failure is recorded but never changes a Run or VerificationRun result.

Supported route types are desktop notifications, SMTP email, generic HTTPS webhooks, Slack incoming webhooks, and Microsoft Teams workflow webhooks. A Policy may reference up to 20 enabled routes. Routes are reusable across jobs in the same workspace.

## Event Catalog

| Event | Produced when |
| --- | --- |
| `backup.succeeded` | A backup Run commits successfully |
| `backup.warning` | A backup Run completes with warnings |
| `backup.failed` | A backup Run reaches terminal failure, including exhausted retries |
| `backup.rpo-overdue` | An enabled job with an RPO target has no successful backup inside that target |
| `recovery-test.succeeded` | A checksum or sampled-restore VerificationRun succeeds |
| `recovery-test.warning` | A VerificationRun completes with warnings |
| `recovery-test.failed` | A VerificationRun fails, including restart reconciliation |

Canceled and retryable interrupted Runs do not emit terminal outcome events. An interrupted scheduled Run emits `backup.failed` only when retry finalization makes it terminal.

## Route Configuration And Secrets

Public route records contain the route name, type, enabled state, selected events, non-secret destination metadata, delivery summary, and optimistic revision. They never contain SMTP passwords or webhook URLs.

- Desktop routes store only the `silent` preference.
- Email routes store SMTP host, port, TLS mode, optional username, sender, and normalized recipients. The optional password is stored as a device-bound encrypted SecretRef.
- Webhook, Slack, and Teams routes store only destination host and insecure-HTTP policy. The full URL is a device-bound encrypted SecretRef.
- Webhooks require HTTPS unless the user explicitly permits HTTP or uses a loopback endpoint. URL credentials and fragments are rejected.
- Deleting a route transactionally removes it from every Policy before soft deletion, then removes its SecretRefs from secure storage and the control database.

Route creation and mutation are audited. Workspace and actor identity are always derived in the main process.

## Delivery Contract

Every event has a stable event key. Successful delivery for a route and event key is idempotent: replay returns the existing successful record instead of calling the provider again. A failed delivery records a safe error, attempt number, and optional next-attempt time. Retry deferral uses bounded exponential delay starting at five minutes and capped at six hours.

Each route retains its newest 100 delivery records and a `lastDelivery` projection. The workspace delivery query merges routes newest-first and returns at most 500 entries. Provider responses, authentication values, webhook URLs, and transport exception details are not projected.

Provider payloads are intentionally bounded:

- desktop: title, body, and silent preference;
- email: a plain-text subject/body message using the configured sender and recipients;
- generic webhook: schema version, event identity, time, severity, bounded resource IDs, and details;
- Slack: text plus a single section block;
- Teams: one Adaptive Card message attachment.

Delivery calls have a 15-second default deadline. SMTP uses the current `nodemailer` transport. Webhook delivery uses the runtime fetch implementation and rejects unsuccessful HTTP responses.

## RPO Semantics

`Policy.objectives.rpoMinutes` is optional and bounded from 1 to 525,600 minutes. The persistent scheduled worker evaluates RPO state on every tick, whether or not a backup is due.

The baseline is the newest succeeded Run for the job. If none exists, the job creation time is the baseline. A job is overdue when current time is later than baseline plus its RPO target. The event key includes the successful baseline, so only one overdue event is delivered for that baseline. A later successful backup establishes a new baseline and permits a future overdue event. Disabled jobs, disabled policies, and policies without an RPO target are ignored.

`BM-208` adds the matching current RPO baseline, an 80% at-risk threshold, RTO evidence, and Overview reporting. Status reads do not dispatch notifications or alter event idempotency.

## User Interface

The Policies tab lists full-width notification routes with channel, safe destination summary, event count, enabled control, latest delivery status, test action, and confirmed delete action. Recent delivery attempts show route, channel, attempt, status, and time. The Add route modal switches among desktop, SMTP, and webhook-family fields and requires at least one of the seven supported events.

The backup-job Protection step accepts optional RPO and RTO targets plus any enabled notification routes. Review shows all selected values before creation. Backend validation repeats route existence, enabled state, uniqueness, count, and objective bounds so stale or manipulated renderer state cannot create an invalid Policy.

## IPC Surface

- `backup:notifications:routes:list`
- `backup:notifications:routes:create`
- `backup:notifications:routes:update`
- `backup:notifications:routes:delete`
- `backup:notifications:routes:test`
- `backup:notifications:deliveries:list`

All mutations are audited and workspace-scoped. No notification IPC accepts a renderer-provided workspace or actor ID.

## Deferred Work

- `BM-209`: job pause/disable/delete behavior and policy editing effects on routes.
- Later phases: objective trend and exported compliance views, provider-specific OAuth or enterprise connectors, escalation chains, quiet hours, digesting, durable cross-process delivery queues, and remote-worker delivery ownership.
