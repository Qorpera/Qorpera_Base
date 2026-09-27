# Coding storage boundary acceptance

The paid workload matrix proves physical coding-machine accounting, but currently bypasses `LxdCodingExecutorHost.prepareWorkspace`, repository seeding and session command execution. Before extending it, the dedicated storage probe tests whether the deployed root-squashed NFS layout can satisfy the existing guest helpers.

Dispatch `.github/workflows/step2-lxd.yml` with only `coding_storage_probe=true`. Its separate concurrency group does not cancel an office or accounting run. The reusable workflow installs the same reviewed LXD revision, then runs:

```sh
sudo env PATH="$PATH:/snap/bin" GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted GITHUB_SHA="$GITHUB_SHA" \
  node scripts/acceptance/coding-storage-physical.mjs --out "$RUNNER_TEMP/coding-storage-probe"
```

This CLI deliberately requires an empty disposable GitHub-hosted Linux machine with KVM, systemd, Node, LXD and NFS tools. It refuses existing instances, storage pools and exports. No production host or company is contacted. The VM uses one CPU and 1 GiB. Budget about five minutes after dependencies; image download can add several minutes.

The evidence separates two observations:

1. The actual executor-owner 1100 directory has mode0700 on hard NFSv4.2 with `nosuid,nodev,root_squash`. Both root and owner1100 attempt to read the same private sentinel. This tests host traversal without inferring a QEMU outcome from it.
2. Only host ancestors are then made traversable (0755) to isolate guest behavior. This is explicitly **not host NAS admission**. The two session roots remain owner1100/mode0755; repository/home/cache are the exact session UID200000/mode0700; inbox/logs/commands/git remain root-owned0755. Production packages and guest checks are unchanged. The probe invokes storage configuration installation, storage initialization and Git transfer preparation, and separately verifies the session user can write the real virtiofs-backed workspace. The Git request is explicitly staged on the server to isolate subsequent dynamic supervisor writes; that does not prove the production inbox upload path.

Each package artifact is hash-checked on the host and in the guest. Evidence includes actual NFS export flags, host and guest mountinfo, ownership, helper exit codes, the base-image fingerprint, Node binary hash, physical UUID and bounded LXD/QEMU/virtiofs diagnostics. Ubuntu's downloaded base fingerprint is recorded; this is an unsigned diagnostic image, not release-image provenance.

Exit0 means both unchanged helpers and root-owned custody creation succeeded. Exit2 means the probe completed and specifically proved that the session user can write while root-supervised custody cannot. Exit1 means infrastructure, ownership or another helper failure made the diagnosis inconclusive. A refused helper alone is never classified as proof. The workflow remains red for incompatibility and uploads `evidence.json` even then.

The probe retains its owned filesystem/export when physical cleanup cannot be confirmed. No filesystem is removed before the VM is deleted and the NFS mount is unmounted. Hosted-runner destruction is the final boundary after cleanup failure.

## Interpretation and next boundary

No physical result is claimed merely because this probe or its classification tests exist. `root_squash` maps root filesystem operations to an anonymous server identity; precreating static directories does not automatically authorize creation of new root-owned command/transfer receipts or log-file ownership changes. The production helpers require those operations dynamically. A negative result requires an explicit storage-identity design, such as a verified guest-to-host UID mapping or a trusted storage supervisor; do not change export policy or relax ownership checks to make acceptance pass. No suitable UID mapping is configured by the current coding VM device plan.

Once that boundary is resolved, extend the existing matrix with a sibling case calling the real workspace, lease, command and detach stack against a bounded local Git fixture, and retain the same independent paid-usage oracle. That scope can prove actual checkout/edit/test/commit, session-volume persistence and debit without model spending. Real GitHub connection custody, PR publication, agent dispatch/follow-up, remote NAS durability, and full installed coding-service acceptance remain separate observations.
