-- Bootstrap claims recover queued jobs and expired leases without a retry
-- budget. The old 1000 cap made an exhausted oldest job permanently block the
-- claim queue. Keep existing counts and monotonic publication operation keys;
-- do not reset counts, replace jobs, or change lease/publication authority.
alter table public.qorpera_company_bootstrap_jobs
    drop constraint qorpera_company_bootstrap_jobs_attempt_check,
    alter column attempt type bigint,
    add constraint qorpera_company_bootstrap_jobs_attempt_check check (attempt >= 0);
