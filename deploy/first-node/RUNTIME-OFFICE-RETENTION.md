# Office diagnostic retention and maintenance boundary

The enabled office service does not delete its VM or root disk. Its ordinary
service restart, explicit power-off and reboot/resume transitions preserve
`/var/lib/qorpera-office-events`. The systemd unit creates that private state
directory with mode 0700; it is outside all model-visible workbench/profile
mounts. The outbox fsyncs original observations and removes a pending record
only after an exact canonical or separately unconfirmed SQL retention receipt.
Export failures do not block ordinary work or discard queued transitions.

The implementation boundary is concrete:

- `LxdOfficeLifecycle` composes creation, inventory, adoption, boot,
  preparation, configuration, activation, service stop/restart, power-off and
  resume workers. Its VM-operation journal call sites dispatch only `create`,
  `start` and `stop`.
- An explicit `replace` request can revoke admission and stop the service,
  then remains `held`. It does not proceed to a deletion or replacement
  worker. The lifecycle test checks this behavior even when preparation is
  disabled, with no successor dispatch.
- The low-level operation journal recognizes a `delete` action, but the
  production office supervisor does not dispatch it. Native job VM retirement
  in `lxd-provider.ts` belongs to the isolated execution provider; it is not
  shared-office deletion.
- No viewer disconnect, expired lease, shutdown request or stopped observation
  releases the office's machine allocation. Release authority is separate.

Current evidence includes actual private disk-queue reopen/replay, SQL retention
after authority revocation/stop, whole Linux guest work while export is offline,
and actual systemd state-directory preservation across service restarts. These
tests establish retention for the enabled lifecycle. The container-loss
Company File proof does not exercise screen-record recovery and must not be
cited as doing so.

## Destructive maintenance and host loss

Manual deletion of a VM/root disk can destroy undelivered records. Automatic
office deletion/replacement and host failover are not implemented or accepted.
They must not be enabled by treating the journal's low-level action enum as a
complete lifecycle workflow. Before destructive maintenance, retain the private
state directory outside the affected root disk, or verify exact delivery of
every pending record. Preserve original scope, startup identity, record text,
ownership and permissions; do not place this archive on the model-visible
workbench or copy it into Company File content. A directory copy alone is not
evidence of successful cloud delivery.

Recovery must use the original events and receipt-verifying outbox path.
Events first delivered after authority loss remain separately classified as
unconfirmed. Recovery must not fabricate closing times, promote uncertain
observations to measured usage, reactivate stale authority or release capacity.
If the root and its only retained copy are lost, missing lifecycle intervals
remain unknown. A future destructive provider workflow needs an explicit,
tested custody handoff before deletion; this audit does not claim that handoff
exists.

This distinction closes the question of accidental deletion by the currently
enabled supervisor. It does not accept destructive maintenance, actual-host
durability or a complete host-failure programme. Those remain live/future
acceptance gates under the runtime contract's stated scope.
