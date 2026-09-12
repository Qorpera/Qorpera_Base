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
  then remains `held`. Without a separate protected reset plan it does not
  proceed to a deletion or replacement worker. The lifecycle test checks this
  behavior even when preparation is disabled, with no successor dispatch.
- The only path that dispatches `delete` for an office is the governed
  same-allocation root reset described below. It requires an operator-authored
  `qorpera.lxd-office-reset-plan/v1` document beside the lifecycle plan
  (`<planPath>.reset`) that binds the exact retained `replace` request. Native
  job VM retirement in `lxd-provider.ts` belongs to the isolated execution
  provider; it is not shared-office deletion.
- No viewer disconnect, expired lease, shutdown request or stopped observation
  releases the office's machine allocation. Release authority is separate.

Current evidence includes actual private disk-queue reopen/replay, SQL retention
after authority revocation/stop, whole Linux guest work while export is offline,
and actual systemd state-directory preservation across service restarts. These
tests establish retention for the enabled lifecycle. The container-loss
Company File proof does not exercise screen-record recovery and must not be
cited as doing so.

## Governed same-allocation root reset

`LxdOfficeResetWorker` implements the retained-office reset design as one
serialized, forward-only phase chain on the existing allocation: `fenced`,
`stopped`, `custodied`, `powered_off`, `root_deleted`, `root_created`,
`restored`, `prepared`, `active`. Migration `20260912000900_runtime_office_reset.sql`
records the chain in `qorpera_runtime_office_resets` with hash-chained phase
events and nonce-bound five-second challenges (at most 64 per phase, no nonce
reuse). The reset retains the company, environment, computer, generation,
allocation, provider, node demand and preparation identity; it creates a fresh
root incarnation, a fresh boot, a distinct successor activation and a new
service invocation. Nothing about the allocation or node-demand rows changes.

Custody is provider-owned and root-only: `<archiveRoot>/<resetId>/` under a
directory that must not overlap the provider journal, the workbench mount or
any of the four adopted layout roots. Before power-off the worker archives
`/var/lib/qorpera-office-events` and the public stop-history root byte-exactly
(ownership, mode, length and digest are bound into the custody manifest), and
holds the four NAS layout roots by descriptor without reading, copying or
comparing their working contents. The custody digest is acknowledged to SQL
before any destructive command; a `.write-*` remnant in the outbox, a changed
NAS root or a differing archive holds the reset instead of continuing. After
`delete`/`create`/`start` the worker restores the archived files with their
original ownership and modes onto the fresh root, reads them back, and
acknowledges a restore receipt bound to the sealed custody digest and the new
boot. Every VM command is journaled under the retained operation journal; an
unknown dispatch outcome is held under the same command identity and is never
redispatched under a new one.

Boundary of the current implementation:

- The guest-side successor lane (configuration staging and ordinary service
  start on the recreated root through the protected root helpers) is not
  composed for production. The composed provider holds at `restored` with
  `OFFICE_RESET_GUEST_LANE_UNAVAILABLE`; the lane is an injected port used by
  tests. Successor credentials are provisioned through the existing protected
  authority path only when that lane is present.
- There is no automatic deletion, host failover, generation change or general
  update mechanism. The plan grants exactly one reset for one retained
  `replace` request; a plan for another predecessor is refused.
- The archive is never deleted by the worker. It is not delivery evidence: the
  outbox records are restored, not exported, and cloud delivery still follows
  the ordinary retention path from the recreated root.

## Destructive maintenance and host loss

Manual deletion of a VM/root disk can destroy undelivered records. Automatic
office deletion/replacement and host failover are not implemented or accepted.
They must not be enabled by treating the journal's low-level action enum as a
complete lifecycle workflow. Outside the governed reset above, before
destructive maintenance retain the private state directory outside the affected
root disk, or verify exact delivery of every pending record. Preserve original
scope, startup identity, record text, ownership and permissions; do not place
this archive on the model-visible workbench or copy it into Company File
content. A directory copy alone is not evidence of successful cloud delivery.

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
