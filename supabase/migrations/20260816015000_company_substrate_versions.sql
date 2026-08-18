-- Immutable cross-layer company state for fork and computer launch points.
--
-- Company trees already have immutable snapshots and session events are
-- append-only, but staff rows are mutable. Record every staff state and
-- session head advance in one profile-wide operation sequence. A substrate
-- version can then bind a tree snapshot to an exact replay watermark without
-- copying those layers into every version.

create table public.qorpera_profile_operation_clocks (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	last_sequence bigint not null default 0 check (last_sequence >= 0)
);

create table public.qorpera_company_operations (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	sequence bigint not null check (sequence > 0),
	environment_id uuid references public.qorpera_company_environments(id) on delete cascade,
	operation_type text not null check (operation_type in ('staff_state', 'session_state', 'session_event')),
	entity_id uuid not null,
	entity_version bigint not null check (entity_version >= 0),
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	payload jsonb not null check (
		jsonb_typeof(payload) = 'object'
		and octet_length(convert_to(payload::text, 'utf8')) between 2 and 131072
	),
	actor_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, sequence),
	check (
		(operation_type = 'staff_state' and environment_id is null)
		or (operation_type in ('session_state', 'session_event') and environment_id is not null)
	)
);

create index qorpera_company_operations_environment_sequence
	on public.qorpera_company_operations (profile_id, environment_id, sequence);

alter table public.qorpera_profile_operation_clocks enable row level security;
alter table public.qorpera_company_operations enable row level security;

revoke all on public.qorpera_profile_operation_clocks from anon, authenticated;
revoke all on public.qorpera_company_operations from anon, authenticated;

create function public.qorpera_append_company_operation(
	p_profile_id uuid,
	p_environment_id uuid,
	p_operation_type text,
	p_entity_id uuid,
	p_entity_version bigint,
	p_payload jsonb,
	p_actor_user_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_sequence bigint;
	v_content_sha256 text;
begin
	if p_profile_id is null
		or p_operation_type not in ('staff_state', 'session_state', 'session_event')
		or p_entity_id is null
		or p_entity_version is null or p_entity_version < 0
		or p_payload is null or jsonb_typeof(p_payload) <> 'object'
		or octet_length(convert_to(p_payload::text, 'utf8')) not between 2 and 131072
		or p_actor_user_id is null
		or (p_operation_type = 'staff_state' and p_environment_id is not null)
		or (p_operation_type in ('session_state', 'session_event') and p_environment_id is null) then
		raise exception 'company operation is invalid' using errcode = '22023';
	end if;

	insert into public.qorpera_profile_operation_clocks (profile_id, last_sequence)
	values (p_profile_id, 1)
	on conflict (profile_id) do update
	set last_sequence = public.qorpera_profile_operation_clocks.last_sequence + 1
	returning last_sequence into v_sequence;

	v_content_sha256 := encode(
		extensions.digest(
			convert_to(
				jsonb_build_object(
					'operation_type', p_operation_type,
					'entity_id', p_entity_id,
					'entity_version', p_entity_version,
					'payload', p_payload
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_company_operations (
		profile_id,
		sequence,
		environment_id,
		operation_type,
		entity_id,
		entity_version,
		content_sha256,
		payload,
		actor_user_id
	)
	values (
		p_profile_id,
		v_sequence,
		p_environment_id,
		p_operation_type,
		p_entity_id,
		p_entity_version,
		v_content_sha256,
		p_payload,
		p_actor_user_id
	);

	return v_sequence;
end
$$;

revoke all on function public.qorpera_append_company_operation(uuid, uuid, text, uuid, bigint, jsonb, uuid) from public;

create function public.qorpera_record_staff_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform public.qorpera_append_company_operation(
		new.profile_id,
		null,
		'staff_state',
		new.staff_agent_id,
		new.version,
		jsonb_build_object(
			'profile_id', new.profile_id,
			'staff_agent_id', new.staff_agent_id,
			'display_name', new.display_name,
			'role', new.role,
			'charter', new.charter,
			'template_id', new.template_id,
			'department_id', new.department_id,
			'appearance_color', new.appearance_color,
			'appearance_shape', new.appearance_shape,
			'employment_status', new.employment_status,
			'version', new.version,
			'created_at', new.created_at,
			'updated_at', new.updated_at,
			'updated_by_user_id', new.updated_by_user_id
		),
		new.updated_by_user_id
	);
	return new;
end
$$;

create function public.qorpera_record_session_state_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_head_sequence bigint := 0;
	v_head_hash text;
begin
	select event.sequence, event.event_hash
	into v_head_sequence, v_head_hash
	from public.qorpera_session_events as event
	where event.session_id = new.id
	order by event.sequence desc
	limit 1;
	v_head_sequence := coalesce(v_head_sequence, 0);

	perform public.qorpera_append_company_operation(
		new.profile_id,
		new.environment_id,
		'session_state',
		new.id,
		v_head_sequence,
		jsonb_build_object(
			'session_id', new.id,
			'client_session_id', new.client_session_id,
			'profile_id', new.profile_id,
			'environment_id', new.environment_id,
			'title', new.title,
			'staff_agent_id', new.staff_agent_id,
			'parent_session_id', new.parent_session_id,
			'status', new.status,
			'head_sequence', v_head_sequence,
			'head_event_hash', v_head_hash,
			'created_by_user_id', new.created_by_user_id,
			'created_at', new.created_at,
			'updated_at', new.updated_at
		),
		new.created_by_user_id
	);
	return new;
end
$$;

create function public.qorpera_record_session_event_operation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_session public.qorpera_shared_sessions%rowtype;
begin
	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = new.session_id;
	if not found then
		raise exception 'session event has no shared session' using errcode = '23503';
	end if;

	perform public.qorpera_append_company_operation(
		v_session.profile_id,
		v_session.environment_id,
		'session_event',
		new.session_id,
		new.sequence,
		jsonb_build_object(
			'session_id', new.session_id,
			'client_session_id', v_session.client_session_id,
			'sequence', new.sequence,
			'event_hash', new.event_hash,
			'event_type', new.event_type,
			'created_at', new.created_at
		),
		new.actor_user_id
	);
	return new;
end
$$;

revoke all on function public.qorpera_record_staff_operation() from public;
revoke all on function public.qorpera_record_session_state_operation() from public;
revoke all on function public.qorpera_record_session_event_operation() from public;

-- Existing hosted state becomes the first replayable journal prefix. Earlier
-- substrate versions do not exist, so one current-state receipt per entity is
-- sufficient; the immutable event table retains every prior trail entry.
do $$
declare
	v_staff public.qorpera_profile_staff%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_head public.qorpera_session_events%rowtype;
	v_has_head boolean;
begin
	for v_staff in
		select staff.*
		from public.qorpera_profile_staff as staff
		order by staff.profile_id, staff.staff_agent_id
	loop
		perform public.qorpera_append_company_operation(
			v_staff.profile_id,
			null,
			'staff_state',
			v_staff.staff_agent_id,
			v_staff.version,
			jsonb_build_object(
				'profile_id', v_staff.profile_id,
				'staff_agent_id', v_staff.staff_agent_id,
				'display_name', v_staff.display_name,
				'role', v_staff.role,
				'charter', v_staff.charter,
				'template_id', v_staff.template_id,
				'department_id', v_staff.department_id,
				'appearance_color', v_staff.appearance_color,
				'appearance_shape', v_staff.appearance_shape,
				'employment_status', v_staff.employment_status,
				'version', v_staff.version,
				'created_at', v_staff.created_at,
				'updated_at', v_staff.updated_at,
				'updated_by_user_id', v_staff.updated_by_user_id
			),
			v_staff.updated_by_user_id
		);
	end loop;

	for v_session in
		select session.*
		from public.qorpera_shared_sessions as session
		order by session.profile_id, session.created_at, session.id
	loop
		select event.* into v_head
		from public.qorpera_session_events as event
		where event.session_id = v_session.id
		order by event.sequence desc
		limit 1;
		v_has_head := found;

		perform public.qorpera_append_company_operation(
			v_session.profile_id,
			v_session.environment_id,
			'session_state',
			v_session.id,
			case when v_has_head then v_head.sequence else 0 end,
			jsonb_build_object(
				'session_id', v_session.id,
				'client_session_id', v_session.client_session_id,
				'profile_id', v_session.profile_id,
				'environment_id', v_session.environment_id,
				'title', v_session.title,
				'staff_agent_id', v_session.staff_agent_id,
				'parent_session_id', v_session.parent_session_id,
				'status', v_session.status,
				'head_sequence', case when v_has_head then v_head.sequence else 0 end,
				'head_event_hash', case when v_has_head then v_head.event_hash else null end,
				'created_by_user_id', v_session.created_by_user_id,
				'created_at', v_session.created_at,
				'updated_at', v_session.updated_at
			),
			v_session.created_by_user_id
		);

		if v_has_head then
			perform public.qorpera_append_company_operation(
				v_session.profile_id,
				v_session.environment_id,
				'session_event',
				v_session.id,
				v_head.sequence,
				jsonb_build_object(
					'session_id', v_session.id,
					'client_session_id', v_session.client_session_id,
					'sequence', v_head.sequence,
					'event_hash', v_head.event_hash,
					'event_type', v_head.event_type,
					'created_at', v_head.created_at
				),
				v_head.actor_user_id
			);
		end if;
	end loop;
end
$$;

create trigger qorpera_profile_staff_record_operation
	after insert or update
	on public.qorpera_profile_staff
	for each row
	execute function public.qorpera_record_staff_operation();

create trigger qorpera_shared_sessions_record_state_operation
	after insert or update of title, staff_agent_id, parent_session_id, status
	on public.qorpera_shared_sessions
	for each row
	execute function public.qorpera_record_session_state_operation();

create trigger qorpera_session_events_record_operation
	after insert
	on public.qorpera_session_events
	for each row
	execute function public.qorpera_record_session_event_operation();

create table public.qorpera_company_substrate_versions (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	company_snapshot_id uuid not null references public.qorpera_company_snapshots(id) on delete restrict,
	client_version_id uuid not null,
	contract_version integer not null check (contract_version > 0),
	operation_sequence bigint not null check (operation_sequence >= 0),
	operation_count bigint not null check (operation_count >= 0),
	artifact_manifest_sha256 text check (artifact_manifest_sha256 is null or artifact_manifest_sha256 ~ '^[0-9a-f]{64}$'),
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	unique (profile_id, client_version_id)
);

create index qorpera_company_substrate_versions_environment_created
	on public.qorpera_company_substrate_versions (environment_id, created_at desc);

alter table public.qorpera_company_substrate_versions enable row level security;
revoke all on public.qorpera_company_substrate_versions from anon, authenticated;

create function public.qorpera_company_substrate_version_json(
	p_version public.qorpera_company_substrate_versions
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'version_id', p_version.id,
		'profile_id', p_version.profile_id,
		'environment_id', p_version.environment_id,
		'company_snapshot_id', p_version.company_snapshot_id,
		'client_version_id', p_version.client_version_id,
		'contract_version', p_version.contract_version,
		'operation_sequence', p_version.operation_sequence,
		'operation_count', p_version.operation_count,
		'artifact_manifest_sha256', p_version.artifact_manifest_sha256,
		'content_sha256', p_version.content_sha256,
		'created_by_user_id', p_version.created_by_user_id,
		'created_at', p_version.created_at
	)
$$;

revoke all on function public.qorpera_company_substrate_version_json(public.qorpera_company_substrate_versions) from public;

create function public.qorpera_capture_company_substrate_version(
	p_snapshot_id uuid,
	p_client_version_id uuid,
	p_contract_version integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_snapshot public.qorpera_company_snapshots%rowtype;
	v_existing public.qorpera_company_substrate_versions%rowtype;
	v_version public.qorpera_company_substrate_versions%rowtype;
	v_operation_sequence bigint := 0;
	v_operation_count bigint := 0;
	v_content_sha256 text;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_snapshot_id is null or p_client_version_id is null
		or p_contract_version is null or p_contract_version <> 1 then
		raise exception 'company substrate version is invalid' using errcode = '22023';
	end if;

	select snapshot.* into v_snapshot
	from public.qorpera_company_snapshots as snapshot
	where snapshot.id = p_snapshot_id;
	if not found or not public.qorpera_can_write_profile(v_snapshot.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;

	select version.* into v_existing
	from public.qorpera_company_substrate_versions as version
	where version.profile_id = v_snapshot.profile_id
		and version.client_version_id = p_client_version_id;
	if found then
		if v_existing.company_snapshot_id <> p_snapshot_id
			or v_existing.contract_version <> p_contract_version then
			raise exception 'substrate client version id is already bound to different content' using errcode = '23505';
		end if;
		return public.qorpera_company_substrate_version_json(v_existing);
	end if;

	select clock.last_sequence into v_operation_sequence
	from public.qorpera_profile_operation_clocks as clock
	where clock.profile_id = v_snapshot.profile_id;
	v_operation_sequence := coalesce(v_operation_sequence, 0);

	select count(*) into v_operation_count
	from public.qorpera_company_operations as operation
	where operation.profile_id = v_snapshot.profile_id
		and operation.sequence <= v_operation_sequence
		and (operation.environment_id is null or operation.environment_id = v_snapshot.environment_id);

	v_content_sha256 := encode(
		extensions.digest(
			convert_to(
				jsonb_build_object(
					'contract_version', p_contract_version,
					'profile_id', v_snapshot.profile_id,
					'environment_id', v_snapshot.environment_id,
					'company_snapshot_id', p_snapshot_id,
					'operation_sequence', v_operation_sequence,
					'artifact_manifest_sha256', null
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_company_substrate_versions (
		profile_id,
		environment_id,
		company_snapshot_id,
		client_version_id,
		contract_version,
		operation_sequence,
		operation_count,
		content_sha256,
		created_by_user_id
	)
	values (
		v_snapshot.profile_id,
		v_snapshot.environment_id,
		p_snapshot_id,
		p_client_version_id,
		p_contract_version,
		v_operation_sequence,
		v_operation_count,
		v_content_sha256,
		v_user_id
	)
	returning * into v_version;

	return public.qorpera_company_substrate_version_json(v_version);
end
$$;

create function public.qorpera_get_company_substrate_version(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_version public.qorpera_company_substrate_versions%rowtype;
begin
	select version.* into v_version
	from public.qorpera_company_substrate_versions as version
	where version.id = p_version_id;
	if not found or not public.qorpera_can_read_profile(v_version.profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	return public.qorpera_company_substrate_version_json(v_version);
end
$$;

create function public.qorpera_list_company_substrate_operations(
	p_version_id uuid,
	p_after_sequence bigint default 0,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_version public.qorpera_company_substrate_versions%rowtype;
begin
	select version.* into v_version
	from public.qorpera_company_substrate_versions as version
	where version.id = p_version_id;
	if not found or not public.qorpera_can_read_profile(v_version.profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	if p_after_sequence < 0 or p_after_sequence > v_version.operation_sequence
		or p_limit not between 1 and 500 then
		raise exception 'company operation page is invalid' using errcode = '22023';
	end if;

	return coalesce((
		select jsonb_agg(jsonb_build_object(
			'profile_id', operation.profile_id,
			'sequence', operation.sequence,
			'environment_id', operation.environment_id,
			'operation_type', operation.operation_type,
			'entity_id', operation.entity_id,
			'entity_version', operation.entity_version,
			'content_sha256', operation.content_sha256,
			'payload', operation.payload,
			'actor_user_id', operation.actor_user_id,
			'created_at', operation.created_at
		) order by operation.sequence)
		from (
			select source.*
			from public.qorpera_company_operations as source
			where source.profile_id = v_version.profile_id
				and source.sequence > p_after_sequence
				and source.sequence <= v_version.operation_sequence
				and (source.environment_id is null or source.environment_id = v_version.environment_id)
			order by source.sequence
			limit p_limit
		) as operation
	), '[]'::jsonb);
end
$$;

revoke all on function public.qorpera_capture_company_substrate_version(uuid, uuid, integer) from public;
revoke all on function public.qorpera_get_company_substrate_version(uuid) from public;
revoke all on function public.qorpera_list_company_substrate_operations(uuid, bigint, integer) from public;
grant execute on function public.qorpera_capture_company_substrate_version(uuid, uuid, integer) to authenticated;
grant execute on function public.qorpera_get_company_substrate_version(uuid) to authenticated;
grant execute on function public.qorpera_list_company_substrate_operations(uuid, bigint, integer) to authenticated;
