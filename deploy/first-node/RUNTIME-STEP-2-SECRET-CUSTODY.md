# Runtime Step 2: company-centered cloud secret custody

**Status:** component implementation, isolated Azure/Supabase canary acceptance, dedicated broker-login proof, live effect/reflection proof, current-host non-exposure scan, and unsigned v53 guest negative-boundary preflight complete; signed real-GPT guest proof and coordinated production integration remain; production connector integration is Step 7

**Normative contract:** [QORPERA-RUNTIME-CONTRACT.md](../../QORPERA-RUNTIME-CONTRACT.md), especially sections 4, 11.4, 11.5, and implementation order 2

## Product model

Qorpera does not give each agent a private `.env` file. The tenant is the company.

- A company-owned credential is controlled by current company owner/admin authority.
- A member-owned credential remains bound to that member and to runs sponsored by that member.
- An agent receives a revocable grant to one versioned connector operation.
- The Company File may retain only the safe descriptor: connector, purpose, owner class, status, allowed operation, and opaque identity.
- Encrypted envelopes, unwrap keys, capture capabilities, operation grants, and secret audit records are privileged control-plane state. They are linked to the company but are not Company File content.

Archiving or deleting an agent revokes its grants. It does not delete a shared company credential. Removing a member revokes that member's credentials and grants without affecting company-owned credentials.

## Implemented kernel

Migration `20260828018000_cloud_secret_custody.sql` provides:

- one independently authenticated broker authority per company;
- immutable envelope versions and a current-version pointer;
- company-owned and member-owned credential semantics;
- ten-minute, single-use member capture tickets;
- versioned, closed connector-operation schemas with exact HTTPS destinations and pinned adapter hashes;
- per-agent operation grants and effect-time revocation checks;
- safe member and native-runtime descriptor projections;
- broker-only capture completion and unwrap authorization;
- exact admitted run, agent, sponsor, grant, operation, destination, receipt, and input-hash checks; and
- private capture, rotation, grant, revocation, and effect-authorization audit events.

Direct table access is revoked from `anon`, `authenticated`, `service_role`, and the dedicated broker login. Members and services use narrowly granted `security definer` functions. The broker login receives exactly three custody functions and cannot inherit `service_role`; nested run validators remain non-callable directly. The migration creates the role `NOLOGIN`; an operator provisions its independent login/password out of band and places only that bounded PostgreSQL URL in the broker credential set. The native runtime can list safe tool descriptors and assert current operation authority; it cannot read ciphertext.

The broker implementation provides:

- AES-256-GCM envelope encryption with a random data key per secret version;
- AES-256-GCM wrapping of that data key under a broker-only key-encryption key;
- authenticated associated data binding company, environment, secret, version, and key identity;
- callback-scoped plaintext use and best-effort zeroing of mutable buffers;
- a compiled, exact connector-adapter registry;
- a response fence for raw, URL-encoded, and base64 credential reflection plus secret-bearing keys;
- fixed, non-secret external errors;
- bounded requests, responses, deadlines, and connection reuse; and
- no `getSecret`, reveal, export, shell, filesystem, arbitrary URL, arbitrary header, or raw HTTP tool.

The separately packaged service binds only to loopback. A TLS reverse proxy publishes the member capture route and a private service route publishes operation execution. The service requires six systemd credentials and has no environment-secret fallback:

- `qorpera-cloud-secret-config`;
- `qorpera-cloud-secret-database-url`;
- `qorpera-cloud-secret-database-ca`;
- `qorpera-cloud-secret-control`;
- `qorpera-cloud-secret-runtime`; and
- `qorpera-cloud-secret-keyring`.

The broker service does not receive a Supabase `service_role` key. The isolated canary driver retains a separately encrypted service credential only for synthetic run setup and recovery; it is not loaded by the broker unit or exposed to a model guest.

Build a fresh, non-overwriting artifact with `npm run pack:cloud-secret-broker -- --out <new-directory>`.

The native Company File runtime receives only a distinct systemd-projected runtime bearer for the broker; environment-token fallback is rejected. That bearer stays in the trusted host and is not forwarded into the isolated model process. The model sees a named business tool with `{ idempotencyKey, input }`; grant, secret, destination, credential placement, protocol, and adapter identity remain host-owned.

## Capture and execution

Credential capture:

1. An authenticated member requests a capture ticket for an exact company/environment, owner class, connector, and secret name.
2. The typed client sends the secret fields directly to the broker's TLS origin with the single-use capture capability.
3. The broker revalidates the ticket, encrypts the fields, and commits only the envelope and digest through its independent authority.
4. The client receives a closed safe descriptor. The model, transcript, Company File, renderer log, runner, and database never receive plaintext.

Connector execution:

1. The native runtime lists current safe operation grants for the admitted run.
2. The model calls a named operation with business arguments and a stable operation key.
3. The cloud tool ledger admits an exact executing receipt and rechecks current grant authority.
4. The broker independently rechecks the run, sponsor, grant, operation, destination, receipt, input digest, credential version, and revocation state.
5. The broker unwraps in memory and invokes the compiled adapter. The adapter owns authentication placement and destination.
6. The broker reduces and fences the response before it can become an untrusted tool result. A completed effect with a withheld response remains completed and is not rerun.

## No local fallback

The legacy desktop vault and coding-agent `secret://` compatibility paths are not authority for governed cloud companies. They are not imported by the cloud broker, cloud Company File runtime, or broker package. Missing broker authority, TLS, a wrapping key, a current grant, or a receipt stops the operation. It never falls back to a member machine, local JSON, process environment, Company Computer file, browser clipboard, provider credential, or another member's connection.

## Verification completed

- TypeScript unit tests cover encryption identity binding, tamper rejection, zeroed callback lifetime, capture, rotation-compatible keyrings, adapter pinning, reflected-secret withholding, generic errors, typed tool schemas, durable receipt use, and authority rechecks.
- HTTP tests cover one-time capture transport, private runtime authentication, safe closed descriptor parsing, and reflected-secret withholding.
- Native runtime tests prove the model sees only the named business operation and not its grant or destination, while the durable operation ledger and current authority are checked before and after the effect.
- SQL test `305_cloud_secret_custody.test.sql` covers table/function privileges, company/member ownership, capture, immutable rotation, grants, agent archive, member removal, and absence of agent work or public sends.
- `npm run test:cloud-secret-custody` applies every migration to a disposable pinned PostgreSQL image, runs that SQL fixture directly, and removes the database.
- The standalone broker package test verifies a syntax-valid bundle, hardened systemd unit, explicit credential inputs, artifact hashes, and refusal to overwrite an existing artifact directory.
- The isolated Azure/Supabase acceptance passed capture, exact final-artifact use, reflected-response fencing, lost-response retry, restart, bounded stall, encrypted backup/restore, KEK rotation and live-key deletion, grant revocation, agent archive, member removal, and post-run non-exposure scans. The immutable record is [RUNTIME-STEP-2-SECRET-CUSTODY-ACCEPTANCE.md](../cloud-secret-broker/azure/RUNTIME-STEP-2-SECRET-CUSTODY-ACCEPTANCE.md).
- The dedicated-login extension re-applied all 91 migrations in disposable PostgreSQL, proved the live broker has no elevated role attributes, table privileges, `service_role` membership, or functions beyond its three fixed custody calls, and revoked `service_role` execution of those calls.
- The currently deployed bundle completed a safe effect and withheld raw, URL, base64, and base64url reflections. After an authenticated company-admin revocation, the same operation was denied at effect time and its receipt was reconciled to `cancelled / confirmed_not_run`.
- A post-operation scan derived 33 raw/encoded patterns from seven current host credential classes and found zero matches in 471 persistent files, the current system journal, reverse-proxy access logs, and crash locations.

## Step ownership

Step 2 owns the custody and non-exposure kernel through deployed canary proof. A deliberately bounded, non-production adapter is sufficient to exercise capture, authorization, unwrap, request construction, response fencing, recovery, rotation, and revocation.

Step 7 owns production connector installation, provider-specific adapters and operation catalogs, OAuth and API-key authorization UX, and connector-to-browser escalation. Production connector breadth does not hold Step 2 open, and the Step 2 canary is not a launch-ready connector.

## Step 2 deployment and live acceptance gates

These are coordinated deployment gates, not prompt work:

1. Apply and review the migration through the production database lane.
2. Provision the broker on compute separate from model runners and the Company Computer.
3. Register each company broker authority with an exact TLS service origin, independent broker capability hash, and active key id.
4. Put the keyring in the chosen cloud KMS/secret-manager custody, project it only as a broker systemd credential, and prove encrypted backup, restore, rotation, and deletion. Database, object-store, runner, client, and NAS operators must not receive the unwrap key by default.
5. Provision a distinct runtime bearer to each trusted native host and terminate member capture at the registered TLS origin. Do not expose the operation route publicly without service authentication and network policy.
6. Compile and register one reviewed, destination-bound non-production canary adapter and operation. It exists only to exercise the Step 2 custody contract.
7. Run the canary acceptance against that adapter: capture, use, reflected response, broker restart, key restore, rotation, grant revocation, agent archive, member removal, stalled request, lost completion response, and audit inspection.
8. Confirm logs, traces, crash reports, reverse-proxy access logs, database statements, Company File history, receipts, model requests, and public sends contain neither the canary nor its encodings.
9. Admit the exact canary tool through a signed final guest and real GPT connection, prove that the model sees only business arguments, and prove its shell, environment, filesystem, and network cannot reach broker credentials or KMS. Remove any temporary proof ingress immediately afterward.

Until those gates pass, the runtime must expose no connector tool rather than downgrade to local or plaintext custody.
