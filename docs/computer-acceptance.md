# Paid computer acceptance

The manual `Step 2 LXD contracts` workflow has a `real_lxd_acceptance` input. Its default is false; ordinary pull-request runs remain contract tests. Select true to exercise the production guard on a disposable GitHub-hosted Ubuntu host with systemd and an actual nested-KVM LXD VM.

```sh
gh workflow run step2-lxd.yml --ref <reviewed-branch> -f real_lxd_acceptance=true
```

The job checks actual KVM VM creation, installs the reviewed LXD revision, and refuses an initialized LXD host or existing instances. The harness creates one temporary Ubuntu VM and uses the production systemd guard unit with its executable path redirected to the candidate bundle. It starts the VM, kills the guard process, checks automatic restart with the original deadline, replays the original arm request, then leaves the guard to stop the physical VM without a provider or renewal process.

The second phase starts the VM with a fresh permit and routes the production guard's LXD connection through a transparent Unix proxy. It withholds responses around the scheduled stop, checks that guard IPC and systemd remain responsive, and independently confirms that the VM is still running with no false stop receipt. Restoring transport must allow a confirmed physical stop before the original deadline. This bounded fault does not prove enforcement during indefinite LXD unavailability.

The uploaded `evidence.json` records the source commit, image fingerprint, guard bundle and unit hashes, physical start operation, restart observations, deadline and actual stop receipts. A pass requires independent LXD confirmation and stop receipts before the paid deadlines. The harness removes its VM on exit; the disposable runner is the final cleanup boundary.

This uses synthetic control-plane permits. It proves the physical guard boundary, not SQL funding, Stripe accounting, full office recovery or deployed host/image parity. GitHub-hosted nested virtualization is experimental; a missing capability fails the job instead of substituting containers or mocks. Disk exhaustion, archive restart latency and the complete office guest/provider/SQL path need separate physical acceptance.

Stripe acceptance must use a test key and a separate database. Evidence must distinguish genuine Stripe canonical objects replayed with local signatures from actual Stripe-to-endpoint webhook delivery. Hosted Checkout creation is not payment completion. A paid invoice and its exact replay must fund one period only; renewals, failed payments and cross-company pooling need their own assertions. Production offer and accounting flags stay disabled until the complete rollout gates pass.

See [computer billing setup](computer-billing-setup.md) for the agreed plans, authority boundaries and remaining launch gates.
