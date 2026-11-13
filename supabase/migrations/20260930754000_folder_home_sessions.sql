-- The agent's home and the company folder: slice 3 of lanes/agent-box-20261113/HOME-PLAN.md, as reworked after the
-- audit of 13 Nov 2026 (lanes/agent-box-20261113/S3-FOLDER-WINDOW.md). A home is a company machine on which the model
-- works with its own shell and file tools, one session per run and boot (builder A's 20260930752000,
-- qorpera_company_home_sessions). Its /company is its boot's own company-wide view, as for machine_run: a view of the
-- run's own cannot be had on a disk that held the company-wide view, and every machine there is held it or was used
-- without the folder check. So a home takes today's rule for a machine, and the machinery a machine_run command has,
-- with the session in the command's place.
--
-- 1. Which runs (qorpera_folder_home_shared): the machine's own partition, as 20260930747000 takes a machine again (its
--    starter's agent, member and worker access), and a run whose agent and member read the folder's root
--    (qorpera_folder_reads_root, the rule every machine command on a disk with a view has had since 20260930420000).
--    Builder A's offer (qorpera_company_home_available) offers no other machine, so a run that may not share one keeps
--    today's tools; and the executor asks again before the channel starts (qorpera_folder_home_session_window).
-- 2. Credit: while the session's channel is open, the executor holds a folder command window for it in the folder
--    service, its id the session's, as it holds one for a running command. A change the machine makes meanwhile carries
--    the session's id in its unit's credits. The commit takes a session of the view's machine, placement and boot as a
--    credit beside a running command (20260930421000): the unit is checked for the session's agent and member, and the
--    first credit is the commit's actor, with the session's run while its job is leased. A session stays a credit after
--    it closed: its window's last boundary comes after the run closed it.
-- 3. Reads: a test machine's release reaches every run with a session open on the machine, as it reaches every run with
--    a command running there (20260930480000). The executor lets what the channel sends back leave only after a
--    boundary released the machine's reads and the run took them in (20260930498000), as for a command's output.
--
-- What it does NOT change: the view, its kind, its mount and its pass; a command's own credit, fan-out and take-in.
--
-- Exact-text patches: each fails unless the function has the text given exactly once; a function with several patches
-- is replaced once, after the last. Body marker "20260930754000".

set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_folder_home_session_window(uuid)') is not null then
		raise exception 'Home sessions in the folder (20260930754000) are already applied'; end if;
	if to_regclass('public.qorpera_company_home_sessions') is null then
		raise exception 'Home sessions in the folder (20260930754000) need 20260930752000 first'; end if;
end $$;

create temporary table folder_home_sessions_defs (fn regprocedure not null, def text not null);
create function pg_temp.folder_home_sessions_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text;
begin
	select def into v_definition from pg_temp.folder_home_sessions_defs where fn = p_function;
	if v_definition is null then
		v_definition := pg_get_functiondef(p_function);
		insert into pg_temp.folder_home_sessions_defs(fn, def) values (p_function, v_definition);
	end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	update pg_temp.folder_home_sessions_defs set def = replace(v_definition, p_old, p_new) where fn = p_function;
end
$patch$;
create function pg_temp.folder_home_sessions_apply() returns void language plpgsql as $apply$
declare v_fn regprocedure; v_def text; v_context text;
begin
	for v_fn, v_def in select fn, def from pg_temp.folder_home_sessions_defs loop
		begin
			execute v_def;
		exception when others then
			-- A short message: the statement's own text would be the whole function.
			get stacked diagnostics v_context = pg_exception_context;
			raise exception '% does not compile after the patches: % (%)', v_fn, sqlerrm, split_part(v_context, E'\n', 1);
		end;
	end loop;
	drop table pg_temp.folder_home_sessions_defs;
end
$apply$;

-- 1. Which runs ---------------------------------------------------------------------------------------------------------

-- Whether the run p_run_id of agent p_staff_agent_id, working for member p_member_user_id, may work on p_machine as its
-- home: the machine is that agent's, started for that member by a run of the same worker access (none, or the same
-- access), as 20260930747000 takes a machine again; and the agent and the member read the folder's root, because a disk
-- of today's image holds what the company-wide view served it (20260930420000). Internal.
create function public.qorpera_folder_home_shared(p_machine public.qorpera_company_machines, p_staff_agent_id uuid,
	p_member_user_id uuid, p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930754000
	select coalesce(p_machine.started_by_staff_agent_id = p_staff_agent_id
		and p_machine.requested_by_user_id = p_member_user_id
		and (public.qorpera_run_worker(p_machine.started_by_run_id)).access
			is not distinct from (public.qorpera_run_worker(p_run_id)).access
		and public.qorpera_folder_reads_root(p_machine.environment_id, p_machine.profile_id, p_staff_agent_id,
			p_member_user_id), false)
$$;
revoke all on function public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Builder A's offer gives a run only a home it may share.
select pg_temp.folder_home_sessions_patch('public.qorpera_company_home_available(jsonb)'::regprocedure,
	$old$		and machine.started_by_staff_agent_id = (v_identity ->> 'staffAgentId')::uuid
$old$,
	$new$		and machine.started_by_staff_agent_id = (v_identity ->> 'staffAgentId')::uuid
		-- 20260930754000: the agent's machine for this member and worker access, and only while they read the root.
		and public.qorpera_folder_home_shared(machine, (v_identity ->> 'staffAgentId')::uuid,
			(v_identity ->> 'requesterUserId')::uuid, (p_binding ->> 'runId')::uuid)
$new$);

-- The executor's ask before a session's channel starts, after builder A's authority (qorpera_authorize_home_session):
-- whether the session still stands on its machine's current placement and boot, and may share the machine; and the ids
-- its folder command window carries. A refusal is an answer: the executor starts no channel, and A's relay tells the
-- model the machine is not available. The service role only (the executor).
create function public.qorpera_folder_home_session_window(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_company_home_sessions%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
begin
	-- 20260930754000
	if auth.role() is distinct from 'service_role' or p_session_id is null then
		raise exception 'Home session window scope invalid' using errcode = '22023'; end if;
	select * into v_session from public.qorpera_company_home_sessions where id = p_session_id;
	if v_session.id is null then
		raise exception 'Home session window unavailable' using errcode = '42501'; end if;
	select * into v_machine from public.qorpera_company_machines where id = v_session.machine_id;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_session.closed_at is not null or v_machine.removed_at is not null
		or v_placement.id is distinct from v_session.placement_id or v_placement.boot_id is distinct from v_session.boot_id
		or v_placement.removed_at is not null or v_placement.retired_at is not null then
		return jsonb_build_object('schema','qorpera.folder-home-session/v1','state','refused','reason','HOME_SESSION_ENDED');
	end if;
	if not public.qorpera_folder_home_shared(v_machine, v_session.staff_agent_id, v_session.requested_by_user_id,
			v_session.run_id) then
		return jsonb_build_object('schema','qorpera.folder-home-session/v1','state','refused','reason','HOME_NOT_SHARED');
	end if;
	return jsonb_build_object('schema','qorpera.folder-home-session/v1','state','open','sessionId',v_session.id,
		'runId',v_session.run_id,'staffAgentId',v_session.staff_agent_id,'requestedByUserId',v_session.requested_by_user_id,
		'machineId',v_machine.id,'placementId',v_placement.id,'bootId',v_placement.boot_id);
end
$$;
revoke all on function public.qorpera_folder_home_session_window(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_home_session_window(uuid) to service_role;

-- 2. The commit: a session's credit ------------------------------------------------------------------------------------

-- Step 2's job locks take the credited sessions' runs' jobs with the commands'.
select pg_temp.folder_home_sessions_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			select coalesce(array_agg(distinct r.job_id), '{}') into v_job_locks
			from public.qorpera_company_machine_commands c
			join public.qorpera_folder_views fv on fv.id = (p_actor ->> 'viewId')::uuid
				and fv.company_machine_id = c.machine_id and fv.placement_id = c.placement_id
			join public.qorpera_execution_runs r on r.id = c.run_id
			where c.id in (select x.id::uuid from jsonb_array_elements(p_units) u
					cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id))
				and c.ended_at is null and r.job_id is not null;$old$,
	$new$			select coalesce(array_agg(distinct credited.job_id), '{}') into v_job_locks
			from (select r.job_id from public.qorpera_company_machine_commands c
				join public.qorpera_folder_views fv on fv.id = (p_actor ->> 'viewId')::uuid
					and fv.company_machine_id = c.machine_id and fv.placement_id = c.placement_id
				join public.qorpera_execution_runs r on r.id = c.run_id
				where c.id in (select x.id::uuid from jsonb_array_elements(p_units) u
						cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id))
					and c.ended_at is null and r.job_id is not null
				-- 20260930754000: and the runs of the credited home sessions of the view's machine, placement and boot.
				union all
				select r.job_id from public.qorpera_company_home_sessions s
				join public.qorpera_folder_views fv on fv.id = (p_actor ->> 'viewId')::uuid
					and fv.company_machine_id = s.machine_id and fv.placement_id = s.placement_id and fv.boot_id = s.boot_id
				join public.qorpera_execution_runs r on r.id = s.run_id
				where s.id in (select x.id::uuid from jsonb_array_elements(p_units) u
						cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id))
					and r.job_id is not null) credited;$new$);

-- The credits: a command running on the view's machine and placement, or a session of its machine, placement and boot.
select pg_temp.folder_home_sessions_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		from public.qorpera_company_machine_commands c
		left join lateral (select r.id as run_id, j.id as job_id from public.qorpera_execution_runs r
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where r.id = c.run_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) live on true
		where c.id in (select x.id::uuid from jsonb_array_elements(p_units) u
				cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id))
			and c.machine_id = v_view.company_machine_id and c.placement_id = v_view.placement_id and c.ended_at is null;$old$,
	$new$		from (select m.id, m.staff_agent_id, m.requested_by_user_id, m.run_id, m.started_at
				from public.qorpera_company_machine_commands m
				where m.machine_id = v_view.company_machine_id and m.placement_id = v_view.placement_id and m.ended_at is null
			-- 20260930754000: a home session of the view's machine, placement and boot, open or closed (its window's last
			-- boundary comes after its run closed it). It started when it opened.
			union all
			select s.id, s.staff_agent_id, s.requested_by_user_id, s.run_id, s.opened_at
				from public.qorpera_company_home_sessions s
				where s.machine_id = v_view.company_machine_id and s.placement_id = v_view.placement_id
					and s.boot_id = v_view.boot_id) c
		left join lateral (select r.id as run_id, j.id as job_id from public.qorpera_execution_runs r
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where r.id = c.run_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) live on true
		where c.id in (select x.id::uuid from jsonb_array_elements(p_units) u
				cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id));$new$);

-- After the anchor step a saved unit's credited command must still run; a credited session need not.
select pg_temp.folder_home_sessions_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			where o.value ->> 'outcome' = 'saved' and not exists (select 1 from public.qorpera_company_machine_commands m
				where m.id = c.id::uuid and m.ended_at is null)) then$old$,
	$new$			where o.value ->> 'outcome' = 'saved' and not exists (select 1 from public.qorpera_company_machine_commands m
				where m.id = c.id::uuid and m.ended_at is null)
				-- 20260930754000: a credited home session of the view's placement and boot, open or closed.
				and not exists (select 1 from public.qorpera_company_home_sessions s where s.id = c.id::uuid
					and s.placement_id = v_view.placement_id and s.boot_id = v_view.boot_id)) then$new$);

-- 3. The release reaches the runs with a session open on the machine ---------------------------------------------------

select pg_temp.folder_home_sessions_patch(
	'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
	$old$						where c.machine_id = v_test_machine and c.placement_id = v_test_placement and c.ended_at is null
						union all select (v_run_actor ->> 'jobId')::uuid)$old$,
	$new$						where c.machine_id = v_test_machine and c.placement_id = v_test_placement and c.ended_at is null
						-- 20260930754000: and the runs with a home session open on the view's machine, placement and boot.
						union all select r.job_id from public.qorpera_company_home_sessions s
						join public.qorpera_execution_runs r on r.id = s.run_id
						where s.machine_id = v_test_machine and s.placement_id = v_test_placement and s.closed_at is null
							and s.boot_id = (select v.boot_id from public.qorpera_folder_views v where v.id = v_view_id)
						union all select (v_run_actor ->> 'jobId')::uuid)$new$);
select pg_temp.folder_home_sessions_patch(
	'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
	$old$		select coalesce(array_agg(distinct c.run_id order by c.run_id), '{}') into v_fan_runs
		from public.qorpera_company_machine_commands c
		join public.qorpera_execution_runs r on r.id = c.run_id
		join public.qorpera_runner_jobs j on j.id = r.job_id
		where c.machine_id = v_test_machine and c.placement_id = v_test_placement and c.ended_at is null
			and j.id = any (v_fan_jobs) and j.status = 'leased' and j.lease_expires_at > clock_timestamp();$old$,
	$new$		select coalesce(array_agg(distinct c.run_id order by c.run_id), '{}') into v_fan_runs
		from (select m.run_id from public.qorpera_company_machine_commands m
				where m.machine_id = v_test_machine and m.placement_id = v_test_placement and m.ended_at is null
			-- 20260930754000: and every run with a home session open on the view's machine, placement and boot.
			union all
			select s.run_id from public.qorpera_company_home_sessions s
				where s.machine_id = v_test_machine and s.placement_id = v_test_placement and s.closed_at is null
					and s.boot_id = (select v.boot_id from public.qorpera_folder_views v where v.id = v_view_id)) c
		join public.qorpera_execution_runs r on r.id = c.run_id
		join public.qorpera_runner_jobs j on j.id = r.job_id
		where j.id = any (v_fan_jobs) and j.status = 'leased' and j.lease_expires_at > clock_timestamp();$new$);

select pg_temp.folder_home_sessions_apply();

-- The patched and new functions may have a private owner in production: it reaches what their text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
		'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure,
		'public.qorpera_company_home_available(jsonb)'::regprocedure,
		'public.qorpera_folder_home_shared(public.qorpera_company_machines,uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_folder_home_session_window(uuid)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Home session folder function has an API owner'; end if;
	end loop;
	-- The commit and the release read the sessions beside the commands.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
		'public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_company_home_sessions, public.qorpera_folder_views to %I', v_owner);
		end if;
	end loop;
	-- The offer asks whether a machine may be shared.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_company_home_available(jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant execute on function '
				'public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid) to %I', v_owner);
		end if;
	end loop;
end $$;
