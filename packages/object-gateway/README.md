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

`QORPERA_OBJECT_GATEWAY_HOST` defaults to `127.0.0.1` and
`QORPERA_OBJECT_GATEWAY_PORT` defaults to `8090`. Production exposure requires
an authenticated TLS reverse proxy, a dedicated service account, a private
storage mount with no client filesystem access, and verified NAS backup and
restore. Do not run this service on an execution worker.

After the schema is deployed and the NAS mount is validated, run
`qorpera-object-gateway migrate` under the same configuration. The command
pages legacy `supabase-storage` catalog rows, downloads and rehashes each
object, writes it to the NAS, and confirms the per-object backend transition.
It is idempotent and stops on the first integrity or authority failure.
