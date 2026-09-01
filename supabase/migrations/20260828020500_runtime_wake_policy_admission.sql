-- Runtime Step 3 forward correction to 20260828020000_runtime_wake_bus.sql.
-- Missing immutable reporting policy retains required final delivery. Only
-- explicit optional/silent policy can grant silence. No queue, principal,
-- public audience, or native/security enforcement interface is introduced.
-- Apply together with the component during initial integration. Existing
-- deployments require the usual reviewed migration and runtime rollout;
-- this task performs neither and does not rewrite admitted wake identities.

create or replace function public.qorpera_wake_policy_value(p_kind text,p_reporting text default 'required')
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_initial text := 'required'; v_final text := 'required'; v_kind text; v_max integer := 64;
begin
	if p_kind in ('human','first-run','routine','agent','room')
		and p_reporting in ('optional','required','silent') then
		v_kind := p_kind;
		if p_kind = 'routine' then
			v_initial := case when p_reporting = 'silent' then 'forbidden' else 'optional' end;
			v_final := case p_reporting when 'required' then 'required' when 'silent' then 'forbidden' else 'optional' end;
			if p_reporting = 'silent' then v_max := 0; end if;
		elsif p_kind = 'agent' then
			v_initial := 'forbidden'; v_final := 'forbidden'; v_max := 0;
		elsif p_kind = 'room' then
			v_initial := 'optional'; v_final := 'optional'; v_max := 3;
		end if;
	end if;
	return jsonb_build_object('schema','qorpera.wake-policy/v1','kind',v_kind,
		'initial',v_initial,'final',v_final,'silenceAllowed',v_final <> 'required','maxPublicSends',v_max);
end
$$;

create or replace function public.qorpera_runtime_wake_policy(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_trigger jsonb; v_reporting text := 'optional'; v_count integer; v_human integer; v_kickoff integer; v_kind text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Wake policy authority is required' using errcode = '42501'; end if;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run_id;
	if v_run.id is null or v_wake.id is null or v_wake.wake_schema <> 'qorpera.wake-envelope/v1'
		or v_wake.source_id is null or v_wake.causal_root_id is null
		or cardinality(v_wake.causal_agent_ids) not between 1 and 16
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_wake.staff_agent_id
		or v_wake.staff_agent_id is distinct from v_run.staff_agent_id
		or v_wake.staff_version is distinct from v_run.staff_version
		or v_wake.requested_by_user_id is distinct from v_run.requested_by_user_id
		or v_wake.profile_id is distinct from v_run.profile_id
		or v_wake.environment_id is distinct from v_run.environment_id
		or v_wake.sponsor_binding_id is distinct from v_run.sponsor_binding_id
		or v_wake.sponsor_version is distinct from v_run.sponsor_version
		or v_wake.logical_computer_id is distinct from v_run.logical_computer_id
		or v_wake.session_id is distinct from v_run.session_id
		or (v_run.source_kind = 'wake' and (v_run.source_id is distinct from v_wake.id
			or cardinality(v_run.input_ids) <> 0
			or (v_wake.source_kind = 'schedule' and v_wake.source_id is distinct from v_wake.routine_id)
			or (v_wake.source_kind = 'company-file' and v_wake.source_id is distinct from v_wake.file_event_id)
			or (v_wake.source_kind = 'coworker' and v_wake.source_id is distinct from v_wake.id)
			or not ((v_wake.wake_kind = 'routine' and v_wake.source_kind in ('schedule','company-file'))
				or (v_wake.wake_kind = 'agent' and v_wake.source_kind = 'coworker'))))
		or (v_run.source_kind = 'session_turn' and (v_wake.source_kind <> 'input'
			or v_run.job_type <> 'agent_turn'
			or v_wake.wake_kind not in ('human','first-run') or not coalesce(v_wake.source_id = any(v_run.input_ids),false)
			or v_wake.payload -> 'inputIds' is distinct from to_jsonb(v_run.input_ids)))
		or v_run.source_kind not in ('session_turn','wake') then
		return public.qorpera_wake_policy_value(null); end if;
	if v_run.source_kind = 'session_turn' then
		select count(*),count(*) filter(where kind = 'user_message'),count(*) filter(where kind = 'kickoff')
		into v_count,v_human,v_kickoff from public.qorpera_session_inputs
		where id = any(v_run.input_ids) and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
			and execution_run_id = v_run.id;
		v_kind := case when v_count = cardinality(v_run.input_ids) and v_count = v_human + v_kickoff
			then case when v_human > 0 then 'human' when v_kickoff = 1 then 'first-run' end end;
		if v_kind is null or v_kind <> v_wake.wake_kind
			or not public.qorpera_uuid_array_is_unique(v_run.input_ids) then return public.qorpera_wake_policy_value(null); end if;
	end if;
	if v_wake.wake_kind = 'routine' then
		select t.value into v_trigger from public.qorpera_cloud_routine_versions v,
			lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = v_wake.routine_id and v.version = v_wake.routine_version
			and v.profile_id = v_run.profile_id and v.environment_id = v_run.environment_id
			and v.created_by_user_id = v_run.requested_by_user_id and v.staff_agent_id = v_run.staff_agent_id
			and v.sponsor_binding_id = v_run.sponsor_binding_id and v.sponsor_version = v_run.sponsor_version
			and v.required_capability = v_run.required_capability and v.job_type = v_run.job_type
			and t.value ->> 'id' = v_wake.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger) then
			return public.qorpera_wake_policy_value(null); end if;
		if (v_wake.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (v_wake.source_kind = 'company-file' and v_trigger ->> 'kind' <> 'listener') then
			return public.qorpera_wake_policy_value(null); end if;
		v_reporting := coalesce(v_trigger ->> 'replyPolicy','required');
	end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);
end
$$;

create function public.qorpera_wake_public_session(p_profile uuid,p_environment uuid,p_staff uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_session uuid;
begin
	-- Reuse the existing company conversation. The row lock prevents archive
	-- or scope changes between eligibility and occurrence pinning. Never wait
	-- here: a canonical sender may hold the session while waiting on the File
	-- already locked by a drain. Contention raises 55P03 and rolls admission
	-- back without advancing its stored cursor. Schedule catch-up remains
	-- caller-owned; a lock conflict must not become an audience denial.
	select s.id into v_session from public.qorpera_shared_sessions s
	join public.qorpera_profile_staff a on a.profile_id = s.profile_id
		and a.staff_agent_id = p_staff and a.version = s.staff_version and a.employment_status = 'active'
	where s.profile_id = p_profile and s.environment_id = p_environment
		and s.staff_agent_id = p_staff::text and s.status = 'open'
		and not (s.execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	for share of s,a nowait;
	return v_session;
end
$$;
revoke all on function public.qorpera_wake_public_session(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.qorpera_pin_wake_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_version public.qorpera_cloud_routine_versions%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_trigger jsonb; v_ancestry jsonb; v_actor uuid;
begin
	if new.wake_schema <> 'qorpera.wake-envelope/v1' or new.wake_kind = 'room' then
		raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
	if new.wake_kind = 'routine' then
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = new.routine_id and version = new.routine_version
			and profile_id = new.profile_id and environment_id = new.environment_id;
		select value into v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = new.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or (new.source_kind = 'schedule' and v_trigger ->> 'kind' <> 'schedule')
			or (new.source_kind = 'company-file' and (v_trigger ->> 'kind' <> 'listener' or new.file_event_id is null))
			or new.source_kind not in ('schedule','company-file') then
			raise exception 'Wake source does not match its routine' using errcode = '22023'; end if;
		new.staff_agent_id := v_version.staff_agent_id; new.requested_by_user_id := v_version.created_by_user_id;
		new.sponsor_binding_id := v_version.sponsor_binding_id; new.sponsor_version := v_version.sponsor_version;
		new.logical_computer_id := v_version.logical_computer_id;
		new.time_zone := coalesce(v_trigger ->> 'timeZone','UTC');
		new.source_id := coalesce(new.file_event_id,new.routine_id);
		if new.source_kind = 'company-file' then
			select run_id,actor_staff_id into new.parent_run_id,v_actor from public.qorpera_company_path_revisions
			where snapshot_id = new.file_event_id and environment_id = new.environment_id;
			if not found then raise exception 'Wake event is unavailable' using errcode = '42501'; end if;
		else
			if new.parent_run_id is not null or new.file_event_id is not null then
				raise exception 'Scheduled wake cannot replace causal identity' using errcode = '42501'; end if;
		end if;
	elsif new.wake_kind in ('human','first-run') then
		select * into strict v_run from public.qorpera_execution_runs where id = new.run_id and source_kind = 'session_turn';
		if new.source_kind <> 'input' or new.profile_id <> v_run.profile_id or new.environment_id <> v_run.environment_id
			or not exists(select 1 from public.qorpera_session_inputs where id = new.source_id and id = any(v_run.input_ids)
				and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id
				and kind = case when new.wake_kind = 'first-run' then 'kickoff' else 'user_message' end) then
			raise exception 'Wake input identity is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := v_run.staff_agent_id; new.requested_by_user_id := v_run.requested_by_user_id;
		new.sponsor_binding_id := v_run.sponsor_binding_id; new.sponsor_version := v_run.sponsor_version;
		new.logical_computer_id := v_run.logical_computer_id;
		new.session_id := v_run.session_id;
		if new.parent_run_id is not null or new.file_event_id is not null then
			raise exception 'Input wake cannot replace causal identity' using errcode = '42501'; end if;
	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id
			and profile_id = new.profile_id and environment_id = new.environment_id;
		if new.source_kind <> 'coworker' then raise exception 'Coworker source is invalid' using errcode = '22023'; end if;
		v_actor := v_run.staff_agent_id; new.source_id := new.id; new.requested_by_user_id := v_run.requested_by_user_id;
		select * into strict v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id for share;
		new.sponsor_binding_id := v_authority.sponsor_binding_id; new.sponsor_version := v_authority.sponsor_version;
		new.logical_computer_id := v_authority.logical_computer_id; new.session_id := null;
		if new.file_event_id is not null then raise exception 'Coworker event identity is invalid' using errcode = '42501'; end if;
	else raise exception 'Wake admission is unsupported' using errcode = '42501';
	end if;
	if new.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
		where id = new.parent_run_id and profile_id = new.profile_id and environment_id = new.environment_id) then
		raise exception 'Wake parent belongs to another company' using errcode = '42501'; end if;
	select * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id
		and staff_agent_id = new.staff_agent_id and employment_status = 'active' for share;
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = new.profile_id and user_id = new.requested_by_user_id) then
		raise exception 'Wake recipient authority is unavailable' using errcode = '42501'; end if;
	new.staff_version := coalesce(v_run.staff_version,v_staff.version);
	if new.wake_kind = 'agent' then new.staff_version := v_staff.version; end if;
	if new.wake_kind = 'routine' then
		new.session_id := public.qorpera_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id);
		if coalesce(v_trigger ->> 'replyPolicy','required') = 'required' and new.session_id is null then
			raise exception 'Wake public audience is unavailable' using errcode = '42501';
		end if;
	end if;
	v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id));
	if v_ancestry is null then raise exception 'Wake causal ancestry is fenced' using errcode = '55000'; end if;
	new.causal_root_id := (v_ancestry ->> 'rootId')::uuid;
	new.causal_agent_ids := array(select jsonb_array_elements_text(v_ancestry -> 'agentIds')::uuid);
	return new;
end
$$;

create or replace function public.qorpera_wake_authorized(p_wake public.qorpera_wake_occurrences)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ancestry jsonb; v_actor uuid; v_revision public.qorpera_company_path_revisions%rowtype; v_path text;
begin
	if p_wake.wake_schema <> 'qorpera.wake-envelope/v1' or p_wake.wake_kind = 'room'
		or (p_wake.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
			where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id))
		or not exists(select 1 from public.qorpera_profile_members where profile_id = p_wake.profile_id
			and user_id = p_wake.requested_by_user_id)
		or not exists(select 1 from public.qorpera_profile_staff where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and version = p_wake.staff_version and employment_status = 'active')
		or (p_wake.session_id is not null and not exists(select 1 from public.qorpera_shared_sessions
			where id = p_wake.session_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id
				and staff_agent_id = p_wake.staff_agent_id::text and status = 'open'
				and (p_wake.wake_kind <> 'routine' or (staff_version = p_wake.staff_version and not
					(execution_scope ?| array['autonomousLabel','roomId','group','parentSession']))))) then return false; end if;
	-- An older occurrence may have been pinned without a public audience.
	-- Do not attach a later session or reserve compute for an unsatisfiable
	-- final obligation. Only explicit optional/silent reporting allows none.
	if p_wake.wake_kind = 'routine' and p_wake.session_id is null and not exists(
		select 1 from public.qorpera_cloud_routine_versions v,
			lateral jsonb_array_elements(v.triggers) t(value)
		where v.routine_id = p_wake.routine_id and v.version = p_wake.routine_version
			and t.value ->> 'id' = p_wake.trigger_id
			and public.qorpera_cloud_routine_trigger_valid(t.value)
			and t.value ->> 'replyPolicy' in ('optional','silent')
	) then return false; end if;
	if p_wake.wake_kind = 'routine' and not exists(
		select 1 from public.qorpera_cloud_routines r join public.qorpera_cloud_routine_versions v
			on v.routine_id = r.id and v.version = r.current_version
		where r.id = p_wake.routine_id and r.status = 'active' and v.version = p_wake.routine_version
			and v.created_by_user_id = p_wake.requested_by_user_id and v.staff_agent_id = p_wake.staff_agent_id
			and v.sponsor_binding_id = p_wake.sponsor_binding_id and v.sponsor_version = p_wake.sponsor_version
	) then return false; end if;
	if p_wake.source_kind = 'company-file' then
		select * into v_revision from public.qorpera_company_path_revisions
		where snapshot_id = p_wake.file_event_id and environment_id = p_wake.environment_id;
		if not found or v_revision.run_id is distinct from p_wake.parent_run_id
			or not coalesce(public.qorpera_wake_path_authorized(p_wake.environment_id,p_wake.requested_by_user_id,
				p_wake.staff_agent_id,v_revision.change #>> '{plan,path}'),false) then return false; end if;
		v_actor := v_revision.actor_staff_id;
	elsif p_wake.wake_kind = 'agent' then
		if not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and sponsor_binding_id = p_wake.sponsor_binding_id
			and sponsor_version = p_wake.sponsor_version
			and logical_computer_id is not distinct from p_wake.logical_computer_id) then return false; end if;
		select staff_agent_id into v_actor from public.qorpera_execution_runs
		where id = p_wake.parent_run_id and profile_id = p_wake.profile_id and environment_id = p_wake.environment_id;
		if not found then return false; end if;
		-- Coworker content cannot wash an already-read path's authority away.
		-- Use the existing durable read set, not another taint or memory store.
		for v_path in select path from public.qorpera_company_run_read_paths where run_id = p_wake.parent_run_id loop
			if not coalesce(public.qorpera_wake_path_authorized(p_wake.environment_id,p_wake.requested_by_user_id,
				p_wake.staff_agent_id,v_path),false) then return false; end if;
		end loop;
	end if;
	v_ancestry := public.qorpera_wake_ancestry(p_wake.parent_run_id,v_actor,p_wake.staff_agent_id,
		coalesce(p_wake.file_event_id,p_wake.id));
	return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
		and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids),false);
end
$$;

create or replace function public.qorpera_drain_company_file_wakes(p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_cursor public.qorpera_company_file_wake_cursors%rowtype; v_revision public.qorpera_company_path_revisions%rowtype;
	v_version public.qorpera_cloud_routine_versions%rowtype; v_file public.qorpera_company_files%rowtype;
	v_trigger jsonb; v_path text; v_key text; v_selector text; v_ancestry jsonb; v_occurrence uuid; v_outcome text;
	v_scanned integer := 0; v_examined integer := 0; v_admitted integer := 0;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'File wake drain authority or bound is invalid' using errcode = '42501'; end if;
	-- LIMIT is on cursor selection BEFORE any revision lookup. Each selected
	-- cursor examines at most one indexed successor, including denied and
	-- unmatched candidates. There is no revision x subscription history scan.
	for v_cursor in
		select c.* from public.qorpera_company_file_wake_cursors c where c.active
		order by c.last_scanned_at,c.routine_id,c.routine_version,c.trigger_id
		for update of c skip locked limit p_limit
	loop
		v_scanned := v_scanned + 1;
		update public.qorpera_company_file_wake_cursors set last_scanned_at = clock_timestamp()
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
		if not exists(select 1 from public.qorpera_cloud_routines where id = v_cursor.routine_id
			and current_version = v_cursor.routine_version and status = 'active') then continue; end if;
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = v_cursor.routine_id and version = v_cursor.routine_version;
		select value into strict v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = v_cursor.trigger_id;
		select * into strict v_file from public.qorpera_company_files where environment_id = v_cursor.environment_id;
		perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
		select * into strict v_file from public.qorpera_company_files where environment_id = v_cursor.environment_id for update;
		select * into v_revision from public.qorpera_company_path_revisions
		where environment_id = v_cursor.environment_id and parent_snapshot_id = v_cursor.processed_head;
		if not found then
			if v_file.head_snapshot_id is distinct from v_cursor.processed_head then
				raise exception 'Company File listener history is unavailable' using errcode = '55000'; end if;
			continue;
		end if;
		v_examined := v_examined + 1; v_occurrence := null;
		v_path := v_revision.change #>> '{plan,path}';
		if v_revision.change #>> '{plan,schema}' is distinct from 'qorpera.company-path-mutation/v1'
			or not coalesce(public.qorpera_company_path_valid(v_path),false) then
			raise exception 'Company File listener event is invalid' using errcode = '55000'; end if;
		v_key := public.qorpera_company_path_key(v_path); v_selector := public.qorpera_company_path_key(v_trigger ->> 'path');
		if (v_key = v_selector or (v_trigger ->> 'match' = 'subtree'
			and (v_selector = '' or left(v_key,length(v_selector) + 1) = v_selector || '/')))
			and not exists(select 1 from public.qorpera_company_file_wake_claims
				where event_id = v_revision.snapshot_id and routine_id = v_cursor.routine_id
					and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id) then
			v_outcome := 'denied';
			if coalesce(public.qorpera_wake_path_authorized(v_cursor.environment_id,v_version.created_by_user_id,
				v_version.staff_agent_id,v_path),false)
				and (coalesce(v_trigger ->> 'replyPolicy','required') in ('optional','silent')
					or public.qorpera_wake_public_session(v_version.profile_id,v_cursor.environment_id,
						v_version.staff_agent_id) is not null) then
				v_ancestry := public.qorpera_wake_ancestry(v_revision.run_id,v_revision.actor_staff_id,
					v_version.staff_agent_id,v_revision.snapshot_id);
				v_outcome := 'causal-fence';
				if v_ancestry is not null then
					v_occurrence := extensions.gen_random_uuid(); v_outcome := 'admitted';
					insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,routine_id,routine_version,
						wake_kind,source_kind,file_event_id,trigger_id,occurrence_key,scheduled_for,not_before,payload)
					values(v_occurrence,v_version.profile_id,v_cursor.environment_id,v_cursor.routine_id,v_cursor.routine_version,
						'routine','company-file',v_revision.snapshot_id,v_cursor.trigger_id,
						'file:' || v_cursor.routine_version::text || ':' || v_cursor.trigger_id || ':' || v_revision.snapshot_id::text,
						v_revision.created_at,clock_timestamp(),jsonb_build_object(
							'eventId',v_revision.snapshot_id,'path',v_path,
							'previousVersion',v_revision.change #> '{plan,expectedVersion}',
							'version',v_revision.change -> 'version',
							'operation',case when v_revision.change #> '{plan,entry}' = 'null'::jsonb then 'delete' else 'upsert' end,
							'receiptId',v_revision.receipt_id,'proposalId',v_revision.proposal_id));
					v_admitted := v_admitted + 1;
				end if;
			end if;
			insert into public.qorpera_company_file_wake_claims(event_id,routine_id,routine_version,trigger_id,outcome,occurrence_id)
			values(v_revision.snapshot_id,v_cursor.routine_id,v_cursor.routine_version,v_cursor.trigger_id,v_outcome,v_occurrence);
		end if;
		-- Terminal denied/cycle claims stay private. An unmatched revision also
		-- advances the cursor in this transaction; a crash loses none of these
		-- decisions and cannot leave an orphan occurrence.
		update public.qorpera_company_file_wake_cursors set processed_head = v_revision.snapshot_id
		where routine_id = v_cursor.routine_id and routine_version = v_cursor.routine_version and trigger_id = v_cursor.trigger_id;
	end loop;
	return jsonb_build_object('schema','qorpera.file-wake-drain/v1','scanned',v_scanned,'examined',v_examined,'admitted',v_admitted);
end
$$;
