# The service-role key out of guests (G2)

The coordinator's G2 (October 2026): runner guests, exec slots and login guests stop holding the database's
service-role key, which reaches every company. This is isolation between companies, not a limit on what an agent
may do: every call a guest makes today it still makes, scoped to its own run or identity.

- G2-1 (migration `20260928409985`, SQL tests 792 and 793): `qorpera_native_host_call` and `_long`, a job's calls
  with its lease token.
- G2-2 (`cloud-native-host-dispatch.ts`, built switched off): the native host's switch to use them; the end-of-job
  cleanup without office or screen locks (migration `20260928419960`, SQL tests 798 and 799).
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
  systemd credentials are fixed when its unit starts, so G2-3b/3c hand a warm host each run's credential with the run
  itself (as G2-2 hands it the job's lease token) and the host drops the old one; the old allocation's credential
  dies at its release.
- **Revocation** is per call and takes no lock: the allocation released, the identity disabled or in recovery, the
  runner revoked or behind the identity's recovery epoch, an allocation of another company.
- **Per kind** (`qorpera_native_identity_calls`, migrations only): a job guest and an exec slot get the four
  identity calls; a login guest gets its own sign-in or refresh (describe, complete), and a refresh's guest also its
  identity's account list and record (the refresh is that list and record), never the recovery state or vault
  custody, because its provider CLI can read its files. A sign-in's completion takes only the native host's own
  capsule reference, `native-capsule/<capsule id>`.
- **For G2-3b:** a login guest reads its identity's recovery state today (the bootstrap, host startup, and the
  `/login` identity-key backup stage, which re-reads it live and compares the epoch). That call is refused for a
  login guest, so the login gateway must answer it (it reads the state node side), or the re-read must go with a
  reason. A sign-in's guest also lists accounts after the sign-in and in its 60 s loop; those calls are refused for
  it, so G2-3b skips them there (the metadata arrives with the next job or refresh).

### Rollout

| Step | What | Ships | Switch |
| --- | --- | --- | --- |
| G2-3a | SQL (migration `20260930005000`, SQL tests 860 and 861) | Release train | Inert: nothing binds or calls |
| G2-3b | Runtime and guest image: the dispatch for the eight calls, the bootstrap's optional credential file, the units' `LoadCredential` | Release train, guest image | Runtime switch off |
| G2-3c | Node host: the LXD provider, the login gateway and the shared-execution service mint, bind and deliver | Node release | Per node, off by default; node 2 first |
| G2-3d | The runtime switch's default on | Next image | After every node's G2-3c switch is on |

**Gates before G2-3c's live probe and before G2-3d** (G2-2's switch-on gates, which the credential shares: its
plaintext travels as an RPC parameter, as the lease token does):

- `log_parameter_max_length` and `log_parameter_max_length_on_error` are 0 wherever statements are logged, so no log
  line carries the credential;
- the live proof that hosted PostgREST applies the entry point's 8 s statement budget, not the publishable key's 3 s.

**Order on each node: the LXD guest image before the orchestrator.** The guest bootstrap checks an exact credential
list, and the journal's `bootstrapSha256` covers every pushed file, the credential list included. An orchestrator
that pushes the credential file into a guest whose image predates G2-3b fails that guest. So a node's pinned image
must come from G2-3b or later before its G2-3c switch goes on; the exec host has no such order (its service and
unit ship together).

### Undo

In this order: G2-3d first, then G2-3c on every node, then G2-3a. Once G2-3d is on, a host without a credential fails
at startup; once a node's G2-3c switch is on, its guests need the bind function.

- G2-3a: nothing uses it while every node's G2-3c switch is off. To remove it: drop `qorpera_native_identity_call`, `qorpera_native_identity_dispatch`,
  `qorpera_native_host_invoke`, `qorpera_bind_native_identity_credential` and the tables
  `qorpera_native_identity_calls` and `qorpera_native_identity_credentials`. The two fixes it carries stay (the
  sign-in completion's capability check before its lock, and the revoked EXECUTE grants).
- G2-3c: the node's switch off (with G2-3d off). Its hosts start without a credential and keep using the key, which
  stays until G2-5.
- G2-3d: the runtime switch's default back off.

## G2-3e: the execution host's own calls

The shared execution host's service (`shared-execution-cli.ts`, root in the execution host VM, not its slots) holds
the service-role key for its own database calls: a runner row per run, the company-ceiling reservation and its
release, the ended-runner query, the identity's recovery state and vault custody, and (G2-3c) each slot's credential
bind. The execution host runs every company's sandboxes, so the key must not be in it. These calls are host-level
(any company's run on that node), so a per-holder credential cannot cover them: the host gets one credential of its
own. G2-3e removes the service's own use only: the service still copies the key into each slot
(`shared-execution-backend.ts`, the slot's `qorpera-supabase-service-key`), whose native host needs it until G2-2's
switch, G2-3d and G2-4 are on; G2-5 removes that copy, and only then does the VM hold no key.

- **SQL (migration `20260930011000`, SQL tests 862 and 863; inert):**
  - `qorpera_execution_host_call(p_host_id, p_credential, p_name, p_args)` (8 s) and `_long` (25 s, the release,
    which sets 25 s itself), the publishable key's alone, check the host's credential first, by its hash and with no
    lock; every refusal is 42501 "execution host call is refused".
  - `qorpera_execution_host_calls` lists the seven calls and their budgets. Each is held to the host's provider
    adapter: a runner row and a reservation only for a run whose job one of its adapter's orchestrators holds a live
    claim on (claimed, assigned or accepted; the orchestrator not revoked); a reservation only of a run machine with a
    runner of its adapter; a release only of its adapter's run machine; ended runners only among its adapter's runners
    (1 to 512); an identity's recovery state and vault custody only with the claimed run it is read for (`p_run_id`,
    checked and removed before the call); a slot bind only as `exec_slot`, for its adapter's run machine.
  - `qorpera_bind_execution_host_credential(host, adapter, sha256)` (service role): the node host binds; a bind again
    (a rebuild) replaces the hash, so the old credential fails at once; the host's adapter never changes; a hash is
    bound once. `qorpera_revoke_execution_host_credential(host)` ends it.
- **Package and scripts:** with a non-empty `qorpera-execution-host` systemd credential the service sends its own
  calls through the entry points (`shared-execution-host-call.ts`) with the publishable key, and refuses any other
  database request of its own; identity reads name the run they are read for. The unit always loads the file (the
  installer creates it empty). `rebuild-exec-host.sh` (and `create-exec-host.sh`, which runs it) with
  `EXEC_HOST_CREDENTIAL=1`, on the node host, which keeps the key: mints the credential (32 random bytes) in a private
  temporary directory, binds its sha256 with the staged key and pushes it straight into the VM's credentials directory
  (root, 0600), never into staging, onto a command line or into its output; every rebuild mints a new one. Without the
  switch the file is empty and nothing changes. The orchestrator's registration and the bundle declaration stay on the
  node host with its key. Minting the provider token and copying the node-level tokens from the node host's own files
  (so no person stages anything for a new host) waits for the next new host: node 1's is dropped for now, and node 2's
  staging exists.

### Rollout (G2-3e)

1. The SQL ships on the release train (inert).
2. The package and scripts ship; node 2's execution host is rebuilt with `EXEC_HOST_CREDENTIAL=1` (in the next
   cut's b3 roll-rebuild, or on its own with `rebuild-exec-host.sh`; pausing node 2's runs meanwhile is fine). Check: its
   first runs start, reserve and release through the entry points, and the service's own unit loads no service key.
   The key still reaches the slots (for their native hosts) until G2-5.
3. Any later execution host (node 1's fast host is dropped for now, 3 Oct) is created the same way. Its staging
   changes in two steps: with G2-3e the script mints and binds the host credential and the service no longer loads
   the key; with G2-5 **no service key is staged** at all.

### Undo (G2-3e)

- A host back on the key: rebuild it without `EXEC_HOST_CREDENTIAL` (its file is then empty), then
  `qorpera_revoke_execution_host_credential('<host id>')`.
- The SQL: drop `qorpera_execution_host_call`, `_call_long`, `qorpera_execution_host_dispatch`,
  `qorpera_execution_host_claims_run`, `qorpera_execution_host_uuid`, `qorpera_bind_execution_host_credential`,
  `qorpera_revoke_execution_host_credential` and the tables `qorpera_execution_host_calls` and
  `qorpera_execution_host_principals`, once no host uses them.
