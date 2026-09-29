-- Company bootstrap: no attempt cap (re-cut of closed draft #326's 20260927182000).
--
-- qorpera_claim_company_bootstrap takes the oldest queued job, or the oldest whose lease expired, and
-- adds 1 to its attempt. The column allowed at most 1000, so once the oldest job reached it every claim
-- failed on the check, and no company behind it could finish its setup. Claims now recover queued jobs
-- and expired leases without a retry budget. Existing counts stay, and the counter stays monotonic
-- because governed publication operation keys include it. It stays an integer: a claim takes a lease of
-- at least 15 s, so reaching 2^31 would take over a thousand years, and changing the type would break
-- cached plans in open connections. Leases and publication authority are unchanged. F1's C2 replaces
-- this bootstrap chain for folder-v2 companies; this keeps the current chain working until then.
set local lock_timeout = '3s';
alter table public.qorpera_company_bootstrap_jobs
	drop constraint qorpera_company_bootstrap_jobs_attempt_check,
	add constraint qorpera_company_bootstrap_jobs_attempt_check check (attempt >= 0);
