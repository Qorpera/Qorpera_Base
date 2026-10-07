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
- G2-4 (migration `20260930103000`, SQL test 907): Storage and Realtime, the login guest's capsule put and get
  included, with the holder's credential in a request header (below).
- G2-5 (no SQL): the key leaves the guests, the slots, the execution host, the bootstrap and the units, with guards
  that it stays out (below).
- G2-6: the node-level tokens bound to one run by a proof of its lease (below): 6a (migration `20260930152000`, SQL test
  986) the secret brokers' runtime routes and the object gateway's folder route; 6b the coding executor; 6c the office
  receiver and the object gateway's native-objects route.

## G2-3: the identity credential

Eight calls run outside a job: the identity's recovery state and vault custody at startup, the account list and
record (the 60 s loop, after a sign-in, during an account refresh), and a login guest's sign-in and account refresh
(describe and complete each). They go through `qorpera_native_identity_call(p_compute_identity_id, p_credential,
p_name, p_args)`, the publishable key's, with authenticator's 8 s.

- **One credential per holder.** A holder is one machine allocation: a job guest or an exec slot (a run allocation,
  whose runner holds the identity) or a login guest (a sign-in or account refresh allocation of the identity). The
  node host mints 32 random bytes (43 characters, base64url), binds the sha256 with
  `qorpera_bind_native_identity_credential(allocation, adapter, instance, kind, sha256)` right after it reserves
  the machine, and writes the plaintext only into the holder's credential file (0600, the host's uid) and, for an
  exec slot, the slot runner's configuration (0600, the runner's account, removed with the runner), which hands it
  to a warm host. Only the hash leaves the node host: never the plaintext in a receipt, journal, log, observation
  or error.
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
  capsule reference, `native-capsule/<capsule id>`, and since G2-4 only the capsule named for the sign-in.

### G2-3bc: the native host and the node host (one change, no switches)

The native host makes every database call through an entry point: a job's calls with the job's lease token (G2-2,
no longer behind `QORPERA_NATIVE_HOST_DISPATCH`, which is gone), the eight calls above with the holder's identity
credential, and any other database call is refused in the host. Storage and Realtime kept the key until G2-4.

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
  identity entry point refuses every call while the identity is in recovery, and once one has finished, the login
  sessions' epoch trigger (migration `20260917030000`) refuses a completion at the sign-in's old epoch; the backup
  stage itself fails closed if the recovery authority changed. The gateway pushes the state once the guest's agent
  answers. The environment's
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

## G2-4: Storage and Realtime

The native host's two last uses of the key in a guest were the credential capsule store (bucket
`qorpera-native-compute-capsules`, objects `<capsule id>.capsule`) and the company presence client (the private
Realtime topic `qorpera-presence-<company>`). Both now go as anon, the publishable key's, and carry the holder's
credential in the request header `x-qorpera-identity`. Hosted Storage and Realtime hand request headers to the row
policies (`request.headers`); proven on hosted 4 Oct 2026 for Storage and for a Realtime private join. Supabase's request logs
keep no value of the header: the gateway logs a fixed set of header keys (the coordinator's log check, 4 Oct, over the
edge, Storage, Realtime, PostgREST and Postgres logs).

- **The header.** `job.<job id>.<lease token>` inside a job, `identity.<identity credential>` between jobs, as
  `NativeHostDispatch.holderHeader()` gives it. `qorpera_native_holder()` (no role may call it) checks it as the two
  entry points check their credentials: the lease token by the job's primary key (leased, an agent turn, the lease
  unexpired), the identity credential by its hash (the allocation unreleased, the identity active and not in
  recovery, the holder's own machine). It takes no lock.
- **What each holder reaches.** Read by the bucket's and the topic's anon policies through
  `qorpera_native_holder_capsules(write)` and `qorpera_native_holder_presence_topic()` (anon's alone, test 001):
  - a job: its identity's active capsules (read; the account metadata loop also runs during a job) and its run's
    leased capsule (create, write back), and its company's presence topic while its run has a live presence device
    (registration accepts only a company-audience run);
  - a job guest, an exec slot or a refresh's login guest: its identity's active capsules, read only;
  - a sign-in's login guest, while its sign-in is pending: `<sign-in id>.capsule` only (read, create, write again on
    a retry). A sign-in's capsule is named for its sign-in: the native host uses the sign-in's id as the capsule id,
    and the identity entry point refuses a completion naming another (`qorpera_native_identity_dispatch`, patched).
    So a login guest never reaches, or claims, another sign-in's capsule.
  - Nothing deletes, nothing lists beyond its own names, nothing reaches another company; no header is plain anon.
- **The native host.** `NativeHostDispatch` signs a capsule request (GET or POST of `<uuid>.capsule` in that bucket
  only; any other Storage request on the project's origin is refused) with the publishable key, as `apikey` and as
  the bearer (the probe's shape; `apikey` alone also worked), and the header; the store holds no key. The presence
  client is
  `createClient(url, publishableKey)` with `nativeHostRealtimeTransport`: Node's WebSocket with the header on the
  upgrade, read when each connection opens.
- **The bucket's limit** becomes the client's encrypted maximum, 64 MiB + 1 MiB (it was 64 MiB, so the largest
  capsules were refused).
- **Known gap (accepted 4 Oct):** a sign-in that never completes leaves its capsule object behind, as before G2-4.
  Object names carry no company, so a company's purge does not find them. They go on the clean-up list of the
  artifact GC worker (with the mail keys, go-live 6b).

### Rollout (G2-4)

It ships whole on the release that carries it: the migration and the native host (guest image) together, the
migration first. No switch. On a guest image from before G2-4, jobs and the account loop are unaffected (they still use
the key), but its sign-ins are refused at their completion: it names its capsule with a random id, which the patched
identity entry point refuses. So sign-ins wait for the new guest image, and the sign-in check below needs it.
The gates G2-2 and G2-3 needed are done (coordinator, 4 Oct, with #762 for v172): authenticator's
`log_parameter_max_length`, `log_parameter_max_length_on_error` and `auto_explain.log_parameter_max_length` are 0 with
its connections recycled, and the 8 s function budget is proven through PostgREST. The header reaches the policies
through Storage's and Realtime's own `request.headers` setting, not a PostgREST call; that no log keeps its value
rests on the coordinator's log check (above), not on these gates.

Check after the release: a job guest's run downloads and writes back its capsule and joins presence; a sign-in
completes (its capsule is `<sign-in id>.capsule`); an account refresh reads its identity's capsule.

### Undo (G2-4)

Revert the runtime and the migration together: drop the five policies (`qorpera_native_capsule_holder_read`,
`_create`, `_write`, `qorpera_presence_native_receive`, `_publish`) and the three functions, and restore
`qorpera_native_identity_dispatch`'s completion check without the sign-in's id. A guest image from before G2-4 still
holds the key and works without them. Keep the bucket's new limit.

## G2-5: no service key in a guest, a slot or the execution host

After G2-4 nothing in a guest used the key, but it was still delivered. G2-5 stops that and refuses it if it comes
back. The node hosts (the LXD provider, the login gateway, `rebuild-exec-host.sh`) keep their own key for their own
calls.

- **Not delivered:** the LXD provider and the login gateway push no `qorpera-supabase-service-key` into a guest; the
  shared execution service writes none into a slot; `rebuild-exec-host.sh` pushes every staged credential into the
  execution host except the key (it still reads the staged key for its own registration, bind and bundle calls); the
  process provider passes none to its local native host.
- **Not loaded:** no unit loads it: the three guest native host units, the slot's `qorpera-shared-run-host@`, and the
  execution host's `qorpera-shared-execution.service`.
- **Guards that it stays out:**
  - the guest bootstrap's exact credential lists no longer name the key, so a job, company or login guest given it is
    refused before any service starts;
  - the native host refuses to start if it is given the key (as a credential or `QORPERA_SUPABASE_SERVICE_KEY`); its
    clients send the publishable key and `NativeHostDispatch` signs every request;
  - the shared execution service refuses to start if it is given the key (a systemd credential, its environment, or
    a file left in its credential source `/etc/qorpera/shared-execution-credentials/`, which no unit loads);
  - tests: no guest, slot or execution host unit names the key; the provider's and the gateway's pushes carry it in no
    file; a slot's credentials are exactly the listed ones; the rebuild never pushes it; the native host, the shared
    execution service and the process provider's native host are each shown to refuse or never get it.

### Rollout (G2-5)

It ships with the release after G2-4's (it needs G2-4's runtime: before it, the native host used the key for Storage
and Realtime). Order on each node: the guest image (bootstrap, units, native host), then the node host (LXD provider
and login gateway), then the execution host's rebuild. A node host updated before the guest image is fine: an old
image's bootstrap refuses a guest without the key, so its runs fail until the new image is in, as the no-compatibility
decision (3 Oct) allows. Journals written before G2-5 carry a bootstrap digest that includes the key's file, so their
guests are refused "bootstrap no longer matches".

Check after the release (deferred, needs Codex): a job guest, a sign-in, an account refresh and an exec slot run each
start without the key.

### Undo (G2-5)

Revert it whole (runtime, guest image, node host and the execution host's package): the key is delivered and loaded
again. Nothing in the database changes.

## G2-6: a guest request proves its run's lease

Four node-level tokens reach a company guest or an execution host's slot: the object gateway's native token, the
secret brokers' runtime token, the coding executor's command token and a company computer's office token. Each server
compared the bearer and then re-checked the request's run binding against the database with its own key. But the
binding is only ids, and the checks behind it read the job's stored lease hash themselves, so the node-level token and
any live run's ids were enough to act for that run, including `/v1/model-logins`, which hands out the run's model
access token.

Now the caller also proves it holds that run's job lease token, which only the run's own native host has. With each
request it sends `x-qorpera-identity: job.<job id>.<lease token>` (`NativeHostDispatch.holderHeader()`, read per
request, so a warm host never sends a released job's token). The server asks
`qorpera_native_binding_proven(binding, holder)` before anything else about the binding:
- the job by its primary key, leased, an agent turn, the lease unexpired;
- the token's hash;
- the binding's job and run being that job and its run.

It is stable, so it takes no row lock, and only the servers' roles may call it (service_role for the object gateway and
the coding executor, qorpera_secret_broker for the brokers; test 001 keeps it off the API roles). It is a gate only: the locked functions
behind each request still check the run and its lease under their locks, so a lease that ends between the proof and
the work is still refused. A server never logs the header or puts it in an error, and every refusal is a plain 401 or
403. The node-level tokens stay as transport checks for now.

- **6a** (migration `20260930152000`, SQL test 986):
  - the secret brokers and the shared vault prove the lease on `/v1/operations`, `/v1/company-accounts`,
    `/v1/company-account-fills` and `/v1/model-logins`, through their own database principal;
  - the object gateway proves it on `/v1/folder-objects`;
  - the native host's broker client, model login client and folder bytes client send the header, as do its
    native-objects clients (the object store and the Company Computer's capture paths), which 6c's check will read.
- **6c, not yet:** `/v1/native-company-objects` also serves the company computer's captures, file imports and exports,
  which the computer makes for a run without holding its lease. Its proof comes with the native host passing its
  holder to the computer with each operation (a company computer image rebuild), together with the office receiver's
  own proof.
- **6b** (no SQL: the coding executor already calls the database as service_role):
  - the executor's guest-facing listener (`commandPort`) proves the lease on `/v1/coding-commands/*` and
    `/v1/machine-commands/*`, before the command's own authorization (a machine start's authorization already records
    the command);
  - the native host's coding and machine command gateways send the header;
  - the executors' peer listener (`peerCommandPort`) takes none: only executors hold its token, and the forwarding
    executor proved the guest's holder at its own ingress.

### Rollout (G2-6a)

The migration first, then the object gateway and the brokers (node 1), with the guest image of the same release. A
guest from before G2-6a sends no header, so its broker and folder requests are refused until the new image is in (no
compatibility path, 3 Oct). Check after the release (deferred, needs Codex): a run's connector operation, company
account, account fill, vault model login and folder read and write each go through.

### Undo (G2-6a)

Revert the servers (they stop asking), then the guest and the migration (`drop function
public.qorpera_native_binding_proven(jsonb, text)`).

### Rollout (G2-6b)

After 6a's migration: the guest image first (an executor from before 6b ignores the header), then each node's coding
executor. A guest from before 6b sends no header, so a 6b executor refuses its coding and machine commands. The HTTPS
proxy in front of `commandPort` must pass `x-qorpera-identity` through (nginx passes request headers by default; no
`proxy_set_header` may clear it). Check after the release (deferred, needs Codex): a coding turn's command and a company
machine's command each go through, both on the node that holds the machine and through a peer.

### Undo (G2-6b)

Revert the executors (they stop asking), then the guest.

## G2-3e: the execution host's own calls

The shared execution host's service (`shared-execution-cli.ts`, root in the execution host VM, not its slots) holds
the service-role key for its own database calls: a runner row per run, the company-ceiling reservation and its
release, the ended-runner query, the identity's recovery state and vault custody, and (G2-3bc) each slot's credential
bind. The execution host runs every company's sandboxes, so the key must not be in it. These calls are host-level
(any company's run on that node), so a per-holder credential cannot cover them: the host gets one credential of its
own. G2-3e removes the service's own use only: the service still copies the key into each slot
(`shared-execution-backend.ts`, the slot's `qorpera-supabase-service-key`), which its native host no longer uses since
G2-4; G2-5 removed that copy, so the VM holds no key.

- **SQL (migration `20260928469230`, renumbered from `20260930011000` at the v171 cut; SQL tests 862 and 863):**
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
node 2's runs meanwhile is fine). Check: its first runs start, reserve and release through the entry points. Since
G2-5 **no service key enters the host**: the staged key stays on the node host for the script's own calls. A later
execution host (node 1's fast host is dropped for now, 3 Oct) is created the same way.

### Undo (G2-3e)

- A host back on the key: rebuild it from the package before G2-3e part 2, then
  `qorpera_revoke_execution_host_credential('<host id>')`.
- The SQL: drop `qorpera_execution_host_call`, `_call_long`, `qorpera_execution_host_dispatch`,
  `qorpera_execution_host_claims_run`, `qorpera_execution_host_run_machine`, `qorpera_execution_host_uuid`,
  `qorpera_bind_execution_host_credential`,
  `qorpera_revoke_execution_host_credential` and the tables `qorpera_execution_host_calls` and
  `qorpera_execution_host_principals`, once no host uses them.
