-- WHY: Eliminate polling bottlenecks across team hiring follow-ups, company founding, background workers, and outbound mail/invitations.
set local lock_timeout = '3s';

-- WHY: Batch follow-up convergence (1 -> 16 subjects/tick) and add a run-scoped commit follow-up kick.

create function public.qorpera_folder_follow_up_converge_inner(
	p_work public.qorpera_folder_follow_ups,
	p_defer_journal boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_out jsonb;
	v_state text;
	v_message text;
	v_result text;
	v_changes jsonb := '[]'::jsonb;
	v_timeout text := current_setting('lock_timeout');
begin
	if p_work.subject_kind = 'company' then
		v_out := public.qorpera_folder_converge_company(p_work.environment_id);
	else
		begin
			v_out := public.qorpera_folder_converge_agent(
				p_work.environment_id,
				p_work.subject_id,
				p_work.hired_by_user_id,
				p_work.first_run_manual
			);
			v_out := v_out || jsonb_build_object('changes', coalesce(v_out -> 'changes', '[]'::jsonb));
			if jsonb_typeof(v_out -> 'changes') is distinct from 'array'
				or exists (select 1 from jsonb_array_elements(v_out -> 'changes') c
					where jsonb_typeof(c) <> 'object'
						or (select array_agg(k order by k) from jsonb_object_keys(c) k)
							is distinct from array['grantId','prefix','revision']
						or c -> 'revision' <> '1'::jsonb or jsonb_typeof(c -> 'prefix') <> 'string'
						or not exists (select 1 from public.qorpera_company_path_grants g where g.id::text = c ->> 'grantId'))
				or (jsonb_array_length(v_out -> 'changes') > 0
					and not exists (select 1 from public.qorpera_folder_clocks k where k.environment_id = p_work.environment_id)) then
				raise exception 'A follow-up''s journal changes are malformed' using errcode = 'XX000';
			end if;
		exception when others then
			get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
			v_out := jsonb_build_object(
				'result', case when v_state = '55000'
					and public.qorpera_company_execution_paused(p_work.profile_id) then 'paused' else 'failed' end,
				'problem', left(v_state || ' ' || v_message, 300)
			);
		end;
		perform set_config('lock_timeout', v_timeout, true);
	end if;
	v_result := v_out ->> 'result';
	if v_result = 'done' and jsonb_array_length(coalesce(v_out -> 'changes', '[]'::jsonb)) > 0 then
		v_changes := v_out -> 'changes';
		if not p_defer_journal then
			perform public.qorpera_folder_authority_journal(
				p_work.environment_id,
				'{"kind":"platform"}'::jsonb,
				false,
				v_changes
			);
		end if;
	end if;
	update public.qorpera_folder_follow_ups set
		dirty = v_result <> 'done',
		attempts = case when v_result = 'failed' then attempts + 1 when v_result = 'done' then 0 else attempts end,
		not_before = case v_result
			when 'failed' then clock_timestamp() + make_interval(secs => least(power(2, least(attempts + 1, 10)), 600))
			when 'dirty' then clock_timestamp() + interval '5 seconds'
			when 'paused' then clock_timestamp() + interval '5 seconds'
			else null end,
		last_problem = case when v_result in ('done', 'failed') then v_out ->> 'problem' else last_problem end,
		last_attempt_at = clock_timestamp(),
		converged_at = case when v_result = 'done' then clock_timestamp() else converged_at end,
		first_run_manual = first_run_manual or (v_result = 'done' and coalesce((v_out ->> 'firstRunManual')::boolean, false)),
		failing_since = case when v_result = 'failed' then coalesce(failing_since, clock_timestamp())
			when v_result = 'done' then null else failing_since end,
		updated_at = clock_timestamp()
	where environment_id = p_work.environment_id
		and subject_kind = p_work.subject_kind
		and subject_id = p_work.subject_id;
	return jsonb_build_object(
		'subjectKind', p_work.subject_kind,
		'subjectId', p_work.subject_id,
		'result', v_result,
		'problem', v_out -> 'problem'
	) || case when p_defer_journal then jsonb_build_object('changes', v_changes) else '{}'::jsonb end;
end $$;
revoke all on function public.qorpera_folder_follow_up_converge_inner(public.qorpera_folder_follow_ups, boolean)
	from public, anon, authenticated, service_role;

create or replace function public.qorpera_folder_follow_up_step()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_batch_limit constant integer := 16;
	v_started timestamptz := clock_timestamp();
	v_subject record;
	v_work public.qorpera_folder_follow_ups%rowtype;
	v_swept bigint := 0;
	v_open uuid[];
	v_items jsonb := '[]'::jsonb;
	v_count integer := 0;
	v_batch_kind text;
	v_seen text[] := '{}';
	v_key text;
	v_out jsonb;
	v_journal_changes jsonb := '{}'::jsonb;
	v_env_key text;
begin
	perform set_config('lock_timeout', '2s', true);
	if extract(epoch from clock_timestamp())::bigint % 60 < 10 then
		v_swept := public.qorpera_folder_follow_up_sweep();
	end if;
	select coalesce(array_agg(e.environment_id), '{}') into v_open
	from (select distinct environment_id from public.qorpera_folder_follow_up_marks offset 0) e
	where public.qorpera_folder_follow_up_open(e.environment_id);
	-- WHY: Batch up to 16 agent subjects per tick with deferred authority journaling so team hires converge in one tick without inverting folder clock lock order, while keeping company name copies isolated in their own transaction.
	for v_subject in
		select m.environment_id, m.subject_kind, m.subject_id
		from public.qorpera_folder_follow_up_marks m
		where m.environment_id = any (v_open)
		group by m.environment_id, m.subject_kind, m.subject_id
		order by min(m.id)
		limit 64
	loop
		exit when v_count >= c_batch_limit or clock_timestamp() - v_started > interval '1500 milliseconds';
		if v_batch_kind = 'agent' and v_subject.subject_kind = 'company' then
			continue;
		end if;
		v_key := v_subject.environment_id::text || ':' || v_subject.subject_kind || ':' || v_subject.subject_id::text;
		v_seen := array_append(v_seen, v_key);
		v_work := public.qorpera_folder_follow_up_take(
			v_subject.environment_id,
			v_subject.subject_kind,
			v_subject.subject_id
		);
		continue when v_work.subject_id is null
			or not v_work.dirty
			or (v_work.not_before is not null and v_work.not_before > clock_timestamp());
		v_batch_kind := v_work.subject_kind;
		if v_work.subject_kind = 'company' then
			v_out := public.qorpera_folder_follow_up_converge(v_work);
			v_items := v_items || jsonb_build_array(v_out);
			v_count := v_count + 1;
			exit;
		end if;
		v_out := public.qorpera_folder_follow_up_converge_inner(v_work, true);
		if jsonb_array_length(coalesce(v_out -> 'changes', '[]'::jsonb)) > 0 then
			v_env_key := v_work.environment_id::text;
			v_journal_changes := jsonb_set(
				v_journal_changes,
				array[v_env_key],
				coalesce(v_journal_changes -> v_env_key, '[]'::jsonb) || (v_out -> 'changes'),
				true
			);
		end if;
		v_items := v_items || jsonb_build_array(v_out - 'changes');
		v_count := v_count + 1;
	end loop;
	if v_batch_kind is distinct from 'company'
		and v_count < c_batch_limit
		and clock_timestamp() - v_started <= interval '1500 milliseconds' then
		for v_subject in
			select w.environment_id, w.subject_kind, w.subject_id
			from public.qorpera_folder_follow_ups w
			where w.dirty
				and (w.not_before is null or w.not_before <= clock_timestamp())
				and public.qorpera_folder_follow_up_open(w.environment_id)
				and (v_batch_kind is null or w.subject_kind = v_batch_kind)
				and not ((w.environment_id::text || ':' || w.subject_kind || ':' || w.subject_id::text) = any (v_seen))
			order by w.not_before nulls first, w.updated_at
			limit 64
		loop
			exit when v_count >= c_batch_limit or clock_timestamp() - v_started > interval '1500 milliseconds';
			if v_batch_kind = 'agent' and v_subject.subject_kind = 'company' then
				continue;
			end if;
			v_work := public.qorpera_folder_follow_up_take(
				v_subject.environment_id,
				v_subject.subject_kind,
				v_subject.subject_id
			);
			continue when v_work.subject_id is null
				or not v_work.dirty
				or (v_work.not_before is not null and v_work.not_before > clock_timestamp());
			v_batch_kind := v_work.subject_kind;
			if v_work.subject_kind = 'company' then
				v_out := public.qorpera_folder_follow_up_converge(v_work);
				v_items := v_items || jsonb_build_array(v_out);
				v_count := v_count + 1;
				exit;
			end if;
			v_out := public.qorpera_folder_follow_up_converge_inner(v_work, true);
			if jsonb_array_length(coalesce(v_out -> 'changes', '[]'::jsonb)) > 0 then
				v_env_key := v_work.environment_id::text;
				v_journal_changes := jsonb_set(
					v_journal_changes,
					array[v_env_key],
					coalesce(v_journal_changes -> v_env_key, '[]'::jsonb) || (v_out -> 'changes'),
					true
				);
			end if;
			v_items := v_items || jsonb_build_array(v_out - 'changes');
			v_count := v_count + 1;
		end loop;
	end if;
	for v_env_key in select k from jsonb_object_keys(v_journal_changes) k order by k loop
		perform public.qorpera_folder_authority_journal(
			v_env_key::uuid,
			'{"kind":"platform"}'::jsonb,
			false,
			v_journal_changes -> v_env_key
		);
	end loop;
	return jsonb_build_object(
		'schema', 'qorpera.folder-follow-up-step/v1',
		'swept', v_swept,
		'converged', case when v_count > 0 then v_items -> 0 else null end,
		'convergedItems', v_items,
		'convergedCount', v_count
	);
end $$;

create function public.qorpera_folder_follow_up_run_commit(
	p_environment_id uuid,
	p_actor jsonb,
	p_commit_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_batch_limit constant integer := 16;
	v_started timestamptz := clock_timestamp();
	v_timeout text := current_setting('lock_timeout');
	v_run_id uuid;
	v_subject record;
	v_work public.qorpera_folder_follow_ups%rowtype;
	v_items jsonb := '[]'::jsonb;
	v_count integer := 0;
	v_batch_kind text;
	v_any_busy boolean := false;
	v_out jsonb;
	v_changes jsonb := '[]'::jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_environment_id is null or p_commit_id is null or p_actor is null
		or jsonb_typeof(p_actor) is distinct from 'object'
		or p_actor ->> 'kind' is distinct from 'run'
		or coalesce(p_actor ->> 'runId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Folder follow-up is invalid' using errcode = '22023';
	end if;
	v_run_id := (p_actor ->> 'runId')::uuid;
	if not exists (
		select 1 from public.qorpera_folder_commits c
		where c.id = p_commit_id and c.environment_id = p_environment_id and c.run_id = v_run_id
	) then
		raise exception 'Folder follow-up is unavailable' using errcode = '42501';
	end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder follow-ups run at read committed' using errcode = '25000';
	end if;
	if not public.qorpera_folder_follow_up_open(p_environment_id) then
		return jsonb_build_object(
			'schema', 'qorpera.folder-follow-up/v1',
			'result', 'closed',
			'convergedCount', 0,
			'convergedItems', '[]'::jsonb,
			'more', false
		);
	end if;
	perform set_config('lock_timeout', '2s', true);
	for v_subject in
		select m.subject_kind, m.subject_id
		from public.qorpera_folder_follow_up_marks m
		where m.environment_id = p_environment_id and m.commit_id = p_commit_id
		group by m.subject_kind, m.subject_id
		order by m.subject_kind = 'agent', m.subject_id
		limit c_batch_limit
	loop
		exit when v_count >= c_batch_limit or clock_timestamp() - v_started > interval '1500 milliseconds';
		if v_batch_kind = 'agent' and v_subject.subject_kind = 'company' then
			continue;
		end if;
		begin
			perform set_config('lock_timeout', '200ms', true);
			v_work := public.qorpera_folder_follow_up_take(
				p_environment_id,
				v_subject.subject_kind,
				v_subject.subject_id
			);
		exception when lock_not_available then
			v_work := null;
		end;
		perform set_config('lock_timeout', '2s', true);
		if v_work.subject_id is null then
			v_any_busy := true;
			continue;
		end if;
		continue when not v_work.dirty;
		v_batch_kind := v_work.subject_kind;
		if v_work.subject_kind = 'company' then
			v_out := public.qorpera_folder_follow_up_converge(v_work);
			v_items := v_items || jsonb_build_array(v_out);
			v_count := v_count + 1;
			exit;
		end if;
		v_out := public.qorpera_folder_follow_up_converge_inner(v_work, true);
		if jsonb_array_length(coalesce(v_out -> 'changes', '[]'::jsonb)) > 0 then
			v_changes := v_changes || (v_out -> 'changes');
		end if;
		v_items := v_items || jsonb_build_array(v_out - 'changes');
		v_count := v_count + 1;
	end loop;
	if jsonb_array_length(v_changes) > 0 then
		perform public.qorpera_folder_authority_journal(
			p_environment_id,
			'{"kind":"platform"}'::jsonb,
			false,
			v_changes
		);
	end if;
	perform set_config('lock_timeout', v_timeout, true);
	return jsonb_build_object(
		'schema', 'qorpera.folder-follow-up/v1',
		'result', case when v_count > 0 then 'done' when v_any_busy then 'busy' else 'none' end,
		'convergedCount', v_count,
		'convergedItems', v_items,
		'more', not v_any_busy and exists (
			select 1 from public.qorpera_folder_follow_up_marks m
			where m.environment_id = p_environment_id and m.commit_id = p_commit_id
		)
	);
end $$;
revoke all on function public.qorpera_folder_follow_up_run_commit(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_follow_up_run_commit(uuid, jsonb, uuid) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_follow_up_run_commit', 'folder')
on conflict (name) do nothing;

-- WHY: Add push wake triggers for orchestrators, coding/machine executors, object gateway, and shared vault.

do $$ begin
	if to_regprocedure('public.qorpera_wake_runner_orchestrators_internal()') is not null then
		if to_regclass('public.qorpera_surface_reconciliations') is not null then
			create trigger qorpera_surface_reconciliations_insert_wake_orchestrators
				after insert on public.qorpera_surface_reconciliations
				for each row when (new.status = 'queued')
				execute function public.qorpera_wake_runner_orchestrators_internal();
			create trigger qorpera_surface_reconciliations_status_wake_orchestrators
				after update of status on public.qorpera_surface_reconciliations
				for each row when (new.status = 'queued' and old.status is distinct from 'queued')
				execute function public.qorpera_wake_runner_orchestrators_internal();
		end if;
		if to_regclass('public.qorpera_surface_automations') is not null then
			create trigger qorpera_surface_automations_insert_wake_orchestrators
				after insert on public.qorpera_surface_automations
				for each row when (new.enabled and new.status = 'idle' and new.next_run_at is not null)
				execute function public.qorpera_wake_runner_orchestrators_internal();
			create trigger qorpera_surface_automations_update_wake_orchestrators
				after update of enabled, status, next_run_at on public.qorpera_surface_automations
				for each row when (
					new.enabled and new.status = 'idle' and new.next_run_at is not null
					and (old.enabled is distinct from new.enabled
						or old.status is distinct from new.status
						or old.next_run_at is distinct from new.next_run_at)
				)
				execute function public.qorpera_wake_runner_orchestrators_internal();
		end if;
		if to_regclass('public.qorpera_folder_journal') is not null then
			create trigger qorpera_folder_journal_insert_wake_orchestrators
				after insert on public.qorpera_folder_journal
				for each row execute function public.qorpera_wake_runner_orchestrators_internal();
		end if;
		if to_regclass('public.qorpera_runtime_workers') is not null then
			create trigger qorpera_runtime_workers_insert_wake_orchestrators
				after insert on public.qorpera_runtime_workers
				for each row when (new.state = 'active' or new.completion_state = 'waiting')
				execute function public.qorpera_wake_runner_orchestrators_internal();
			create trigger qorpera_runtime_workers_update_wake_orchestrators
				after update of state, completion_state on public.qorpera_runtime_workers
				for each row when (
					(new.state = 'active' and old.state is distinct from 'active')
					or (new.completion_state = 'waiting' and old.completion_state is distinct from 'waiting')
				)
				execute function public.qorpera_wake_runner_orchestrators_internal();
		end if;
		if to_regclass('public.qorpera_coding_sessions') is not null then
			create trigger qorpera_coding_sessions_insert_wake_orchestrators
				after insert on public.qorpera_coding_sessions
				for each row when (new.phase in ('queued', 'input_ready'))
				execute function public.qorpera_wake_runner_orchestrators_internal();
			create trigger qorpera_coding_sessions_phase_wake_orchestrators
				after update of phase on public.qorpera_coding_sessions
				for each row when (
					new.phase in ('queued', 'input_ready', 'completed', 'failed', 'cancelled', 'awaiting_input')
					and new.phase is distinct from old.phase
				)
				execute function public.qorpera_wake_runner_orchestrators_internal();
		end if;
	end if;
end $$;

-- WHY: Broadcast once per transaction to all enabled coding and machine executor nodes so coding claims, turn completion, surface code jobs, and member machine starts wake immediately without poll dead air.
create function public.qorpera_wake_coding_executors_internal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_started timestamptz;
	v_left integer;
	v_topic text;
begin
	if current_setting('qorpera.coding_executors_woken', true) = 'yes' then
		return null;
	end if;
	perform set_config('qorpera.coding_executors_woken', 'yes', true);
	v_started := clock_timestamp();
	begin
		perform set_config('lock_timeout', '200ms', true);
		for v_topic in
			select distinct public.qorpera_code_request_wake_topic(executor.owner, executor.machine_id_sha256)
			from (
				select owner, nas_machine_id_sha256 as machine_id_sha256
				from public.qorpera_coding_executors
				where enabled and nas_machine_id_sha256 is not null
				union
				select owner, machine_id_sha256
				from public.qorpera_machine_executors
				where enabled and machine_id_sha256 is not null
			) as executor
		loop
			v_left := 200 - floor(extract(epoch from clock_timestamp() - v_started) * 1000)::integer;
			exit when v_left < 1;
			perform set_config('lock_timeout', v_left || 'ms', true);
			perform realtime.send(jsonb_build_object('schema', 'qorpera.code-request-wake/v1'), 'wake', v_topic, true);
		end loop;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
	return null;
end $$;
revoke all on function public.qorpera_wake_coding_executors_internal() from public, anon, authenticated, service_role;

do $$ begin
	if to_regclass('public.qorpera_coding_sessions') is not null then
		create trigger qorpera_coding_sessions_insert_wake_executors
			after insert on public.qorpera_coding_sessions
			for each row when (new.phase in ('queued', 'input_ready'))
			execute function public.qorpera_wake_coding_executors_internal();
		create trigger qorpera_coding_sessions_phase_wake_executors
			after update of phase on public.qorpera_coding_sessions
			for each row when (new.phase in ('queued', 'input_ready') and new.phase is distinct from old.phase)
			execute function public.qorpera_wake_coding_executors_internal();
	end if;
	if to_regclass('public.qorpera_runner_jobs') is not null then
		create trigger qorpera_runner_jobs_terminal_wake_executors
			after update of status on public.qorpera_runner_jobs
			for each row when (
				new.status in ('completed', 'failed', 'cancelled')
				and old.status is distinct from new.status
			)
			execute function public.qorpera_wake_coding_executors_internal();
	end if;
	if to_regclass('public.qorpera_surface_previews') is not null then
		create trigger qorpera_surface_previews_insert_wake_executors
			after insert on public.qorpera_surface_previews
			for each row when (new.status = 'composing')
			execute function public.qorpera_wake_coding_executors_internal();
		create trigger qorpera_surface_previews_status_wake_executors
			after update of status on public.qorpera_surface_previews
			for each row when (new.status = 'composing' and old.status is distinct from 'composing')
			execute function public.qorpera_wake_coding_executors_internal();
	end if;
	if to_regclass('public.qorpera_surface_jobs') is not null then
		create trigger qorpera_surface_jobs_insert_wake_executors
			after insert on public.qorpera_surface_jobs
			for each row when (new.status = 'queued')
			execute function public.qorpera_wake_coding_executors_internal();
		create trigger qorpera_surface_jobs_status_wake_executors
			after update of status on public.qorpera_surface_jobs
			for each row when (new.status = 'queued' and old.status is distinct from 'queued')
			execute function public.qorpera_wake_coding_executors_internal();
	end if;
	if to_regclass('public.qorpera_surface_reconciliations') is not null then
		create trigger qorpera_surface_reconciliations_insert_wake_executors
			after insert on public.qorpera_surface_reconciliations
			for each row when (new.status = 'queued')
			execute function public.qorpera_wake_coding_executors_internal();
		create trigger qorpera_surface_reconciliations_status_wake_executors
			after update of status on public.qorpera_surface_reconciliations
			for each row when (new.status = 'queued' and old.status is distinct from 'queued')
			execute function public.qorpera_wake_coding_executors_internal();
	end if;
	if to_regclass('public.qorpera_company_machines') is not null then
		create trigger qorpera_company_machines_insert_wake_executors
			after insert on public.qorpera_company_machines
			for each row when (new.desired_state = 'running' and new.removed_at is null)
			execute function public.qorpera_wake_coding_executors_internal();
		create trigger qorpera_company_machines_wake_executors
			after update of desired_state, wanted_at on public.qorpera_company_machines
			for each row when (
				new.desired_state = 'running'
				and new.removed_at is null
				and (old.desired_state is distinct from 'running' or old.wanted_at is distinct from new.wanted_at)
			)
			execute function public.qorpera_wake_coding_executors_internal();
	end if;
	if to_regclass('public.qorpera_company_machine_placements') is not null then
		create trigger qorpera_company_machine_placements_insert_wake_executors
			after insert on public.qorpera_company_machine_placements
			for each row execute function public.qorpera_wake_coding_executors_internal();
	end if;
end $$;

-- WHY: Broadcast service-role-only private Realtime wakes to object-gateway so company creations, coding results, connection files, and folder surfaces drain immediately instead of waiting on 5s-15s polls.
create function public.qorpera_wake_object_gateway_internal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_kind text := coalesce(tg_argv[0], 'all');
	v_setting text := 'qorpera.object_gateway_woken_' || v_kind;
	v_lock_timeout text := current_setting('lock_timeout');
begin
	if current_setting(v_setting, true) = 'yes' then
		return null;
	end if;
	perform set_config(v_setting, 'yes', true);
	begin
		perform set_config('lock_timeout', '50ms', true);
		perform realtime.send(
			jsonb_build_object('schema', 'qorpera.object-gateway-wake/v1', 'kind', v_kind),
			'wake',
			'qorpera-object-gateway-wake',
			true
		);
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
	return null;
end $$;
revoke all on function public.qorpera_wake_object_gateway_internal() from public, anon, authenticated, service_role;

do $$ begin
	if to_regclass('public.qorpera_folder_company_creations') is not null then
		create trigger qorpera_folder_company_creations_insert_wake_gateway
			after insert on public.qorpera_folder_company_creations
			for each row when (new.state = 'queued')
			execute function public.qorpera_wake_object_gateway_internal('company_creation');
		create trigger qorpera_folder_company_creations_state_wake_gateway
			after update of state on public.qorpera_folder_company_creations
			for each row when (new.state = 'queued' and old.state is distinct from 'queued')
			execute function public.qorpera_wake_object_gateway_internal('company_creation');
	end if;
	if to_regclass('public.qorpera_coding_results_files') is not null then
		create trigger qorpera_coding_results_files_insert_wake_gateway
			after insert on public.qorpera_coding_results_files
			for each row execute function public.qorpera_wake_object_gateway_internal('coding_results');
		create trigger qorpera_coding_results_files_update_wake_gateway
			after update of sequence on public.qorpera_coding_results_files
			for each row when (new.sequence is distinct from old.sequence)
			execute function public.qorpera_wake_object_gateway_internal('coding_results');
	end if;
	if to_regclass('public.qorpera_folder_connection_file_marks') is not null then
		create trigger qorpera_folder_connection_file_marks_insert_wake_gateway
			after insert on public.qorpera_folder_connection_file_marks
			for each row execute function public.qorpera_wake_object_gateway_internal('connection_files');
	end if;
	if to_regclass('public.qorpera_surface_jobs') is not null then
		create trigger qorpera_surface_jobs_insert_wake_gateway
			after insert on public.qorpera_surface_jobs
			for each row when (new.status = 'queued')
			execute function public.qorpera_wake_object_gateway_internal('surface_folder');
		create trigger qorpera_surface_jobs_status_wake_gateway
			after update of status on public.qorpera_surface_jobs
			for each row when (new.status = 'queued' and old.status is distinct from 'queued')
			execute function public.qorpera_wake_object_gateway_internal('surface_folder');
	end if;
	if to_regclass('public.qorpera_surface_previews') is not null then
		create trigger qorpera_surface_previews_insert_wake_gateway
			after insert on public.qorpera_surface_previews
			for each row when (new.status = 'composing')
			execute function public.qorpera_wake_object_gateway_internal('surface_folder');
		create trigger qorpera_surface_previews_status_wake_gateway
			after update of status on public.qorpera_surface_previews
			for each row when (new.status = 'composing' and old.status is distinct from 'composing')
			execute function public.qorpera_wake_object_gateway_internal('surface_folder');
	end if;
end $$;

-- WHY: Notify the shared vault over Postgres LISTEN/NOTIFY when a new company row commits so vault registration and account-login linking complete before the founding page's grace timer expires.
create function public.qorpera_notify_shared_vault_internal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if current_setting('qorpera.shared_vault_notified', true) = 'yes' then
		return null;
	end if;
	begin
		if exists (
			select 1 from public.qorpera_cloud_secret_broker_principals p
			where p.status = 'active' and new.created_at > p.registers_companies_created_after
		) then
			perform set_config('qorpera.shared_vault_notified', 'yes', true);
			perform pg_catalog.pg_notify('qorpera_shared_vault_companies', new.id::text);
		end if;
	exception when others then
		null;
	end;
	return null;
end $$;
revoke all on function public.qorpera_notify_shared_vault_internal()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create trigger qorpera_profiles_notify_shared_vault
	after insert on public.qorpera_profiles
	for each row execute function public.qorpera_notify_shared_vault_internal();

-- WHY: Accept optional initial vision in qorpera_open_company_founding to eliminate a serial pre-start RPC.

drop function public.qorpera_open_company_founding(uuid, text);
create function public.qorpera_open_company_founding(
	p_client_creation_id uuid,
	p_company_name text,
	p_vision text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid();
	v_created jsonb;
	v_profile uuid;
	v_vision text := coalesce(btrim(p_vision), '');
begin
	if v_user is null or not public.qorpera_current_email_verified() then
		raise exception 'A verified account is required' using errcode = '42501';
	end if;
	if not public.qorpera_company_founding_available() then
		raise exception 'New companies do not start at a founding table yet' using errcode = '0A000';
	end if;
	if p_client_creation_id is null or char_length(btrim(p_company_name)) > 120 or octet_length(v_vision) > 16384 then
		raise exception 'Company details are invalid' using errcode = '22023';
	end if;
	v_created := public.qorpera_folder_company_open(v_user, p_client_creation_id, btrim(p_company_name));
	v_profile := (v_created ->> 'profile_id')::uuid;
	if public.qorpera_company_is_folder_v2(v_profile) then
		perform 1 from public.qorpera_folder_fences where profile_id = v_profile for no key update;
		if not found then
			raise exception 'Company folder is unavailable' using errcode = '42501';
		end if;
		perform 1 from public.qorpera_profiles where id = v_profile for no key update;
	else
		perform 1 from public.qorpera_profiles where id = v_profile for update;
	end if;
	if not exists(select 1 from public.qorpera_company_foundings where profile_id = v_profile) then
		if exists(select 1 from public.qorpera_profile_members where profile_id = v_profile
				and (user_id <> v_user or role <> 'owner'))
			or not exists(select 1 from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user) then
			raise exception 'This company already exists' using errcode = '23505';
		end if;
		insert into public.qorpera_company_foundings(profile_id, created_by_user_id, vision_draft)
		values (v_profile, v_user, v_vision);
	elsif not exists(select 1 from public.qorpera_company_foundings
		where profile_id = v_profile and created_by_user_id = v_user) then
		raise exception 'This company is not a founding table' using errcode = '23505';
	end if;
	insert into public.qorpera_company_founder_seats(profile_id, user_id, invited_by_user_id, state, joined_at)
	values (v_profile, v_user, v_user, 'joined', clock_timestamp()) on conflict do nothing;
	return public.qorpera_company_founding_json(v_profile);
end $$;
revoke all on function public.qorpera_open_company_founding(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_open_company_founding(uuid, text, text) to authenticated;

-- WHY: Add fail-open async pg_net kicks for outbound mail and profile invitation emails while keeping pg_cron as durable fallback.

create function public.qorpera_mail_outbox_kick()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_url text;
	v_key text;
begin
	if current_setting('qorpera.mail_outbox_kicked', true) = 'yes' then
		return null;
	end if;
	if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
		or to_regclass('vault.decrypted_secrets') is null then
		return null;
	end if;
	perform set_config('qorpera.mail_outbox_kicked', 'yes', true);
	begin
		perform set_config('lock_timeout', '50ms', true);
		execute 'select (select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_project_url'' limit 1),
			(select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_mail_outbox_key'' limit 1)'
		into v_url, v_key;
		if v_url is not null and v_key is not null and v_url like 'https://%' then
			execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 120000)'
			using rtrim(v_url, '/') || '/functions/v1/mail-outbox',
				jsonb_build_object('content-type', 'application/json', 'apikey', v_key);
		end if;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
	return null;
end $$;
revoke all on function public.qorpera_mail_outbox_kick() from public, anon, authenticated, service_role;

create trigger qorpera_company_mail_outbox_kick
	after insert on public.qorpera_company_mail_outbox
	for each row when (new.status = 'pending')
	execute function public.qorpera_mail_outbox_kick();

create function public.qorpera_profile_invitation_email_kick()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_url text;
	v_key text;
begin
	if current_setting('qorpera.invitation_email_kicked', true) = 'yes' then
		return null;
	end if;
	if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
		or to_regclass('vault.decrypted_secrets') is null then
		return null;
	end if;
	perform set_config('qorpera.invitation_email_kicked', 'yes', true);
	begin
		perform set_config('lock_timeout', '50ms', true);
		execute 'select (select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_project_url'' limit 1),
			(select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_invitation_worker_key'' limit 1)'
		into v_url, v_key;
		if v_url is not null and v_key is not null and v_url like 'https://%' then
			execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 30000)'
			using rtrim(v_url, '/') || '/functions/v1/profile-invitation-email',
				jsonb_build_object('content-type', 'application/json', 'apikey', v_key);
		end if;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
	return null;
end $$;
revoke all on function public.qorpera_profile_invitation_email_kick() from public, anon, authenticated, service_role;

create trigger qorpera_profile_invitation_deliveries_insert_kick
	after insert on public.qorpera_profile_invitation_deliveries
	for each row when (new.status = 'pending')
	execute function public.qorpera_profile_invitation_email_kick();

create trigger qorpera_profile_invitation_deliveries_status_kick
	after update of status on public.qorpera_profile_invitation_deliveries
	for each row when (new.status = 'pending' and old.status is distinct from 'pending')
	execute function public.qorpera_profile_invitation_email_kick();
