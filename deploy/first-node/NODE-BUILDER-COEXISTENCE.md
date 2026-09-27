# Image builders alongside ordinary computer wakes

An image builder is host infrastructure, not a company allocation. An unregistered builder makes complete-host inventory unavailable, and the ordinary node reservation gate then refuses wakes. Do not ignore its project, name prefix or public marker. Existing infrastructure enrollment can account for the exact builder without changing the observer or placement rules.

`scripts/prepare-node-builder-inventory.mjs` creates an **offline review proposal**, not an executable deployment. It accepts one or two explicitly reviewed, stopped VM identities, checks them against a complete inventory using the production reconciler, preserves existing policy and allocations, and requires operating plus infrastructure reservations to fit current headroom. Raw VM configuration is not copied to the proposal. Unknown machines, different resource limits, UUID/configuration drift, missing builders, runtime metadata, autostart and insufficient headroom are refused.

## Inputs and use

Use Node 24 from a source checkout:

```sh
node scripts/prepare-node-builder-inventory.mjs private-input.json new-plan.json
node --test scripts/node-builder-inventory-plan.test.mjs
```

`private-input.json` has exactly four fields:

- `context`: exact current `qorpera_runtime_node_inventory_context(node_id)` result.
- `inventory`: complete `LxdHostInventoryClient.inspectHostInventory` result from the pinned host/daemon, not a hand-selected VM list. Keep this source evidence private because raw LXD config may contain credentials.
- `previousPolicySha256`: enrolled database policy digest. This is the PostgreSQL JSONB digest; **do not substitute a file SHA or `officeDigest`**.
- `builders`: reviewed `RuntimeNodeInfrastructure` records, each containing `project`, `name`, `physicalId`, `type`, `configurationSha256`, `cpuMillis`, and `memoryBytes`. The configuration digest comes from `runtimeNodeInstanceConfigurationSha256` over reviewed local/effective config, devices and profiles. A current scan is evidence for review, not permission to enroll arbitrary discovered VMs.

The output is exclusively created mode 0600. It records the expected context/node version, previous policy, replacement RPC arguments and complete infrastructure budget. It neither calls RPCs nor starts VMs. The operator must verify freshness and custody; the helper cannot infer those from a JSON file. A plan is not a node-admission receipt.

Builder plans must set `boot.autostart=false` locally and effectively. Use an ordinary build marker such as `user.image-build-purpose`. Existing infrastructure reconciliation rejects `user.qorpera.*` runtime metadata; the helper also refuses the historical `user.qorpera.purpose` marker and the management-VM exception for builders. Choose the correct metadata **before creating** the new VM. Do not relabel a managed machine to bypass its allocation.

## Guarded operator sequence

1. Pin the chosen host, source/artifacts, reviewed builder resource/device/network shape, current node version, inventory policy digest, observer configuration and installed observer code. Review guest isolation: no company/identity disks or production credentials mounted into the builder. Review peak disk/RAM/CPU use independently of admission arithmetic. Preserve existing reservations, provider journals and policy history.
2. Calculate operating reserve + all enrolled infrastructure + all planned builders/verifiers, including absent/stopped entries. If current headroom is insufficient, prepare a **temporary node-budget CAS** with sufficient headroom. Never lower operating reserve to make a builder fit. The ordinary configure RPC must refuse a budget that cannot accommodate existing allocated machines. Wait for natural release or select another node if needed.
3. Briefly disable new admission by exact version CAS and allow issued admission windows/dispatches to settle. Recheck pending/uncertain creates and starts. The node reservation lease is at most five seconds; a fixed sleep alone is not evidence that a dispatched command settled. Keep active guests and their allocations intact. Set temporary headroom, create the exact new builder **stopped**, and independently inspect it.
4. Obtain fresh complete inventory and SQL context under that hold. Prepare/review the helper output. In the application transaction, lock the node and current inventory-policy row, assert node still disabled, node version/context/previous policy unchanged, then call `qorpera_replace_runtime_node_inventory`. Keep the returned digest and policy-history receipt. Existing RPC history and prior-digest CAS are authoritative; no direct row rewrite or new migration is needed.
5. Install only the matching reviewed observer configuration through its protected, pinned operator path; preserve endpoint, credential, socket/host identity and unrelated configuration. SQL and local policy can differ briefly **only while admission is held**. A fresh ordinary observer publication must match the new policy and current node version. Do not fabricate a ready record or replay a previous timestamp.
6. Restore the original enabled setting by exact CAS while retaining temporary headroom. That CAS invalidates the prior receipt: wait for another **fresh current-version inventory** before normal work. Start the builder via its reviewed executor after rechecking exact UUID/config and policy. The ordinary observer must continue reporting the running builder as infrastructure with full cost. Ordinary wakes remain subject to their normal authority and available-capacity gates.
7. Sealing often changes profiles, config or devices; those changes invalidate the exact configuration pin. Return to the admission hold and stopped-builder protocol before each such phase, with a reviewed replacement pin and fresh observer publication. A verifier is a separate VM/reservation; enroll it independently or remove the builder first. Never broaden a digest comparison to accommodate drift.
8. After confirmed stopped deletion of each exact builder/verifier, retain independent absence/deletion evidence. Absence by itself does not release infrastructure headroom. Under the same hold, replace the inventory policy to remove only those reviewed reservations, reconfigure the observer, then restore the exact original node budget/enabled setting by current-version CAS. Keep all intervening history. Require a final fresh ready observation and verify ordinary allocations unchanged.

Every mutation uses an exclusive intent/result receipt and stops on an uncertain outcome. Do not rerun an uncertain create, replacement or start automatically. If enrollment/configuration/start fails, preserve the builder and its charge until the actual outcome is established. If a builder is still present, restoring the old policy would correctly make the node unavailable; do not call that a completed rollback.

## Acceptance and proof limits

The focused regression demonstrates the previously unavailable unregistered-builder scan becoming ready only with exact reviewed enrollment. It verifies stopped/running/absent charging, an existing office allocation remaining unchanged, and refusal of substituted UUID/configuration, changed limits, runtime markers, unknown VMs, frozen/running enrollment, autostart, insufficient headroom, duplicate IDs and allocation collisions. The existing inventory test suite exercises ordinary observer publication and fail-closed reconciliation.

Physical acceptance still requires one real ordinary office wake (or native allocation on the selected builder host) while the enrolled builder is running, with saved current-version inventory, full infrastructure charge, capacity result, operation/activation identity and process evidence. Also prove a harmless planned builder-config drift in an isolated test lane fences admission and a reviewed re-pin restores it. Do not inject a drift into an active production builder for demonstration. Unit tests and a ready snapshot do not establish this live wake acceptance.

No deployed observer, runtime bundle, SQL schema or production configuration changes are made by this source change. Existing long-running image executors that require admission disabled throughout must be separately adapted and reviewed before using this workflow; this helper does not waive their preconditions.
