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
  preparation, configuration, activation, service stop/restart, power-off,
  resume and retirement workers. Outside the reset and the retirement below, its
  VM-operation journal call sites dispatch only `create`, `start` and `stop`.
- An explicit `replace` request can revoke admission and stop the service,
  then remains `held`. Without a separate protected reset plan it does not
  proceed to a deletion or replacement worker. The lifecycle test checks this
  behavior even when preparation is disabled, with no successor dispatch.
- Two paths dispatch `delete` for an office: the governed same-allocation root
  reset described below, and the retirement of a deleted company's computer
  ("Office retirement" below). It requires an operator-authored
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

After the restore acknowledgement the worker composes the guest-side successor
lane on the recreated root through two new protected root helpers packaged with
the guest, `qorpera-company-computer-reset-configuration-control` and
`qorpera-company-computer-reset-service-start-control`, dispatched under the
same content-addressed staging, kernel-lock and single-command journal rules as
the retained-boot helpers (`reset-configuration-<allocation>-<activation>` and
`reset-service-start-<allocation>-<activation>` journals). The configuration
packet carries the exact original preparation document and fresh credentials
resolved through the existing protected authority path, with only the boot
attestation rebound; the helper binds them to the restored public receipt and
the restored predecessor stop history, restores `/etc/qorpera-office/preparation.json`
as allowlisted public provenance, refuses a root with any historical credential
directory or start/stop claim, installs the credentials only under the new
boot's directory and never starts a unit. The start packet is the SQL-prepared
reset successor itself; the start helper verifies the acknowledged reset
configuration, claims before `systemctl`, and answers nonce-bound inspections.
The provider measures the invocation and activates through
`qorpera_activate_runtime_office_reset_successor` inside one five-second
window, exactly as the other successor lanes do.

Boundary of the current implementation:

- The guest helpers are unit-covered only through the provider lane against a
  synthetic root; their Linux/systemd behavior on a real recreated root is not
  yet exercised by a disposable fixture and remains a live acceptance gate.
- A completed reset successor is a new activation lineage: the later stop,
  restart, reboot and second-reset evidence readers still expect an original or
  retained-boot predecessor and have not been extended to a reset-born
  activation. Lifecycle continuation after a reset is therefore unproven.
- There is no automatic deletion, host failover, generation change or general
  update mechanism. The plan grants exactly one reset for one retained
  `replace` request; a plan for another predecessor is refused.
- The archive is never deleted by the worker. It is not delivery evidence: the
  outbox records are restored, not exported, and cloud delivery still follows
  the ordinary retention path from the recreated root.

## Office retirement (company deleted)

`LxdOfficeRetirementWorker` retires the Company Computer of a company being
deleted (RUNTIME-COMPANY-DELETE.md, D3; migration
`20260929320000_runtime_office_retirement.sql`). It runs only after the
power-off worker's confirmed `powered_off` for a `power_off` transition with no
resume. SQL answers null while the company lives. For a deleting company SQL
issues one delete command id; the worker pins it in
`office-retirement-request.json` (with the power-off request) before anything
else. The pin binds the power-off completion and its seed, and the journal must
end with that stop, so the delete follows `[create, start, …, stop]` under the
VM lineage grammar. A durable nonce file records each requested five-second SQL
window (at most 64). Inside a window the worker rechecks that the VM is
`Stopped` (status code 102, LXD instance and state), then dispatches the one
journaled `delete`. It settles only on a settled delete and an absent VM:
`qorpera_retire_runtime_office` releases the allocation and node demand, drops
the node binding and marks the office `retired`. The worker then writes
`office-retired.json` from SQL's receipt. An unknown or failed delete is held
under the same command id and never redispatched.

Once pinned, the lifecycle runs only this worker, before any status call. SQL
answers the retirement from its ledger even after the company's purge, so a lost
release reply still reaches the marker. With the marker, the lifecycle, both
journal observers, the fleet unit and the root host-shutdown, host-resume and
credential-rotation guards make no call, and the provider service ends.

Retirement keeps no custody: by the founder's decision (28 September 2026) no
copy of a deleted company's machine is kept. The private
`/var/lib/qorpera-office-events` outbox is lost with the root, including
undelivered records. The workbench is a host directory and is not touched here
(deleted-company NAS queue, D5). Not retired, and held for an operator: a
computer created but never activated, one mid-reset, and one whose resume was
under way at the deletion.

## Destructive maintenance and host loss

Manual deletion of a VM/root disk can destroy undelivered records. Apart from
the retirement of a deleted company's computer above, automatic office
deletion/replacement and host failover are not implemented or accepted.
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
