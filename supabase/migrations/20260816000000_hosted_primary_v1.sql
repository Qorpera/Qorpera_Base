-- Qorpera hosted-primary v1
--
-- This migration establishes the shared control-plane boundary only:
-- profile membership, stable environment/session identities, and the
-- append-only account-authored event stream. Agent/kernel events and object
-- payload materialization use separate capability-bearing service paths and
-- are intentionally not writable through these account RPCs.

create extension if not exists pgcrypto with schema extensions;

create type public.qorpera_profile_role as enum ('owner', 'admin', 'contributor', 'viewer');
create type public.qorpera_session_status as enum ('open', 'closed');

create table public.qorpera_profiles (
	id uuid primary key default extensions.gen_random_uuid(),
	name text not null check (char_length(btrim(name)) between 1 and 120),
	created_by_user_id uuid not null references auth.users(id) on delete cascade,
	created_at timestamptz not null default statement_timestamp()
);

create table public.qorpera_profile_members (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	email text not null check (email = lower(email) and char_length(email) between 3 and 320),
	display_name text not null check (char_length(btrim(display_name)) between 1 and 256),
	avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
	role public.qorpera_profile_role not null,
	joined_at timestamptz not null default statement_timestamp(),
	primary key (profile_id, user_id)
);

create unique index qorpera_profile_one_owner
	on public.qorpera_profile_members (profile_id)
	where role = 'owner';

create table public.qorpera_profile_invitations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	email text not null check (email = lower(email) and char_length(email) between 3 and 320),
	role public.qorpera_profile_role not null check (role <> 'owner'),
	invited_by_user_id uuid not null references auth.users(id) on delete cascade,
	created_at timestamptz not null default statement_timestamp(),
	expires_at timestamptz not null,
	unique (profile_id, email)
);

create table public.qorpera_company_environments (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	name text not null check (char_length(btrim(name)) between 1 and 120),
	contract_version integer not null check (contract_version > 0),
	created_by_user_id uuid not null references auth.users(id) on delete cascade,
	created_at timestamptz not null default statement_timestamp()
);

create table public.qorpera_shared_sessions (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	title text not null check (char_length(btrim(title)) between 1 and 256),
	staff_agent_id text check (staff_agent_id is null or char_length(staff_agent_id) between 1 and 128),
	parent_session_id uuid references public.qorpera_shared_sessions(id) on delete set null,
	status public.qorpera_session_status not null default 'open',
	created_by_user_id uuid not null references auth.users(id) on delete cascade,
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp()
);

create index qorpera_shared_sessions_environment_updated
	on public.qorpera_shared_sessions (environment_id, updated_at desc);

create table public.qorpera_session_events (
	session_id uuid not null references public.qorpera_shared_sessions(id) on delete cascade,
	sequence bigint not null check (sequence > 0),
	event_id uuid not null unique,
	event_type text not null check (
		event_type in (
			'message',
			'session_info',
			'run_receipt',
			'artifact_receipt',
			'authorization_request',
			'authorization_decision'
		)
	),
	actor_user_id uuid not null references auth.users(id) on delete restrict,
	body jsonb not null,
	previous_hash text check (previous_hash is null or previous_hash ~ '^[0-9a-f]{64}$'),
	event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null,
	primary key (session_id, sequence)
);

alter table public.qorpera_profiles enable row level security;
alter table public.qorpera_profile_members enable row level security;
alter table public.qorpera_profile_invitations enable row level security;
alter table public.qorpera_company_environments enable row level security;
alter table public.qorpera_shared_sessions enable row level security;
alter table public.qorpera_session_events enable row level security;

create function public.qorpera_member_role(p_profile_id uuid)
returns public.qorpera_profile_role
language sql
stable
security definer
set search_path = ''
as $$
	select member.role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id
		and member.user_id = auth.uid()
$$;

create function public.qorpera_can_read_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_member_role(p_profile_id) is not null
$$;

create function public.qorpera_can_write_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(public.qorpera_member_role(p_profile_id) in ('owner', 'admin', 'contributor'), false)
$$;

create function public.qorpera_can_authorize_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(public.qorpera_member_role(p_profile_id) in ('owner', 'admin'), false)
$$;

create function public.qorpera_session_profile_id(p_session_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
	select session.profile_id
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
$$;

create policy qorpera_profiles_member_read
	on public.qorpera_profiles for select
	to authenticated
	using (public.qorpera_can_read_profile(id));

create policy qorpera_profile_members_member_read
	on public.qorpera_profile_members for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

create policy qorpera_profile_invitations_manager_read
	on public.qorpera_profile_invitations for select
	to authenticated
	using (public.qorpera_can_authorize_profile(profile_id));

create policy qorpera_environments_member_read
	on public.qorpera_company_environments for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

create policy qorpera_sessions_member_read
	on public.qorpera_shared_sessions for select
	to authenticated
	using (public.qorpera_can_read_profile(profile_id));

create policy qorpera_session_events_member_read
	on public.qorpera_session_events for select
	to authenticated
	using (public.qorpera_can_read_profile(public.qorpera_session_profile_id(session_id)));

create function public.qorpera_create_hosted_profile(
	p_profile_name text,
	p_environment_name text,
	p_contract_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
	v_metadata jsonb := coalesce(auth.jwt() -> 'user_metadata', '{}'::jsonb);
	v_display_name text;
	v_avatar_url text;
	v_profile public.qorpera_profiles%rowtype;
	v_environment public.qorpera_company_environments%rowtype;
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if char_length(btrim(p_profile_name)) not between 1 and 120 then
		raise exception 'profile name is invalid' using errcode = '22023';
	end if;
	if char_length(btrim(p_environment_name)) not between 1 and 120 then
		raise exception 'environment name is invalid' using errcode = '22023';
	end if;
	if p_contract_version is null or p_contract_version < 1 then
		raise exception 'environment contract version is invalid' using errcode = '22023';
	end if;
	if v_email = '' then
		raise exception 'account email is unavailable' using errcode = '22023';
	end if;
	v_display_name := coalesce(
		nullif(btrim(v_metadata ->> 'full_name'), ''),
		nullif(btrim(v_metadata ->> 'name'), ''),
		nullif(btrim(v_metadata ->> 'user_name'), ''),
		split_part(v_email, '@', 1)
	);
	v_avatar_url := nullif(coalesce(v_metadata ->> 'avatar_url', v_metadata ->> 'picture'), '');

	insert into public.qorpera_profiles (name, created_by_user_id)
	values (btrim(p_profile_name), v_user_id)
	returning * into v_profile;

	insert into public.qorpera_profile_members (
		profile_id,
		user_id,
		email,
		display_name,
		avatar_url,
		role
	)
	values (v_profile.id, v_user_id, v_email, left(v_display_name, 256), left(v_avatar_url, 2048), 'owner');

	insert into public.qorpera_company_environments (
		profile_id,
		name,
		contract_version,
		created_by_user_id
	)
	values (v_profile.id, btrim(p_environment_name), p_contract_version, v_user_id)
	returning * into v_environment;

	return jsonb_build_object(
		'profile_id', v_profile.id,
		'environment_id', v_environment.id,
		'profile_name', v_profile.name,
		'environment_name', v_environment.name,
		'role', 'owner',
		'contract_version', v_environment.contract_version,
		'created_at', v_profile.created_at
	);
end
$$;

create function public.qorpera_list_hosted_profiles()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(
		jsonb_agg(
			jsonb_build_object(
				'profile_id', profile.id,
				'environment_id', environment.id,
				'profile_name', profile.name,
				'environment_name', environment.name,
				'role', member.role,
				'contract_version', environment.contract_version,
				'created_at', profile.created_at
			)
			order by profile.created_at, environment.created_at
		),
		'[]'::jsonb
	)
	from public.qorpera_profile_members as member
	join public.qorpera_profiles as profile on profile.id = member.profile_id
	join public.qorpera_company_environments as environment on environment.profile_id = profile.id
	where member.user_id = auth.uid()
$$;

create function public.qorpera_invite_profile_member(
	p_profile_id uuid,
	p_email text,
	p_role public.qorpera_profile_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_email text := lower(btrim(p_email));
	v_invitation public.qorpera_profile_invitations%rowtype;
begin
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if p_role = 'owner' or p_role is null then
		raise exception 'owner invitations are not permitted' using errcode = '22023';
	end if;
	if v_actor_role = 'admin' and p_role = 'admin' then
		raise exception 'only the owner can grant full access' using errcode = '42501';
	end if;
	if char_length(v_email) not between 3 and 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
		raise exception 'email is invalid' using errcode = '22023';
	end if;
	if exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.email = v_email
	) then
		raise exception 'this account already has access' using errcode = '23505';
	end if;
	delete from public.qorpera_profile_invitations
	where profile_id = p_profile_id and expires_at <= statement_timestamp();

	insert into public.qorpera_profile_invitations (
		profile_id,
		email,
		role,
		invited_by_user_id,
		expires_at
	)
	values (p_profile_id, v_email, p_role, v_actor_id, statement_timestamp() + interval '14 days')
	returning * into v_invitation;

	return jsonb_build_object(
		'id', v_invitation.id,
		'profile_id', v_invitation.profile_id,
		'email', v_invitation.email,
		'role', v_invitation.role,
		'invited_by_user_id', v_invitation.invited_by_user_id,
		'created_at', v_invitation.created_at,
		'expires_at', v_invitation.expires_at
	);
end
$$;

create function public.qorpera_accept_profile_invitations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
	v_metadata jsonb := coalesce(auth.jwt() -> 'user_metadata', '{}'::jsonb);
	v_display_name text;
	v_avatar_url text;
	v_invitation public.qorpera_profile_invitations%rowtype;
	v_count integer := 0;
begin
	if v_user_id is null or v_email = '' then
		raise exception 'authenticated account email is required' using errcode = '42501';
	end if;
	v_display_name := coalesce(
		nullif(btrim(v_metadata ->> 'full_name'), ''),
		nullif(btrim(v_metadata ->> 'name'), ''),
		nullif(btrim(v_metadata ->> 'user_name'), ''),
		split_part(v_email, '@', 1)
	);
	v_avatar_url := nullif(coalesce(v_metadata ->> 'avatar_url', v_metadata ->> 'picture'), '');

	for v_invitation in
		select invitation.*
		from public.qorpera_profile_invitations as invitation
		where invitation.email = v_email
			and invitation.expires_at > statement_timestamp()
		order by invitation.created_at
		for update
	loop
		insert into public.qorpera_profile_members (
			profile_id,
			user_id,
			email,
			display_name,
			avatar_url,
			role
		)
		values (
			v_invitation.profile_id,
			v_user_id,
			v_email,
			left(v_display_name, 256),
			left(v_avatar_url, 2048),
			v_invitation.role
		)
		on conflict (profile_id, user_id) do update
		set email = excluded.email,
			display_name = excluded.display_name,
			avatar_url = excluded.avatar_url;

		delete from public.qorpera_profile_invitations where id = v_invitation.id;
		v_count := v_count + 1;
	end loop;

	return to_jsonb(v_count);
end
$$;

create function public.qorpera_create_shared_session(
	p_environment_id uuid,
	p_title text,
	p_staff_agent_id text default null,
	p_parent_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype;
begin
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023';
	end if;
	if p_staff_agent_id is not null and char_length(p_staff_agent_id) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023';
	end if;
	if p_parent_session_id is not null and not exists (
		select 1 from public.qorpera_shared_sessions as parent
		where parent.id = p_parent_session_id and parent.environment_id = p_environment_id
	) then
		raise exception 'parent session is outside the environment' using errcode = '22023';
	end if;

	insert into public.qorpera_shared_sessions (
		profile_id,
		environment_id,
		title,
		staff_agent_id,
		parent_session_id,
		created_by_user_id
	)
	values (
		v_profile_id,
		p_environment_id,
		btrim(p_title),
		nullif(btrim(p_staff_agent_id), ''),
		p_parent_session_id,
		v_user_id
	)
	returning * into v_session;

	return jsonb_build_object(
		'session_id', v_session.id,
		'profile_id', v_session.profile_id,
		'environment_id', v_session.environment_id,
		'title', v_session.title,
		'staff_agent_id', v_session.staff_agent_id,
		'parent_session_id', v_session.parent_session_id,
		'status', v_session.status,
		'created_by_user_id', v_session.created_by_user_id,
		'created_at', v_session.created_at,
		'updated_at', v_session.updated_at
	);
end
$$;

create function public.qorpera_list_shared_sessions(p_environment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce(
		(
			select case
				when not public.qorpera_can_read_profile(environment.profile_id) then '[]'::jsonb
				else coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'session_id', session.id,
								'profile_id', session.profile_id,
								'environment_id', session.environment_id,
								'title', session.title,
								'staff_agent_id', session.staff_agent_id,
								'parent_session_id', session.parent_session_id,
								'status', session.status,
								'created_by_user_id', session.created_by_user_id,
								'created_at', session.created_at,
								'updated_at', session.updated_at
							)
							order by session.updated_at desc
						)
						from public.qorpera_shared_sessions as session
						where session.environment_id = p_environment_id
					),
					'[]'::jsonb
				)
			end
			from public.qorpera_company_environments as environment
			where environment.id = p_environment_id
		),
		'[]'::jsonb
	)
$$;

create function public.qorpera_append_account_event(
	p_session_id uuid,
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
	v_session public.qorpera_shared_sessions%rowtype;
	v_existing public.qorpera_session_events%rowtype;
	v_sequence bigint := 0;
	v_previous_hash text;
	v_event_hash text;
	v_created_at timestamptz := statement_timestamp();
begin
	if v_user_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_event_type not in (
		'message',
		'session_info',
		'run_receipt',
		'artifact_receipt',
		'authorization_request',
		'authorization_decision'
	) then
		raise exception 'session event type is invalid' using errcode = '22023';
	end if;
	if p_body is null or octet_length(convert_to(p_body::text, 'utf8')) > 262144 then
		raise exception 'session event body is invalid or too large' using errcode = '22023';
	end if;

	select event.* into v_existing
	from public.qorpera_session_events as event
	where event.event_id = p_event_id;
	if found then
		if v_existing.session_id <> p_session_id
			or v_existing.event_type <> p_event_type
			or v_existing.actor_user_id <> v_user_id
			or v_existing.body <> p_body then
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
			'created_at', v_existing.created_at
		);
	end if;

	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;
	if not found or not public.qorpera_can_write_profile(v_session.profile_id) then
		raise exception 'profile write access is required' using errcode = '42501';
	end if;
	if v_session.status <> 'open' then
		raise exception 'session is closed' using errcode = '55000';
	end if;
	if p_event_type = 'authorization_decision' and not public.qorpera_can_authorize_profile(v_session.profile_id) then
		raise exception 'authorization requires full access' using errcode = '42501';
	end if;

	select event.sequence, event.event_hash
	into v_sequence, v_previous_hash
	from public.qorpera_session_events as event
	where event.session_id = p_session_id
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
					'session_id', p_session_id,
					'sequence', v_sequence,
					'event_id', p_event_id,
					'event_type', p_event_type,
					'actor_user_id', v_user_id,
					'body', p_body,
					'created_at', v_created_at
				)::text,
				'utf8'
			),
			'sha256'
		),
		'hex'
	);

	insert into public.qorpera_session_events (
		session_id,
		sequence,
		event_id,
		event_type,
		actor_user_id,
		body,
		previous_hash,
		event_hash,
		created_at
	)
	values (
		p_session_id,
		v_sequence,
		p_event_id,
		p_event_type,
		v_user_id,
		p_body,
		v_previous_hash,
		v_event_hash,
		v_created_at
	);
	update public.qorpera_shared_sessions set updated_at = v_created_at where id = p_session_id;

	return jsonb_build_object(
		'session_id', p_session_id,
		'sequence', v_sequence,
		'event_id', p_event_id,
		'event_type', p_event_type,
		'actor_user_id', v_user_id,
		'body', p_body,
		'previous_hash', v_previous_hash,
		'event_hash', v_event_hash,
		'created_at', v_created_at
	);
end
$$;

create function public.qorpera_read_session_events(
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
					'created_at', event.created_at
				)
				order by event.sequence
			)
			from (
				select source.*
				from public.qorpera_session_events as source
				where source.session_id = p_session_id and source.sequence > p_after_sequence
				order by source.sequence
				limit p_limit
			) as event
		),
		'[]'::jsonb
	);
end
$$;

revoke all on public.qorpera_profiles from anon, authenticated;
revoke all on public.qorpera_profile_members from anon, authenticated;
revoke all on public.qorpera_profile_invitations from anon, authenticated;
revoke all on public.qorpera_company_environments from anon, authenticated;
revoke all on public.qorpera_shared_sessions from anon, authenticated;
revoke all on public.qorpera_session_events from anon, authenticated;

grant select on public.qorpera_profiles to authenticated;
grant select on public.qorpera_profile_members to authenticated;
grant select on public.qorpera_profile_invitations to authenticated;
grant select on public.qorpera_company_environments to authenticated;
grant select on public.qorpera_shared_sessions to authenticated;
grant select on public.qorpera_session_events to authenticated;

revoke all on function public.qorpera_member_role(uuid) from public;
revoke all on function public.qorpera_can_read_profile(uuid) from public;
revoke all on function public.qorpera_can_write_profile(uuid) from public;
revoke all on function public.qorpera_can_authorize_profile(uuid) from public;
revoke all on function public.qorpera_session_profile_id(uuid) from public;
revoke all on function public.qorpera_create_hosted_profile(text, text, integer) from public;
revoke all on function public.qorpera_list_hosted_profiles() from public;
revoke all on function public.qorpera_invite_profile_member(uuid, text, public.qorpera_profile_role) from public;
revoke all on function public.qorpera_accept_profile_invitations() from public;
revoke all on function public.qorpera_create_shared_session(uuid, text, text, uuid) from public;
revoke all on function public.qorpera_list_shared_sessions(uuid) from public;
revoke all on function public.qorpera_append_account_event(uuid, uuid, text, jsonb, bigint) from public;
revoke all on function public.qorpera_read_session_events(uuid, bigint, integer) from public;

grant execute on function public.qorpera_member_role(uuid) to authenticated;
grant execute on function public.qorpera_can_read_profile(uuid) to authenticated;
grant execute on function public.qorpera_can_write_profile(uuid) to authenticated;
grant execute on function public.qorpera_can_authorize_profile(uuid) to authenticated;
grant execute on function public.qorpera_session_profile_id(uuid) to authenticated;
grant execute on function public.qorpera_create_hosted_profile(text, text, integer) to authenticated;
grant execute on function public.qorpera_list_hosted_profiles() to authenticated;
grant execute on function public.qorpera_invite_profile_member(uuid, text, public.qorpera_profile_role) to authenticated;
grant execute on function public.qorpera_accept_profile_invitations() to authenticated;
grant execute on function public.qorpera_create_shared_session(uuid, text, text, uuid) to authenticated;
grant execute on function public.qorpera_list_shared_sessions(uuid) to authenticated;
grant execute on function public.qorpera_append_account_event(uuid, uuid, text, jsonb, bigint) to authenticated;
grant execute on function public.qorpera_read_session_events(uuid, bigint, integer) to authenticated;
