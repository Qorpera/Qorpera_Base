# One-shot runner startup cleanup

The provider previously restarted a guest that powered off before reporting its
assignment inbox ready. Reconciliation treated a `starting` journal as permission
to start again, despite the signed runner unit using `Restart=no` and powering off
the guest on exit. Retrying acquisition could also revive a powered-off registered
guest or a guest already marked for cleanup.

The provider now writes a `bootstrapping` journal before invoking the bootstrap
unit. Reconciliation and acquisition retries observe that startup without
invoking the unit again. Only a `creating` guest with no recorded start intent can
be started or recreated. Missing guests after a start intent are recorded as lost.
Powered-off guests after a start intent are retired. Startup failures and
cancellation record `stopping` with `delivery_failed`; reconciliation completes
guest deletion and preserves custom identity and recovery volumes. Acquisition
cannot replay stopping, stopped, or lost runs.

Journal replacement syncs the file before rename and the parent directory after
rename. The readiness transport reports an observed powered-off guest immediately
instead of consuming the five-minute readiness deadline. No additional guest
process probes run inside the provider mutex.

An interruption after writing bootstrap intent but before invoking systemd is
intentionally ambiguous. Recovery observes readiness; if the unit never started,
the bounded readiness failure sends the guest to cleanup. It does not invoke the
runner a second time. An interrupted initial VM creation remains recoverable.

Local validation on 2026-09-06 reproduced two VM starts in the regression before
the fix. The provider, provider-service, and orchestrator tests then passed all 86
cases. Regressions cover startup poweroff, cancellation, provider interruption,
deletion failure, acquisition replay, missing guests, initial creation recovery,
and retained volumes. `npm run check` passed. The Linux x64 provider package is
`5a191a0613e2ab019cc6ea2b379a6b9b37e48d86f48f2244afb469cc3bd331eb`.

Deployment must pause Company41 execution, confirm no active jobs, leases, or job
guests, and verify existing terminal journal hashes before replacing the host
provider. Keep the v8 signed image, guest package, runtime bundle, credentials,
and journal configuration unchanged. Older providers reject the new journal
state; do not downgrade across unfinished startup journals. Local tests do not
constitute the admitted live startup-failure acceptance proof.
