-- The native host's describe refresh reads its run without the run mutex (production DB slowness, 16 October 2026).
--
-- Every qorpera_describe_native_tool_authority took the run mutex: qorpera_native_tool_locked_run runs
-- qorpera_folder_tool_run, which takes the run's qorpera_execution_run_budgets row FOR UPDATE (20260928279470). The
-- native host calls describe to open a tool run, to renew its authority (every 10 s at most; validForMs is capped at
-- 30 s) and before each tool operation. On production on 16 October, 15:04 to 15:36Z, host calls of 12 to 22 s held a
-- run's budget row; the same run's describe refreshes waited behind them until their 8 s lock_timeout, the authority
-- window lapsed, and the run's context_authority and manage_routine calls were denied authority_unavailable.
--
-- describe now takes a plain read when it is the transaction's entry point: request.path names describe in PostgREST's
-- form (/rpc/<name> or /rest/v1/rpc/<name>, the pattern of qorpera_company_fence_shared, 20260928339380), and no
-- function but describe and the host entry (qorpera_native_host_call, qorpera_native_host_call_long,
-- qorpera_native_host_dispatch) is on the call stack (a DO block or a session's own pg_temp function, which only
-- direct SQL can run, does not count; a call stack in any other form keeps the lock). The host dispatcher sets
-- request.path to the called function (20260928409985), and PostgREST to the RPC it runs, so this covers the host's
-- refresh, open and operation checks through qorpera_native_host_call and the office gateway's refresh through
-- PostgREST. Any other caller (the context
-- fence, qorpera_describe_company_run_context, the office, machine and hook functions that use describe as their run
-- check, direct SQL with no request.path) keeps qorpera_native_tool_locked_run, and a request.path set by hand gains
-- nothing inside any of them: only describe's own reads skip the mutex.
--
-- The plain read is qorpera_folder_native_run_plain: the locked check's lookups and refusals in its order, with no row
-- lock (the binding; the job's folder-v2 Company File, 42501; the stop, 55000; the company folder, 42501; the run's
-- resolve and its wake authority; a plain exists for each row the run entry requires, which are the company, the
-- requester's membership, the agent, and the room with its two memberships or the routine, 42501; then the lease, the
-- job lease and the run's model). It returns the same run row. It does not read the budget row, which exists for every
-- admitted run.
--
-- Why a plain read is safe for these callers: describe reads only the binding, the job, the run, the lease, the
-- runner, the assignment, the company's stop and folder, the resolved actor and the admitted bundle. A run's own steps
-- write none of those (they write receipts, transcript events, sends, views, the read set and the folder). Those rows
-- change only by admission, renewal, completion and cancel, resume and handoff, and none of those ever took the mutex,
-- so the mutex never ordered describe against them. A commit between two of describe's statements gives the old or
-- the new expiry (both true), the end of the run (a 42501 refusal, or the same short window a locked describe that
-- finished just before would have given), or a new identity (the host closes the run). Describe is advisory for
-- effects: every writer runs the locked run check again in its own transaction.
--
-- What keeps the mutex: the context fence (qorpera_fence_native_context and its nested describe), every writer (the
-- receipts, views, reads and releases, sends, the office and machine functions), and qorpera_assert_company_path_reads,
-- which reads the run's read set that the run's parallel steps write. describe's grants, settings and output are as
-- before; it is patched in place from pg_get_functiondef, so the fast-mode check of 20260927161500 stays. DB only: no
-- caller changes.
set local lock_timeout = '3s';

create function public.qorpera_folder_native_run_plain(p_binding jsonb)
returns public.qorpera_execution_runs language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_folder_native_actor(p_binding); v_file public.qorpera_company_files%rowtype;
	v_resolved jsonb; v_target record; v_found boolean;
begin
	select file.* into v_file from public.qorpera_runner_jobs job
	join public.qorpera_company_files file on file.environment_id = job.environment_id and file.core = 'folder-v2'
	where job.id = (v_actor ->> 'jobId')::uuid and job.run_id = (v_actor ->> 'runId')::uuid;
	if not found then raise exception 'native tool run is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_file.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_folder_fences where profile_id = v_file.profile_id) then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_resolved := public.qorpera_folder_run_resolve(v_file.environment_id, v_file.profile_id, v_actor);
	-- The rows the run entry requires (its resolve's targets, the requester's membership and the company row), in
	-- the entry's rank and table order, each read without a lock.
	for v_target in
		select t ->> 'tbl' as tbl, lower(t ->> 'key') as key, coalesce((t ->> 'required')::boolean, false) as required
		from jsonb_array_elements(coalesce(v_resolved -> 'lockTargets', '[]'::jsonb) || jsonb_build_array(
			jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', v_file.profile_id::text || ':' || (v_resolved ->> 'requesterUserId'), 'required', true),
			jsonb_build_object('rank', 0, 'tbl', 'qorpera_profiles', 'key', v_file.profile_id::text, 'required', true))) t
		order by (t ->> 'rank')::smallint, array_position(array['qorpera_profiles','qorpera_profile_members',
			'qorpera_profile_staff','qorpera_company_rooms','qorpera_company_room_members','qorpera_cloud_routines'], t ->> 'tbl')
	loop
		if v_target.tbl = 'qorpera_profiles' then
			v_found := exists (select 1 from public.qorpera_profiles where id = v_target.key::uuid);
		elsif v_target.tbl = 'qorpera_profile_members' then
			v_found := exists (select 1 from public.qorpera_profile_members
				where profile_id = split_part(v_target.key, ':', 1)::uuid and user_id = split_part(v_target.key, ':', 2)::uuid);
		elsif v_target.tbl = 'qorpera_profile_staff' then
			v_found := exists (select 1 from public.qorpera_profile_staff
				where profile_id = split_part(v_target.key, ':', 1)::uuid and staff_agent_id = split_part(v_target.key, ':', 2)::uuid);
		elsif v_target.tbl = 'qorpera_company_rooms' then
			v_found := exists (select 1 from public.qorpera_company_rooms where id = v_target.key::uuid);
		elsif v_target.tbl = 'qorpera_company_room_members' then
			v_found := exists (select 1 from public.qorpera_company_room_members where room_id = split_part(v_target.key, ':', 1)::uuid
				and principal_kind = split_part(v_target.key, ':', 2) and principal_id = split_part(v_target.key, ':', 3)::uuid);
		elsif v_target.tbl = 'qorpera_cloud_routines' then
			v_found := exists (select 1 from public.qorpera_cloud_routines where id = v_target.key::uuid);
		else
			raise exception 'Folder lock target table % is unknown', v_target.tbl using errcode = 'XX000';
		end if;
		if v_target.required and not v_found then
			raise exception 'A row this change set relies on is unavailable' using errcode = '42501'; end if;
	end loop;
	return public.qorpera_folder_native_run_current(p_binding);
end $$;
comment on function public.qorpera_folder_native_run_plain(jsonb) is
	'The run check of qorpera_native_tool_locked_run as plain reads: the same lookups, refusals and run row, with no row '
	'lock and no budget row. Only qorpera_describe_native_tool_authority calls it, as the entry point. 20260930487000.';
revoke all on function public.qorpera_folder_native_run_plain(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create temporary table j_describe_before as
select prosecdef, proconfig, provolatile from pg_proc
where oid = 'public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure;

create function pg_temp.j_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930487000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.j_replace('public.qorpera_describe_native_tool_authority(jsonb)',
	E'\tv_until timestamptz; v_remaining bigint; v_manifest jsonb;\n',
	E'\tv_until timestamptz; v_remaining bigint; v_manifest jsonb; v_context text;\n');

select pg_temp.j_replace('public.qorpera_describe_native_tool_authority(jsonb)',
	E'\tv_run := public.qorpera_native_tool_locked_run(p_binding);\n',
	$new$	-- 20260930487000: as the entry point (the host's or PostgREST's request.path names describe, and no function
	-- but the host entry calls it), a plain read without the run mutex; any other caller keeps the locked run check.
	get diagnostics v_context = pg_context;
	if substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$')
			is not distinct from 'qorpera_describe_native_tool_authority'
		and v_context ~ '^PL/pgSQL function (public\.)?qorpera_describe_native_tool_authority\(jsonb\) line '
		and not exists (select 1 from regexp_matches(v_context, '^(?:PL/pgSQL function |SQL function ")([^ ("]+)', 'gn') as f(name)
			where regexp_replace(f.name[1], '^public\.', '') not in ('qorpera_describe_native_tool_authority',
				'qorpera_native_host_dispatch', 'qorpera_native_host_call', 'qorpera_native_host_call_long')
				and f.name[1] !~ '^(pg_temp(_[0-9]+)?\.|inline_code_block$)') then
		v_run := public.qorpera_folder_native_run_plain(p_binding);
	else
		v_run := public.qorpera_native_tool_locked_run(p_binding);
	end if;
$new$);

do $$
declare v_helper pg_proc; v_describe pg_proc; v_before record;
begin
	select * into strict v_helper from pg_proc where oid = 'public.qorpera_folder_native_run_plain(jsonb)'::regprocedure;
	select * into strict v_describe from pg_proc where oid = 'public.qorpera_describe_native_tool_authority(jsonb)'::regprocedure;
	select * into strict v_before from pg_temp.j_describe_before;
	if not v_helper.prosecdef or v_helper.proconfig is distinct from array['search_path=""'] or v_helper.provolatile <> 'v'
		or v_helper.prorettype <> 'public.qorpera_execution_runs'::regtype
		or v_helper.prosrc ~* 'qorpera_execution_run_budgets|for (update|share|no key update|key share)'
		or exists (select 1 from unnest(array['public','anon','authenticated','service_role','qorpera_secret_broker']) r(name)
			where has_function_privilege(r.name, v_helper.oid, 'execute')) then
		raise exception '20260930487000: the plain run check is not as expected'; end if;
	if position('20260930487000' in v_describe.prosrc) = 0
		or position('v_run := public.qorpera_folder_native_run_plain(p_binding);' in v_describe.prosrc) = 0
		or position('v_run := public.qorpera_native_tool_locked_run(p_binding);' in v_describe.prosrc) = 0
		or position('(v_run.service_tier is null) <> (v_manifest #>> ''{modelPolicy,fastMode}'' is null)' in v_describe.prosrc) = 0
		or v_describe.prosecdef is distinct from v_before.prosecdef or v_describe.proconfig is distinct from v_before.proconfig
		or v_describe.provolatile is distinct from v_before.provolatile then
		raise exception '20260930487000: describe did not change as expected'; end if;
end $$;
