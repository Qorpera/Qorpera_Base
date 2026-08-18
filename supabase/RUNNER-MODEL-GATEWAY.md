# Runner model gateway

The runner model gateway is a leased-job control plane for model calls. It does not expose provider, account, or gateway credentials to the runner or sandbox.

## Authority

An owner or admin explicitly configures one immutable model policy while a runner job is still queued. The policy names up to 32 exact provider/model pairs and sets cumulative call, input-token, and output-token ceilings. Each request conservatively reserves its encoded input size plus 16,384 tokens for controlled gateway instructions and tool schemas; observed usage replaces that reservation when the request finalizes.

The job creator and policy authorizer are separate identities:

- `actor_user_id` is the member whose job caused the call.
- `authorized_by_user_id` is the owner or admin who approved the bounded model authority.
- Neither field is treated as the final billing account. Account entitlement, profile sponsorship, credits, and invoicing remain a separate attribution layer.

A contributor can therefore cause already-authorized work without buying a plan or receiving authorization permission.

## Request path

1. The trusted runner host sends the model request to `runner-broker` with its rotating runner session and exact job lease credentials in headers.
2. The Edge Function hashes both credentials before invoking Postgres.
3. `qorpera_runner_broker_reserve_model_request` locks the leased job, checks the immutable model allowlist and remaining token/call budget, and binds the client request UUID to a request digest.
4. The Edge Function forwards only the provider, model, input, request UUID, and output limit to the configured Qorpera model gateway. The gateway credential remains in Edge Function secrets.
5. A bounded gateway response is finalized against the same lease and reservation. One immutable usage observation records provider, model, outcome, observed tokens, and provider-reported cost in micro-USD.

Completed request UUIDs replay their stored response, including after a job lease moves to another runner. An ambiguous timeout, transport error, invalid response, or non-success gateway status does not invent a permanent zero-usage result: the reservation remains unresolved, replay extends its recovery window, and the controlled gateway receives the same `idempotency-key`. The gateway must return the original result without starting or charging another provider call. Job completion is rejected while any unresolved model reservation remains. Prompt bodies are not stored in the authority or usage tables; the request digest and bounded final response provide retry integrity.

The encoded-input reservation is a conservative budget hold, not a claim about provider tokenization. A valid response may report more input tokens than the estimate and is recorded exactly. If a provider exceeds the requested output-token limit, the request fails for the runner but the reported input, output, and cost remain an immutable usage fact.

## Gateway contract

The Edge Function sends:

```json
{
  "request_id": "uuid",
  "provider": "provider-id",
  "model": "model-id",
  "input": {},
  "max_output_tokens": 1024
}
```

The gateway must treat `request_id` and the matching `idempotency-key` header as a durable idempotency key, then return a bounded JSON response:

```json
{
  "schema": "qorpera.model-gateway-response/v1",
  "output": {},
  "usage": {
    "input_tokens": 100,
    "output_tokens": 20,
    "cost_microusd": 250
  }
}
```

`QORPERA_RUNNER_MODEL_GATEWAY_URL` must be HTTPS outside local development. `QORPERA_RUNNER_MODEL_GATEWAY_TOKEN` must be a dedicated secret of at least 32 characters. It is never forwarded to the runner, placed in a job payload, or returned in an error.

## Sandbox handoff

The networkless container connects to one job-private Unix-domain socket mounted at `/qorpera/broker/model.sock`. The trusted worker owns the socket and the `CloudRunnerJobBroker`; the container receives neither runner/lease authority nor gateway/provider credentials. Each connection accepts one bounded, schema-versioned request frame and returns one bounded response or a generic rejection. The adapter has job-wide call and concurrency ceilings, rejects extra fields and multiple frames, and is destroyed with the container.

The socket exposes only model requests. Arbitrary URL forwarding is not part of this contract; approved network tools require named adapters, destination policy, DNS/IP revalidation, and separate request budgets.

## Current boundary

The database authority, Edge gateway adapter, host transport, policy administration, response replay, usage parsing, host socket adapter, worker lifecycle, and container client are implemented and use fake gateway responses in tests. Portable tests pass on Windows. The real Linux containment test now includes a networkless socket probe but has not been rerun for this revision. The production migration and Edge Function are not deployed, and no live or paid provider request has been made.

## Deployment

1. Apply `migrations/20260817003000_runner_model_gateway.sql` after the runner usage migration.
2. Apply `migrations/20260817006000_runner_recovery_ambiguity.sql` before configuring any paid provider. It preserves ambiguous reservations and makes both usage ledgers append-only with restrictive references.
3. Deploy the updated `functions/runner-broker`.
4. Configure a dedicated HTTPS model gateway and secret only after account entitlement and sponsorship enforcement are ready.
5. Run the real Linux containment workflow, then queue a disposable job, authorize one test model, replay one request UUID, and verify exactly one usage observation.
6. Verify a contributor cannot configure policy, an unlisted model cannot reserve, and runner credentials never reach the gateway.
