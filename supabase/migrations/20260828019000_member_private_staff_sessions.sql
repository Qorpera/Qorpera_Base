-- Member-private attended conversations. A company can have one shared staff
-- identity (notably the Co-Founder) without making each member's conversation
-- company-readable. Operational trails remain company-scoped and keep their
-- existing execution authority.

alter table public.qorpera_shared_sessions
	add column audience_kind text not null default 'company'
		check (audience_kind in ('company','member_private')),
	add column audience_user_id uuid;

alter table public.qorpera_shared_sessions
	add constraint qorpera_shared_sessions_member_private_audience
		check ((audience_kind = 'member_private') = (audience_user_id is not null)),
	add constraint qorpera_shared_sessions_audience_member
		foreign key (profile_id,audience_user_id)
		references public.qorpera_profile_members(profile_id,user_id) on delete cascade;

drop index public.qorpera_shared_sessions_one_open_per_staff;
create unique index qorpera_shared_sessions_one_open_company_per_staff
	on public.qorpera_shared_sessions(profile_id,staff_agent_id)
	where status = 'open' and staff_agent_id is not null and audience_kind = 'company'
		and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);
create unique index qorpera_shared_sessions_one_open_member_private_per_staff
	on public.qorpera_shared_sessions(profile_id,staff_agent_id,audience_user_id)
	where status = 'open' and staff_agent_id is not null and audience_kind = 'member_private'
		and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);

create function public.qorpera_can_read_session(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.qorpera_shared_sessions session
		join public.qorpera_profile_members member on member.profile_id = session.profile_id
			and member.user_id = auth.uid()
		where session.id = p_session_id and (
			session.audience_kind = 'company'
			or (session.audience_kind = 'member_private' and session.audience_user_id = auth.uid())
		)
	)
$$;

create function public.qorpera_can_write_session(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.qorpera_shared_sessions session
		join public.qorpera_profile_members member on member.profile_id = session.profile_id
			and member.user_id = auth.uid() and member.role in ('owner','admin','contributor')
		where session.id = p_session_id and (
			session.audience_kind = 'company'
			or (session.audience_kind = 'member_private' and session.audience_user_id = auth.uid())
		)
	)
$$;

create or replace function public.qorpera_session_profile_id(p_session_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select session.profile_id from public.qorpera_shared_sessions session
	where session.id = p_session_id and (
		coalesce(auth.role(),'') <> 'authenticated' or public.qorpera_can_read_session(session.id)
	)
$$;

drop policy qorpera_sessions_member_read on public.qorpera_shared_sessions;
create policy qorpera_sessions_audience_read on public.qorpera_shared_sessions for select to authenticated
	using (public.qorpera_can_read_session(id));
drop policy qorpera_session_events_member_read on public.qorpera_session_events;
create policy qorpera_session_events_audience_read on public.qorpera_session_events for select to authenticated
	using (public.qorpera_can_read_session(session_id));

create or replace function public.qorpera_session_profile_for_write(p_session_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid;
begin
	select session.profile_id into v_profile_id from public.qorpera_shared_sessions session
	where session.id = p_session_id;
	if v_profile_id is null or not public.qorpera_can_write_session(p_session_id) then
		raise exception 'session write access is required' using errcode = '42501';
	end if;
	return v_profile_id;
end
$$;

create or replace function public.qorpera_shared_session_json(p_session public.qorpera_shared_sessions)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'session_id',p_session.id,'client_session_id',p_session.client_session_id,
		'profile_id',p_session.profile_id,'environment_id',p_session.environment_id,
		'title',p_session.title,'staff_agent_id',p_session.staff_agent_id,
		'parent_session_id',p_session.parent_session_id,'execution_scope',p_session.execution_scope,
		'company_snapshot_id',p_session.company_snapshot_id,'staff_version',p_session.staff_version,
		'audience_kind',p_session.audience_kind,'audience_user_id',p_session.audience_user_id,
		'status',p_session.status,'created_by_user_id',p_session.created_by_user_id,
		'created_at',p_session.created_at,'updated_at',p_session.updated_at
	)
$$;

create or replace function public.qorpera_list_shared_sessions_page(
	p_environment_id uuid,p_after_updated_at timestamptz default null,p_after_id uuid default null,p_limit integer default 100
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile_id uuid;
begin
	select environment.profile_id into v_profile_id from public.qorpera_company_environments environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'shared session read access is required' using errcode = '42501';
	end if;
	if p_limit not between 1 and 100 or ((p_after_updated_at is null) is distinct from (p_after_id is null)) then
		raise exception 'shared session page is invalid' using errcode = '22023';
	end if;
	return (
		with visible as (
			select session.* from public.qorpera_shared_sessions session
			where session.environment_id = p_environment_id and public.qorpera_can_read_session(session.id)
				and (p_after_updated_at is null or (session.updated_at,session.id) > (p_after_updated_at,p_after_id))
			order by session.updated_at,session.id limit p_limit + 1
		), page as (select * from visible order by updated_at,id limit p_limit)
		select jsonb_build_object(
			'items',coalesce((select jsonb_agg(public.qorpera_shared_session_json(session)
				order by session.updated_at,session.id) from page session),'[]'::jsonb),
			'has_more',(select count(*) > p_limit from visible),
			'next_updated_at',(select max(updated_at) from page),
			'next_id',(select id from page order by updated_at desc,id desc limit 1)
		)
	);
end
$$;

create or replace function public.qorpera_get_shared_session_by_client(p_environment_id uuid,p_client_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype;
begin
	select session.* into v_session from public.qorpera_shared_sessions session
	where session.environment_id = p_environment_id and session.client_session_id = p_client_session_id;
	if not found or not public.qorpera_can_read_session(v_session.id) then return null; end if;
	return public.qorpera_shared_session_json(v_session);
end
$$;

create or replace function public.qorpera_list_shared_sessions(p_environment_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(public.qorpera_list_shared_sessions_page(p_environment_id,null,null,100) -> 'items','[]'::jsonb)
$$;

-- Keep the established profile-scoped implementations private and put the
-- audience check in front of every public transcript surface.
alter function public.qorpera_read_session_events(uuid,bigint,integer)
	rename to qorpera_read_session_events_profile_scope;
create function public.qorpera_read_session_events(p_session_id uuid,p_after_sequence bigint default 0,p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.qorpera_can_read_session(p_session_id) then
		raise exception 'session read access is required' using errcode = '42501';
	end if;
	return public.qorpera_read_session_events_profile_scope(p_session_id,p_after_sequence,p_limit);
end
$$;

alter function public.qorpera_list_session_inputs(uuid,bigint,integer)
	rename to qorpera_list_session_inputs_profile_scope;
create function public.qorpera_list_session_inputs(p_session_id uuid,p_after_position bigint default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.qorpera_can_read_session(p_session_id) then
		raise exception 'session read access is required' using errcode = '42501';
	end if;
	return public.qorpera_list_session_inputs_profile_scope(p_session_id,p_after_position,p_limit);
end
$$;

alter function public.qorpera_append_account_event(uuid,uuid,text,jsonb,bigint,text,uuid,uuid)
	rename to qorpera_append_account_event_profile_scope;
create function public.qorpera_append_account_event(
	p_session_id uuid,p_event_id uuid,p_event_type text,p_body jsonb,p_expected_sequence bigint default null,
	p_execution_kind text default null,p_execution_id uuid default null,p_execution_claimant_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if not public.qorpera_can_write_session(p_session_id) then
		raise exception 'session write access is required' using errcode = '42501';
	end if;
	return public.qorpera_append_account_event_profile_scope(
		p_session_id,p_event_id,p_event_type,p_body,p_expected_sequence,
		p_execution_kind,p_execution_id,p_execution_claimant_id
	);
end
$$;

create or replace function public.qorpera_ensure_staff_session(
	p_environment_id uuid,p_staff_agent_id text,p_client_session_id uuid,p_title text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_profile_id uuid;
	v_session public.qorpera_shared_sessions%rowtype; v_created boolean := false;
begin
	select environment.profile_id into v_profile_id from public.qorpera_company_environments environment
	where environment.id = p_environment_id;
	if v_profile_id is null or not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'profile write access is required' using errcode = '42501'; end if;
	if p_client_session_id is null then raise exception 'client session id is required' using errcode = '22023'; end if;
	if p_staff_agent_id is null or char_length(btrim(p_staff_agent_id)) not between 1 and 128 then
		raise exception 'staff agent id is invalid' using errcode = '22023'; end if;
	if char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'session title is invalid' using errcode = '22023'; end if;
	insert into public.qorpera_shared_sessions(profile_id,environment_id,client_session_id,title,staff_agent_id,
		audience_kind,audience_user_id,created_by_user_id)
	values (v_profile_id,p_environment_id,p_client_session_id,btrim(p_title),btrim(p_staff_agent_id),
		'company',null,v_user_id)
	on conflict (profile_id,staff_agent_id) where status = 'open' and staff_agent_id is not null
		and audience_kind = 'company'
		and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	do nothing returning * into v_session;
	v_created := found;
	if v_created then
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id)
		values (v_session.id,v_session.id,'kickoff',v_user_id);
	else
		select session.* into v_session from public.qorpera_shared_sessions session
		where session.profile_id = v_profile_id and session.staff_agent_id = btrim(p_staff_agent_id)
			and session.status = 'open' and session.audience_kind = 'company'
			and not (session.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);
		if not found then raise exception 'staff session could not be adopted' using errcode = '40001'; end if;
	end if;
	return jsonb_build_object('session_id',v_session.id,'client_session_id',v_session.client_session_id,
		'environment_id',v_session.environment_id,'title',v_session.title,
		'company_snapshot_id',v_session.company_snapshot_id,'staff_version',v_session.staff_version,
		'audience_kind',v_session.audience_kind,'audience_user_id',v_session.audience_user_id,
		'created',v_created,'created_by_user_id',v_session.created_by_user_id,'created_at',v_session.created_at);
end
$$;

create function public.qorpera_ensure_member_private_staff_session_internal(
	p_environment_id uuid,p_staff_agent_id uuid,p_audience_user_id uuid,p_client_session_id uuid,p_title text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid; v_session public.qorpera_shared_sessions%rowtype; v_created boolean := false;
begin
	select environment.profile_id into v_profile_id from public.qorpera_company_environments environment
	where environment.id = p_environment_id;
	if v_profile_id is null or p_staff_agent_id is null or p_audience_user_id is null or p_client_session_id is null
		or char_length(btrim(p_title)) not between 1 and 256 then
		raise exception 'member-private staff session is invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_profile_members member
	where member.profile_id = v_profile_id and member.user_id = p_audience_user_id
		and member.role in ('owner','admin','contributor') for share;
	if not found or not exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = v_profile_id and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active') then
		raise exception 'member-private session authority is required' using errcode = '42501'; end if;
	insert into public.qorpera_shared_sessions(profile_id,environment_id,client_session_id,title,staff_agent_id,
		audience_kind,audience_user_id,created_by_user_id)
	values (v_profile_id,p_environment_id,p_client_session_id,btrim(p_title),p_staff_agent_id::text,
		'member_private',p_audience_user_id,p_audience_user_id)
	on conflict (profile_id,staff_agent_id,audience_user_id) where status = 'open' and staff_agent_id is not null
		and audience_kind = 'member_private'
		and not (execution_scope ?| array['autonomousLabel','roomId','group','parentSession'])
	do nothing returning * into v_session;
	v_created := found;
	if not v_created then
		select session.* into strict v_session from public.qorpera_shared_sessions session
		where session.profile_id = v_profile_id and session.staff_agent_id = p_staff_agent_id::text
			and session.audience_kind = 'member_private' and session.audience_user_id = p_audience_user_id
			and session.status = 'open'
			and not (session.execution_scope ?| array['autonomousLabel','roomId','group','parentSession']);
	end if;
	return public.qorpera_shared_session_json(v_session) || jsonb_build_object('created',v_created);
end
$$;

create function public.qorpera_ensure_member_private_staff_session(
	p_environment_id uuid,p_staff_agent_id uuid,p_audience_user_id uuid,p_client_session_id uuid,p_title text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() = 'authenticated' and auth.uid() is distinct from p_audience_user_id then
		raise exception 'member-private session authority is required' using errcode = '42501'; end if;
	if auth.role() not in ('authenticated','service_role') then
		raise exception 'member-private session authority is required' using errcode = '42501'; end if;
	return public.qorpera_ensure_member_private_staff_session_internal(
		p_environment_id,p_staff_agent_id,p_audience_user_id,p_client_session_id,p_title
	);
end
$$;

-- Legacy session creation remains callable by older clients, but it may not
-- use a private session as a parent or adopt another member's private client
-- identity. All ordinary creation paths still create company-audience rows.
alter function public.qorpera_create_shared_session(uuid,text,text,uuid)
	rename to qorpera_create_shared_session_profile_scope;
create function public.qorpera_create_shared_session(
	p_environment_id uuid,p_title text,p_staff_agent_id text default null,p_parent_session_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_session_id uuid;
begin
	if p_parent_session_id is not null and not public.qorpera_can_read_session(p_parent_session_id) then
		raise exception 'parent session is unavailable' using errcode = '42501'; end if;
	v_result := public.qorpera_create_shared_session_profile_scope(
		p_environment_id,p_title,p_staff_agent_id,p_parent_session_id);
	v_session_id := (v_result ->> 'session_id')::uuid;
	if not public.qorpera_can_read_session(v_session_id) then
		raise exception 'session is unavailable' using errcode = '42501'; end if;
	return v_result || jsonb_build_object('audience_kind','company','audience_user_id',null);
end
$$;

alter function public.qorpera_create_shared_session_v2(uuid,uuid,text,text,uuid)
	rename to qorpera_create_shared_session_v2_profile_scope;
create function public.qorpera_create_shared_session_v2(
	p_environment_id uuid,p_client_session_id uuid,p_title text,p_staff_agent_id text default null,
	p_parent_session_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_existing uuid; v_result jsonb; v_session_id uuid;
begin
	select session.id into v_existing from public.qorpera_shared_sessions session
	join public.qorpera_company_environments environment on environment.profile_id = session.profile_id
	where environment.id = p_environment_id and session.client_session_id = p_client_session_id;
	if (p_parent_session_id is not null and not public.qorpera_can_read_session(p_parent_session_id))
		or (v_existing is not null and not public.qorpera_can_read_session(v_existing)) then
		raise exception 'session is unavailable' using errcode = '42501'; end if;
	v_result := public.qorpera_create_shared_session_v2_profile_scope(
		p_environment_id,p_client_session_id,p_title,p_staff_agent_id,p_parent_session_id);
	v_session_id := (v_result ->> 'session_id')::uuid;
	if not public.qorpera_can_read_session(v_session_id) then
		raise exception 'session is unavailable' using errcode = '42501'; end if;
	return v_result || jsonb_build_object('audience_kind','company','audience_user_id',null);
end
$$;

alter function public.qorpera_create_shared_session_v3(uuid,uuid,text,text,uuid,jsonb)
	rename to qorpera_create_shared_session_v3_profile_scope;
create function public.qorpera_create_shared_session_v3(
	p_environment_id uuid,p_client_session_id uuid,p_title text,p_staff_agent_id text,
	p_parent_session_id uuid,p_execution_scope jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_existing uuid; v_result jsonb; v_session_id uuid;
begin
	select session.id into v_existing from public.qorpera_shared_sessions session
	join public.qorpera_company_environments environment on environment.profile_id = session.profile_id
	where environment.id = p_environment_id and session.client_session_id = p_client_session_id;
	if (p_parent_session_id is not null and not public.qorpera_can_read_session(p_parent_session_id))
		or (v_existing is not null and not public.qorpera_can_read_session(v_existing)) then
		raise exception 'session is unavailable' using errcode = '42501'; end if;
	v_result := public.qorpera_create_shared_session_v3_profile_scope(
		p_environment_id,p_client_session_id,p_title,p_staff_agent_id,p_parent_session_id,p_execution_scope);
	v_session_id := (v_result ->> 'session_id')::uuid;
	if not public.qorpera_can_read_session(v_session_id) then
		raise exception 'session is unavailable' using errcode = '42501'; end if;
	return v_result || jsonb_build_object('audience_kind','company','audience_user_id',null);
end
$$;

alter function public.qorpera_cancel_runner_job(uuid)
	rename to qorpera_cancel_runner_job_profile_scope;
create function public.qorpera_cancel_runner_job(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare v_session_id uuid;
begin
	select job.session_id into v_session_id from public.qorpera_runner_jobs job where job.id = p_job_id;
	if v_session_id is not null and not public.qorpera_can_write_session(v_session_id) then
		raise exception 'runner job cancellation is not allowed' using errcode = '42501'; end if;
	return public.qorpera_cancel_runner_job_profile_scope(p_job_id);
end
$$;

alter function public.qorpera_cancel_session_run(uuid,uuid)
	rename to qorpera_cancel_session_run_profile_scope;
create function public.qorpera_cancel_session_run(p_session_id uuid,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
begin
	if not public.qorpera_can_write_session(p_session_id) then
		raise exception 'cloud run cancellation is not allowed' using errcode = '42501'; end if;
	return public.qorpera_cancel_session_run_profile_scope(p_session_id,p_run_id);
end
$$;

-- Public run and attachment surfaces must honor the same audience boundary.
create or replace function public.qorpera_get_session_run_control(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_run jsonb;
begin
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id;
	if auth.uid() is null or not found or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'cloud conversation is unavailable' using errcode = '42501'; end if;
	select jsonb_build_object('run_id',run.id,'status',job.status,
		'can_cancel',public.qorpera_can_write_session(v_session.id) and job.created_by_user_id = auth.uid()) into v_run
	from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id and job.run_id = run.id
	where run.session_id = v_session.id and job.session_id = v_session.id and run.profile_id = v_session.profile_id
		and job.profile_id = v_session.profile_id and run.environment_id = v_session.environment_id
		and job.environment_id = v_session.environment_id and run.staff_agent_id::text = v_session.staff_agent_id
		and run.source_kind = 'session_turn' and job.status in ('queued','leased')
	order by (job.status = 'leased') desc,job.created_at,run.id limit 1;
	return jsonb_build_object('session_id',v_session.id,'staff_agent_id',v_session.staff_agent_id,'run',v_run);
end
$$;

create or replace function public.qorpera_authorize_member_session_attachment(p_session_id uuid,p_input_id uuid,p_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_input public.qorpera_session_inputs%rowtype;
	v_file public.qorpera_company_files%rowtype; v_image jsonb; v_object public.qorpera_profile_objects%rowtype;
begin
	select * into v_session from public.qorpera_shared_sessions where id = p_session_id;
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or v_session.id is null
		or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Chat attachment access is unavailable' using errcode = '42501'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = v_session.environment_id;
	select * into v_input from public.qorpera_session_inputs where id = p_input_id and session_id = p_session_id;
	if v_file.path_gateway_version is distinct from 1 or v_input.kind is distinct from 'user_message'
		or v_input.body ->> 'schema' is distinct from 'qorpera.session-prompt/v1'
		or not exists (select 1 from public.qorpera_session_events where session_id = p_session_id
			and event_id = p_input_id and session_input_id = p_input_id and actor_user_id = v_input.author_user_id) then
		raise exception 'Canonical chat input is unavailable' using errcode = '42501'; end if;
	select value into v_image from jsonb_array_elements(v_input.body -> 'images')
	where value ->> 'objectSha256' = p_sha256 limit 1;
	if v_image is null or (v_input.created_at >= v_file.member_attachment_authority_from and not exists (
		select 1 from public.qorpera_member_session_attachment_uploads where accepted_input_id = p_input_id
			and session_id = p_session_id and user_id = v_input.author_user_id and client_input_id = v_input.client_input_id
			and sha256 = p_sha256 and bytes = (v_image ->> 'bytes')::bigint and media_type = v_image ->> 'mediaType'
			and verified_at is not null)) then
		raise exception 'Attachment does not belong to this canonical input' using errcode = '42501'; end if;
	select * into v_object from public.qorpera_profile_objects where profile_id = v_session.profile_id and sha256 = p_sha256;
	if not found or v_object.bytes <> (v_image ->> 'bytes')::bigint then
		raise exception 'Attachment object is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object('companyId',v_session.profile_id,'sessionId',p_session_id,'inputId',p_input_id,
		'sha256',p_sha256,'bytes',v_object.bytes,'mediaType',v_image ->> 'mediaType');
end
$$;

revoke all on function public.qorpera_can_read_session(uuid),public.qorpera_can_write_session(uuid),
	public.qorpera_create_shared_session_profile_scope(uuid,text,text,uuid),
	public.qorpera_create_shared_session_v2_profile_scope(uuid,uuid,text,text,uuid),
	public.qorpera_create_shared_session_v3_profile_scope(uuid,uuid,text,text,uuid,jsonb),
	public.qorpera_cancel_runner_job_profile_scope(uuid),public.qorpera_cancel_session_run_profile_scope(uuid,uuid),
	public.qorpera_read_session_events_profile_scope(uuid,bigint,integer),
	public.qorpera_list_session_inputs_profile_scope(uuid,bigint,integer),
	public.qorpera_append_account_event_profile_scope(uuid,uuid,text,jsonb,bigint,text,uuid,uuid),
	public.qorpera_ensure_member_private_staff_session_internal(uuid,uuid,uuid,uuid,text),
	public.qorpera_ensure_member_private_staff_session(uuid,uuid,uuid,uuid,text)
	from public,anon,authenticated,service_role;
grant execute on function public.qorpera_can_read_session(uuid),public.qorpera_can_write_session(uuid) to authenticated;
grant execute on function public.qorpera_read_session_events(uuid,bigint,integer),
	public.qorpera_list_session_inputs(uuid,bigint,integer),
	public.qorpera_append_account_event(uuid,uuid,text,jsonb,bigint,text,uuid,uuid),
	public.qorpera_create_shared_session(uuid,text,text,uuid),
	public.qorpera_create_shared_session_v2(uuid,uuid,text,text,uuid),
	public.qorpera_create_shared_session_v3(uuid,uuid,text,text,uuid,jsonb),
	public.qorpera_ensure_staff_session(uuid,text,uuid,text),public.qorpera_get_session_run_control(uuid),
	public.qorpera_authorize_member_session_attachment(uuid,uuid,text),
	public.qorpera_cancel_runner_job(uuid),public.qorpera_cancel_session_run(uuid,uuid) to authenticated;
grant execute on function public.qorpera_ensure_member_private_staff_session(uuid,uuid,uuid,uuid,text)
	to authenticated,service_role;
