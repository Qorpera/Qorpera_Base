# Profile invitation email operations

Profile invitation email is a server-side outbox. The desktop creates a recipient-bound invitation through the existing authenticated RPC. Postgres creates the delivery row in the same transaction. A secret-authenticated Edge Function leases pending rows and sends transactional email through Resend.

The invitation UUID is not an authorization credential. Acceptance still requires a signed-in account whose normalized email matches the invitation. Expiry, cancellation, and role assignment remain database-enforced.

## Required configuration

1. Verify a sending domain in Resend. Use a dedicated transactional sender such as `Qorpera <invites@mail.qorpera.com>`.
2. Configure these Edge Function secrets from `functions/.env.example`:
   - `RESEND_API_KEY`
   - `QORPERA_INVITE_FROM`
   - `QORPERA_INVITE_URL`
3. Set `QORPERA_INVITE_URL` to `https://qorpera.com/invitation`. The website route lives in `Qorpera_Website/src/app/invitation/route.ts`. The email adds the invitation UUID as a URL fragment, so it is not sent in the HTTP request or server logs.
4. Deploy `profile-invitation-email` with JWT verification disabled as declared in `config.toml`.

Supabase automatically exposes the project URL and secret-key dictionary to the function. No database, Supabase, or Resend secret belongs in the desktop bundle.

## Schedule

Invoke the function every minute from Supabase Cron. Store the project URL and a Supabase secret key in Vault, then use `pg_cron` with `pg_net`:

```sql
select vault.create_secret('https://PROJECT_REF.supabase.co', 'qorpera_project_url');
select vault.create_secret('sb_secret_REPLACE_ME', 'qorpera_invitation_worker_key');

select cron.schedule(
	'qorpera-profile-invitation-email',
	'* * * * *',
	$$
	select net.http_post(
		url := (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_project_url')
			|| '/functions/v1/profile-invitation-email',
		headers := jsonb_build_object(
			'content-type', 'application/json',
			'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_invitation_worker_key')
		),
		body := '{}'::jsonb
	);
	$$
);
```

Creating or rotating the worker key and entering it into Vault are production credential operations. Do not place those values in migrations, source control, logs, or desktop configuration.

## Delivery behavior

- The worker claims at most 25 rows with a five-minute lease and `skip locked`, so overlapping invocations do not send the same job concurrently.
- Resend receives `qorpera-profile-invitation/<invitation UUID>` as its idempotency key.
- The HTTPS website handoff reads the invitation UUID from the fragment, removes it from browser history, and invokes the registered `qorpera://profile-invitation/<invitation UUID>` desktop route only after an explicit click. Its install link carries no invitation data.
- Network errors, rate limits, concurrent idempotency conflicts, and provider 5xx responses retry with database-persisted exponential backoff.
- Invalid sender, recipient, or request errors fail after the current attempt. Retryable deliveries stop automatically after eight attempts; a profile owner or admin can queue them again from profile settings.
- A provider success followed by a lost database response leaves the lease unresolved. The next worker retries with the same idempotency key and reconciles the provider result.
- Accepting, declining, cancelling, or expiring an invitation cascades to its outbox row.

## Operational checks

Monitor the delivery table by aggregate status rather than recipient address:

```sql
select status, count(*)
from public.qorpera_profile_invitation_deliveries
group by status
order by status;
```

Inspect failed rows only from the protected database dashboard. Provider errors are truncated to 1,000 characters and are exposed only to profile managers through the team RPC.

References: [Supabase scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions), [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets), and [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).
