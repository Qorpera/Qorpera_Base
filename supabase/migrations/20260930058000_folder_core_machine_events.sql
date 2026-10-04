-- Company folder core, C1c-3i part b (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §6.17, LISTENER §9): a company
-- machine's events reach the folder-v2 run that started the work, as a drain of the shared folder drains step.
--
-- A command that ended, a machine that runs, or one stopped before it ran is a row of qorpera_company_machine_events
-- for the run that asked (its parent). On folder-v2 none reached its parent: the pin trigger refused a 'machine-event'
-- wake (0A000), qorpera_folder_wake_authorized answered false, qorpera_folder_run_resolve refused its run, and the legacy
-- drain skipped folder-v2 (nothing has called it since P28).
-- * The three refusals lose the 'machine-event' token only, found by each list's own statement and count-checked; a
--   list left empty (A1's C1c-3l removes 'office-activation') drops its whole statement. qorpera_folder_wake_authorized
--   also admits the event in a parent's room conversation, as worker completions are, and checks its chain with
--   qorpera_machine_wake_ancestry. P28's materializer already copies the parent's capability for it.
-- * qorpera_folder_parent_continuation (a parent's state for a continuation of a source kind: ready, running, pending,
--   stopped, gone) and qorpera_folder_insert_continuation (the agent wake, under the caller's admission): any drain that
--   continues a parent run uses them; machine events are the first.
-- * qorpera_folder_machine_events_due / _company: the shared drains' pair. A company's step takes the folder fence KEY
--   SHARE, rank 0, its parents' requesters, agents and authorities KEY SHARE (ranks 1 to 3), then the events FOR UPDATE
--   SKIP LOCKED (run-owned rows), the parents' conversations KEY SHARE in id order, and admission; then one wake per parent
--   with up to 8 of its events. One continuation per parent at a time; a stopped parent's events are suppressed, a gone
--   one's undeliverable; a running parent's events wait. No clock, nothing stronger than KEY SHARE before the events.
-- Quiet coding check-ins stay with coding dispatch on folder-v2 (C3): a check-in is a worker-completion wake, which the
-- same helpers carry. Every patched or new body carries the marker 20260930058000.

create function pg_temp.c1c3ib_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C1c-3i-b anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- Removes p_token from the one source-kind list that p_pattern finds in p_target (group 1: the whole statement, group 2:
-- the list), whatever else the list holds; p_note, a comment, ends the statement's last line. With no token left, the
-- statement goes and the note takes its place on a line of its own (p_empty_drops), or the removal refuses.
create function pg_temp.c1c3ib_drop_token(p_target regprocedure, p_pattern text, p_token text, p_note text, p_empty_drops boolean)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_match text[]; v_items text[]; v_kept text[]; v_separator text;
	v_statement text; v_indent text;
begin
	if (select count(*) from regexp_matches(v_definition, p_pattern, 'g')) <> 1 then
		raise exception 'C1c-3i-b list not found exactly once in %', p_target; end if;
	v_match := regexp_match(v_definition, p_pattern);
	v_items := array(select btrim(x) from unnest(string_to_array(v_match[2], ',')) x);
	if (select count(*) from unnest(v_items) x where x = quote_literal(p_token)) <> 1 then
		raise exception 'C1c-3i-b token % not found exactly once in %', p_token, p_target; end if;
	v_kept := array(select x from unnest(v_items) x where x <> quote_literal(p_token));
	v_separator := case when position(', ' in v_match[2]) > 0 then ', ' else ',' end;
	v_indent := coalesce((regexp_match(v_match[1], E'^\\n?(\\t*)'))[1], '');
	if cardinality(v_kept) = 0 then
		if not p_empty_drops then raise exception 'C1c-3i-b would empty a list in %', p_target; end if;
		v_statement := E'\n' || v_indent || p_note;
	else
		v_statement := replace(v_match[1], '(' || v_match[2] || ')', '(' || array_to_string(v_kept, v_separator) || ')')
			|| ' ' || p_note;
	end if;
	execute replace(v_definition, v_match[1], v_statement);
end $$;

-- 1. The source kind on folder-v2 -------------------------------------------------------------------------------------

select pg_temp.c1c3ib_drop_token('public.qorpera_pin_wake_occurrence()',
	$re$(\n\t*if new\.source_kind in \(([^)]*)\) then\n\t*raise exception 'This wake source does not serve folder-v2 yet' using errcode = '0A000'; end if;)$re$,
	'machine-event', '-- C1c-3i-b (20260930058000): a machine event continues its parent run on folder-v2.', true);
select pg_temp.c1c3ib_drop_token('public.qorpera_folder_run_resolve(uuid,uuid,jsonb)',
	$re$(\n\t*if v_wake\.source_kind in \(([^)]*)\) then\n\t*raise exception 'Folder writes by this kind of run are not available yet' using errcode = '0A000'; end if;)$re$,
	'machine-event', '-- C1c-3i-b (20260930058000): a machine event''s run writes as its agent.', true);
select pg_temp.c1c3ib_drop_token('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)',
	$re$(or p_wake\.source_kind in \(([^)]*)\) then return false; end if;)$re$,
	'machine-event', '-- C1c-3i-b (20260930058000): a machine event is checked below, as an agent wake.', false);
-- A parent running in a room's conversation is continued there, as a worker's completion is.
select pg_temp.c1c3ib_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)',
	$old$or (p_wake.source_kind = 'worker-completion'$old$,
	$new$or (p_wake.source_kind in ('worker-completion', 'machine-event')$new$);
select pg_temp.c1c3ib_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)',
	E'v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);\n',
	E'v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);\n'
	|| E'\t\telsif p_wake.source_kind = ''machine-event'' then v_ancestry := public.qorpera_machine_wake_ancestry(p_wake); -- 20260930058000\n');

-- 2. Continuing a parent run ------------------------------------------------------------------------------------------

-- Whether a parent run may take a continuation of p_source_kind now. No lock: callers read it before their locks and
-- again under them. ready; running (its job is queued or leased: wait); pending (a wake of this kind for it is queued, or
-- materialized with its job missing, queued or leased: one at a time); stopped (its job was cancelled or a member stopped
-- its revivals: suppress); gone (no run or job: undeliverable).
create function public.qorpera_folder_parent_continuation(p_parent_run_id uuid, p_source_kind text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_status text;
begin
	-- C1c-3i-b (20260930058000).
	select * into v_run from public.qorpera_execution_runs where id = p_parent_run_id;
	if v_run.id is null or v_run.job_id is null then return 'gone'; end if;
	select status into v_status from public.qorpera_runner_jobs where id = v_run.job_id;
	if v_status is null then return 'gone'; end if;
	if v_status in ('queued', 'leased') then return 'running'; end if;
	if v_status = 'cancelled' or public.qorpera_machine_revival_stopped(v_run.id) then return 'stopped'; end if;
	if exists (select 1 from public.qorpera_wake_occurrences pending
		left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
		left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
		where pending.parent_run_id = p_parent_run_id and pending.source_kind = p_source_kind
			and (pending.status = 'queued' or (pending.status = 'materialized'
				and (pending_job.id is null or pending_job.status in ('queued', 'leased'))))) then return 'pending'; end if;
	return 'ready';
end $$;

-- The agent wake that continues p_parent from p_source_kind's p_source_id, with p_payload. The caller holds the company's
-- folder fence and admission (the pin trigger refuses a wake without it); the pin trigger fills the conversation, the
-- requester, the payer and the causal chain from the parent.
create function public.qorpera_folder_insert_continuation(p_parent public.qorpera_execution_runs, p_source_kind text,
	p_source_id uuid, p_payload jsonb)
returns public.qorpera_wake_occurrences language plpgsql security definer set search_path = '' as $$
declare v_id uuid := extensions.gen_random_uuid(); v_wake public.qorpera_wake_occurrences%rowtype;
begin
	-- C1c-3i-b (20260930058000).
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
		parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (v_id, p_parent.profile_id, p_parent.environment_id, 'agent', p_source_kind, p_source_id, p_parent.staff_agent_id,
		p_parent.id, p_source_kind, p_source_kind || ':' || v_id::text, clock_timestamp(), clock_timestamp(), p_payload)
	returning * into v_wake;
	return v_wake;
end $$;

-- 3. The machine events drain -----------------------------------------------------------------------------------------

create index qorpera_company_machine_events_waiting_environment on public.qorpera_company_machine_events
	(environment_id, parent_run_id, created_at, id) where delivery = 'waiting';

-- The shared drains' page (LISTENER §9): folder-v2 companies, not deleting and not paused, with a waiting event whose
-- parent is ready, stopped or gone. A parent still running, or with its continuation pending, asks nothing.
create function public.qorpera_folder_machine_events_due(p_after_environment uuid default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_environments uuid[];
begin
	-- C1c-3i-b (20260930058000).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Folder machine events limit is invalid' using errcode = '22023'; end if;
	select coalesce(array_agg(x.environment_id order by x.environment_id), '{}') into v_environments from (
		select f.environment_id from public.qorpera_company_files f
		where f.core = 'folder-v2' and (p_after_environment is null or f.environment_id > p_after_environment)
			and exists (select 1 from public.qorpera_company_machine_events e
				where e.environment_id = f.environment_id and e.delivery = 'waiting'
					and public.qorpera_folder_parent_continuation(e.parent_run_id, 'machine-event') in ('ready', 'stopped', 'gone'))
			and not public.qorpera_company_deleting(f.profile_id)
			and not public.qorpera_company_execution_paused(f.profile_id)
		order by f.environment_id limit p_limit) x;
	return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('environment_id', e) order by e)
			from unnest(v_environments) e), '[]'::jsonb),
		'has_more', cardinality(v_environments) = p_limit,
		'next_after_environment_id', case when cardinality(v_environments) = p_limit
			then v_environments[cardinality(v_environments)] end);
end $$;

-- One company's step, in its own transaction (read committed): up to p_limit parents, oldest event first.
create function public.qorpera_folder_machine_events_company(p_environment_id uuid, p_limit integer default 8)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	c_schema constant text := 'qorpera.folder-machine-events/v1';
	v_profile uuid; v_parents jsonb; v_targets jsonb; v_parent uuid; v_ids uuid[]; v_state text; v_ready jsonb := '[]'::jsonb;
	v_item jsonb; v_run public.qorpera_execution_runs%rowtype; v_payload jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_sessions uuid[]; v_delivered integer := 0; v_suppressed integer := 0; v_undeliverable integer := 0; v_error text;
begin
	-- C1c-3i-b (20260930058000).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder machine events run at read committed' using errcode = '25000'; end if;
	if p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Folder machine events limit is invalid' using errcode = '22023'; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then return jsonb_build_object('schema', c_schema, 'state', 'not_folder'); end if;
	-- 1. Plain reads: the parents with waiting events that are ready, stopped or gone, oldest event first.
	select coalesce(jsonb_agg(jsonb_build_object('parent', p.parent_run_id, 'state', p.state) order by p.first_at, p.parent_run_id),
		'[]'::jsonb) into v_parents
	from (select w.parent_run_id, w.first_at, w.state from (
			select e.parent_run_id, min(e.created_at) as first_at,
				public.qorpera_folder_parent_continuation(e.parent_run_id, 'machine-event') as state
			from public.qorpera_company_machine_events e
			where e.environment_id = p_environment_id and e.delivery = 'waiting' group by e.parent_run_id) w
		where w.state in ('ready', 'stopped', 'gone') order by w.first_at, w.parent_run_id limit p_limit) p;
	if jsonb_array_length(v_parents) = 0 then return jsonb_build_object('schema', c_schema, 'state', 'idle'); end if;
	-- The ready parents' requesters, agents and authorities, KEY SHARE at ranks 1 to 3 (as the listener's wakes).
	select coalesce(jsonb_agg(distinct t.t), '[]'::jsonb) into v_targets
	from jsonb_array_elements(v_parents) x join public.qorpera_execution_runs r on r.id = (x.value ->> 'parent')::uuid
	cross join lateral (values
		(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members', 'key', v_profile::text || ':' || r.requested_by_user_id::text,
			'mode', 'keyshare')),
		(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', v_profile::text || ':' || r.staff_agent_id::text,
			'mode', 'keyshare')),
		(jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_profile::text || ':' || r.staff_agent_id::text, 'mode', 'keyshare'))) t(t)
	where x.value ->> 'state' = 'ready' and r.profile_id = v_profile;
	begin
		-- 2. The fence KEY SHARE, rank 0, ranks 1 to 3.
		perform public.qorpera_folder_company_enter(p_environment_id, v_profile, v_targets, false);
		if public.qorpera_company_deleting(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'deleting'); end if;
		if public.qorpera_company_execution_paused(v_profile) then
			return jsonb_build_object('schema', c_schema, 'state', 'paused'); end if;
		-- 3. Each parent's events FOR UPDATE SKIP LOCKED (run-owned rows), in parent id order, and the parent's state again
		-- under them. Events another step holds are its own.
		for v_parent in select (x.value ->> 'parent')::uuid from jsonb_array_elements(v_parents) x order by 1 loop
			select array_agg(ready.id order by ready.created_at, ready.id) into v_ids from (
				select event.id, event.created_at from public.qorpera_company_machine_events event
				where event.environment_id = p_environment_id and event.parent_run_id = v_parent and event.delivery = 'waiting'
				order by event.created_at, event.id limit 8 for update skip locked) ready;
			if v_ids is null then continue; end if;
			v_state := public.qorpera_folder_parent_continuation(v_parent, 'machine-event');
			if v_state = 'stopped' then
				update public.qorpera_company_machine_events set delivery = 'suppressed', scanned_at = clock_timestamp()
				where id = any(v_ids);
				v_suppressed := v_suppressed + cardinality(v_ids);
			elsif v_state = 'gone' then
				update public.qorpera_company_machine_events set delivery = 'undeliverable', scanned_at = clock_timestamp()
				where id = any(v_ids);
				v_undeliverable := v_undeliverable + cardinality(v_ids);
			elsif v_state = 'ready' then
				v_ready := v_ready || jsonb_build_array(jsonb_build_object('parent', v_parent, 'ids', to_jsonb(v_ids)));
			end if;
		end loop;
		if jsonb_array_length(v_ready) > 0 then
			-- 4. The parents' conversations KEY SHARE in id order, then admission.
			select array_agg(distinct r.session_id) into v_sessions from jsonb_array_elements(v_ready) x
			join public.qorpera_execution_runs r on r.id = (x.value ->> 'parent')::uuid where r.session_id is not null;
			perform 1 from public.qorpera_shared_sessions where id = any(coalesce(v_sessions, '{}')) and profile_id = v_profile
			order by id for key share;
			perform public.qorpera_folder_admit_wakes(v_profile);
			-- 5. One wake per parent, its events in at most 6 KiB. A pause at admission cancels the wake and the events wait;
			-- a parent whose agent, requester or conversation is gone, or whose events cannot be carried, is undeliverable.
			for v_item in select x.value from jsonb_array_elements(v_ready) x loop
				v_ids := array(select jsonb_array_elements_text(v_item -> 'ids')::uuid);
				select * into v_run from public.qorpera_execution_runs where id = (v_item ->> 'parent')::uuid;
				begin
					v_payload := public.qorpera_machine_event_payload(v_run.id, v_ids);
					while pg_column_size(v_payload) > 6144 and cardinality(v_ids) > 1 loop
						v_ids := v_ids[1:cardinality(v_ids) - 1];
						v_payload := public.qorpera_machine_event_payload(v_run.id, v_ids);
					end loop;
					v_wake := public.qorpera_folder_insert_continuation(v_run, 'machine-event', v_ids[1], v_payload);
					update public.qorpera_company_machine_events set scanned_at = clock_timestamp(),
						delivery = case when v_wake.status = 'queued' then 'delivered' else delivery end,
						occurrence_id = case when v_wake.status = 'queued' then v_wake.id else occurrence_id end
					where id = any(v_ids);
					if v_wake.status = 'queued' then v_delivered := v_delivered + 1; end if;
				exception when insufficient_privilege or no_data_found or object_not_in_prerequisite_state
					or check_violation or unique_violation or program_limit_exceeded then
					-- The step's answer names the last such refusal, for the operator.
					v_error := left(sqlstate || ': ' || sqlerrm, 300);
					update public.qorpera_company_machine_events set delivery = 'undeliverable', scanned_at = clock_timestamp()
					where id = any(v_ids);
					v_undeliverable := v_undeliverable + cardinality(v_ids);
				end;
			end loop;
		end if;
	exception when lock_not_available or deadlock_detected then
		return jsonb_build_object('schema', c_schema, 'state', 'busy');
	end;
	return jsonb_build_object('schema', c_schema, 'state', 'done', 'delivered', v_delivered, 'suppressed', v_suppressed,
		'undeliverable', v_undeliverable) || case when v_error is null then '{}'::jsonb else jsonb_build_object('lastError', v_error) end;
end $$;

revoke all on function public.qorpera_folder_parent_continuation(uuid, text),
	public.qorpera_folder_insert_continuation(public.qorpera_execution_runs, text, uuid, jsonb),
	public.qorpera_folder_machine_events_due(uuid, integer), public.qorpera_folder_machine_events_company(uuid, integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_machine_events_due(uuid, integer),
	public.qorpera_folder_machine_events_company(uuid, integer) to service_role;
