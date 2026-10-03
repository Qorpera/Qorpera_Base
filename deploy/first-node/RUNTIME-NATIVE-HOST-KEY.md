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
  is bound once (23505 otherwise), so a warm reuse, a new allocation, binds a new credential.
- **Revocation** is per call and takes no lock: the allocation released, the identity disabled or in recovery, the
  runner revoked or behind the identity's recovery epoch.
- **Per kind** (`qorpera_native_identity_calls`, migrations only): a job guest and an exec slot get the four
  identity calls; a login guest gets its own sign-in or refresh (describe, complete) and its identity's account
  list and record, never the recovery state or vault custody, because its provider CLI can read its files.

### Rollout

| Step | What | Ships | Switch |
| --- | --- | --- | --- |
| G2-3a | SQL (migration `20260930005000`, SQL tests 860 and 861) | Release train | Inert: nothing binds or calls |
| G2-3b | Runtime and guest image: the dispatch for the eight calls, the bootstrap's optional credential file, the units' `LoadCredential` | Release train, guest image | Runtime switch off |
| G2-3c | Node host: the LXD provider, the login gateway and the shared-execution service mint, bind and deliver | Node release | Per node, off by default; node 2 first |
| G2-3d | The runtime switch's default on | Next image | After every node's G2-3c switch is on |

**Order on each node: the LXD guest image before the orchestrator.** The guest bootstrap checks an exact credential
list, and the journal's `bootstrapSha256` covers every pushed file, the credential list included. An orchestrator
that pushes the credential file into a guest whose image predates G2-3b fails that guest. So a node's pinned image
must come from G2-3b or later before its G2-3c switch goes on; the exec host has no such order (its service and
unit ship together).

### Undo

- G2-3a: nothing uses it. To remove it: drop `qorpera_native_identity_call`, `qorpera_native_identity_dispatch`,
  `qorpera_native_host_invoke`, `qorpera_bind_native_identity_credential` and the tables
  `qorpera_native_identity_calls` and `qorpera_native_identity_credentials`. The two fixes it carries stay (the
  sign-in completion's capability check before its lock, and the revoked EXECUTE grants).
- G2-3c: the node's switch off. Its hosts start without a credential and keep using the key, which stays until G2-5.
- G2-3d: the runtime switch's default back off.
