# The service-role key out of guests (G2)

The coordinator's G2 (October 2026): runner guests, exec slots and login guests stop holding the database's
service-role key, which reaches every company. This is isolation between companies, not a limit on what an agent
may do: every call a guest makes today it still makes, scoped to its own run or identity.

Founder decision, 3 October 2026: production's companies are wiped, legacy compatibility is dropped and nothing is
released to production until the first milestone. So G2's steps not yet built need no per-node switches, staged
rollouts or fallbacks that only keep live companies running: each ships whole, on the next release.

- G2-1 (migration `20260928409985`, SQL tests 792 and 793): `qorpera_native_host_call` and `_long`, a job's calls
  with its lease token.
- G2-2 (`cloud-native-host-dispatch.ts`): the native host's dispatch that uses them, always on since G2-3bc; the
  end-of-job cleanup without office or screen locks (migration `20260928419960`, SQL tests 798 and 799).
- G2-3: the identity credential, for the calls a native host makes outside a job (below).
- G2-3e: the exec host's own calls (runner rows, reservations, ended runners, identity state) with one credential
  per exec host, minted and bound on the node host; node 2's host is rebuilt without the key and node 1's is
  created that way.
- G2-4: Storage and Realtime, the login guest's capsule put and get included.
- G2-5: the key leaves the guests, the bootstrap and the units, with a guard that it stays out.
- G2-6: the node-level object-gateway and broker runtime tokens narrowed per run.

## G2-3: the identity credential

Eight calls run outside a job: the identity's recovery state and vault custody at startup, the account list and
record (the 60 s loop, after a sign-in, during an account refresh), and a login guest's sign-in and account refresh
(describe and complete each). They go through `qorpera_native_identity_call(p_compute_identity_id, p_credential,
p_name, p_args)`, the publishable key's, with authenticator's 8 s.

- **One credential per holder.** A holder is one machine allocation: a job guest or an exec slot (a run allocation,
  whose runner holds the identity) or a login guest (a sign-in or account refresh allocation of the identity). The
  node host mints 32 random bytes (43 characters, base64url), binds the sha256 with
  `qorpera_bind_native_identity_credential(allocation, adapter, instance, kind, sha256)` right after it reserves
  the machine, and writes the plaintext only into the guest's credential file (0600, the host's uid). Only the
  hash leaves the node host: never the plaintext in a receipt, journal, log, observation or error.
- **Rotation.** Binding the same allocation again replaces the hash, and the old credential fails at once. A hash
  is bound once (23505 otherwise), so a warm reuse, a new allocation, binds a new credential. A warm exec host's
  systemd credentials are fixed when its unit starts, so G2-3bc hands a warm host each run's credential with the run
  itself (as G2-2 hands it the job's lease token) and the host drops the old one; the old allocation's credential
  dies at its release.
- **Revocation** is per call and takes no lock: the allocation released, the identity disabled or in recovery, the
  runner revoked or behind the identity's recovery epoch, an allocation of another company.
- **Per kind** (`qorpera_native_identity_calls`, migrations only): a job guest and an exec slot get the four
  identity calls; a login guest gets its own sign-in or refresh (describe, complete), and a refresh's guest also its
  identity's account list and record (the refresh is that list and record), never the recovery state or vault
  custody, because its provider CLI can read its files. A sign-in's completion takes only the native host's own
  capsule reference, `native-capsule/<capsule id>`.

### G2-3bc: the native host and the node host (one change, no switches)

The native host makes every database call through an entry point: a job's calls with the job's lease token (G2-2,
no longer behind `QORPERA_NATIVE_HOST_DISPATCH`, which is gone), the eight calls above with the holder's identity
credential, and any other database call is refused in the host. Storage and Realtime keep the key until G2-4.

- **What a holder gets.** The systemd credential `qorpera-native-identity`, JSON
  `{schema: "qorpera.native-identity-credential/v1", compute_identity_id, credential, publishable_key}`. The guest
  bootstrap requires it (each credential list names it), checks it is for the guest's identity and independent of
  every other credential, and the host refuses to start without it.
- **Job guests** (LXD provider): the provider mints it with the acquisition's other tokens, records only its sha256
  in the journal, binds it as `job_guest` right after it reserves the machine (with the node key) and pushes the
  file with the bootstrap. The bootstrap reads the identity's recovery state through it.
- **Login guests** (login gateway): the gateway mints it next to the bridge token (kept in `bridge.json`), binds it
  as `login_guest` right after it reserves the sign-in or refresh machine, and pushes it. A login guest may not
  read its identity's recovery state, so the gateway reads it node side and pushes it as the credential
  `qorpera-native-identity-state` (outside the sealed bootstrap digest, which it would otherwise change); the
  bootstrap, host startup and the `/login` backup stage use that copy. A recovery started since is still caught: the
  identity entry point refuses every call while the identity is in recovery, and the sign-in's completion carries
  the epoch it started at (`p_recovery_epoch`), which must still be the identity's. The environment's
  `QORPERA_NATIVE_LOGIN_GUEST` (`sign_in` or `account_refresh`) tells the host which; a sign-in's host runs no
  account loop (those calls are refused for it, and the metadata arrives with the next job or refresh).
- **Exec slots** (shared execution): the service mints one per run (a warm reuse is a new allocation, so a new
  credential), binds it as `exec_slot` through its own entry point right after the reservation, and writes it into
  the slot's credentials and the runner's configuration (`native_identity_credential`). A warm host's systemd
  credentials are fixed when its unit starts, so the runner sends each run's credential with the execution
  (`native_host.identity_credential`, beside the lease token) and the host's dispatch replaces the old one.

### Rollout (G2-3bc)

It ships whole on the milestone release: the runtime, the guest image (bootstrap and units) and the node host
together. Order on each node: the LXD guest image before the orchestrator, because the bootstrap checks an exact
credential list. Node 2's execution host is rebuilt with it (its service and slot unit ship together).

**Gates before the release** (G2-2's gates, which the credential shares: its plaintext travels as an RPC parameter,
as the lease token does):

- `log_parameter_max_length` and `log_parameter_max_length_on_error` are 0 wherever statements are logged, so no log
  line carries the credential;
- the live proof that hosted PostgREST applies the entry points' 8 s statement budget, not the publishable key's 3 s.

Check on node 2 after the release: a job guest, a sign-in, an account refresh and an exec slot run each start and
make their calls through the entry points.

### Undo

- G2-3bc: revert it whole (runtime, image and node host); there is no switch.
- G2-3a: nothing uses it once G2-3bc is reverted. To remove it: drop `qorpera_native_identity_call`,
  `qorpera_native_identity_dispatch`, `qorpera_native_host_invoke`, `qorpera_bind_native_identity_credential` and
  the tables `qorpera_native_identity_calls` and `qorpera_native_identity_credentials`. The two fixes it carries stay
  (the sign-in completion's capability check before its lock, and the revoked EXECUTE grants).

## G2-3e: the execution host's own calls

The shared execution host's service (`shared-execution-cli.ts`, root in the execution host VM, not its slots) holds
the service-role key for its own database calls: a runner row per run, the company-ceiling reservation and its
release, the ended-runner query, the identity's recovery state and vault custody, and (G2-3bc) each slot's credential
bind. The execution host runs every company's sandboxes, so the key must not be in it. These calls are host-level
(any company's run on that node), so a per-holder credential cannot cover them: the host gets one credential of its
own. G2-3e removes the service's own use only: the service still copies the key into each slot
(`shared-execution-backend.ts`, the slot's `qorpera-supabase-service-key`), whose native host needs it for Storage and
Realtime until G2-4; G2-5 removes that copy, and only then does the VM hold no key.

- **SQL (migration `20260930011000`, SQL tests 862 and 863; inert):**
  - `qorpera_execution_host_call(p_host_id, p_credential, p_name, p_args)` (8 s) and `_long` (25 s, the release,
    which sets 25 s itself), the publishable key's alone, check the host's credential first, by its hash and with no
    lock; every refusal is 42501 "execution host call is refused".
  - `qorpera_execution_host_calls` lists the seven calls and their budgets. Each is held to the host's own
    co-located orchestrator and provider adapter, not the whole node's adapter (a node's fresh-VM orchestrator may
    share it). A run is the host's while its orchestrator holds the run's current claim: claimed or assigned while the
    job is queued, or accepted while the job is leased by the runner assigned through that claim (an accepted claim is
    never released, so an ended or retried run is no longer the host's). A runner row, a reservation (of a run
    machine, with a runner of its adapter), an identity's recovery state and vault custody (only with `p_run_id`, the
    run it is read for, checked and removed before the call) and a slot bind (only as `exec_slot`) need such a
    current run. A release and the ended-runner query need its adapter's run machine of a run its orchestrator ever
    claimed (they come after the run); ended runners 1 to 512.
  - `qorpera_bind_execution_host_credential(host, adapter, orchestrator, sha256)` (service role): the node host binds,
    after it registered the host's orchestrator; a bind again (a rebuild) replaces the hash, so the old credential
    fails at once; the host's adapter and orchestrator never change; a hash and an orchestrator are bound once.
    `qorpera_revoke_execution_host_credential(host)` ends it. Removing a host revokes it; moving a host to another
    adapter or orchestrator is a revocation, then a new bind.
- **Package and scripts:** the service requires its `qorpera-execution-host` systemd credential and sends its own
  calls through the entry points (`shared-execution-host-call.ts`) with the publishable key; any other database
  request of its own is refused there, and identity reads name the run they are read for. `rebuild-exec-host.sh` (and
  `create-exec-host.sh`, which runs it), on the node host, which keeps the key: mints the credential (32 random bytes)
  in a private temporary directory at every rebuild, binds its sha256 to the host's adapter and co-located
  orchestrator with the staged key, and pushes it straight into the VM's credentials directory (root, 0600), never
  into staging, onto a command line or into its output. The orchestrator's registration and the bundle declaration
  stay on the node host with its key. Minting the provider token and copying the node-level tokens from the node
  host's own files (so no person stages anything for a new host) waits for the next new host: node 1's is dropped for
  now, and node 2's staging exists.

### Rollout (G2-3e)

The SQL and the package ship together on the next release; node 2's execution host is rebuilt with it (pausing
node 2's runs meanwhile is fine). Check: its first runs start, reserve and release through the entry points. The key
still reaches the slots (for their native hosts) until G2-5, when **no service key is staged** at all. A later
execution host (node 1's fast host is dropped for now, 3 Oct) is created the same way.

### Undo (G2-3e)

- A host back on the key: rebuild it from the package before G2-3e part 2, then
  `qorpera_revoke_execution_host_credential('<host id>')`.
- The SQL: drop `qorpera_execution_host_call`, `_call_long`, `qorpera_execution_host_dispatch`,
  `qorpera_execution_host_claims_run`, `qorpera_execution_host_run_machine`, `qorpera_execution_host_uuid`,
  `qorpera_bind_execution_host_credential`,
  `qorpera_revoke_execution_host_credential` and the tables `qorpera_execution_host_calls` and
  `qorpera_execution_host_principals`, once no host uses them.
