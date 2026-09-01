-- Runtime Step 3. The existing occurrence table remains the only wake queue.
-- File revisions remain the only Company File change ledger. New private
-- cursor/claim rows are delivery projections, never a second execution lane.

alter table public.qorpera_wake_occurrences
	alter column routine_id drop not null,
	alter column routine_version drop not null,
	add column wake_schema text not null default 'qorpera.wake-envelope/v1',
	add column wake_kind text not null default 'routine' check (wake_kind in ('human','first-run','routine','agent','room')),
	add column source_kind text not null default 'schedule' check (source_kind in ('input','schedule','company-file','coworker','room')),
	add column source_id uuid,
	add column staff_agent_id uuid,
	add column staff_version bigint,
	add column requested_by_user_id uuid references auth.users(id) on delete restrict,
	add column sponsor_binding_id uuid,
	add column sponsor_version bigint,
	add column logical_computer_id uuid references public.qorpera_logical_computers(id) on delete restrict,
	add column session_id uuid references public.qorpera_shared_sessions(id) on delete restrict,
	add column parent_run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	add column causal_root_id uuid,
	add column causal_agent_ids uuid[] not null default '{}'::uuid[],
	add column time_zone text not null default 'UTC',
	add column file_event_id uuid references public.qorpera_company_path_revisions(snapshot_id) on delete restrict,
	add constraint qorpera_wake_routine_identity check (
		(wake_kind = 'routine' and routine_id is not null and routine_version is not null)
		or (wake_kind <> 'routine' and routine_id is null and routine_version is null)
	),
	add constraint qorpera_wake_causal_bound check (
		cardinality(causal_agent_ids) <= 16 and public.qorpera_uuid_array_is_unique(causal_agent_ids)
	),
	add foreign key (sponsor_binding_id,sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id,version) on delete restrict;

-- Existing admitted routines retain their source identity; no payload flag
-- can reclassify them as a human, a room, or a fresh causal root.
update public.qorpera_wake_occurrences w set
	source_id = w.routine_id, staff_agent_id = v.staff_agent_id,
	staff_version = coalesce((select r.staff_version from public.qorpera_execution_runs r where r.id = w.run_id),s.version),
	requested_by_user_id = v.created_by_user_id,
	sponsor_binding_id = v.sponsor_binding_id, sponsor_version = v.sponsor_version,
	logical_computer_id = v.logical_computer_id,
	session_id = (select r.session_id from public.qorpera_execution_runs r where r.id = w.run_id),
	time_zone = coalesce((select t.value ->> 'timeZone' from jsonb_array_elements(v.triggers) t(value)
		where t.value ->> 'id' = w.trigger_id),'UTC'),
	causal_root_id = w.id, causal_agent_ids = array[v.staff_agent_id]
from public.qorpera_cloud_routine_versions v
join public.qorpera_profile_staff s on s.profile_id = v.profile_id and s.staff_agent_id = v.staff_agent_id
where w.routine_id = v.routine_id and w.routine_version = v.version;

create unique index qorpera_wake_nonroutine_source
	on public.qorpera_wake_occurrences(environment_id,wake_kind,occurrence_key,staff_agent_id)
	where routine_id is null;
create unique index qorpera_wake_first_run_once
	on public.qorpera_wake_occurrences(environment_id,staff_agent_id) where wake_kind = 'first-run';
create index qorpera_wake_parent_run on public.qorpera_wake_occurrences(parent_run_id) where parent_run_id is not null;
create unique index qorpera_company_path_revision_successor
	on public.qorpera_company_path_revisions(environment_id,parent_snapshot_id);

create table public.qorpera_company_file_wake_cursors (
	routine_id uuid not null,
	routine_version bigint not null,
	trigger_id text not null,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	activation_head uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	processed_head uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	active boolean not null default false,
	last_scanned_at timestamptz not null default '-infinity',
	primary key(routine_id,routine_version,trigger_id),
	foreign key(routine_id,routine_version)
		references public.qorpera_cloud_routine_versions(routine_id,version) on delete cascade
);
create index qorpera_company_file_wake_scan on public.qorpera_company_file_wake_cursors(last_scanned_at,routine_id,routine_version,trigger_id)
	where active;

create table public.qorpera_company_file_wake_claims (
	event_id uuid not null references public.qorpera_company_path_revisions(snapshot_id) on delete cascade,
	routine_id uuid not null,
	routine_version bigint not null,
	trigger_id text not null,
	outcome text not null check (outcome in ('admitted','denied','causal-fence')),
	occurrence_id uuid unique references public.qorpera_wake_occurrences(id) on delete cascade,
	primary key(event_id,routine_id,routine_version,trigger_id),
	foreign key(routine_id,routine_version,trigger_id)
		references public.qorpera_company_file_wake_cursors(routine_id,routine_version,trigger_id) on delete cascade,
	check ((outcome = 'admitted') = (occurrence_id is not null))
);
alter table public.qorpera_company_file_wake_cursors enable row level security;
alter table public.qorpera_company_file_wake_claims enable row level security;
revoke all on public.qorpera_company_file_wake_cursors, public.qorpera_company_file_wake_claims
	from public,anon,authenticated,service_role;

-- Closed policies. This is a wake schema pin, NOT the missing full runtime
-- bundle pin. Unrecognized policy never grants silence.
create function public.qorpera_wake_policy_value(p_kind text,p_reporting text default 'optional')
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

create function public.qorpera_runtime_wake_policy(p_run_id uuid)
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
		v_reporting := coalesce(v_trigger ->> 'replyPolicy','optional');
	end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);
end
$$;

create function public.qorpera_assert_wake_work_allowed(p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_policy jsonb := public.qorpera_runtime_wake_policy(p_run_id);
begin
	if v_policy ->> 'initial' = 'required' and not exists (
		select 1 from public.qorpera_agent_sends s join public.qorpera_session_events e on e.event_id = s.event_id
		where s.run_id = p_run_id and e.execution_id = p_run_id and s.phase = 'progress'
	) then raise exception 'Wake requires an acknowledgement before work' using errcode = '55000'; end if;
	if exists(select 1 from public.qorpera_agent_sends where run_id = p_run_id and phase = 'final') then
		raise exception 'Wake public output is already final' using errcode = '55000'; end if;
end
$$;

create function public.qorpera_assert_wake_completion(p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_policy jsonb := public.qorpera_runtime_wake_policy(p_run_id); v_count integer; v_final integer; v_progress integer;
begin
	select count(*),count(*) filter(where s.phase = 'final'),count(*) filter(where s.phase = 'progress') into v_count,v_final,v_progress
	from public.qorpera_agent_sends s join public.qorpera_session_events e on e.event_id = s.event_id
	where s.run_id = p_run_id and e.execution_id = p_run_id;
	if v_count > (v_policy ->> 'maxPublicSends')::integer
		or (v_policy ->> 'initial' = 'required' and v_progress = 0)
		or (v_policy ->> 'final' = 'forbidden' and v_count <> 0)
		or (v_policy ->> 'final' = 'required' and v_final <> 1)
		or (v_count > 0 and v_final <> 1) then
		raise exception 'Wake reply obligation is not satisfied' using errcode = '55000'; end if;
end
$$;

-- This helper reads only immutable causal identity, never treats the parent's
-- expired lease or former grants as recipient authority.
create function public.qorpera_wake_ancestry(p_parent_run uuid,p_actor_staff uuid,p_recipient uuid,p_root uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_parent public.qorpera_wake_occurrences%rowtype; v_agents uuid[] := '{}'; v_root uuid := p_root;
begin
	if p_parent_run is not null then
		select w.* into v_parent from public.qorpera_wake_occurrences w
		join public.qorpera_execution_runs r on r.id = w.run_id and r.staff_agent_id = w.staff_agent_id
		where w.run_id = p_parent_run;
		if not found or v_parent.wake_schema <> 'qorpera.wake-envelope/v1'
			or public.qorpera_runtime_wake_policy(p_parent_run) ->> 'kind' is distinct from v_parent.wake_kind
			or (p_actor_staff is not null and v_parent.staff_agent_id <> p_actor_staff)
			or v_parent.causal_root_id is null or cardinality(v_parent.causal_agent_ids) not between 1 and 16 then return null; end if;
		v_agents := v_parent.causal_agent_ids; v_root := v_parent.causal_root_id;
	elsif p_actor_staff is not null then
		v_agents := array[p_actor_staff];
	end if;
	if p_recipient is null or p_recipient = any(v_agents) or cardinality(v_agents) >= 16 then return null; end if;
	return jsonb_build_object('rootId',v_root,'agentIds',to_jsonb(v_agents || p_recipient));
end
$$;

create function public.qorpera_wake_path_authorized(
	p_environment uuid,p_requester uuid,p_staff uuid,p_path text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_file from public.qorpera_company_files where environment_id = p_environment;
	if not found then return false; end if;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into v_file from public.qorpera_company_files where environment_id = p_environment for update;
	if v_file.path_gateway_version is distinct from 1
		or v_file.path_index_snapshot_id is distinct from v_file.head_snapshot_id then return false; end if;
	perform 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = p_requester for share;
	perform 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id and staff_agent_id = p_staff for share;
	v_resource := public.qorpera_company_path_resource(p_environment,p_path);
	return v_resource.scope = 'company_shared'
		and public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'member',p_requester,'read')
		and public.qorpera_company_path_principal_allowed(v_file.profile_id,v_resource,'staff_agent',p_staff,'read');
end
$$;

alter function public.qorpera_cloud_routine_trigger_valid(jsonb) rename to qorpera_cloud_routine_trigger_before_wake_bus;
revoke all on function public.qorpera_cloud_routine_trigger_before_wake_bus(jsonb) from public,anon,authenticated,service_role;
create function public.qorpera_cloud_routine_trigger_valid(p_trigger jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
begin
	if jsonb_typeof(p_trigger) is distinct from 'object'
		or (p_trigger ? 'replyPolicy' and (jsonb_typeof(p_trigger -> 'replyPolicy') <> 'string'
			or p_trigger ->> 'replyPolicy' not in ('optional','required','silent'))) then return false; end if;
	if p_trigger ->> 'kind' = 'schedule' then
		return public.qorpera_cloud_routine_trigger_before_wake_bus(p_trigger - 'replyPolicy');
	end if;
	return coalesce(p_trigger ->> 'kind' = 'listener' and p_trigger ->> 'source' = 'company-file'
		and p_trigger ?& array['id','kind','source','path','match','timeZone']
		and p_trigger - array['id','kind','source','path','match','timeZone','replyPolicy'] = '{}'::jsonb
		and jsonb_typeof(p_trigger -> 'id') = 'string'
		and p_trigger ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
		and jsonb_typeof(p_trigger -> 'path') = 'string'
		and public.qorpera_company_path_valid(p_trigger ->> 'path',p_trigger ->> 'match' = 'subtree')
		and p_trigger ->> 'match' in ('exact','subtree')
		and jsonb_typeof(p_trigger -> 'timeZone') = 'string'
		and exists(select 1 from pg_catalog.pg_timezone_names where name = p_trigger ->> 'timeZone'),false);
exception when others then return false;
end
$$;

create function public.qorpera_activate_company_file_listener()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_trigger jsonb; v_head uuid;
begin
	if not exists(select 1 from jsonb_array_elements(new.triggers) t where t ->> 'kind' = 'listener') then return new; end if;
	if jsonb_array_length(new.triggers) <> 1 then
		raise exception 'A listener cannot also be a schedule' using errcode = '22023'; end if;
	v_trigger := new.triggers -> 0;
	-- Match drain's cursor-before-File order, including older cursor versions
	-- which the routine's status trigger will deactivate in this transaction.
	perform 1 from public.qorpera_company_file_wake_cursors where routine_id = new.routine_id for update;
	if not public.qorpera_cloud_routine_trigger_valid(v_trigger)
		or not coalesce(public.qorpera_wake_path_authorized(new.environment_id,new.created_by_user_id,
			new.staff_agent_id,v_trigger ->> 'path'),false) then
		raise exception 'Company File listener authority is unavailable' using errcode = '42501'; end if;
	-- The preceding authorization holds the same File lock as publication.
	-- Capture the actual current head, not a timestamp, UUID watermark, or old
	-- routine cursor. Creation/edit is future-only; backfill is unsupported.
	select head_snapshot_id into strict v_head from public.qorpera_company_files where environment_id = new.environment_id;
	insert into public.qorpera_company_file_wake_cursors(routine_id,routine_version,trigger_id,environment_id,activation_head,processed_head)
	values(new.routine_id,new.version,v_trigger ->> 'id',new.environment_id,v_head,v_head);
	return new;
end
$$;
create trigger qorpera_cloud_routine_listener_activation after insert on public.qorpera_cloud_routine_versions
	for each row execute function public.qorpera_activate_company_file_listener();

create function public.qorpera_sync_company_file_listener()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_head uuid;
begin
	-- Keep old versions outside the bounded drain index. A status-only resume
	-- also captures the current head under the publication lock, future-only.
	perform 1 from public.qorpera_company_file_wake_cursors where routine_id = new.id for update;
	if new.status = 'active' and old.status <> 'active' and new.current_version = old.current_version
		and exists(select 1 from public.qorpera_company_file_wake_cursors where routine_id = new.id
			and routine_version = new.current_version) then
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		select head_snapshot_id into strict v_head from public.qorpera_company_files
		where environment_id = new.environment_id for update;
		update public.qorpera_company_file_wake_cursors set activation_head = v_head,processed_head = v_head
		where routine_id = new.id and routine_version = new.current_version;
	end if;
	update public.qorpera_company_file_wake_cursors set active = new.status = 'active' and routine_version = new.current_version
	where routine_id = new.id;
	return new;
end
$$;
create trigger qorpera_cloud_routine_listener_status after update of current_version,status on public.qorpera_cloud_routines
	for each row execute function public.qorpera_sync_company_file_listener();

create function public.qorpera_pin_wake_occurrence()
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
		select id into new.session_id from public.qorpera_shared_sessions where profile_id = new.profile_id
			and environment_id = new.environment_id and staff_agent_id = new.staff_agent_id::text and status = 'open'
			and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);
	end if;
	v_ancestry := public.qorpera_wake_ancestry(new.parent_run_id,v_actor,new.staff_agent_id,coalesce(new.file_event_id,new.id));
	if v_ancestry is null then raise exception 'Wake causal ancestry is fenced' using errcode = '55000'; end if;
	new.causal_root_id := (v_ancestry ->> 'rootId')::uuid;
	new.causal_agent_ids := array(select jsonb_array_elements_text(v_ancestry -> 'agentIds')::uuid);
	return new;
end
$$;
create trigger qorpera_wake_occurrence_pin before insert on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_pin_wake_occurrence();

create function public.qorpera_guard_wake_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
	if (to_jsonb(new) - array['status','blocked_reason','run_id','finished_at'])
		is distinct from (to_jsonb(old) - array['status','blocked_reason','run_id','finished_at'])
		or (old.run_id is not null and new.run_id is distinct from old.run_id) then
		raise exception 'Admitted wake identity is immutable' using errcode = '42501'; end if;
	return new;
end
$$;
create trigger qorpera_wake_occurrence_identity before update on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_guard_wake_identity();

create function public.qorpera_admit_input_wake()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_id uuid := extensions.gen_random_uuid(); v_source uuid; v_count integer;
	v_human integer; v_kickoff integer; v_run public.qorpera_execution_runs%rowtype;
begin
	if new.event_type <> 'queued' then return new; end if;
	select * into strict v_run from public.qorpera_execution_runs where id = new.run_id;
	if v_run.source_kind <> 'session_turn' or v_run.job_type <> 'agent_turn' or cardinality(v_run.input_ids) = 0
		or exists(select 1 from public.qorpera_wake_occurrences where run_id = v_run.id) then return new; end if;
	select count(*),count(*) filter(where kind = 'user_message'),count(*) filter(where kind = 'kickoff'),
		coalesce(min(id::text) filter(where kind = 'user_message'),min(id::text))::uuid
		into v_count,v_human,v_kickoff,v_source
	from public.qorpera_session_inputs where id = any(v_run.input_ids) and session_id = v_run.session_id
		and author_user_id = v_run.requested_by_user_id and execution_run_id = v_run.id;
	if v_count <> cardinality(v_run.input_ids) or not public.qorpera_uuid_array_is_unique(v_run.input_ids) then
		raise exception 'Wake input set is not fully bound' using errcode = '42501'; end if;
	v_kind := case when v_count = v_human + v_kickoff then
		case when v_human > 0 then 'human' when v_kickoff = 1 then 'first-run' end end;
	if v_kind is null then return new; end if;
	insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,source_id,
		trigger_id,occurrence_key,scheduled_for,not_before,payload,status,run_id)
	values(v_id,v_run.profile_id,v_run.environment_id,v_kind,'input',v_source,v_kind,'input:' || v_source::text,
		clock_timestamp(),clock_timestamp(),jsonb_build_object('inputIds',to_jsonb(v_run.input_ids)),'materialized',v_run.id);
	return new;
end
$$;
-- This existing event is emitted after sponsor reservation and input claims.
-- Provisional runs rejected by admission can still be deleted without a wake.
create trigger qorpera_execution_run_input_wake after insert on public.qorpera_execution_run_events
	for each row execute function public.qorpera_admit_input_wake();

revoke all on function public.qorpera_wake_policy_value(text,text),
	public.qorpera_wake_ancestry(uuid,uuid,uuid,uuid),
	public.qorpera_wake_path_authorized(uuid,uuid,uuid,text),
	public.qorpera_activate_company_file_listener(),public.qorpera_sync_company_file_listener(),public.qorpera_pin_wake_occurrence(),
	public.qorpera_guard_wake_identity(),public.qorpera_admit_input_wake(),
	public.qorpera_cloud_routine_trigger_valid(jsonb)
	from public,anon,authenticated,service_role;
revoke all on function public.qorpera_runtime_wake_policy(uuid),public.qorpera_assert_wake_work_allowed(uuid),
	public.qorpera_assert_wake_completion(uuid) from public,anon,authenticated;
grant execute on function public.qorpera_runtime_wake_policy(uuid),public.qorpera_assert_wake_work_allowed(uuid),
	public.qorpera_assert_wake_completion(uuid) to service_role;

create function public.qorpera_wake_authorized(p_wake public.qorpera_wake_occurrences)
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
				and staff_agent_id = p_wake.staff_agent_id::text and status = 'open')) then return false; end if;
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

create function public.qorpera_drain_company_file_wakes(p_limit integer default 32)
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
				v_version.staff_agent_id,v_path),false) then
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

create function public.qorpera_send_coworker_message(
	p_binding jsonb,p_recipient_staff_id uuid,p_operation_key text,p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_authority public.qorpera_staff_execution_authorities%rowtype;
	v_digest text; v_receipt_id uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_occurrence uuid := extensions.gen_random_uuid(); v_ancestry jsonb; v_path text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if p_recipient_staff_id is null or p_operation_key is null or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or p_text is null or p_text !~ '[^[:space:]]' or octet_length(p_text) > 4096 then
		raise exception 'Coworker message is invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_profile_staff where profile_id = v_run.profile_id
		and staff_agent_id = p_recipient_staff_id and employment_status = 'active' for share;
	if not found then raise exception 'Coworker recipient is unavailable' using errcode = '42501'; end if;
	select * into v_authority from public.qorpera_staff_execution_authorities
	where profile_id = v_run.profile_id and staff_agent_id = p_recipient_staff_id for share;
	if not found or not exists(select 1 from public.qorpera_execution_sponsor_versions s
		join public.qorpera_execution_sponsor_bindings b on b.id = s.binding_id
		where s.binding_id = v_authority.sponsor_binding_id and s.version = v_authority.sponsor_version
			and b.profile_id = v_run.profile_id and b.status = 'active' and s.allow_autonomous) then
		raise exception 'Coworker execution authority is unavailable' using errcode = '42501'; end if;
	for v_path in select path from public.qorpera_company_run_read_paths where run_id = v_run.id loop
		if not coalesce(public.qorpera_wake_path_authorized(v_run.environment_id,v_run.requested_by_user_id,
			p_recipient_staff_id,v_path),false) then
			raise exception 'Coworker audience cannot receive this context' using errcode = '42501'; end if;
	end loop;
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('schema','qorpera.coworker-message/v1',
		'runId',v_run.id,'companyId',v_run.profile_id,'senderStaffId',v_run.staff_agent_id,
		'requesterUserId',v_run.requested_by_user_id,'recipientStaffId',p_recipient_staff_id,
		'operationKey',p_operation_key,'text',p_text)::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding,v_receipt_id,'coworker:' || p_operation_key,
		v_digest,encode(extensions.digest(convert_to(v_run.id::text || ':coworker:' || p_operation_key,'utf8'),'sha256'),'hex'),false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Coworker message requires reconciliation' using errcode = '55000'; end if;
	v_ancestry := public.qorpera_wake_ancestry(v_run.id,v_run.staff_agent_id,p_recipient_staff_id,v_occurrence);
	if v_ancestry is not null then
		insert into public.qorpera_wake_occurrences(id,profile_id,environment_id,wake_kind,source_kind,staff_agent_id,
			parent_run_id,sponsor_binding_id,sponsor_version,trigger_id,occurrence_key,scheduled_for,not_before,payload)
		values(v_occurrence,v_run.profile_id,v_run.environment_id,'agent','coworker',p_recipient_staff_id,
			v_run.id,v_authority.sponsor_binding_id,v_authority.sponsor_version,'coworker',
			'coworker:' || v_run.id::text || ':' || p_operation_key,clock_timestamp(),clock_timestamp(),
			jsonb_build_object('text',p_text,'senderStaffId',v_run.staff_agent_id,'receiptId',v_receipt_id));
	else v_occurrence := null;
	end if;
	v_result := jsonb_build_object('schema','qorpera.coworker-send/v1','runId',v_run.id,
		'receiptId',v_receipt_id,'occurrenceId',v_occurrence,'recipientStaffId',p_recipient_staff_id,
		'status',case when v_occurrence is null then 'causal-fence' else 'queued' end);
	-- Receipt, addressed content, and occurrence commit together. A lost RPC
	-- response is replayed by the existing ledger, never by re-sending text.
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt_id,v_digest,v_result);
	return v_result;
end
$$;

create function public.qorpera_read_native_wake(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_actor jsonb; v_path text; v_payload jsonb; v_routine jsonb := null; v_sender uuid; v_actor_user uuid;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id,p_binding);
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id;
	if not found or not public.qorpera_wake_authorized(v_wake)
		or public.qorpera_runtime_wake_policy(v_run.id) ->> 'kind' is distinct from v_wake.wake_kind then
		raise exception 'Admitted wake is unavailable' using errcode = '42501'; end if;
	if v_wake.source_kind = 'company-file' then
		select change #>> '{plan,path}' into strict v_path from public.qorpera_company_path_revisions
		where snapshot_id = v_wake.file_event_id;
		perform public.qorpera_company_path_remember_read(v_actor,v_path);
	elsif v_wake.wake_kind = 'agent' then
		for v_path in select path from public.qorpera_company_run_read_paths where run_id = v_wake.parent_run_id loop
			perform public.qorpera_company_path_remember_read(v_actor,v_path);
		end loop;
	end if;
	perform public.qorpera_company_path_assert_context(v_actor);
	if v_wake.wake_kind = 'routine' then
		select jsonb_build_object('id',routine_id,'version',version,'intent',prompt) into v_routine
		from public.qorpera_cloud_routine_versions where routine_id = v_wake.routine_id and version = v_wake.routine_version;
	end if;
	if v_wake.parent_run_id is not null then
		select staff_agent_id,requested_by_user_id into v_sender,v_actor_user
		from public.qorpera_execution_runs where id = v_wake.parent_run_id;
	elsif v_wake.source_kind = 'input' then v_actor_user := v_run.requested_by_user_id;
	end if;
	if v_wake.source_kind = 'company-file' then
		select actor_staff_id,actor_user_id into v_sender,v_actor_user
		from public.qorpera_company_path_revisions where snapshot_id = v_wake.file_event_id;
	end if;
	v_payload := jsonb_build_object('schema','qorpera.wake-envelope/v1','id',v_wake.id,'runId',v_run.id,
		'kind',v_wake.wake_kind,'companyId',v_run.profile_id,'environmentId',v_run.environment_id,
		'staffAgentId',v_run.staff_agent_id,'requesterUserId',v_run.requested_by_user_id,
		'actorStaffId',v_sender,'actorUserId',v_actor_user,
		'audience',jsonb_build_object('kind','company','sessionId',v_run.session_id),
		'source',jsonb_build_object('kind',v_wake.source_kind,'id',v_wake.source_id,'occurrenceKey',v_wake.occurrence_key),
		'policy',public.qorpera_runtime_wake_policy(v_run.id),
		'time',jsonb_build_object('utc',to_char(v_wake.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			'local',to_char(v_wake.scheduled_for at time zone v_wake.time_zone,'YYYY-MM-DD"T"HH24:MI:SS.US'),'timeZone',v_wake.time_zone),
		'pins',jsonb_build_object('companySnapshotId',v_run.company_snapshot_id,'staffVersion',v_run.staff_version,
			'wakeSchema','qorpera.wake-envelope/v1','runtimeBundleVersion',null),
		'routine',v_routine,'payload',v_wake.payload,'parentRunId',v_wake.parent_run_id,
		'causal',jsonb_build_object('rootId',v_wake.causal_root_id,'agentIds',to_jsonb(v_wake.causal_agent_ids)));
	if pg_column_size(v_payload) > 49152 then raise exception 'Wake context exceeds its bound' using errcode = '54000'; end if;
	return v_payload;
end
$$;

revoke all on function public.qorpera_wake_authorized(public.qorpera_wake_occurrences) from public,anon,authenticated,service_role;
revoke all on function public.qorpera_drain_company_file_wakes(integer),
	public.qorpera_send_coworker_message(jsonb,uuid,text,text),public.qorpera_read_native_wake(jsonb)
	from public,anon,authenticated;
grant execute on function public.qorpera_drain_company_file_wakes(integer),
	public.qorpera_send_coworker_message(jsonb,uuid,text,text),public.qorpera_read_native_wake(jsonb) to service_role;

-- Replace only the occurrence materializer, keeping the existing orchestrator,
-- jobs, run admission, sponsor reservation, assignment, lease and retry lanes.
-- Native context must load the authorized envelope; a job carries only its ID.
create or replace function public.qorpera_materialize_wake_execution_runs(p_limit integer default 32)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_wake public.qorpera_wake_occurrences%rowtype; v_version public.qorpera_cloud_routine_versions%rowtype;
	v_file public.qorpera_company_files%rowtype; v_substrate public.qorpera_company_substrate_versions%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
	v_id uuid; v_payload jsonb; v_digest text; v_capability text; v_job_type text;
	v_publication text; v_review text; v_reviewers uuid[]; v_sequence bigint; v_runs jsonb := '[]';
	v_compute uuid; v_mode text; v_worker_class text; v_now timestamptz;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Wake materialization authority or bound is invalid' using errcode = '42501'; end if;
	perform public.qorpera_drain_company_file_wakes(p_limit);
	v_now := clock_timestamp();
	for v_wake in select * from public.qorpera_wake_occurrences
		where status = 'queued' and not_before <= v_now
		order by not_before,created_at,id for update skip locked limit p_limit
	loop
		perform public.qorpera_lock_profile_gc_fence(v_wake.profile_id);
		select * into v_file from public.qorpera_company_files
		where environment_id = v_wake.environment_id and profile_id = v_wake.profile_id for update;
		perform 1 from public.qorpera_profile_members
		where profile_id = v_wake.profile_id and user_id = v_wake.requested_by_user_id for share;
		perform 1 from public.qorpera_profile_staff
		where profile_id = v_wake.profile_id and staff_agent_id = v_wake.staff_agent_id for share;
		if v_wake.wake_kind not in ('routine','agent') or not public.qorpera_wake_authorized(v_wake) then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake recipient or source authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		v_capability := 'agent_turn'; v_job_type := 'agent_turn';
		v_publication := 'automatic'; v_review := null; v_reviewers := '{}';
		if v_wake.wake_kind = 'routine' then
			select * into strict v_version from public.qorpera_cloud_routine_versions
			where routine_id = v_wake.routine_id and version = v_wake.routine_version;
			v_capability := v_version.required_capability; v_job_type := v_version.job_type;
			v_publication := v_version.publication_mode; v_review := v_version.review_policy_key;
			v_reviewers := v_version.reviewer_staff_ids;
		end if;
		perform 1 from public.qorpera_execution_sponsor_bindings b
		join public.qorpera_execution_sponsor_versions s on s.binding_id = b.id and s.version = v_wake.sponsor_version
		join public.qorpera_provider_connections c on c.id = s.provider_connection_id
		where b.id = v_wake.sponsor_binding_id and b.profile_id = v_wake.profile_id and b.status = 'active'
			and s.allow_autonomous and c.profile_id = v_wake.profile_id and c.status = 'active' for share of b,c;
		if not found then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake execution authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		select * into v_substrate from public.qorpera_company_substrate_versions
		where profile_id = v_wake.profile_id and environment_id = v_wake.environment_id
			and company_snapshot_id = v_file.head_snapshot_id order by created_at desc,id desc limit 1;
		if v_file.head_snapshot_id is null or v_substrate.id is null or (v_wake.logical_computer_id is not null
			and not exists(select 1 from public.qorpera_logical_computers where id = v_wake.logical_computer_id
				and profile_id = v_wake.profile_id and status = 'active' and capabilities ? v_capability)) then
			update public.qorpera_wake_occurrences set blocked_reason = 'Pinned Company File or computer is unavailable'
			where id = v_wake.id;
			continue;
		end if;
		-- Resolve compute from the already authorized immutable sponsor/capsule,
		-- then let the existing native provenance trigger verify ownership.
		select c.compute_identity_id,v.authentication_mode into v_compute,v_mode
		from public.qorpera_execution_sponsor_versions s join public.qorpera_provider_connection_versions v
			on v.connection_id = s.provider_connection_id and v.version = s.provider_connection_version
		left join public.qorpera_native_credential_capsules c on c.id = v.credential_capsule_id and c.status = 'active'
		where s.binding_id = v_wake.sponsor_binding_id and s.version = v_wake.sponsor_version;
		v_worker_class := 'managed_sandbox';
		if v_wake.logical_computer_id is not null then
			select computer_class into v_worker_class from public.qorpera_logical_computers where id = v_wake.logical_computer_id
				and (v_compute is null or compute_identity_id = v_compute);
			if v_compute is null then
				select compute_identity_id into v_compute from public.qorpera_logical_computers where id = v_wake.logical_computer_id;
			end if;
		end if;
		if (v_mode = 'native_subscription' and v_compute is null) or v_worker_class is null then
			update public.qorpera_wake_occurrences set status = 'cancelled',finished_at = clock_timestamp(),
				blocked_reason = 'Wake compute authority is unavailable' where id = v_wake.id;
			continue;
		end if;
		v_id := extensions.gen_random_uuid();
		v_payload := jsonb_build_object('schema','qorpera.wake-run/v1','occurrenceId',v_wake.id);
		v_digest := encode(extensions.digest(convert_to(v_payload::text,'utf8'),'sha256'),'hex');
		select coalesce(max(sequence),0) into v_sequence from public.qorpera_session_events where session_id = v_wake.session_id;
		insert into public.qorpera_runner_jobs(profile_id,environment_id,session_id,substrate_version_id,client_job_id,
			required_capability,job_type,payload,created_by_user_id)
		values(v_wake.profile_id,v_wake.environment_id,v_wake.session_id,v_substrate.id,v_id,
			v_capability,v_job_type,v_payload,v_wake.requested_by_user_id) returning * into v_job;
		insert into public.qorpera_execution_runs(id,profile_id,environment_id,source_kind,source_id,session_id,job_id,
			substrate_version_id,company_snapshot_id,staff_agent_id,staff_version,input_ids,sponsor_binding_id,sponsor_version,
			required_capability,job_type,payload_sha256,publication_mode,review_policy_key,reviewer_staff_ids,logical_computer_id,
			compute_identity_id,worker_class,transcript_start_sequence,created_by_user_id)
		values(v_id,v_wake.profile_id,v_wake.environment_id,'wake',v_wake.id,v_wake.session_id,v_job.id,
			v_substrate.id,v_file.head_snapshot_id,v_wake.staff_agent_id,v_wake.staff_version,'{}',
			v_wake.sponsor_binding_id,v_wake.sponsor_version,v_capability,v_job_type,v_digest,
			v_publication,v_review,v_reviewers,v_wake.logical_computer_id,v_compute,v_worker_class,v_sequence,v_wake.requested_by_user_id)
		returning * into v_run;
		update public.qorpera_runner_jobs set run_id = v_run.id where id = v_job.id;
		if not public.qorpera_reserve_execution_sponsor_authority(v_run.id) then
			update public.qorpera_runner_jobs set run_id = null where id = v_job.id;
			delete from public.qorpera_execution_runs where id = v_run.id;
			delete from public.qorpera_runner_jobs where id = v_job.id;
			update public.qorpera_wake_occurrences set blocked_reason = 'Execution sponsor authority or quota is unavailable'
			where id = v_wake.id;
			continue;
		end if;
		update public.qorpera_wake_occurrences set status = 'materialized',run_id = v_run.id,blocked_reason = null where id = v_wake.id;
		insert into public.qorpera_execution_run_events(run_id,event_type) values(v_run.id,'queued');
		v_runs := v_runs || jsonb_build_array(public.qorpera_execution_run_json(v_run));
	end loop;
	return v_runs;
end
$$;
revoke all on function public.qorpera_materialize_wake_execution_runs(integer) from public,anon,authenticated;
grant execute on function public.qorpera_materialize_wake_execution_runs(integer) to service_role;
