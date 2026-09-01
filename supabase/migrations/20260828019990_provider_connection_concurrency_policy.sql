-- 2026-09-01 amendment (contract section 17; addendum decision 2): a provider
-- connection MAY sponsor several concurrent runs under its concurrency
-- policy; quota, not exclusivity, is the ceiling. The Step 2 exclusive
-- per-connection lease was max_native_concurrency = 1 at the global provider
-- policy, which also capped every connection version's own policy at login.
-- Founder decision 2026-09-02: uncapped by default. The schema bounds the
-- value at 64 per connection, so the global policy and the login default
-- are that maximum; a lower per-connection policy may still be configured.
-- Each connection version records the bounded policy it was consented with,
-- per-run usage accounting is unchanged, lease acquisition still refuses a
-- run beyond least(version, policy), and no credential fallback exists.
alter table public.qorpera_provider_execution_policies alter column max_native_concurrency set default 64;
update public.qorpera_provider_execution_policies
set max_native_concurrency = 64,policy_version = policy_version + 1,updated_at = statement_timestamp()
where authentication_mode = 'native_subscription' and max_native_concurrency < 64;
