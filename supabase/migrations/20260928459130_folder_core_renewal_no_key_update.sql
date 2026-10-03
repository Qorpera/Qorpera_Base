-- Company folder core, C3 (P23, part 1): a folder-v2 run's lease renewals take its job FOR NO KEY UPDATE
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §3 step 2; RUNTIME-COMPANY-FOLDER-C1B.md "Not in C1b";
-- RUNTIME-COMPANY-FOLDER-C1C.md §5.8).
--
-- A folder-v2 run's tool calls, commits and views hold its job FOR KEY SHARE. Renewal took the job FOR UPDATE, so it
-- waited for every call in flight (test 648 C). FOR NO KEY UPDATE does not conflict with KEY SHARE, so renewal now runs
-- beside them and is never starved; every change that ends the lease (requeue, cancel, handoff, completion, re-claim)
-- still takes FOR UPDATE and waits for them, as core §3 requires. Changes only folder-v2 behaviour: each snapshot-v1
-- statement stays in the else branch.
-- * qorpera_renew_runner_job: the job FOR NO KEY UPDATE on folder-v2. The lease update after it writes no key column,
--   so it needs no stronger lock (no upgrade); its trigger updates the assignment row, which the folder run path does not
--   lock (C1c-2a's lease check takes no row locks).
-- * qorpera_renew_native_provider_connection_lease (the second lease, C1b inventory): on folder-v2 its job check is
--   qorpera_folder_renewal_locked_job, qorpera_runner_broker_locked_job's text with the job FOR NO KEY UPDATE. The other
--   callers of locked_job (acquire, release, model authority) keep FOR UPDATE.

-- 1. Patch helper (a name unique to this migration: pg_temp lives for the whole session) ---------------------------

create function pg_temp.p23_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'P23 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. The renewal's job check on folder-v2: locked_job's text with the job FOR NO KEY UPDATE --------------------------

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_runner_broker_locked_job(uuid,text,uuid,text)'::regprocedure);
	c_lock constant text := E'\t\tand job.lease_expires_at > statement_timestamp()\n\tfor update;\n';
begin
	if (length(v_definition) - length(replace(v_definition, c_lock, ''))) / length(c_lock) <> 1
		or position('FUNCTION public.qorpera_runner_broker_locked_job(' in v_definition) = 0 then
		raise exception 'P23 locked_job anchor changed'; end if;
	v_definition := replace(v_definition, 'FUNCTION public.qorpera_runner_broker_locked_job(', 'FUNCTION public.qorpera_folder_renewal_locked_job(');
	v_definition := replace(v_definition, c_lock,
		E'\t\tand job.lease_expires_at > statement_timestamp()\n'
		|| E'\t-- P23 (20260930002200): a folder-v2 renewal; tool calls hold the job KEY SHARE, which this mode does not block.\n'
		|| E'\tfor no key update;\n');
	-- A new function, so CREATE rather than CREATE OR REPLACE: it must not exist yet.
	execute replace(v_definition, 'CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
end $$;

-- 3. Patches ------------------------------------------------------------------------------------------------------------

do $$
begin
	perform pg_temp.p23_replace('public.qorpera_renew_runner_job(uuid,text,uuid,text)',
		E'\tselect job.* into v_job from public.qorpera_runner_jobs as job\n'
		|| E'\twhere job.id = p_job_id and job.status = ''leased'' and job.runner_id = p_runner_id\n'
		|| E'\t\tand job.lease_token_sha256 = p_lease_token_sha256\n'
		|| E'\t\tand job.lease_expires_at > statement_timestamp() for update;\n',
		E'\t-- P23 (20260930002200): on folder-v2 the job FOR NO KEY UPDATE, beside the run''s tool calls (KEY SHARE).\n'
		|| E'\tif public.qorpera_job_is_folder_v2(p_job_id) then\n'
		|| E'\t\tselect job.* into v_job from public.qorpera_runner_jobs as job\n'
		|| E'\t\twhere job.id = p_job_id and job.status = ''leased'' and job.runner_id = p_runner_id\n'
		|| E'\t\t\tand job.lease_token_sha256 = p_lease_token_sha256\n'
		|| E'\t\t\tand job.lease_expires_at > statement_timestamp() for no key update;\n'
		|| E'\telse\n'
		|| E'\tselect job.* into v_job from public.qorpera_runner_jobs as job\n'
		|| E'\twhere job.id = p_job_id and job.status = ''leased'' and job.runner_id = p_runner_id\n'
		|| E'\t\tand job.lease_token_sha256 = p_lease_token_sha256\n'
		|| E'\t\tand job.lease_expires_at > statement_timestamp() for update;\n'
		|| E'\tend if;\n', 1);

	perform pg_temp.p23_replace('public.qorpera_renew_native_provider_connection_lease(uuid,uuid,text,uuid,text,integer)',
		E'\tv_job := public.qorpera_runner_broker_locked_job(\n'
		|| E'\t\tp_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256\n'
		|| E'\t);\n',
		E'\t-- P23 (20260930002200): on folder-v2 the job FOR NO KEY UPDATE, beside the run''s tool calls (KEY SHARE).\n'
		|| E'\tif public.qorpera_job_is_folder_v2(p_job_id) then\n'
		|| E'\t\tv_job := public.qorpera_folder_renewal_locked_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);\n'
		|| E'\telse\n'
		|| E'\tv_job := public.qorpera_runner_broker_locked_job(\n'
		|| E'\t\tp_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256\n'
		|| E'\t);\n'
		|| E'\tend if;\n', 1);
end $$;

-- 4. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through the native lease renewal.
revoke all on function public.qorpera_folder_renewal_locked_job(uuid, text, uuid, text) from public, anon, authenticated, service_role;
