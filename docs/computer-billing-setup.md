# Computer subscription integration

The initial server catalog contains Basis (185 DKK/month, 74 standard-computer hours), Standard (630 DKK/month, 286 standard-computer hours), and Dedicated (1,592 DKK/month, the actual paid calendar period at standard size). One standard computer is 4 vCPU / 8 GiB. Version 1 normalizes awake elapsed time by `max(reservedCPU / 4vCPU, reservedRAM / 8GiB)`. Half-size computers consume half an hour per awake hour; a double-size computer consumes two. Sleep and login helpers consume zero. This reference matches the documented coding worker configuration; deployment resource policies still pin the actual shape per machine.

All offers have `active_for_checkout=false`. Separate `runtime_accounting_ready` and `checkout_enabled` flags are also false. Publishing a tariff alone cannot enable purchases. The meter runs in shadow mode; physical observations do not automatically debit paid allowance.

Each metering epoch pins its allocation, exact instance digest, resource kind, tariff version, and the admitted node demand's CPU/memory shape when available. Unknown shape remains null and nonbillable. Checkpoints are cumulative, replay checked and monotonic; sequence gaps remain explicit. Multiple screens or coding sessions do not create additional machine hours. The node observer/outbox feeds shadow observations; gaps count zero uncertain active time, not guessed uptime. This is not yet sufficient for paid runtime enforcement.

Model subscriptions and credentials remain member-bound. Computer pool participation is self-authorized and company-scoped. Current runtime access can use explicit operator complimentary grants or an explicitly participating member's existing internal complimentary entitlement. A Computer Usage owner is a contact/preference; that role alone does not consent to sharing their allowance.

## Allowance kernel and remaining runtime work

Only a canonical paid Stripe subscription-cycle/create invoice issues an allowance bucket. Active subscription status alone issues nothing. A bucket belongs to one member and one paid subscription period globally, so participating in multiple companies never copies the balance. Overlapping periods cannot be funded twice. Dedicated uses the exact invoice line period length (February differs from March); no artificial pooling limits are added.

`qorpera_reserve_computer_allowance` holds a finite integer number of standard-computer microseconds against an exact allocation/epoch. It derives the direct responsible member from the run requester or coding-machine member, then uses currently consenting eligible company members. Shared computers have no arbitrary direct-member bypass; the company's Computer Usage owner may be preferred only with pool consent. Candidate global buckets lock in a consistent order. An insufficient pool rolls back the whole hold. A timeout never releases money while a physical computer might still be running.

`qorpera_settle_computer_allowance` reads an immutable checkpoint and its pinned resource shape/tariff, differences cumulative normalized time, and atomically converts holds to debits while releasing unused allowance. Cumulative rounding happens at microsecond precision, so checkpoint frequency cannot increase the bill. Immutable receipts and exact request replay prevent duplicate debit; exceeding a reservation fails closed and requires reconciliation. Withdrawal prevents new reservations but does not erase usage authorized by an existing hold. `qorpera_my_computer_usage()` exposes only the signed-in member's current paid balance and subscription summary.

**Before enabling paid service:** wire funding reservation before physical start/resume (the current kernel requires an observed epoch; add a prestart allocation budget and later epoch binding), renew bounded reservations while running, stop/disable the machine before its reservation is exhausted, and settle/release only against verified physical outcomes. Handle orphan holds, provider outages, refunds/chargebacks/credits, cancellation policy, late receipts, accounting alarms, and recovery. Neither the shadow observer nor the standalone ledger solves that lifecycle by itself. Keep both readiness flags and every offer disabled until those paths are implemented and exercised with Stripe test mode and a real disposable runtime node.

### Implementation follow-up: physical enforcement

Build one provider path end to end first, preferably member coding machines. Add a prestart allocation-budget RPC against the admitted node shape and exact immutable instance. Bind that budget once to the physical boot/epoch when observed. Persist a host permit before dispatch; its expiry must use host monotonic time and subtract RPC latency. A host restart or a changed machine/guest boot cannot extend the permit. Renewal must atomically settle the current checkpoint and reserve the next bounded interval across the same global member buckets.

An independent host-local watchdog must stop the actual VM or systemd sandbox when its permit cannot renew, including loss of executor, database, or network. The existing coding guest watchdog stops command slices only; the VM can remain awake and incur resource cost. Ordinary coding sleep custody also refuses a live leased turn. The paid permit therefore needs explicit expiry stop custody for the exact machine, granted before starting, plus enough reserved stopping time. Do not repurpose the read-only shadow observer into a privileged controller implicitly. Only verified physical stop/release may settle the remainder; unknown outcomes keep the hold and require recovery.

Current integration points:

- Coding: `qorpera_authorize_coding_machine_run` in `supabase/migrations/20260924220000_runtime_coding_member_machines.sql` reserves node capacity before effects. `packages/runner-orchestrator/src/coding-executor-host.ts` calls it in `#run`, dispatches VM state through `#reconcile`, and performs physical stop then `qorpera_suspend_coding_machine` in `#sleep`. Extend the admission receipt and durable machine journal with the paid permit; place physical expiry enforcement outside the executor's ordinary turn loop.
- Shared company computers: `reserveLxdOfficeNodeMachine` in `lxd-office-node-admission.ts` is used immediately before dispatch by `lxd-office-creation-worker.ts`, `lxd-office-boot-worker.ts`, `lxd-office-resume-worker.ts`, and `lxd-office-reset-worker.ts`. Every start/resume/reset route needs the same funding gate. `lxd-office-power-off-worker.ts` calls `suspendLxdOfficeNodeMachine` after confirmed power-off; reuse that verified outcome for settlement. Preserve the existing lifecycle revocation, privacy and stop-acknowledgement contracts.
- Native per-run VMs: `lxd-provider.ts` uses `#reserveMachine` followed by `#reserveNodeMachine` before creation/start, and `#releaseMachine` after physical deletion. Add the permit around those exact allocation/instance journals.
- Shared systemd execution: `shared-execution-backend.ts` calls `#reserveMachine` before starting host/runner units, then `#retire`/`#releaseMachine` after unit cleanup. It needs its own measured unit-uptime and expiry-stop adapter. LXD observations cannot stand in for these sandbox allocations.

All TypeScript paths above are under `packages/runner-orchestrator/src`. Keep provider-neutral SQL/permit definitions under one owner; provider-specific host adapters can be implemented independently. Paid readiness must cover every enabled physical path, or structurally refuse paid use on unsupported paths. Required tests include failure before/after provider dispatch, lost reserve/renew replies, cross-company contention, concurrent sessions sharing one machine, membership/pool withdrawal, host restart, database/network loss, stop failure and exact retry without duplicate debit. Run those against a disposable real node before publishing Checkout.

## Deployment prerequisites

No Stripe account or credentials have been provisioned by this change. Configure a Stripe test account first. Never use production payment credentials in unit tests.

Deploy `computer-billing` with gateway JWT verification disabled so Stripe can deliver raw webhooks. The handler verifies Stripe signatures itself; member routes separately validate their bearer token against Supabase Auth.

```toml
[functions.computer-billing]
verify_jwt = false
```

Required secrets/configuration:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: server-only database/Auth access.
- `QORPERA_STRIPE_SECRET_KEY`: Stripe server key for the configured account.
- `QORPERA_STRIPE_WEBHOOK_SECRET`: endpoint signing secret, never a client key.
- `QORPERA_STRIPE_LIVE_MODE`: explicitly `false` for test, `true` only for a reviewed live deployment.
- `QORPERA_BILLING_RETURN_URL`: fixed HTTPS application URL. Its origin is the only member CORS origin.
- `QORPERA_STRIPE_PORTAL_CONFIGURATION`: reviewed Stripe portal configuration ID. The service rechecks that it is active, belongs to the configured mode, and disables subscription updates before opening a portal session.
- `QORPERA_STRIPE_PRICE_PLANS`: JSON mapping explicitly configured Stripe price IDs to catalog versions, e.g. `{"price_example":{"planKey":"basis","version":1}}`. Price currency, amount, quantity, and monthly interval are rechecked against the server catalog.

Pin the Stripe webhook endpoint API version to `2026-08-26.dahlia`, matching outbound requests. Subscribe to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, and `invoice.payment_action_required`. Endpoint URL: `/functions/v1/computer-billing/webhook`.

After publication, Checkout creates the authenticated member's Stripe customer using a durable server command and then atomically records its immutable mapping. Existing verified customers can be mapped through service-only `qorpera_map_computer_billing_customer`. Members cannot supply customer IDs. Customer and Checkout commands have stable provider idempotency keys and database leases; a second request UUID cannot create another open payable session. Ambiguous creates older than 23 hours stop for provider reconciliation because Stripe can prune idempotency keys after 24 hours. Resolve those commands by verifying the exact existing Stripe customer/session before recording a result; never clear the command and blindly create another object.

## Routes and payment truth

- `POST /computer-billing/webhook`: verifies bounded raw-body HMAC and a five-minute signature timestamp window; rejects wrong mode/version. Claims a database lease per subscription and retrieves its canonical Stripe state. For `invoice.paid`, also retrieves the canonical invoice and validates paid status, customer, subscription, one configured non-prorated monthly line and its service period. Snapshot, invoice funding and event completion commit atomically. Old events trigger current retrieval rather than rewind state; an old paid period stays expired. Exact completed retries do not fetch again; changed replays fail. Original event timestamps/body digests remain in the inbox. Canonical retrieval times order snapshots, including events created in the same Stripe second. Unsupported adjustments/prorations require reconciliation and cannot mint a second full allowance.
- `POST /computer-billing/portal`, body `{}`: authenticated user's mapped customer only, with fixed configured return URL. Returns a hosted `billing.stripe.com` URL. Members cannot choose another customer or return address. Configure the portal without plan updates until checkout publication and the tariff are ready.
- `POST /computer-billing/checkout`, body containing `planKey`, `version`, and UUID `requestId`: authenticates, checks the server catalog/readiness and configured Stripe price, then creates the customer and hosted subscription Checkout using durable commands. Before creating another session it also checks canonical customer subscriptions, so a late payment webhook cannot allow a duplicate purchase after session expiry. Returns `{url,expiresAt}` for the resulting `checkout.stripe.com` session. Retry the same member/offer request ID after a lost reply; retain it until the known session expiry. Unpublished offers are rejected before customer/session creation. Success/cancel URLs come only from server configuration.

A successful browser redirect never grants access. Stripe subscription status alone also does not grant paid runtime allowance in the shadow phase. Provider timeouts and database errors return retryable failure without exposing provider responses, tokens, or secrets. Monitor webhook delivery failures and unmapped/unsupported subscriptions before enabling a live deployment.

## Validation

Run the focused fake-provider suite with `node --test supabase/functions/computer-billing/computer-billing.test.ts`. Apply SQL migrations to a disposable local database and run `630_company_computer_subscriptions.test.sql`, `633_computer_billing_sync.test.sql`, and `635_computer_allowance_ledger.test.sql`. The 635 fixture marker supports two-connection contention tests across companies. These tests create no real Stripe objects and spend no money.

Implementation references: [Stripe raw-body signature verification](https://docs.stripe.com/webhooks/signature), [subscription retrieval](https://docs.stripe.com/api/subscriptions/retrieve), [invoice payment truth](https://docs.stripe.com/api/invoices/object), [idempotency retention](https://docs.stripe.com/api/idempotent_requests), [API versioning](https://docs.stripe.com/api/versioning), and [customer portal](https://docs.stripe.com/customer-management).
