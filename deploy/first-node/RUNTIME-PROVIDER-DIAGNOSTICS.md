# Office provider diagnostics

The standalone office provider emits closed
`qorpera.lxd-office-provider-observation/v2` records to its standard output.
With the default systemd journal output, an authorized host operator can inspect
them with `journalctl -u qorpera-office-provider.service -o cat`. Journal access,
storage and rotation follow the host's systemd journal configuration. This is
optional diagnostic retention, not the immutable allocation/operation journal;
the runtime does not promise retention after journal rotation or host loss.

Each record includes company, environment, office computer, logical computer,
generation, provider, host machine hash, provider policy hash and guest package
manifest hash from the protected physical policy. The installed provider's own
exact package remains recorded in its protected installation receipt. No raw
policy, host paths, credentials, private challenges or backend errors are logged.

Settled reconciliation records name the known intent, phase, transition and
activation when available. A typed failed phase reports `PHASE_FAILED`. An
exception reports `RECONCILIATION_UNCONFIRMED`, with unknown phase/intent rather
than carrying a previous poll's identity forward. `observedAt` is the original
time the diagnostic was formed; it is not an exact VM transition timestamp.
Existing acknowledgement times retain their separate field and meaning.
Resource release is never inferred from any logged result.

Repeated identical results are suppressed after a successful write. These are
change observations, not heartbeats or proof of current health. At most one
write is pending. A stalled writer drops intervening diagnostics and cannot
block reconciliation or create a queued backlog. A failed writer can be tried
with the next fresh observation; earlier records are not replayed or restamped.
Synchronous exceptions and asynchronous rejections in result/error observers are
contained, and a broken standard-output stream cannot terminate the provider.
Missing log records must remain missing evidence, not a healthy outcome.

VM dispatch, acceptance and terminal-operation records also have a separate
read-only journal history command. New v2 events preserve provider clock times;
old v1 event bytes remain unchanged with unknown times. See
[RUNTIME-PROVIDER-OPERATION-HISTORY.md](RUNTIME-PROVIDER-OPERATION-HISTORY.md).
This retained operation history is distinct from optional reconciliation logs
and does not establish service readiness, physical transition time or release.

Named tests cover identity/time, stalled writers, recovery, clock failure and
continued reconciliation after both result and error observers fail. Actual
packaged Linux/systemd acceptance checks these identities in the journal across
a registry outage and recovery, while preserving service PID, zero capabilities,
kernel lock and installed files. The registry is synthetic and requests idle
status only; this does not prove real LXD provisioning or physical transitions.

The operator query described in [RUNTIME-COMPUTE-REQUESTS.md](RUNTIME-COMPUTE-REQUESTS.md)
combines retained office/login/native requests, placement and admission refusals,
including requests without allocations and typed native dispatch failures.
Physical provisioning outcomes remain in provider diagnostics; missing outcomes
stay unknown. These local records provide attributable office-provider outcomes
for investigation without introducing a new SQL export dependency.
