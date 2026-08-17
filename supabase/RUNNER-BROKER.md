# Runner object broker

The runner object broker is the only Storage path available to an outbound runner host. It converts the current runner session plus active job lease into narrowly scoped, integrity-checked object operations. It never passes database credentials, Storage credentials, signed URLs, or raw object paths into the sandbox.

The NAS is not involved in this slice.

## Authority boundary

- The runner session token is sent as a bearer header and the independent lease token as `x-qorpera-lease-token`. Tokens never appear in URLs or request bodies.
- The Edge Function hashes both tokens before calling service-role RPCs. Postgres stores and compares only SHA-256 hashes.
- Every request revalidates the active runner session, exact runner/job binding, lease hash, leased status, and two-minute lease expiry.
- Input authorization accepts only an object in a complete reachability graph rooted at the job's exact company snapshot or one of the exact artifact-index entries. A confirmed output object may also be reread by the same job for retry verification.
- Output authorization, upload confirmation, and artifact registration serialize on the job row. Completion, failure, expiry recovery, and revocation therefore cannot race a new durable output.

The broker is host-side infrastructure. Sandboxed customer code sees verified read-only files and a private writable output directory, not this protocol or its credentials.

## Operations

`POST` requests provide metadata and paging:

- `describe` returns the leased job, exact substrate version, company snapshot, artifact index, and output limits.
- `operations` pages the immutable company operation journal only through the substrate watermark.
- `artifacts` pages the exact immutable artifact index.
- `register_artifact` converts one confirmed output object into an immutable direct artifact, complete one-object reachability graph, and restore proof.

`GET` retrieves one authorized object. The function downloads it from the private profile bucket, verifies its byte length and SHA-256 digest, and then returns it with `no-store` caching.

`PUT` claims one direct output object, reads an exactly bounded body, verifies its digest, stores it content-addressed, verifies any pre-existing object, and confirms Storage presence in Postgres.

## Limits and durability

- Direct object size: 8 MiB maximum.
- Output objects: 100 maximum per job.
- Aggregate direct output: 64 MiB maximum per job.
- Metadata request body: 128 KiB maximum.
- Operation and artifact pages: 500 records maximum.
- Artifact root contract: `qorpera.object/v1`.

Sandbox output publication is deterministic. The host rereads and rehashes every scanned file, uploads the content-addressed object, derives a stable artifact UUID from the job, relative path, and digest, and retries safely after ambiguous responses. Successful job completion atomically creates an artifact index containing the source index plus exactly that job's outputs, then creates a child substrate with the source snapshot and operation watermark.

## Deployment

1. Apply `migrations/20260817000000_runner_object_broker.sql` after the runner registration, substrate, artifact, reachability, and Storage migrations.
2. Apply `migrations/20260817001000_runner_output_substrates.sql` to attribute artifacts to jobs and install atomic output-substrate completion.
3. Deploy `functions/runner-broker` and the updated `functions/runner-control` with JWT verification disabled as declared in `config.toml`. Each function performs custom 43-character token validation.
4. Keep the Supabase secret key inside the Edge Function environment. A runner receives only the function URL, runner UUID, current runner session token, active job UUID, and current lease token.
5. Validate that malformed requests return HTTP 400, unknown but structurally valid runner authority returns HTTP 401, authenticated desktop roles cannot execute broker RPCs, and only the service role can call the public broker entry points.

## Failure and recovery

- A lost metadata response can be repeated under the same lease.
- A lost output response repeats the same object digest and metadata. Existing Storage content is downloaded and rehashed before confirmation.
- A deterministic artifact UUID returns the existing artifact only when all immutable metadata matches; reuse with different content fails.
- A lost completion response reuses deterministic artifact-index and substrate-version UUIDs. Replay returns the same completed job and child substrate only when the immutable request matches.
- Expired, completed, failed, requeued, or revoked authority fails closed. The runner must obtain a current job lease rather than extending object access independently.
- Uploaded but unregistered output remains job-attributed and is not a durable retained root. Reference-aware cleanup can collect it in a later orphan-output policy; that automatic policy is not enabled in this slice.

Chunked runner output, explicit sibling-substrate merge/rebase, model/network brokering, usage metering, and physical compute isolation remain separate work.
