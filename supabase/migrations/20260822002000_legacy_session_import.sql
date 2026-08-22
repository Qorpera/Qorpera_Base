-- One-time transcript imports preserve pre-cloud history without pretending
-- that historical content was produced by a live turn, wake, or runner. The
-- ordinary event append fence remains unchanged; imported events have a
-- separate durable receipt, owner/admin authorization, and a closed import.

create table public.qorpera_legacy_session_imports (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	session_id uuid not null unique references public.qorpera_shared_sessions(id) on delete cascade,
	client_import_id uuid not null,
	source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
	expected_event_count integer not null check (expected_event_count between 1 and 10000),
	imported_event_count integer not null default 0 check (imported_event_count between 0 and expected_event_count),
	status text not null default 'uploading' check (status in ('uploading', 'complete')),
	content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	created_at timestamptz not null default statement_timestamp(),
	completed_at timestamptz,
	unique (profile_id, client_import_id),
	check ((status = 'complete') = (completed_at is not null)),
	check ((status = 'complete') = (content_sha256 is not null)),
	check (status <> 'complete' or imported_event_count = expected_event_count)
);

create table public.qorpera_legacy_session_import_events (
	import_id uuid not null references public.qorpera_legacy_session_imports(id) on delete cascade,
	event_id uuid not null unique references public.qorpera_session_events(event_id) on delete restrict,
	sequence bigint not null check (sequence > 0),
	primary key (import_id, event_id),
	unique (import_id, sequence)
);

alter table public.qorpera_legacy_session_imports enable row level security;
alter table public.qorpera_legacy_session_import_events enable row level security;
revoke all on public.qorpera_legacy_session_imports from public, anon, authenticated;
revoke all on public.qorpera_legacy_session_import_events from public, anon, authenticated;

create function public.qorpera_block_session_inputs_during_legacy_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if exists (
		select 1
		from public.qorpera_legacy_session_imports as legacy_import
		where legacy_import.session_id = new.session_id and legacy_import.status = 'uploading'
	) then
		raise exception 'session transcript import is still uploading' using errcode = '55000';
	end if;
	return new;
end
$$;

create trigger qorpera_block_session_inputs_during_legacy_import
before insert on public.qorpera_session_inputs
for each row execute function public.qorpera_block_session_inputs_during_legacy_import();

revoke all on function public.qorpera_block_session_inputs_during_legacy_import() from public, anon, authenticated;

create function public.qorpera_block_session_execution_during_legacy_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.session_id is not null and exists (
		select 1
		from public.qorpera_legacy_session_imports as legacy_import
		where legacy_import.session_id = new.session_id and legacy_import.status = 'uploading'
	) then
		raise exception 'session transcript import is still uploading' using errcode = '55000';
	end if;
	return new;
end
$$;

create trigger qorpera_block_session_execution_during_legacy_import
before insert on public.qorpera_execution_runs
for each row execute function public.qorpera_block_session_execution_during_legacy_import();

revoke all on function public.qorpera_block_session_execution_during_legacy_import() from public, anon, authenticated;

create function public.qorpera_fence_legacy_session_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_import_id uuid;
begin
	select legacy_import.id into v_import_id
	from public.qorpera_legacy_session_imports as legacy_import
	where legacy_import.session_id = new.session_id and legacy_import.status = 'uploading';
	if found and new.body ->> 'legacyImportId' is distinct from v_import_id::text then
		raise exception 'session transcript import is still uploading' using errcode = '55000';
	end if;
	return new;
end
$$;

create trigger qorpera_fence_legacy_session_import
before insert on public.qorpera_session_events
for each row execute function public.qorpera_fence_legacy_session_import();

revoke all on function public.qorpera_fence_legacy_session_import() from public, anon, authenticated;

create function public.qorpera_block_session_close_during_legacy_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if old.status = 'open' and new.status = 'closed' and exists (
		select 1
		from public.qorpera_legacy_session_imports as legacy_import
		where legacy_import.session_id = new.id and legacy_import.status = 'uploading'
	) then
		raise exception 'session transcript import is still uploading' using errcode = '55000';
	end if;
	return new;
end
$$;

create trigger qorpera_block_session_close_during_legacy_import
before update of status on public.qorpera_shared_sessions
for each row execute function public.qorpera_block_session_close_during_legacy_import();

revoke all on function public.qorpera_block_session_close_during_legacy_import() from public, anon, authenticated;

create function public.qorpera_begin_legacy_session_import(
	p_session_id uuid,
	p_client_import_id uuid,
	p_source_sha256 text,
	p_expected_event_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_session public.qorpera_shared_sessions%rowtype;
	v_import public.qorpera_legacy_session_imports%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_source_sha256 !~ '^[0-9a-f]{64}$' or p_expected_event_count not between 1 and 10000 then
		raise exception 'legacy import contract is invalid' using errcode = '22023';
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_session.profile_id) then
		raise exception 'profile authorization access is required' using errcode = '42501';
	end if;
	if v_session.status <> 'open' then
		raise exception 'session is closed' using errcode = '55000';
	end if;

	select legacy_import.* into v_import
	from public.qorpera_legacy_session_imports as legacy_import
	where legacy_import.session_id = p_session_id
		or (legacy_import.profile_id = v_session.profile_id and legacy_import.client_import_id = p_client_import_id)
	for update;
	if found then
		if v_import.session_id <> p_session_id
			or v_import.client_import_id <> p_client_import_id
			or v_import.source_sha256 <> p_source_sha256
			or v_import.expected_event_count <> p_expected_event_count then
			raise exception 'legacy import identity is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'import_id', v_import.id,
			'profile_id', v_import.profile_id,
			'session_id', v_import.session_id,
			'client_import_id', v_import.client_import_id,
			'source_sha256', v_import.source_sha256,
			'expected_event_count', v_import.expected_event_count,
			'imported_event_count', v_import.imported_event_count,
			'status', v_import.status,
			'content_sha256', v_import.content_sha256,
			'created_by_user_id', v_import.created_by_user_id,
			'created_at', v_import.created_at,
			'completed_at', v_import.completed_at
		);
	end if;

	if exists (select 1 from public.qorpera_session_inputs as input where input.session_id = p_session_id)
		or exists (select 1 from public.qorpera_execution_runs as run where run.session_id = p_session_id)
		or exists (
			select 1
			from public.qorpera_session_events as event
			where event.session_id = p_session_id
				and event.body ->> 'schema' is distinct from 'qorpera.shared-session/v1'
		) then
		raise exception 'legacy import requires a metadata-only session' using errcode = '55000';
	end if;

	insert into public.qorpera_legacy_session_imports (
		profile_id, session_id, client_import_id, source_sha256,
		expected_event_count, created_by_user_id
	) values (
		v_session.profile_id, p_session_id, p_client_import_id, p_source_sha256,
		p_expected_event_count, v_user_id
	)
	returning * into v_import;

	return jsonb_build_object(
		'import_id', v_import.id,
		'profile_id', v_import.profile_id,
		'session_id', v_import.session_id,
		'client_import_id', v_import.client_import_id,
		'source_sha256', v_import.source_sha256,
		'expected_event_count', v_import.expected_event_count,
		'imported_event_count', v_import.imported_event_count,
		'status', v_import.status,
		'content_sha256', v_import.content_sha256,
		'created_by_user_id', v_import.created_by_user_id,
		'created_at', v_import.created_at,
		'completed_at', v_import.completed_at
	);
end
$$;

create function public.qorpera_append_legacy_session_import_event(
	p_import_id uuid,
	p_event_id uuid,
	p_event_type text,
	p_body jsonb,
	p_expected_sequence bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_import public.qorpera_legacy_session_imports%rowtype;
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_existing_import_id uuid;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
	v_entry_type text;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_event_type not in ('message', 'session_info')
		or p_body is null
		or jsonb_typeof(p_body) <> 'object'
		or octet_length(convert_to(p_body::text, 'utf8')) > 262144 then
		raise exception 'legacy import event is invalid or too large' using errcode = '22023';
	end if;

	select legacy_import.* into v_import
	from public.qorpera_legacy_session_imports as legacy_import
	where legacy_import.id = p_import_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_import.profile_id) then
		raise exception 'profile authorization access is required' using errcode = '42501';
	end if;

	select event.* into v_existing
	from public.qorpera_session_events as event
	where event.event_id = p_event_id;
	if found then
		select imported.import_id into v_existing_import_id
		from public.qorpera_legacy_session_import_events as imported
		where imported.event_id = p_event_id;
		if v_existing.session_id <> v_import.session_id
			or v_existing.event_type <> p_event_type
			or v_existing.body <> p_body
			or v_existing_import_id is distinct from p_import_id then
			raise exception 'event id is already bound to different content' using errcode = '23505';
		end if;
		return jsonb_build_object(
			'session_id', v_existing.session_id,
			'sequence', v_existing.sequence,
			'event_id', v_existing.event_id,
			'event_type', v_existing.event_type,
			'actor_user_id', v_existing.actor_user_id,
			'body', v_existing.body,
			'previous_hash', v_existing.previous_hash,
			'event_hash', v_existing.event_hash,
			'execution_kind', v_existing.execution_kind,
			'execution_id', v_existing.execution_id,
			'execution_claimant_id', v_existing.execution_claimant_id,
			'runner_assignment_id', v_existing.runner_assignment_id,
			'session_input_id', v_existing.session_input_id,
			'legacy_import_id', p_import_id,
			'created_at', v_existing.created_at
		);
	end if;

	if v_import.status <> 'uploading' then
		raise exception 'legacy import is already complete' using errcode = '55000';
	end if;
	if v_import.imported_event_count >= v_import.expected_event_count then
		raise exception 'legacy import exceeds its declared event count' using errcode = '54000';
	end if;

	v_entry_type := p_body ->> 'entryType';
	if p_body ->> 'schema' <> 'qorpera.shared-trail-entry-part/v1'
		or p_body ->> 'legacyImportId' <> p_import_id::text
		or not (p_body ?& array[
			'schema', 'legacyImportId', 'entryId', 'entryType',
			'partIndex', 'partCount', 'payloadBase64'
		])
		or (p_body - 'schema' - 'legacyImportId' - 'entryId' - 'entryType' - 'partIndex' - 'partCount' - 'payloadBase64') <> '{}'::jsonb
		or jsonb_typeof(p_body -> 'entryId') <> 'string'
		or char_length(p_body ->> 'entryId') not between 1 and 512
		or jsonb_typeof(p_body -> 'entryType') <> 'string'
		or char_length(v_entry_type) not between 1 and 128
		or jsonb_typeof(p_body -> 'partIndex') <> 'number'
		or (p_body ->> 'partIndex') !~ '^(0|[1-9][0-9]*)$'
		or jsonb_typeof(p_body -> 'partCount') <> 'number'
		or (p_body ->> 'partCount') !~ '^[1-9][0-9]*$'
		or jsonb_typeof(p_body -> 'payloadBase64') <> 'string'
		or char_length(p_body ->> 'payloadBase64') not between 4 and 240000
		or char_length(p_body ->> 'payloadBase64') % 4 <> 0
		or (p_body ->> 'payloadBase64') !~ '^[A-Za-z0-9+/]*={0,2}$'
		or (p_event_type = 'message') <> (v_entry_type = 'message')
		or (p_body ->> 'partIndex')::numeric < 0
		or (p_body ->> 'partCount')::numeric > 128
		or (p_body ->> 'partIndex')::numeric >= (p_body ->> 'partCount')::numeric then
		raise exception 'legacy import event body is invalid' using errcode = '22023';
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = v_import.session_id
	for update;
	if not found or v_session.profile_id <> v_import.profile_id or v_session.status <> 'open' then
		raise exception 'legacy import session is unavailable' using errcode = '55000';
	end if;
	if exists (select 1 from public.qorpera_session_inputs as input where input.session_id = v_session.id)
		or exists (select 1 from public.qorpera_execution_runs as run where run.session_id = v_session.id) then
		raise exception 'legacy import session began executing' using errcode = '55000';
	end if;

	select event.sequence, event.event_hash
	into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = v_session.id
	order by event.sequence desc
	limit 1;
	v_sequence := coalesce(v_sequence, 0);
	if p_expected_sequence is not null and p_expected_sequence <> v_sequence then
		raise exception 'session event sequence changed' using errcode = '40001';
	end if;
	v_sequence := v_sequence + 1;
	v_event_hash := encode(
		extensions.digest(
			convert_to(
				coalesce(v_previous_hash, '') || E'\n' || jsonb_build_object(
					'session_id', v_session.id,
					'sequence', v_sequence,
					'event_id', p_event_id,
					'event_type', p_event_type,
					'actor_user_id', v_user_id,
					'body', p_body,
					'execution_kind', null,
					'execution_id', null,
					'execution_claimant_id', null,
					'legacy_import_id', p_import_id,
					'created_at', v_created_at
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_session_events (
		session_id, sequence, event_id, event_type, actor_user_id, body,
		previous_hash, event_hash, execution_kind, execution_id,
		execution_claimant_id, runner_assignment_id, session_input_id, created_at
	) values (
		v_session.id, v_sequence, p_event_id, p_event_type, v_user_id, p_body,
		v_previous_hash, v_event_hash, null, null, null, null, null, v_created_at
	);
	insert into public.qorpera_legacy_session_import_events (import_id, event_id, sequence)
	values (p_import_id, p_event_id, v_sequence);
	update public.qorpera_legacy_session_imports
	set imported_event_count = imported_event_count + 1
	where id = p_import_id
	returning * into v_import;
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = v_session.id;

	return jsonb_build_object(
		'session_id', v_session.id,
		'sequence', v_sequence,
		'event_id', p_event_id,
		'event_type', p_event_type,
		'actor_user_id', v_user_id,
		'body', p_body,
		'previous_hash', v_previous_hash,
		'event_hash', v_event_hash,
		'execution_kind', null,
		'execution_id', null,
		'execution_claimant_id', null,
		'runner_assignment_id', null,
		'session_input_id', null,
		'legacy_import_id', p_import_id,
		'created_at', v_created_at
	);
end
$$;

create function public.qorpera_complete_legacy_session_import(p_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_import public.qorpera_legacy_session_imports%rowtype;
	v_entry record;
	v_content_sha256 text;
begin
	select legacy_import.* into v_import
	from public.qorpera_legacy_session_imports as legacy_import
	where legacy_import.id = p_import_id
	for update;
	if not found or not public.qorpera_can_authorize_profile(v_import.profile_id) then
		raise exception 'profile authorization access is required' using errcode = '42501';
	end if;
	if v_import.status = 'complete' then
		return jsonb_build_object(
			'import_id', v_import.id,
			'profile_id', v_import.profile_id,
			'session_id', v_import.session_id,
			'client_import_id', v_import.client_import_id,
			'source_sha256', v_import.source_sha256,
			'expected_event_count', v_import.expected_event_count,
			'imported_event_count', v_import.imported_event_count,
			'status', v_import.status,
			'content_sha256', v_import.content_sha256,
			'created_by_user_id', v_import.created_by_user_id,
			'created_at', v_import.created_at,
			'completed_at', v_import.completed_at
		);
	end if;
	if v_import.imported_event_count <> v_import.expected_event_count then
		raise exception 'legacy import event count is incomplete' using errcode = '55000';
	end if;

	for v_entry in
		select
			event.body ->> 'entryId' as entry_id,
			min(event.body ->> 'entryType') as entry_type,
			count(*)::integer as received_parts,
			count(distinct event.body ->> 'entryType')::integer as entry_type_count,
			count(distinct (event.body ->> 'partCount')::integer)::integer as part_count_variants,
			min((event.body ->> 'partCount')::integer) as part_count,
			count(distinct (event.body ->> 'partIndex')::integer)::integer as distinct_part_count,
			min((event.body ->> 'partIndex')::integer) as first_part,
			max((event.body ->> 'partIndex')::integer) as last_part,
			convert_from(
				string_agg(
					decode(event.body ->> 'payloadBase64', 'base64'),
					''::bytea order by (event.body ->> 'partIndex')::integer
				),
				'utf8'
			)::jsonb as entry
		from public.qorpera_legacy_session_import_events as imported
		join public.qorpera_session_events as event on event.event_id = imported.event_id
		where imported.import_id = p_import_id
		group by event.body ->> 'entryId'
	loop
		if v_entry.entry_type_count <> 1
			or v_entry.part_count_variants <> 1
			or v_entry.received_parts <> v_entry.part_count
			or v_entry.distinct_part_count <> v_entry.part_count
			or v_entry.first_part <> 0
			or v_entry.last_part <> v_entry.part_count - 1
			or jsonb_typeof(v_entry.entry) <> 'object'
			or v_entry.entry ->> 'id' <> v_entry.entry_id
			or v_entry.entry ->> 'type' <> v_entry.entry_type
			or jsonb_typeof(v_entry.entry -> 'parentId') not in ('null', 'string')
			or jsonb_typeof(v_entry.entry -> 'timestamp') <> 'string'
			or v_entry.entry ? 'execution' then
			raise exception 'legacy import transcript closure is invalid' using errcode = '22023';
		end if;
	end loop;

	select encode(
		extensions.digest(
			convert_to(string_agg(event.event_hash, E'\n' order by event.sequence), 'utf8'),
			'sha256'
		),
		'hex'
	) into v_content_sha256
	from public.qorpera_legacy_session_import_events as imported
	join public.qorpera_session_events as event on event.event_id = imported.event_id
	where imported.import_id = p_import_id;
	if v_content_sha256 is null then
		raise exception 'legacy import transcript closure is empty' using errcode = '22023';
	end if;

	update public.qorpera_legacy_session_imports
	set status = 'complete', content_sha256 = v_content_sha256, completed_at = statement_timestamp()
	where id = p_import_id
	returning * into v_import;

	return jsonb_build_object(
		'import_id', v_import.id,
		'profile_id', v_import.profile_id,
		'session_id', v_import.session_id,
		'client_import_id', v_import.client_import_id,
		'source_sha256', v_import.source_sha256,
		'expected_event_count', v_import.expected_event_count,
		'imported_event_count', v_import.imported_event_count,
		'status', v_import.status,
		'content_sha256', v_import.content_sha256,
		'created_by_user_id', v_import.created_by_user_id,
		'created_at', v_import.created_at,
		'completed_at', v_import.completed_at
	);
end
$$;

create or replace function public.qorpera_read_session_events(
	p_session_id uuid,
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
	v_profile_id uuid;
begin
	v_profile_id := public.qorpera_session_profile_id(p_session_id);
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	if p_after_sequence < 0 or p_limit not between 1 and 500 then
		raise exception 'event page is invalid' using errcode = '22023';
	end if;
	return coalesce(
		(
			select jsonb_agg(
				jsonb_build_object(
					'session_id', event.session_id,
					'sequence', event.sequence,
					'event_id', event.event_id,
					'event_type', event.event_type,
					'actor_user_id', event.actor_user_id,
					'body', event.body,
					'previous_hash', event.previous_hash,
					'event_hash', event.event_hash,
					'execution_kind', event.execution_kind,
					'execution_id', event.execution_id,
					'execution_claimant_id', event.execution_claimant_id,
					'runner_assignment_id', event.runner_assignment_id,
					'session_input_id', event.session_input_id,
					'legacy_import_id', event.legacy_import_id,
					'created_at', event.created_at
				)
				order by event.sequence
			)
			from (
				select source.*, imported.import_id as legacy_import_id
				from public.qorpera_session_events as source
				left join public.qorpera_legacy_session_import_events as imported on imported.event_id = source.event_id
				where source.session_id = p_session_id and source.sequence > p_after_sequence
				order by source.sequence
				limit p_limit
			) as event
		),
		'[]'::jsonb
	);
end
$$;

revoke all on function public.qorpera_begin_legacy_session_import(uuid, uuid, text, integer) from public, anon;
revoke all on function public.qorpera_append_legacy_session_import_event(uuid, uuid, text, jsonb, bigint) from public, anon;
revoke all on function public.qorpera_complete_legacy_session_import(uuid) from public, anon;
grant execute on function public.qorpera_begin_legacy_session_import(uuid, uuid, text, integer) to authenticated;
grant execute on function public.qorpera_append_legacy_session_import_event(uuid, uuid, text, jsonb, bigint) to authenticated;
grant execute on function public.qorpera_complete_legacy_session_import(uuid) to authenticated;
