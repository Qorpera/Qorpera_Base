# Runner broker

The runner broker is the runner host's lease-scoped path to its run. It converts the current runner session plus active job lease into a description of the leased folder-v2 run and into the run's native provider authority. It never passes database credentials, Storage credentials, signed URLs, or raw object paths into the sandbox.

The snapshot-v1 lane is gone since migration `20260930334000` (legacy sweep step D5): the broker no longer lists inputs, transcripts, operations or artifacts, serves or confirms objects, registers artifacts, meters model requests, or carries the runner's company revision lane. A folder-v2 run reads and writes its company through the folder lane, not through the broker.

## Authority boundary

- The runner session token is sent as a bearer header and the independent lease token as `x-qorpera-lease-token`. Tokens never appear in URLs or request bodies.
- The Edge Function hashes both tokens before calling service-role RPCs. Postgres stores and compares only SHA-256 hashes.
- Every request revalidates the active runner session, exact runner/job binding, lease hash, leased status, and lease expiry.

The broker is host-side infrastructure. Sandboxed customer code sees neither this protocol nor its credentials.

## Operations

Every request is a `POST` with a JSON body of at most 512 KiB:

- `describe` returns the leased job, its run and sponsor in the path lane's shape, with no Company File substrate or output limits (`qorpera_runner_broker_describe`, which refuses a proposal review and, since legacy sweep D8, a company that is not folder-v2).
- `native_authority` leases the run's native provider connection for 30 to 900 seconds and returns it with the run's model authority.
- `renew_native_authority` extends that lease for 30 to 900 seconds.
- `release_native_authority` ends it as `released`, `revoked`, or `expired`.

## Deployment

1. Deploy `functions/runner-broker` and `functions/runner-control` with JWT verification disabled as declared in `config.toml`. Each function performs custom 43-character token validation.
2. Keep the Supabase secret key inside the Edge Function environment. A runner receives only the function URL, runner UUID, current runner session token, active job UUID, and current lease token.
3. Validate that malformed requests return HTTP 400, unknown but structurally valid runner authority returns HTTP 401, authenticated desktop roles cannot execute broker RPCs, and only the service role can call the public broker entry points.

## Failure and recovery

- A lost description can be requested again under the same lease.
- Expired, completed, failed, requeued, or revoked authority fails closed. The runner must obtain a current job lease rather than extending its authority independently.

Successful runner resource observations are defined separately in `RUNNER-USAGE.md`.
