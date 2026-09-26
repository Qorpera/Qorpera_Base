# Account usernames rollout

Account settings save the chosen name in Auth metadata's `display_name`.
`20260926000000_account_display_names.sql` projects it into company memberships,
emits the existing member refresh hint, and resolves the same name for friends.
Apply that migration transactionally before publishing this web change.

## Production preflight, 26 September 2026

The canonical web app uses Supabase project `phqlfrkcvstmxlebljcj`.
Read-only inspection confirmed active/latest runtime version 126 with SHA-256
`18b370ad54d1811eaa92de16d8721ddccc11c60dc0ac75064a3f33084826a170`.
The account-name helper was absent. GitHub's hosted database workflow tests a
disposable database; merging does not apply production SQL.

The historical v126 activation is preserved byte for byte. The regenerated
source candidate uses a separate v127 activation. Do not apply that activation
or replace a runtime host as part of this account-only rollout. It belongs to
the next coordinated runtime release, after verifying the latest shipped
version and recutting it if another runtime release has landed.

The browser records the candidate runtime identity in `web-deployment.json`
as build provenance; it neither submits nor enforces that hash on requests.
The account migration changes display metadata and refresh hints, not execution
admission or runtime contracts. Production can keep v126 hosts and v126 active
while this migration and the web client are deployed.

## Release sequence

1. Apply only `20260926000000_account_display_names.sql` in one transaction with
   bounded lock and statement timeouts, recording its version in the existing
   Supabase migration journal. Do not apply all pending migrations blindly.
2. Verify the helper and three triggers exist, member names match saved Auth
   metadata, the friend function uses the helper, and the active bundle remains
   the original v126 hash. Do not expose account metadata in verification output.
3. Merge the reviewed PR into the Pages production branch. Verify the canonical
   deployment manifest identifies the merged commit and expected build files.
4. Verify account settings show the editable name and email subtitle, and that
   saved names appear in the account rail, friends, and company members.

## Production database verification

On 26 September 2026, the account-name migration was applied through the
project's SQL editor in a transaction with a 5-second lock timeout and a
30-second statement timeout. Its exact SQL was recorded in the migration
journal under version `20260926000000`. Post-commit verification confirmed the
helper, all three triggers, zero membership-name mismatches, and the friends
function's use of the helper. The active runtime remained the original v126
hash above. No v127 runtime activation was applied.

The web deployment and live account UI still need verification after merge.
