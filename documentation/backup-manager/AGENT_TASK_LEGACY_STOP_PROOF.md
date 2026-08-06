# Agent task: InfluxDB 3 Enterprise legacy stop proof

Implement a genuine, fail-closed cluster stop-proof primitive in new isolated files under `src/backup-manager`.

- Use exact per-node tested SSH bindings and systemd unit identities.
- Verify the requested cluster ID and node-ID set exactly match the configured bindings.
- Open each current-device, successfully tested SSH connection through the existing SSH execution helper.
- Query `systemctl show` with bounded output and require `ActiveState=inactive`, `SubState=dead`, and `MainPID=0` for every exact unit.
- Recheck every node before returning proof so a node cannot restart during the proof window.
- Return only sanitized node IDs, unit names, timestamps, and an authenticated proof digest. Do not expose hosts, SSH IDs, commands, paths, or credentials.
- Fail closed on missing, duplicate, stale, foreign-device, running, ambiguous, malformed, or changed bindings.
- Add focused tests covering success, running/restarting nodes, binding mismatch, stale SSH identity, malformed output, cancellation, and redaction.
- Do not edit `src/main.js`, `src/preload.js`, renderer files, or existing Enterprise modules. Report exports and test results to root.
