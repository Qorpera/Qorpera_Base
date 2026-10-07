# Qorpera object gateway

This is the trusted data-plane service between authenticated Qorpera clients,
Supabase's durable object catalog, and a Qorpera-owned NAS filesystem. It is not
an agent runner and never executes provider or company code.

The gateway authorizes each request against the caller's Supabase session,
hashes every upload server-side, writes immutable bytes under
`<profile-id>/<sha256>`, and only then confirms the catalog row with its
service credential. Downloads are rehashed. Cleanup requires the private
gateway control token plus either a live Supabase GC lease or its previously
committed, exact deletion authorization. The gateway authorizes first, removes
bytes second, and finalizes the catalog last, so a lost response is safely
reconcilable.

Required configuration:

- `QORPERA_SUPABASE_URL`
- `QORPERA_SUPABASE_PUBLISHABLE_KEY`
- `QORPERA_SUPABASE_SECRET_KEY`
- `QORPERA_OBJECT_GATEWAY_STORAGE_ROOT` (an absolute NAS-mounted directory)
- `QORPERA_OBJECT_GATEWAY_CONTROL_TOKEN`
- `QORPERA_OBJECT_GATEWAY_VERIFIER_TOKEN` (distinct from the cleanup control token)

`QORPERA_OBJECT_GATEWAY_HOST` defaults to `127.0.0.1` and
`QORPERA_OBJECT_GATEWAY_PORT` defaults to `8090`. Production exposure requires
an authenticated TLS reverse proxy, a dedicated service account, a private
storage mount with no client filesystem access, distinct cleanup and verifier
tokens, and verified NAS backup and restore. The verifier token grants
integrity-checked reads to the trusted Company File verifier, but cannot upload
or delete objects. Do not run this service on an execution worker.

Completed shared exports use `GET /v1/member-file-exports/<environment>/<asset>/<sha256>` with member bearer authentication. SQL requires current membership, a completed shared export receipt and available content. The gateway verifies bounded bytes and hash, then repeats authority before replying with `x-qorpera-access-mode: live-export-authority`. This route accepts no raw object hashes or local paths and performs no mutation. The member discovery API is `qorpera_list_member_file_exports`; its UUID cursor can advance over an empty page. `scripts/test-member-file-exports.mjs` verifies actual SQL, Linux export, storage, member download through this gateway and revocation during a read; `QORPERA_WEB_EXPORT_TEST_BROWSER` adds the member web app's browser download. Hosted proxy/NAS acceptance remains separate.

Native path activity uses `POST /v1/member-company-presence/<company>/<environment>` with a member bearer and JSON `{paths,candidates,truncated}`. The existing `QORPERA_MEMBER_COMPANY_FILES=1` configuration enables it through the member authority; embedded hosts may supply `memberPresence` separately. Each request checks member path scope before and after independent service-only native subject transactions, verifies Ed25519 signatures and intersects both actors' current path routes. It returns a closed display view plus verified client/sequence confirmations. It never returns native bindings, signing keys or routing tokens, stores no activity and admits no work. The operation is bounded to 2.5 seconds, 1 MiB, eight paths, 32 statements and four concurrent subject lookups. A stalled inbound body is disconnected. This optional display cannot authorize a file mutation.

Browser member clients require `QORPERA_MEMBER_CLIENT_ORIGINS`, a JSON array of
exact origins such as `["https://app.example.com"]`. The default is `[]`.
Only canonical HTTPS origins are accepted; `http://127.0.0.1:<port>` is allowed
for local development and acceptance. Wildcards, opaque origins, paths and
credentials are rejected. The allowlist is read at service startup.

CORS is limited to the member Company File object, upload, edit/review, export,
native activity display and session attachment routes and their specific methods and headers. Preflights
perform no authority or storage I/O. Actual requests retain all member bearer
token and live resource checks, including after object reads. Responses expose
the access-mode, ETag and pending plan hash headers; cookie credentials are not enabled. Private
native, verifier, cleanup, diagnostics and raw profile-object routes receive no
browser access. Desktop requests without an Origin header retain their existing
transport. Configure the same exact public web origin at the deployment proxy,
which must forward OPTIONS and preserve the gateway's CORS and Vary headers;
hosted proxy/TLS acceptance is a separate deployment gate.

`scripts/test-member-file-cors-browser.mjs` verifies the shared member reader in
Chromium against the actual gateway and disk store on a separate local origin.
It exercises native preflights, exposed headers, denied origins/private routes,
corrupt bytes and access revoked during storage I/O. Authority and control RPC
responses remain fixtures. Set `QORPERA_FILE_TEST_BROWSER` to an installed
Chromium executable; no deployment or external credentials are used.

Member binary uploads use `PUT /v1/member-company-file/<environment>/uploads`
with a bearer token, `application/octet-stream`, exact content length and the
canonical base64url UTF-8 `x-qorpera-company-upload` metadata. The shared client
constructs this closed schema. Migration `20260908003300` binds the selected
member filename/hash/size/media type and canonical manifest/chunks to the
original human command before staging. The gateway verifies all selected bytes
before storing them, stages only registered objects, and uses the existing live
publisher or protected human review. Retries cannot substitute a source or
decorate a previous text command. Uploads are at most 8 MiB with 4 MiB chunks;
the text endpoint stays limited to 32 KiB.

`GET /v1/member-company-file/<environment>/{edits|proposals}/<id>/file`
returns at most 8 MiB of verified pending content. Manifest and chunk reads use
the existing current member object authority, followed by a final command or
proposal check. The response is binary, non-cacheable and carries
`x-qorpera-plan-sha256`; clients verify that digest plus full file size/hash.
This does not publish the file or approve its plan. (Its SQL/HTTP/Chromium
script, `test-member-company-file-upload.mjs`, ran on snapshot-v1 and was deleted in the legacy sweep, B2b.)

The vault's connection-file writer (P22b) is off by default. With `QORPERA_CONNECTION_FILE_WRITER=1` it writes, every 15 s in a loop of its own, up to ten due `connections/<name>.md` files of folder-v2 companies as the platform, from the vault's allow-listed settings only (`qorpera_claim_connection_file` / `qorpera_finish_connection_file`); `QORPERA_CONNECTION_FILE_WORKER_ID` names the worker (a random id otherwise). A company whose creation has not completed is skipped until it has (P14a). The vault stays the authority: no tool reads these files to act.

Company creation's worker (P14b) is off by default. With `QORPERA_COMPANY_FOLDER_CREATOR=1` it claims, every 15 s in a loop of its own, up to five creations a founding table started (`qorpera_folder_company_creation_claim`), builds each company's seeded tree from the founders' input, stages its files as the platform and calls `qorpera_folder_company_create` once: the creation commit, the Co-Founder and its silent first run in one transaction. It releases a claim with a back-off on any other problem, and fails it only for a seed tree the parser or a writer refuses, or a staging refusal (`stage_invalid`). `QORPERA_COMPANY_FOLDER_CREATOR_WORKER_ID` names the worker (a random id otherwise).

After the schema is deployed and the NAS mount is validated, run
`qorpera-object-gateway migrate` under the same configuration. The command
pages legacy `supabase-storage` catalog rows, downloads and rehashes each
object, writes it to the NAS, and confirms the per-object backend transition.
It is idempotent and stops on the first integrity or authority failure.
