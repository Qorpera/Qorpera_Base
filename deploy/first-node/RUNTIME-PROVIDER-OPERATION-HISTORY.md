# Retained office VM operation history

New office VM operation records use `qorpera.lxd-office-operation-event/v2`.
The existing mandatory journal retains dispatch before transmission, acceptance
before polling, and the first observed terminal outcome. Each new record also
retains the provider clock time when its bytes were formed. Querying, reopening,
replaying a completed command or retrying diagnostics never refreshes that time.

The reader accepts original v1 records and mixed v1/v2 hash chains. Old records
retain their exact bytes and have unknown timestamps. New records append to the
original chain. A failed/invalid clock produces a null time with an explicit
`clock_unavailable` source; it cannot prevent mandatory dispatch custody.
Clock corrections can move time backward, so journal sequence remains the
ordering authority. Invalid retained timestamp metadata makes the journal
unconfirmed; it is never silently repaired. Older provider binaries cannot read
new v2 records, so downgrading after new writes is unsupported.

An authorized operator can run the installed package as the dedicated provider
user that owns its private journal:

```text
/usr/bin/node /opt/qorpera/office-provider/qorpera-office-provider.cjs \
  --journal-history /absolute/journal/root allocation-uuid
```

Use the `journal.path` from the protected physical policy as the root, and the
existing allocation UUID. The read-only command validates directory/file owner,
modes, links, original authority and the ordered hash chain. It creates no files,
loads no credentials and contacts neither LXD nor SQL. It does not need the
service's mutation lock. A concurrent append can expose a consistent earlier
prefix or make the read temporarily unconfirmed; retrying the read never repairs
or mutates the journal. The journal's existing 384-event bound applies.

The closed JSON result links company, environment, office/logical computer,
generation, allocation, intent, provider, provider policy, guest image/bootstrap,
commands and exact provider operation IDs. It includes the journal head hash,
sequence, operation stage/outcome, typed reason and original time/source. It
excludes the workbench path, network/storage configuration, raw errors and
credentials. Runtime-bundle identity is not recorded in this physical journal
and stays explicitly unknown; the run/request and service records provide their
separate provenance. File access and retention follow the protected provider
journal; no automatic pruning or remote export is added.

These are **provider operation records**. Successful create/start/stop/delete
operations do not by themselves prove guest service readiness, fresh physical
postconditions or released capacity. Those checks and the exact allocation
release record remain separate. `physicalTransitionAt` is null: the local record
time is not an invented instant when a VM changed physical state. Historical
gaps cannot be reconstructed from current state or filesystem modification time.

Named journal tests cover original times, lost replies, reopen, inert replay,
mixed-format custody, clock failures/corrections, malformed records and no-write
history access. The packaged CLI test reads an actual generated journal under
the hardened Node flags and verifies unchanged bytes. Daemon outcomes in these
tests are explicit fixtures. Repeated provider/SQL lifecycle acceptance retains
its separate scope; none of these tests claims deployed physical transition
timestamps or VM-destruction durability.
