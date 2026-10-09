-- 20260930245000: the legacy sweep, step F1b (wakes). Three functions keep only their folder-v2 path (folder-v2 only, the
-- founder's decision of 3 October):
-- - the wake insert trigger qorpera_pin_wake_occurrence: every wake needs the folder's admission (snapshot-v1 serialized
--   on the company row instead); a file wake names its change set; the agent's row is read without a lock; a routine's
--   wake goes to the folder's public session. P31's refusal of a human-task wake outside folder-v2 stays;
-- - qorpera_read_native_wake hands every read to qorpera_folder_read_wake;
-- - qorpera_wake_authorized hands every check to qorpera_folder_wake_authorized.
-- The rest of each body is the live text, unchanged; create or replace keeps every grant.

set local lock_timeout = '3s';

create or replace function public.qorpera_pin_wake_occurrence()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_version public.qorpera_cloud_routine_versions%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_staff public.qorpera_profile_staff%rowtype; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_trigger jsonb; v_ancestry jsonb; v_actor uuid; v_room public.qorpera_company_rooms%rowtype;
	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype; v_p31_task public.qorpera_folder_human_task_index%rowtype;
begin
	-- 20260930245000 (legacy sweep F1b): folder-v2 only, so every wake needs the folder's admission.
	if current_setting('qorpera.folder_wake_admission', true) is distinct from new.profile_id::text then
		raise exception 'Folder wake admission is required' using errcode = '55000'; end if;
	-- C1c-3l (20260930030100): office-activation serves folder-v2. -- C1c-3i-b (20260930058000): a machine event continues its parent run on folder-v2.
	if new.wake_schema <> 'qorpera.wake-envelope/v1' then
		raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
	if new.wake_kind = 'routine' then
		select * into strict v_version from public.qorpera_cloud_routine_versions
		where routine_id = new.routine_id and version = new.routine_version
			and profile_id = new.profile_id and environment_id = new.environment_id;
		select value into v_trigger from jsonb_array_elements(v_version.triggers) t(value) where value ->> 'id' = new.trigger_id;
		if v_trigger is null or not public.qorpera_cloud_routine_trigger_valid(v_trigger)
			or (new.source_kind = 'schedule' and v_trigger ->> 'kind' not in ('schedule','once'))
			-- 20260930020000 (P29): a folder-v2 file wake names its change set, never a snapshot event.
			or (new.source_kind = 'company-file'
				and (v_trigger ->> 'kind' <> 'file-change' or new.file_event_id is not null or new.source_id is null))
			or (new.source_kind = 'event' and (v_trigger ->> 'kind' <> 'listener' or v_trigger ->> 'source' is distinct from 'event'
				or new.file_event_id is not null))
			or new.source_kind not in ('schedule','company-file','event') then
			raise exception 'Wake source does not match its routine' using errcode = '22023'; end if;
		new.staff_agent_id := v_version.staff_agent_id; new.requested_by_user_id := v_version.created_by_user_id;
		new.sponsor_binding_id := v_version.sponsor_binding_id;
		new.sponsor_version := public.qorpera_live_sponsor_version(v_version.sponsor_binding_id, v_version.sponsor_version);
		new.logical_computer_id := v_version.logical_computer_id;
		new.time_zone := coalesce(v_trigger ->> 'timeZone','UTC');
		new.source_id := case when new.source_kind = 'event' then (v_trigger ->> 'hookId')::uuid
			when new.source_kind = 'company-file' then new.source_id
			else coalesce(new.file_event_id,new.routine_id) end;
		if new.source_kind = 'company-file' then
			-- 20260930020000 (P29): the change set's run, or a coding session's turn run (C1B as amended), is the parent;
			-- its agent is the actor.
			select coalesce(c.run_id, c.turn_run_id), case when c.actor_kind = 'staff_agent' then c.actor_id end
			into new.parent_run_id, v_actor from public.qorpera_folder_commits c
			where c.id = new.source_id and c.environment_id = new.environment_id and c.seq is not null;
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
	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then
		-- 20260930065000 (P31): a human task's wake has no parent run. Its pending marker (named by the key) and its task give
		-- the woken agent, the payer, the payload and the agent whose change it is; nothing the inserter sends is trusted.
		select * into v_p31_mark from public.qorpera_folder_human_task_wakes m where m.environment_id = new.environment_id
			and m.occurrence_key = new.occurrence_key and m.task_id = new.source_id and m.profile_id = new.profile_id
			and m.state = 'pending' and m.wake_id is null;
		select * into v_p31_task from public.qorpera_folder_human_task_index t where t.environment_id = new.environment_id
			and t.id = new.source_id and t.retired_at is null;
		if not public.qorpera_company_is_folder_v2(new.profile_id) or v_p31_mark.id is null or v_p31_task.id is null
			or new.parent_run_id is not null or new.file_event_id is not null then
			raise exception 'Wake task is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := public.qorpera_folder_human_task_recipient(new.profile_id, new.environment_id,
			v_p31_task.from_staff_agent_id);
		new.requested_by_user_id := coalesce(v_p31_mark.payer_user_id, v_p31_task.started_by_user_id);
		new.trigger_id := 'human-task';
		new.payload := jsonb_build_object('schema', 'qorpera.human-task-wake/v1', 'taskId', v_p31_mark.task_id,
			'reason', v_p31_mark.reason, 'commitId', v_p31_mark.commit_id,
			'dueAt', to_char(v_p31_mark.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_folder_human_task_sponsor(new.profile_id, new.requested_by_user_id, new.staff_agent_id) as payer;
		if new.sponsor_binding_id is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		select * into v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id;
		new.logical_computer_id := case when v_authority.sponsor_binding_id = new.sponsor_binding_id
			then v_authority.logical_computer_id end;
		-- The woken agent's own thread for the payer: it may answer there (reply optional).
		new.session_id := public.qorpera_folder_wake_public_session(new.profile_id, new.environment_id, new.staff_agent_id,
			new.requested_by_user_id);
		v_actor := v_p31_mark.actor_staff_agent_id;
	elsif new.wake_kind = 'agent' then
		select * into strict v_run from public.qorpera_execution_runs where id = new.parent_run_id
			and profile_id = new.profile_id and environment_id = new.environment_id;
		if new.source_kind not in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin') then raise exception 'Agent source is invalid' using errcode = '22023'; end if;
  if new.source_kind='coworker' then v_actor:=v_run.staff_agent_id; new.source_id:=new.id; end if;
  new.requested_by_user_id:=v_run.requested_by_user_id;
		-- The member who started the chain pays (20260928230000): their own login, else a company
		-- account, never the agent's standing account or another member's login.
		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_starter_sponsor(new.profile_id, new.requested_by_user_id, new.staff_agent_id,
			v_run.sponsor_binding_id) as payer;
		-- A standing authority lends its configured computer only to its own company account.
		select * into v_authority from public.qorpera_staff_execution_authorities
		where profile_id = new.profile_id and staff_agent_id = new.staff_agent_id;
		new.logical_computer_id := case when v_authority.sponsor_binding_id = new.sponsor_binding_id
			then v_authority.logical_computer_id end;
		new.session_id := case when new.source_kind in ('worker-completion','machine-event','machine-checkin') then v_run.session_id
			when new.source_kind = 'coworker' then new.session_id end;
		if new.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
			where w.id = new.source_id and w.species = 'coding') then
			select w.owner_sponsor_binding_id, public.qorpera_live_sponsor_version(w.owner_sponsor_binding_id, w.owner_sponsor_version)
			into new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_runtime_workers w where w.id = new.source_id;
			new.logical_computer_id := null;
		end if;
		if new.sponsor_binding_id is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		if new.source_kind = 'coworker' then
			-- The send names the receiver's own shared thread; admission only checks it is that thread.
			if new.session_id is null or not exists (select 1 from public.qorpera_company_rooms room
				where room.profile_id = new.profile_id and room.bound_staff_agent_id = new.staff_agent_id
					and room.status = 'active' and room.session_id = new.session_id) then
				raise exception 'Coworker thread is unavailable' using errcode = '42501'; end if;
			select coalesce(parent.causal_hop_count,0) + 1 into new.causal_hop_count
			from public.qorpera_wake_occurrences parent where parent.run_id = new.parent_run_id;
			new.causal_hop_count := coalesce(new.causal_hop_count,1);
		end if;
		if new.file_event_id is not null then raise exception 'Coworker event identity is invalid' using errcode = '42501'; end if;
	elsif new.wake_kind = 'room' then
		if new.source_kind <> 'room' or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null
			or new.session_id is null or new.source_id is null or new.staff_agent_id is null or new.requested_by_user_id is null
			or new.sponsor_binding_id is null or new.sponsor_version is null then
			raise exception 'Wake admission is unsupported' using errcode = '42501'; end if;
		select * into v_room from public.qorpera_company_rooms where session_id = new.session_id
			and profile_id = new.profile_id and environment_id = new.environment_id and status = 'active';
		if not found
			or not exists (select 1 from public.qorpera_session_inputs input where input.id = new.source_id
				and input.session_id = new.session_id and input.author_user_id = new.requested_by_user_id and input.kind = 'user_message')
			or not exists (select 1 from public.qorpera_company_room_members member where member.room_id = v_room.id
				and member.principal_kind = 'member' and member.principal_id = new.requested_by_user_id and member.status = 'active')
			or not exists (select 1 from public.qorpera_company_room_members member where member.room_id = v_room.id
				and member.principal_kind = 'staff_agent' and member.principal_id = new.staff_agent_id and member.status = 'active')
			or not exists (select 1 from public.qorpera_execution_sponsor_bindings binding
				join public.qorpera_execution_sponsor_versions version on version.binding_id = binding.id
					and version.version = new.sponsor_version
				where binding.id = new.sponsor_binding_id and binding.profile_id = new.profile_id and binding.status = 'active')
			-- The poster's own login or a company account (20260928230000).
			or not public.qorpera_sponsor_serves_requester(new.profile_id, new.sponsor_binding_id, new.sponsor_version,
				new.requested_by_user_id) then
			raise exception 'Room wake authority is unavailable' using errcode = '42501'; end if;
		v_actor := null; new.logical_computer_id := null;
	else raise exception 'Wake admission is unsupported' using errcode = '42501';
	end if;
	if new.parent_run_id is not null and not exists(select 1 from public.qorpera_execution_runs
		where id = new.parent_run_id and profile_id = new.profile_id and environment_id = new.environment_id) then
		raise exception 'Wake parent belongs to another company' using errcode = '42501'; end if;
	-- 20260930245000 (legacy sweep F1b): folder-v2 only, so the agent's row is read without a lock.
	select * into v_staff from public.qorpera_profile_staff where profile_id = new.profile_id
		and staff_agent_id = new.staff_agent_id and employment_status = 'active';
	if not found or not exists(select 1 from public.qorpera_profile_members
		where profile_id = new.profile_id and user_id = new.requested_by_user_id) then
		raise exception 'Wake recipient authority is unavailable' using errcode = '42501'; end if;
	new.staff_version := coalesce(v_run.staff_version,v_staff.version);
	if new.wake_kind = 'agent' then new.staff_version := v_staff.version; end if;
	if new.wake_kind = 'routine' then
		-- 20260930245000 (legacy sweep F1b): folder-v2 only, so the folder's public session.
		new.session_id := public.qorpera_folder_wake_public_session(new.profile_id,new.environment_id,new.staff_agent_id,
			new.requested_by_user_id);
		if coalesce(v_trigger ->> 'replyPolicy','required') = 'required' and new.session_id is null then
			raise exception 'Wake public audience is unavailable' using errcode = '42501';
		end if;
	end if;
 if new.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(new);
 elsif new.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(new);
 elsif new.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(new);
 elsif new.source_kind = 'machine-checkin' then v_ancestry := public.qorpera_machine_checkin_ancestry(new); -- 20260930098000
 elsif new.source_kind = 'coworker' then v_ancestry := public.qorpera_coworker_wake_ancestry(new);
 else v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,
	coalesce(new.file_event_id,case when new.source_kind = 'company-file' then new.source_id end,new.id)); end if; -- 20260930020000
	if v_ancestry is null then raise exception 'Wake causal ancestry is fenced' using errcode = '55000'; end if;
	new.causal_root_id := (v_ancestry ->> 'rootId')::uuid;
	new.causal_agent_ids := array(select jsonb_array_elements_text(v_ancestry -> 'agentIds')::uuid);
	-- The company pause (the operator brake) holds at admission
	-- without agent cooperation. A refused autonomous wake stays durable and
	-- cancelled with its reason; a human turn under a pause is refused at request.
	if new.wake_kind in ('routine','agent','room') and new.status = 'queued' then
		if public.qorpera_company_execution_paused(new.profile_id) then
			new.status := 'cancelled'; new.finished_at := clock_timestamp();
			new.blocked_reason := 'Company execution is paused';
			return new;
		end if;
	elsif new.wake_kind in ('human','first-run') and public.qorpera_company_execution_paused(new.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000';
	end if;
	return new;
end
$function$;

create or replace function public.qorpera_read_native_wake(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930245000 (legacy sweep F1b): folder-v2 only, so the folder core reads every wake.
	return public.qorpera_folder_read_wake(p_binding);
end
$function$;

create or replace function public.qorpera_wake_authorized(p_wake public.qorpera_wake_occurrences)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930245000 (legacy sweep F1b): folder-v2 only, so the folder core checks every wake.
	return public.qorpera_folder_wake_authorized(p_wake);
end
$function$;
