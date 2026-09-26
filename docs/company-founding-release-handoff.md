# Company founding and paid computer release handoff

PR #326 is a source feature under the [runtime release train](../deploy/first-node/RUNTIME-RELEASE-TRAIN.md). Its earlier branch-only runtime activations were never deployed and are removed from the feature diff. Preserve master's released bundle and guest identity. Historical acceptance reports describe their recorded source commit; they do not certify a later merge or release.

The feature migrations run in dependency order from `20260927010100_company_multiple_founders.sql` through `20260927012500_computer_guard_usage_stream.sql`, after master's placement, coding lock-order, CPU-ratio, dynamic routine and review-rule migrations. This ordering matters: paid admission clones must inherit the current shared capacity policy. The capacity ratio does not change the independent 4-vCPU/8-GiB standard-hour tariff.

The coordinator's activation must require the complete feature migration chain, including founding provenance, billing bridge authority, paid prestart custody, terminal recovery, office outage recovery, funding caps and the durable guard stream. In particular, require `qorpera_record_computer_guard_samples(jsonb,text)` and the exact-current-running-tip renewal checks in both coding and runtime renewal functions. Older caller-supplied samples must not regain renewal authority after a newer running or gap sample. Presence of the upload RPC alone is insufficient.

Rebuild and review the native provider, coding executor, independent computer guards, office service package and applicable installers on Linux at the release commit. Re-pin the released guest and executable digests through the release lane. Feature packaging tests use the committed bundle identity and still check package contents, separation of credentials and supervisor configuration; their passes are not release freshness evidence. Production packagers keep strict freshness checks.

Before enabling checkout or paid runtime readiness, retain passing reports for the exact candidate:

- Native PostgreSQL migration application and paid accounting, concurrent spending, reversal and replay tests.
- Real Stripe sandbox purchases through the production client and billing handler, followed by two-founder consent, vision revision, noncreator launch and immutable startup publication.
- Physical Linux/LXD native, coding, office and excluded login workloads, including CPU- and memory-dominant shapes, shared machines, pooled funding, sustained renewal, capture gaps, process restart, disk exhaustion and terminal reconciliation.
- The materialized founding run reaching the actual governed guest and producing a retained result, with isolated synthetic model transport clearly identified where used.

The smaller GitHub runner matrix does not replace standard/larger-VM acceptance. The latter requires a disposable KVM host with sufficient guest resources and production headroom. A new release must rerun bundle freshness, activation transition, provenance and Linux packaging checks; source integration does not activate or deploy it.
