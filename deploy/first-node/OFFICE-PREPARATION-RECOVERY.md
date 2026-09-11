# Office preparation transport recovery

LXD 6.9 VM execution with `record-output: false` can close its agent control
connection immediately and kill the command (exit 137). Office controls use
recording with fixed, nonsecret diagnostics. A separate observer retains real
terminal results while lifecycle reconciliation performs cloud and storage IO;
LXD removes completed operations after five seconds. Missing operations remain
unknown. The observer never submits commands or manufactures completion.

An existing unknown or failed **preparation** command requires an explicit
operator recovery. The ordinary provider does not retry it. Keep the original
authority, dispatch, acceptance, request, boot and adoption records unchanged.
Do not use this procedure for configuration, service start, stop or reboot.

1. Stop the office provider and acquire its existing lifecycle flock as the
   dedicated provider user. Verify the same allocation, physical VM, current
   boot, protected incoming request, adopted copy and current cloud authority.
   Check the pinned preparation controller's guest claim and kernel-lock
   semantics before proceeding. Reusing its exact command cannot start its
   preparation unit twice: an existing claim only permits completion inspection.
   Never remove its claim, result, receipt or installed request to force a retry.
2. Publish a root-owned protected file at
   `<storage-review-path>.preparation-recovery`, with these closed fields:
   `schema: qorpera.lxd-office-preparation-recovery/v1`, a fresh UUID `recoveryId`,
   `identitySha256` (officeDigest of the original preparation authority excluding
   `schema`), `originalOperationId`, and `acceptedSha256` (SHA-256 of the original
   `000001.json` bytes). Preserve the review as recovery authority.
3. Create a private, provider-owned recovery root at
   `<journal>/preparation-recovery-<allocationId>-<recoveryId>`. Open a new
   `LxdOfficePreparationJournal` there with the **identical original identity**.
   With fresh cloud/physical authority and exact incoming-byte readback, submit
   its fixed controller once through `LxdUnixClient.submitOfficePreparation`.
   Persist acceptance and poll/retain its actual exit promptly. An uncertain
   recovery submission is not permission to replay it.
4. The regular preparation worker consumes only a succeeded recovery journal
   with a different LXD operation ID and matching protected review. It then
   independently rechecks the guest completion, report, adoption receipt,
   current boot and cloud/physical authority before advancing. Its observation
   names the actual recovery operation. Removing or changing the recovery
   authority or either journal fails closed. Restart the provider only after
   this verification passes.

This procedure installs no new signed guest code, bypasses no admission check,
and grants no capacity release or ordinary service activation. Operator receipts
must record the original failed/unknown attempt and the separate actual recovery.
