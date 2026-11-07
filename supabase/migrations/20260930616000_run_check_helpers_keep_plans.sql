-- The run check's SQL helpers keep their plans (perf sprint D6, 7 November 2026).
--
-- Every tool call runs the run check (qorpera_folder_tool_run, or qorpera_folder_native_run_plain for describe), and a
-- locked call holds the run mutex and its rank locks through it. Eight helpers of that check are LANGUAGE sql with
-- SECURITY DEFINER and SET search_path, so PostgreSQL cannot inline them, and before version 18 it parses and plans a
-- non-inlined SQL function's statement once per transaction and calling statement, which on this path is every call.
-- Under the load test (scripts/load-folder-core.mjs, 20 runs, 4 CPUs) these eight took 28 % of the self time of the top
-- 60 functions; alone on a test machine each call costs 0.05 to 0.85 ms, and a tool call makes about ten of them.
--
-- Now they are PL/pgSQL with the same expression. PL/pgSQL keeps a statement's plan for the connection and replans it
-- on DDL. Only the plan is kept: every call reads the rows again, so no answer is cached and no check is skipped.
-- What stays the same:
-- - the statement of each, word for word, so the same rows give the same answer;
-- - volatility, SECURITY DEFINER, search_path, owner, grants and cost (checked below). A volatile function's statement
--   takes a new snapshot and a stable one the caller's, in both languages, so a stop or a recovery that committed during
--   a wait at the run mutex is seen as before (supabase/tests/1116, 648 D);
-- - the one lock among them: qorpera_execution_sponsor_available still calls qorpera_run_autonomous_authority, whose
--   FOR SHARE on a wake run's provider connection is an authorization lock. The run mutex itself is not touched.
-- qorpera_run_worker returned NULL for a run with no worker, and still does (a real NULL, not a row of NULLs).
--
-- DB only: no caller changes. The first statement of a function on a new connection pays for the plan (a PostgREST
-- connection lives up to 30 minutes).
set local lock_timeout = '3s';

-- What each function must be before this migration, so a concurrent change to one fails here rather than being lost.
create temporary table d6_before as
select p.oid, p.proname::text as name, l.lanname::text as language, md5(p.prosrc) as source_md5, p.provolatile, p.prosecdef, p.proisstrict,
	p.proleakproof, p.proparallel, p.procost, p.proconfig, p.proowner, p.proacl, p.prorettype
from pg_proc p join pg_language l on l.oid = p.prolang
where p.oid in ('public.qorpera_execution_compute_available(public.qorpera_execution_runs)'::regprocedure,
	'public.qorpera_execution_sponsor_available(public.qorpera_execution_runs)'::regprocedure,
	'public.qorpera_company_execution_paused(uuid)'::regprocedure,
	'public.qorpera_sponsor_serves_requester(uuid,uuid,bigint,uuid)'::regprocedure,
	'public.qorpera_connection_is_chatgpt_plan(uuid)'::regprocedure,
	'public.qorpera_sponsor_version_is_chatgpt_plan(uuid,bigint)'::regprocedure,
	'public.qorpera_run_worker(uuid)'::regprocedure,
	'public.qorpera_runner_session_valid(uuid,text)'::regprocedure);

do $$
begin
	if (select count(*) from pg_temp.d6_before) <> 8 or exists (select 1 from pg_temp.d6_before where language <> 'sql')
		or exists (select 1 from pg_temp.d6_before b
			where b.source_md5 is distinct from case b.name
				when 'qorpera_execution_compute_available' then '4dd031b06d5625f132ac06467e832729'
				when 'qorpera_execution_sponsor_available' then '625180c2f3697bb94a1085d64783fcda'
				when 'qorpera_company_execution_paused' then '27aea3cd6bceb8cb51edb5033ff978a3'
				when 'qorpera_sponsor_serves_requester' then 'c8f1979c3b7a8b8aba57aff496d3552a'
				when 'qorpera_connection_is_chatgpt_plan' then 'a928a0358057d4a734b4f6c7431aa33a'
				when 'qorpera_sponsor_version_is_chatgpt_plan' then '057b519194a5c0dd347166924da886c1'
				when 'qorpera_run_worker' then 'b59977fe0c51487b3b895c3db0db77fa'
				when 'qorpera_runner_session_valid' then 'b209ee7fabf452780065c910e6db0cc2' end) then
		raise exception '20260930616000: a run check helper is not the one this migration replaces'; end if;
end $$;

create or replace function public.qorpera_execution_compute_available(p_run public.qorpera_execution_runs)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
	return (p_run.logical_computer_id is null or exists (
		select 1 from public.qorpera_logical_computers computer join public.qorpera_runner_jobs job on job.id = p_run.job_id
		where computer.id = p_run.logical_computer_id and computer.profile_id = p_run.profile_id
			and computer.status = 'active' and computer.capabilities ? job.required_capability))
	and (p_run.compute_identity_id is null or exists (
		select 1 from public.qorpera_member_compute_identities identity where identity.id = p_run.compute_identity_id
			and identity.profile_id = p_run.profile_id and identity.status = 'active'
			and identity.recovery_pending_id is null and identity.recovery_epoch = p_run.compute_recovery_epoch));
end $$;

create or replace function public.qorpera_execution_sponsor_available(p_run public.qorpera_execution_runs)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
	return exists (
		select 1
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_run.sponsor_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id
		join public.qorpera_execution_sponsor_reservations as reservation
			on reservation.run_id = p_run.id and reservation.status = 'reserved'
		join public.qorpera_runner_model_policies as policy on policy.job_id = p_run.job_id
		where binding.id = p_run.sponsor_binding_id and binding.profile_id = p_run.profile_id
			and binding.status = 'active' and connection.profile_id = p_run.profile_id
			and connection.status = 'active'
			and public.qorpera_run_autonomous_authority(p_run)
			and (
				sponsor.sponsor_kind <> 'member_connection'
				or exists (
					select 1 from public.qorpera_profile_members as member
					where member.profile_id = p_run.profile_id
						and member.user_id = connection.owner_user_id
				)
			)
	);
end $$;

create or replace function public.qorpera_company_execution_paused(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id)
		or exists (select 1 from public.qorpera_company_deletions where profile_id = p_profile_id);
end $$;

create or replace function public.qorpera_sponsor_serves_requester(p_profile_id uuid, p_binding_id uuid, p_version bigint, p_requester uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return coalesce((
		select case when sponsor.sponsor_kind = 'member_connection'
				then connection.owner_user_id is not null and connection.owner_user_id = p_requester
			else connection.owner_user_id is null end
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = binding.id and sponsor.version = p_version
		join public.qorpera_provider_connections as connection
			on connection.id = sponsor.provider_connection_id and connection.profile_id = binding.profile_id
		where binding.id = p_binding_id and binding.profile_id = p_profile_id), false);
end $$;

create or replace function public.qorpera_connection_is_chatgpt_plan(p_connection_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (select 1 from public.qorpera_provider_connection_versions as version
		join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
		where version.connection_id = p_connection_id and login.login_kind = 'chatgpt_plan');
end $$;

create or replace function public.qorpera_sponsor_version_is_chatgpt_plan(p_binding_id uuid, p_version bigint)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return coalesce((select public.qorpera_connection_is_chatgpt_plan(sponsor.provider_connection_id)
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_binding_id and sponsor.version = p_version), false);
end $$;

create or replace function public.qorpera_run_worker(p_run_id uuid)
returns public.qorpera_runtime_workers language plpgsql stable security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype;
begin
	select worker.* into v_worker from public.qorpera_wake_occurrences wake
	join public.qorpera_runtime_workers worker on worker.id = wake.source_id
	where wake.run_id = p_run_id and wake.wake_kind = 'agent' and wake.source_kind = 'worker-dispatch';
	if not found then return null; end if;
	return v_worker;
end $$;

create or replace function public.qorpera_runner_session_valid(p_runner_id uuid, p_token_sha256 text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (
		select 1
		from public.qorpera_runners as runner
		where runner.id = p_runner_id and runner.status = 'active'
			and (
				(runner.session_token_sha256 = p_token_sha256
					and runner.session_expires_at > statement_timestamp())
				or (runner.previous_session_token_sha256 = p_token_sha256
					and runner.previous_session_expires_at > statement_timestamp())
			)
	);
end $$;

do $$
begin
	if exists (select 1 from pg_temp.d6_before b join pg_proc p on p.oid = b.oid join pg_language l on l.oid = p.prolang
		where l.lanname <> 'plpgsql' or p.provolatile <> b.provolatile or p.prosecdef <> b.prosecdef or not p.prosecdef
			or p.proisstrict <> b.proisstrict or p.proleakproof <> b.proleakproof or p.proparallel <> b.proparallel
			or p.procost <> b.procost or p.proconfig is distinct from b.proconfig
			or p.proconfig is distinct from array['search_path=""'] or p.proowner <> b.proowner
			or p.proacl is distinct from b.proacl or p.prorettype <> b.prorettype) then
		raise exception '20260930616000: a run check helper changed more than its language'; end if;
end $$;

drop table pg_temp.d6_before;
