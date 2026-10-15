-- Test machine credits: F3 step 6, slice 6a, part 2 (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md), the credits
-- per unit of RUNTIME-COMPANY-FOLDER-C1B.md §8. A test machine's view saves for the commands that made each change.
-- 1. Shape: a unit's "credits" is absent, or 1 to 64 distinct command ids (uuid strings). Only a test machine's view
--    sends them; anywhere else they make the unit malformed ("Change set unit N is invalid", 22023).
-- 2. Check, per unit: each credited command still runs on the view's machine and placement (not ended). Otherwise the
--    unit is refused (command_ended) and nothing in it is applied; the other units go on.
-- 3. Authority, per unit: the unit's paths are checked once for each credited command's agent and member, in place of
--    the starter's within the view's principal set, and each credited agent must still be on staff (else denied). A
--    unit without credits is checked for the starter.
-- 4. The commit's actor: the valid credited command that started first (its agent, its member, its run while that
--    run's job is leased), else the starter. The commit row lists every valid credited command, in start order
--    (credits; null without any).
-- 5. The hook and the review act as the commit's actor; a review binds the commit's run (review_required without one).
-- 6. After the anchor step (the machine FOR SHARE, which every command end waits for), a saved unit whose credited
--    command has ended refuses the commit ("Folder view command has ended", 42501).
-- The read set's fan-out to the commands' runs and the take-in (part 3) and the crashed service refusal (part 4) come
-- later.
--
-- Exact-text patches: each fails unless the function has the text given exactly once; the function is replaced once,
-- after the last. Body marker "20260930421000".

set local lock_timeout = '3s';

do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_folder_commits'::regclass
		and attname = 'credits' and not attisdropped) then
		raise exception 'Test machine credits (20260930421000) are already applied'; end if;
end $$;

-- The patches edit the definition's text in order; the function is replaced once, after the last one (one patch opens
-- a loop that a later one closes, so a single patch does not compile on its own).
create temporary table folder_test_machine_credits_defs (fn regprocedure not null, def text not null);
create function pg_temp.folder_test_machine_credits_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text;
begin
	select def into v_definition from pg_temp.folder_test_machine_credits_defs where fn = p_function;
	if v_definition is null then
		v_definition := pg_get_functiondef(p_function);
		insert into pg_temp.folder_test_machine_credits_defs(fn, def) values (p_function, v_definition);
	end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	update pg_temp.folder_test_machine_credits_defs set def = replace(v_definition, p_old, p_new) where fn = p_function;
end
$patch$;
create function pg_temp.folder_test_machine_credits_apply() returns void language plpgsql as $apply$
declare v_fn regprocedure; v_def text; v_context text;
begin
	for v_fn, v_def in select fn, def from pg_temp.folder_test_machine_credits_defs loop
		begin
			execute v_def;
		exception when others then
			-- A short message: the statement's own text would be the whole function.
			get stacked diagnostics v_context = pg_exception_context;
			raise exception '% does not compile after the patches: % (%)', v_fn, sqlerrm, split_part(v_context, E'\n', 1);
		end;
	end loop;
	drop table pg_temp.folder_test_machine_credits_defs;
end
$apply$;

-- 4. The commands a test machine's commit credits: the valid ones, in start order; null when it credits none. No
-- foreign key: a removed machine's commands go, and the commit's history stays.
alter table public.qorpera_folder_commits add column credits uuid[],
	add constraint qorpera_folder_commits_credits check (credits is null
		or (view_kind = 'test_machine' and cardinality(credits) > 0 and array_position(credits, null) is null));

-- Its own variables.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	v_final boolean := false; -- 20260930183000: a command view's last change set (C1B §8)
$old$,
	$new$	v_final boolean := false; -- 20260930183000: a command view's last change set (C1B §8)
	-- 20260930421000: the first unit with credits; the valid credited commands by id (agent, member, live run, and
	-- whether the agent is still on staff) and in start order; the command the commit acts as, when not the starter;
	-- the view's own principal set; a unit's credits and the one being checked.
	v_credits_unit integer; v_credits jsonb := '{}'::jsonb; v_credit_ids uuid[] := '{}'; v_credit_actor jsonb;
	v_starter_auth jsonb; v_unit_credits text[]; v_credit_no integer;
$new$);

-- 1. Shape, with the other unit checks: only malformed requests raise.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$						or not public.qorpera_company_path_valid(v_path || '/' || (c.value ->> 'path'))))) then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
	end loop;$old$,
	$new$						or not public.qorpera_company_path_valid(v_path || '/' || (c.value ->> 'path'))))) then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
		-- 20260930421000: credits are 1-64 distinct command ids (uuid strings), from a view only; its kind is checked
		-- once it resolves.
		if v_unit ? 'credits' then
			if v_actor_kind <> 'view' or jsonb_typeof(v_unit -> 'credits') is distinct from 'array'
				or jsonb_array_length(v_unit -> 'credits') not between 1 and 64
				or exists (select 1 from jsonb_array_elements(v_unit -> 'credits') c
					where jsonb_typeof(c.value) is distinct from 'string'
						or c.value #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
				or (select count(distinct c.value) from jsonb_array_elements(v_unit -> 'credits') c)
					<> jsonb_array_length(v_unit -> 'credits') then
				raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
			v_credits_unit := coalesce(v_credits_unit, v_no);
		end if;
	end loop;$new$);

-- 1. Only a test machine's view; 5. a credited view's review is checked against the commit's run, below.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if p_review_id is not null and v_run_actor is null then
			raise exception 'Only a run carries a review' using errcode = '22023'; end if;$old$,
	$new$		-- 20260930421000: credits come only from a test machine's view. Credited units may act through a command's
		-- run, so their review is checked against the commit's run (review_required when it has none).
		if v_credits_unit is not null and v_view_early -> 'view' ->> 'kind' is distinct from 'test_machine' then
			raise exception 'Change set unit % is invalid', v_credits_unit using errcode = '22023'; end if;
		if p_review_id is not null and v_run_actor is null and v_credits_unit is null then
			raise exception 'Only a run carries a review' using errcode = '22023'; end if;$new$);

-- 2. The valid commands, 3. their principals' rows with the commit's own locks, 4. and 5. the actor for the hook.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	elsif v_actor_kind = 'member' then
		v_auth_actor := p_actor; v_hook_actor := p_actor;
	else
		v_hook_actor := p_actor;
	end if;
$old$,
	$new$	elsif v_actor_kind = 'member' then
		v_auth_actor := p_actor; v_hook_actor := p_actor;
	else
		v_hook_actor := p_actor;
	end if;

	-- 20260930421000 (C1B §8): a test machine's credits. 2. A credited command is valid while it runs on the view's
	-- machine and placement; each valid one with its agent, its member and its run while the run's job is leased (the
	-- view's resolve rule), and all of them in start order. Plain reads: no command row is locked, the anchor step
	-- re-checks the saved units' commands. 3. Each credited agent's staff row (rank 2) and member's row (rank 1) go with
	-- the commit's own locks, not required: a unit whose principals do not stand is denied, not the commit.
	-- 4. and 5. The first valid command is the commit's actor and the hook's, unless it is the starter's own.
	if v_credits_unit is not null then
		select coalesce(jsonb_object_agg(c.id::text, jsonb_build_object('staffAgentId', c.staff_agent_id,
				'requesterUserId', c.requested_by_user_id, 'runId', live.run_id, 'jobId', live.job_id)), '{}'::jsonb),
			coalesce(array_agg(c.id order by c.started_at, c.id), '{}')
		into v_credits, v_credit_ids
		from public.qorpera_company_machine_commands c
		left join lateral (select r.id as run_id, j.id as job_id from public.qorpera_execution_runs r
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where r.id = c.run_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) live on true
		where c.id in (select x.id::uuid from jsonb_array_elements(p_units) u
				cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id))
			and c.machine_id = v_view.company_machine_id and c.placement_id = v_view.placement_id and c.ended_at is null;
		v_starter_auth := v_auth_actor;
		v_targets := v_targets || coalesce((select jsonb_agg(t.target) from jsonb_each(v_credits) e
			cross join lateral (values
				(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
					'key', v_file.profile_id::text || ':' || (e.value ->> 'requesterUserId'), 'mode', 'keyshare', 'required', false)),
				(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
					'key', v_file.profile_id::text || ':' || (e.value ->> 'staffAgentId'), 'mode', 'keyshare', 'required', false))
			) t(target)), '[]'::jsonb);
		if cardinality(v_credit_ids) > 0 then
			v_credit_actor := v_credits -> (v_credit_ids[1]::text);
			if v_credit_actor ->> 'staffAgentId' = v_resolved ->> 'staffAgentId'
				and v_credit_actor ->> 'requesterUserId' = v_resolved ->> 'requesterUserId'
				and v_credit_actor ->> 'runId' is not distinct from v_resolved ->> 'runId' then
				-- The starter's own agent, member and run: the commit keeps its attribution as it is.
				v_credit_actor := null;
			else
				v_hook_actor := (v_hook_actor - array['jobId','staffVersion','causalWakeId','wakeKind','routineId','routineVersion'])
					|| jsonb_build_object('staffAgentId', v_credit_actor -> 'staffAgentId',
						'requesterUserId', v_credit_actor -> 'requesterUserId', 'runId', v_credit_actor -> 'runId',
						'jobId', v_credit_actor -> 'jobId');
			end if;
		end if;
	end if;
$new$);

-- 3. Under the locks, whether each credited agent is still on staff; 4. the commit's actor.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	-- The commit row, before any unit is applied (units reference it); outcomes and seq are written at the end.
$old$,
	$new$	-- 20260930421000: 3. each credited agent's staff row, read under its lock, as the starter's rank 2 row holds the
	-- starter. 4. The commit acts as the first valid credited command: its agent and member, and its run (null once
	-- the run's job is not leased); the starter's wake, routine and sponsor only stay with the starter's run.
	if v_credits_unit is not null then
		select coalesce(jsonb_object_agg(e.key, e.value || jsonb_build_object('stands', exists (select 1
				from public.qorpera_profile_staff s where s.profile_id = v_file.profile_id
					and s.staff_agent_id = (e.value ->> 'staffAgentId')::uuid and s.employment_status = 'active'))), '{}'::jsonb)
		into v_credits from jsonb_each(v_credits) e;
	end if;
	if v_credit_actor is not null then
		if v_credit_actor ->> 'runId' is distinct from v_resolved ->> 'runId' then
			v_resolved := v_resolved - array['jobId','staffVersion','causalWakeId','wakeKind','routineId','routineVersion'];
			v_attr := '{}'::jsonb;
		end if;
		v_resolved := v_resolved || jsonb_build_object('staffAgentId', v_credit_actor -> 'staffAgentId',
			'requesterUserId', v_credit_actor -> 'requesterUserId', 'runId', v_credit_actor -> 'runId');
		v_actor_id := (v_credit_actor ->> 'staffAgentId')::uuid;
	end if;

	-- The commit row, before any unit is applied (units reference it); outcomes and seq are written at the end.
$new$);
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		provider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id, receipt_id, proposal_id)$old$,
	$new$		provider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id, receipt_id, proposal_id,
		credits) -- 20260930421000$new$);
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		v_view.id, v_view.kind, v_turn_run, p_receipt_id, v_proposal.id);$old$,
	$new$		v_view.id, v_view.kind, v_turn_run, p_receipt_id, v_proposal.id,
		case when cardinality(v_credit_ids) > 0 then v_credit_ids end); -- 20260930421000$new$);

-- 2. and 3., per unit, before its authority; the authority check runs once per credited command.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		-- Authority on every path the unit touches (a subtree's boundaries included): write on what changes,
		-- read on a copy's source. A member as C1a; a run's agent for its requester and audience (C1B §3).
		if v_ok and v_actor_kind in ('member','run','view') then$old$,
	$new$		-- 20260930421000: 2. a credited command that no longer runs on the view's machine and placement refuses the
		-- unit (command_ended); 3. a credited agent off staff denies it. Then its authority is checked once for each
		-- credited command's agent and member, each in the starter's place within the view's principal set; a unit
		-- without credits is checked for the starter.
		v_unit_credits := array(select jsonb_array_elements_text(coalesce(v_unit -> 'credits', '[]'::jsonb)));
		if v_ok and exists (select 1 from unnest(v_unit_credits) c(id) where not v_credits ? c.id) then
			v_ok := false; v_reason := 'command_ended';
		elsif v_ok and exists (select 1 from unnest(v_unit_credits) c(id)
			where not coalesce((v_credits -> c.id ->> 'stands')::boolean, false)) then
			v_ok := false; v_reason := 'denied';
		end if;
		v_credit_no := 0;
		loop
			if cardinality(v_unit_credits) > 0 then
				v_credit_no := v_credit_no + 1;
				v_auth_actor := v_starter_auth || jsonb_build_object(
					'staffAgentId', v_credits -> v_unit_credits[v_credit_no] -> 'staffAgentId',
					'requesterUserId', v_credits -> v_unit_credits[v_credit_no] -> 'requesterUserId');
			end if;
		-- Authority on every path the unit touches (a subtree's boundaries included): write on what changes,
		-- read on a copy's source. A member as C1a; a run's agent for its requester and audience (C1B §3).
		if v_ok and v_actor_kind in ('member','run','view') then$new$);
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion' and v_unit -> 'expectedVersion' <> 'null'::jsonb then$old$,
	$new$			exit when v_credit_no >= cardinality(v_unit_credits) or not v_ok;
		end loop;
		if v_credit_no > 0 then v_auth_actor := v_starter_auth; end if; -- 20260930421000: the view's own, again

		if v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion' and v_unit -> 'expectedVersion' <> 'null'::jsonb then$new$);

-- 5. A parked unit carries no credits: the run that applies its proposal sends none. Its review binds the commit's run.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$					v_parked := v_parked || jsonb_build_array(jsonb_build_object('no', v_no, 'unit', v_unit, 'path', v_eff_path,$old$,
	$new$					v_parked := v_parked || jsonb_build_array(jsonb_build_object('no', v_no, 'unit', v_unit - 'credits', -- 20260930421000
						'path', v_eff_path,$new$);
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$				elsif v_review.id is null or v_review.run_id is distinct from (v_auth_actor ->> 'runId')::uuid$old$,
	$new$				elsif v_review.id is null or v_review.run_id is distinct from (v_resolved ->> 'runId')::uuid -- 20260930421000$new$);

-- 6. The race guard, after the anchor step: an end holds the machine row FOR UPDATE, so this new statement sees every
-- end that committed while the anchor waited for it.
select pg_temp.folder_test_machine_credits_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			from public.qorpera_runtime_office_shell_commands where id = v_view.shell_command_id and ended_at is null) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;$old$,
	$new$			from public.qorpera_runtime_office_shell_commands where id = v_view.shell_command_id and ended_at is null) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;
		-- 20260930421000: a saved unit's credited command that ended while this commit waited refuses the commit.
		if v_view.kind = 'test_machine' and exists (select 1 from jsonb_array_elements(v_outcomes) o
			cross join lateral jsonb_array_elements_text(p_units -> ((o.value ->> 'unit')::integer - 1) -> 'credits') c(id)
			where o.value ->> 'outcome' = 'saved' and not exists (select 1 from public.qorpera_company_machine_commands m
				where m.id = c.id::uuid and m.ended_at is null)) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;$new$);
select pg_temp.folder_test_machine_credits_apply();

-- The commit may have a private owner in production: it reaches the commands, the runs and jobs it reads them with,
-- and the credited agents' staff rows.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Test machine credit function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_company_machine_commands, public.qorpera_execution_runs, '
				'public.qorpera_runner_jobs, public.qorpera_profile_staff to %I', v_owner);
		end if;
	end loop;
end $$;
