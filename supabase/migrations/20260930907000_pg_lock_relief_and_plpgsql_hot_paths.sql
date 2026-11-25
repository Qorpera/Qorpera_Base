set local lock_timeout = '3s';

create function pg_temp.w4_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930907000 anchor differs in %: %', p_function, left(p_old, 80);
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- WHY: Downgrade read-only provider connection version locks from FOR UPDATE to FOR SHARE (connections stay FOR UPDATE as the max_concurrent_runs mutex).
select pg_temp.w4_replace(
	'public.qorpera_folder_materialize_company(uuid,integer)',
	'order by version.connection_id, version.version for update;',
	'order by version.connection_id, version.version for share;'
);

select pg_temp.w4_replace(
	'public.qorpera_reserve_execution_sponsor_authority(uuid)',
	$old$	select version.* into v_connection_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_sponsor.provider_connection_id
		and version.version = v_sponsor.provider_connection_version
	for update;$old$,
	$new$	select version.* into v_connection_version
	from public.qorpera_provider_connection_versions as version
	where version.connection_id = v_sponsor.provider_connection_id
		and version.version = v_sponsor.provider_connection_version
	for share;$new$
);

-- WHY: PG 17 does not cache plans for non-inlinable LANGUAGE sql SECURITY DEFINER helpers; converting hot helpers to PL/pgSQL caches plans per session.
create temporary table w4_plpgsql_before as
select p.oid, p.proname::text as name, l.lanname::text as language, p.provolatile, p.prosecdef, p.proisstrict,
	p.proleakproof, p.proparallel, p.procost, p.proconfig, p.proowner, p.proacl, p.prorettype
from pg_proc p join pg_language l on l.oid = p.prolang
where p.oid in (
	'public.qorpera_run_member_waits(public.qorpera_execution_runs)'::regprocedure,
	'public.qorpera_member_folder_object(uuid,text)'::regprocedure,
	'public.qorpera_folder_object_readable(uuid,uuid,jsonb,text)'::regprocedure,
	'public.qorpera_folder_caller_allowed(jsonb)'::regprocedure,
	'public.qorpera_company_founding_seated(uuid)'::regprocedure,
	'public.qorpera_folder_company_ready(uuid)'::regprocedure,
	'public.qorpera_list_company_foundings()'::regprocedure,
	'public.qorpera_company_founding_open(uuid)'::regprocedure
);

do $$
begin
	if (select count(*) from pg_temp.w4_plpgsql_before) <> 8
		or exists (select 1 from pg_temp.w4_plpgsql_before where language <> 'sql') then
		raise exception '20260930907000: hot SQL helper inventory differs from expected 8 sql functions';
	end if;
end $$;

create or replace function public.qorpera_run_member_waits(p_run public.qorpera_execution_runs)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	-- WHY: Preserve 20260930602000 deploy marker while caching plan in PL/pgSQL.
	return case p_run.source_kind
		when 'room_delivery' then true
		when 'session_turn' then not (
			exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind = 'kickoff')
			and not exists (select 1 from public.qorpera_session_inputs input
				where input.id = any(p_run.input_ids) and input.kind is distinct from 'kickoff'))
		else false end;
end $$;

create or replace function public.qorpera_member_folder_object(p_environment_id uuid, p_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_folder_authorize_object_download(
		p_environment_id,
		public.qorpera_member_folder_actor(p_environment_id),
		p_sha256
	) - array['authoritySeq', 'checkedAt', 'viaActive'];
end $$;

create or replace function public.qorpera_folder_object_readable(
	p_environment_id uuid,
	p_profile_id uuid,
	p_auth jsonb,
	p_sha256 text
)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_folder_object_readable_state(p_environment_id, p_profile_id, p_auth, p_sha256) <> 'none';
end $$;

create or replace function public.qorpera_folder_caller_allowed(p_actor jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	-- WHY: Preserve C4 P27a (20260930013000) marker while caching plan in PL/pgSQL.
	return coalesce(auth.role() = 'service_role'
		or (auth.role() = 'authenticated' and auth.uid() is not null
			and p_actor = jsonb_build_object('kind', 'member', 'userId', auth.uid()::text)), false);
end $$;

create or replace function public.qorpera_company_founding_seated(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return auth.uid() is not null
		and not exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = p_profile_id)
		and exists (select 1 from public.qorpera_company_founder_seats seat
			join public.qorpera_company_foundings founding using (profile_id)
			where seat.profile_id = p_profile_id and seat.user_id = auth.uid()
				and (founding.phase = 'open' or exists (select 1 from public.qorpera_profile_members member
					where member.profile_id = p_profile_id and member.user_id = auth.uid())));
end $$;

create or replace function public.qorpera_folder_company_ready(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	-- WHY: Preserve 20260930010000 (P14a), 20260930022000 (P15) markers while caching plan in PL/pgSQL.
	return exists (select 1 from public.qorpera_folder_company_creations as creation
		join public.qorpera_folder_follow_ups as work on work.environment_id = creation.environment_id
			and work.subject_kind = 'agent' and work.subject_id = creation.cofounder_id
		where creation.profile_id = p_profile_id and creation.state = 'completed'
			and not work.dirty and work.converged_at is not null
			and not exists (select 1 from public.qorpera_folder_follow_up_marks as mark
				where mark.environment_id = creation.environment_id and mark.subject_kind = 'agent'
					and mark.subject_id = creation.cofounder_id));
end $$;

create or replace function public.qorpera_list_company_foundings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
	select coalesce(jsonb_agg(jsonb_build_object('profileId', founding.profile_id, 'companyName', profile.name,
		'phase', founding.phase, 'myState', seat.state,
		'invitedByDisplayName', left(public.qorpera_account_display_name(inviter.raw_user_meta_data), 160),
		'joined', (select count(*) from public.qorpera_company_founder_seats other
			where other.profile_id = founding.profile_id and other.state = 'joined'))
		order by founding.created_at, founding.profile_id), '[]'::jsonb)
	into v_result
	from public.qorpera_company_founder_seats seat
	join public.qorpera_company_foundings founding on founding.profile_id = seat.profile_id
	join public.qorpera_profiles profile on profile.id = seat.profile_id
	left join auth.users inviter on inviter.id = seat.invited_by_user_id
	where seat.user_id = auth.uid() and public.qorpera_current_email_verified()
		and not exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = founding.profile_id)
		and (founding.phase = 'open' or (seat.state = 'joined'
			and exists (select 1 from public.qorpera_profile_members member
				where member.profile_id = founding.profile_id and member.user_id = auth.uid())
			and not public.qorpera_folder_company_ready(founding.profile_id)));
	return v_result;
end $$;

create or replace function public.qorpera_company_founding_open(p_profile_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	return exists (select 1 from public.qorpera_company_foundings where profile_id = p_profile_id and phase = 'open');
end $$;

do $$
begin
	if exists (select 1 from pg_temp.w4_plpgsql_before b join pg_proc p on p.oid = b.oid join pg_language l on l.oid = p.prolang
		where l.lanname <> 'plpgsql' or p.provolatile <> b.provolatile or p.prosecdef <> b.prosecdef or not p.prosecdef
			or p.proisstrict <> b.proisstrict or p.proleakproof <> b.proleakproof or p.proparallel <> b.proparallel
			or p.procost <> b.procost or p.proconfig is distinct from b.proconfig
			or p.proconfig is distinct from array['search_path=""'] or p.proowner <> b.proowner
			or p.proacl is distinct from b.proacl or p.prorettype <> b.prorettype) then
		raise exception '20260930907000: a converted helper changed more than its language';
	end if;
end $$;

drop table pg_temp.w4_plpgsql_before;

-- WHY: Allow member download fence wrapper to reuse qorpera_folder_download_fence via the caller's own member actor while keeping direct execute service_role-only.
select pg_temp.w4_replace(
	'public.qorpera_folder_download_fence(uuid,jsonb,text,bigint,timestamptz,boolean)',
	$old$if auth.role() is distinct from 'service_role' then$old$,
	$new$if not public.qorpera_folder_caller_allowed(p_actor) then$new$
);

-- WHY: Expose fence-capable member object download RPCs so object-gateway eliminates the duplicate post-NAS full readability scan without weakening revocation checks.
create or replace function public.qorpera_member_folder_object_authorize(p_environment_id uuid, p_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_folder_authorize_object_download(
		p_environment_id,
		public.qorpera_member_folder_actor(p_environment_id),
		p_sha256
	);
end $$;

revoke all on function public.qorpera_member_folder_object_authorize(uuid, text)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_folder_object_authorize(uuid, text)
	to authenticated;

create or replace function public.qorpera_member_folder_object_fence(
	p_environment_id uuid,
	p_sha256 text,
	p_authority_seq bigint,
	p_checked_at timestamptz,
	p_via_active boolean
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	return public.qorpera_folder_download_fence(
		p_environment_id,
		public.qorpera_member_folder_actor(p_environment_id),
		p_sha256,
		p_authority_seq,
		p_checked_at,
		p_via_active
	);
end $$;

revoke all on function public.qorpera_member_folder_object_fence(uuid, text, bigint, timestamptz, boolean)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_folder_object_fence(uuid, text, bigint, timestamptz, boolean)
	to authenticated;
