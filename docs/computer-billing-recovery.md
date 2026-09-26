# Recovering an ambiguous billing command

Use this procedure only for a customer or Checkout creation command that reports `reconciliation_required` after 23 hours. It never repeats the provider create, changes the command UUID, or interprets an empty search result as permission to create again. Checkout remains subject to the ordinary publication flags and canonical active-subscription check.

The operator must identify the exact existing Stripe object in the configured account. New objects carry the original command key in `metadata.qorpera_command_id`. Older objects also require the exact canonical Stripe event whose `request.idempotency_key` equals that command's retained provider key. A customer must match the member; a Checkout session must also match the immutable customer, offer, quantity, subscription mode and return URLs. Wrong environments, deleted objects, missing correlation, and unsupported states remain unresolved.

The helper uses canonical Stripe GET requests only. It writes a private proof file before changing the database. The database independently checks command identity, age, lease expiry, exact intent, proof shape and freshness. The proof and decision become immutable; an exact retry returns the original decision. A provider timeout or lost database reply never resets the command.

Create an operator-owned regular JSON file with mode `0600`, outside source control:

```json
{
  "supabaseUrl": "https://your-project.supabase.co",
  "serviceKey": "<service role key>",
  "billingSecret": "<independently enrolled billing bridge secret>",
  "stripeSecretKey": "<Stripe server key for this account>",
  "liveMode": false
}
```

The service role alone cannot recover commands. The dedicated billing bridge credential must be enrolled and unrevoked. Keep both it and the Stripe key off browsers, guests and runtime nodes. Use a trusted operator machine and the correct Stripe test/live mode. The helper requires Node 24 and uses the application's pinned Stripe API version.

Prepare a proof using absolute private paths and the retained database command ID:

```sh
node scripts/computer-billing-recovery.mjs \
  --config /private/operator/billing.json \
  --command <command-uuid> \
  --object <cus_id-or-cs_id> \
  --out /private/operator/new-recovery-proof.json
```

For an older object without command metadata, add `--event <evt_id>`. The output file must not already exist. Preparation does not alter the command. Review the retained identities and proof, then apply within ten minutes:

```sh
node scripts/computer-billing-recovery.mjs \
  --config /private/operator/billing.json \
  --apply /private/operator/new-recovery-proof.json
```

If the apply reply is lost, repeat the exact apply command with the same file. A committed proof remains replayable after its freshness window. If an uncommitted proof expires, prepare another file from fresh canonical retrieval; do not alter the original command or provider key. Retain the applied file privately with operational evidence; it contains member/provider identifiers and may contain a still-payable Checkout URL.

A recovered customer resumes the original command with its existing immutable mapping. A recovered open Checkout session returns the existing URL until its verified expiry. A recovered completed or expired session returns a typed terminal result, with no payment URL. The client retires only that exact retained attempt; another explicit user action can then request a new command, subject to the canonical active-subscription check. Recovery itself issues no allowance and does not assert that a payment succeeded; normal canonical invoice reconciliation remains authoritative.

If no exact existing object can be proved, leave the command unresolved for account-specific investigation. Do not delete command rows, age them forward, clear leases manually, or manufacture an absence proof. Run `node --test scripts/computer-billing-recovery.test.mjs` and disposable SQL test `664_computer_billing_command_recovery.test.sql` for this boundary.
