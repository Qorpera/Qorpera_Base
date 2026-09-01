-- 2026-09-01 amendment (contract section 17; addendum decision 2): a provider
-- connection MAY sponsor several concurrent runs under its concurrency
-- policy; quota, not exclusivity, is the ceiling. The Step 2 exclusive
-- per-connection lease was max_native_concurrency = 1 at the global provider
-- policy, which also capped every connection version's own policy at login.
-- This raises the global ceiling so a per-connection policy above one is
-- admissible; each connection version still records the bounded policy it
-- was consented with, per-run usage accounting is unchanged, and the lease
-- acquisition still refuses a run beyond least(version, policy). No
-- credential fallback is introduced.
alter table public.qorpera_provider_execution_policies alter column max_native_concurrency set default 8;
update public.qorpera_provider_execution_policies
set max_native_concurrency = 8,policy_version = policy_version + 1,updated_at = statement_timestamp()
where authentication_mode = 'native_subscription' and max_native_concurrency < 8;
