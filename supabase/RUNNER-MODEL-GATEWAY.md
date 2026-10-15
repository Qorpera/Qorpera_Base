# Runner model gateway

The runner broker's model gateway is gone since migration `20260930334000` (legacy sweep step D5). It served only the snapshot-v1 runner lane: the runner host sent each model request through `runner-broker`, which reserved it against the job's model policy, forwarded it to a configured Qorpera model gateway, and finalized its usage. The runtime asks for none of it.

A folder-v2 run calls its model through the native provider lane. `runner-broker`'s native authority actions lease the run's provider connection (`RUNNER-BROKER.md`), and `qorpera_native_run_model_authority` reads the job's model policy: the allowed provider and model pairs and the call and token ceilings that `qorpera_reserve_execution_sponsor_authority` copies from the sponsor's connection.

The old gateway's tables go with step E of the legacy sweep.
