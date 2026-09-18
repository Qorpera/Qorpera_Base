-- Contract 14.1: creating an agent seeds exactly one first-run wake. Until now only the silent kickoff input was
-- seeded; a first-run wake is born from a session turn that carries that kickoff alone, and since agent threads
-- (20260917050000) no client requests such a turn. Found live 2026-09-18: four of four kickoffs never claimed.
--
-- 1. The kickoff of a new agent is seeded in the agent's shared thread, where members see the greeting.
-- 2. Creation queues the first-run turn on the creating member's own model account when that member has exactly
--    one usable account (their action caused the run; no other member's account is ever chosen). The existing
--    materializer turns it into a session_turn run whose only input is the kickoff, i.e. a first-run wake.
-- 3. Otherwise the kickoff stays pending and its author starts it with an account of their choice.
-- The same applies to the Co-Founder's first run at company bootstrap.

create function public.qorpera_member_first_run_sponsor(p_profile_id uuid,p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	with usable as (
		select sponsor.binding_id,sponsor.version,identity.id as compute_identity_id
		from public.qorpera_member_compute_identities identity
		join public.qorpera_native_credential_capsules capsule on capsule.compute_identity_id = identity.id
			and capsule.status = 'active' and capsule.ownership_kind = 'member' and capsule.owner_user_id = p_user_id
		join public.qorpera_provider_connection_versions version on version.credential_capsule_id = capsule.id
			and version.authentication_mode = 'native_subscription' and version.authorization_state = 'active'
		join public.qorpera_provider_connections connection on connection.id = version.connection_id
			and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id and connection.status = 'active'
		join lateral (
			select sponsor_version.binding_id,sponsor_version.version
			from public.qorpera_execution_sponsor_versions sponsor_version
			join public.qorpera_execution_sponsor_bindings binding on binding.id = sponsor_version.binding_id
				and binding.profile_id = p_profile_id and binding.status = 'active'
			where sponsor_version.provider_connection_id = connection.id
				and sponsor_version.provider_connection_version = version.version
				and sponsor_version.sponsor_kind = 'member_connection'
			order by sponsor_version.created_at desc,sponsor_version.version desc limit 1
		) sponsor on true
		where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
			and identity.owner_user_id = p_user_id and identity.status = 'active'
			and public.qorpera_provider_execution_enabled(connection.provider,'native_subscription',version.native_harness)
			and exists (select 1 from public.qorpera_profile_members member where member.profile_id = p_profile_id
				and member.user_id = p_user_id and member.role in ('owner','admin','contributor'))
	)
	select case when (select count(*) from usable) = 1 then (select jsonb_build_object(
		'sponsorBindingId',binding_id,'sponsorVersion',version,'computeIdentityId',compute_identity_id) from usable) end
$$;
revoke all on function public.qorpera_member_first_run_sponsor(uuid,uuid) from public,anon,authenticated,service_role;

-- Queues the one first-run turn of an agent. Idempotent: a kickoff has at most one turn request (unique input).
create function public.qorpera_queue_agent_first_run(p_profile_id uuid,p_staff_agent_id uuid,p_sponsor jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_first public.qorpera_agent_first_runs%rowtype; v_input public.qorpera_session_inputs%rowtype; v_request uuid;
begin
	select * into v_first from public.qorpera_agent_first_runs
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id;
	if not found or p_sponsor is null then return null; end if;
	select * into v_input from public.qorpera_session_inputs where id = v_first.input_id for update;
	if not found or v_input.kind <> 'kickoff' or v_input.completed_at is not null or v_input.failed_at is not null
		or v_input.execution_run_id is not null or v_input.turn_id is not null then return null; end if;
	select id into v_request from public.qorpera_session_turn_requests where input_id = v_input.id;
	if found then return v_request; end if;
	insert into public.qorpera_session_turn_requests(profile_id,session_id,client_request_id,input_id,
		requested_by_user_id,sponsor_mode,sponsor_binding_id,sponsor_version,sponsored_by_user_id,compute_identity_id,
		worker_class,required_capability,job_type,publication_mode,status,sponsored_at,initial_execution_selection)
	values (p_profile_id,v_input.session_id,v_input.id,v_input.id,v_input.author_user_id,'member_connection',
		(p_sponsor ->> 'sponsorBindingId')::uuid,(p_sponsor ->> 'sponsorVersion')::bigint,v_input.author_user_id,
		(p_sponsor ->> 'computeIdentityId')::uuid,'managed_sandbox','agent_turn','agent_turn','automatic','queued',
		statement_timestamp(),jsonb_build_object('sponsor_binding_id',p_sponsor -> 'sponsorBindingId',
			'sponsor_version',p_sponsor -> 'sponsorVersion','compute_identity_id',p_sponsor -> 'computeIdentityId',
			'logical_computer_id',null,'worker_class','managed_sandbox','reason','agent_first_run'))
	returning id into v_request;
	return v_request;
end
$$;
revoke all on function public.qorpera_queue_agent_first_run(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- The kickoff's author starts a pending first run with an account of their choice.
create function public.qorpera_start_agent_first_run(p_environment_id uuid,p_staff_agent_id uuid,
	p_sponsor_binding_id uuid default null,p_sponsor_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_profile uuid; v_first public.qorpera_agent_first_runs%rowtype;
	v_input public.qorpera_session_inputs%rowtype; v_sponsor jsonb; v_request uuid;
begin
	select profile_id into v_profile from public.qorpera_company_environments where id = p_environment_id;
	if v_user is null or v_profile is null or not public.qorpera_can_write_profile(v_profile) then
		raise exception 'First run is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_profile) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code','QRC01','message','Company execution is paused',
			'details',null,'hint',null)::text, detail = '{"status":409,"headers":{}}'; end if;
	select * into v_first from public.qorpera_agent_first_runs
	where profile_id = v_profile and environment_id = p_environment_id and staff_agent_id = p_staff_agent_id;
	select * into v_input from public.qorpera_session_inputs where id = v_first.input_id;
	if v_first.input_id is null or v_input.author_user_id is distinct from v_user then
		raise exception 'First run is unavailable' using errcode = '42501'; end if;
	if v_input.completed_at is not null or v_input.execution_run_id is not null then
		return jsonb_build_object('schema','qorpera.agent-first-run-start/v1','state','started','turnRequestId',
			(select id from public.qorpera_session_turn_requests where input_id = v_input.id)); end if;
	if p_sponsor_binding_id is null then
		v_sponsor := public.qorpera_member_first_run_sponsor(v_profile,v_user);
	else
		select jsonb_build_object('sponsorBindingId',sponsor.binding_id,'sponsorVersion',sponsor.version,
			'computeIdentityId',capsule.compute_identity_id) into v_sponsor
		from public.qorpera_execution_sponsor_versions sponsor
		join public.qorpera_execution_sponsor_bindings binding on binding.id = sponsor.binding_id
			and binding.profile_id = v_profile and binding.status = 'active'
		join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
			and connection.profile_id = v_profile and connection.owner_user_id = v_user and connection.status = 'active'
		join public.qorpera_provider_connection_versions version on version.connection_id = connection.id
			and version.version = sponsor.provider_connection_version and version.authorization_state = 'active'
		join public.qorpera_native_credential_capsules capsule on capsule.id = version.credential_capsule_id
			and capsule.status = 'active' and capsule.owner_user_id = v_user
		where sponsor.binding_id = p_sponsor_binding_id and sponsor.version = p_sponsor_version
			and sponsor.sponsor_kind = 'member_connection';
	end if;
	if v_sponsor is null then
		return jsonb_build_object('schema','qorpera.agent-first-run-start/v1','state','sponsor_required','turnRequestId',null); end if;
	v_request := public.qorpera_queue_agent_first_run(v_profile,p_staff_agent_id,v_sponsor);
	return jsonb_build_object('schema','qorpera.agent-first-run-start/v1',
		'state',case when v_request is null then 'unavailable' else 'started' end,'turnRequestId',v_request);
end
$$;
revoke all on function public.qorpera_start_agent_first_run(uuid,uuid,uuid,bigint) from public,anon;
grant execute on function public.qorpera_start_agent_first_run(uuid,uuid,uuid,bigint) to authenticated;

do $$
declare v_definition text; v_old text; v_new text;
begin
	-- Agent creation: seed the kickoff in the agent's thread (created by the staff trigger just above) and queue it.
	v_definition := pg_get_functiondef('public.qorpera_project_company_agent_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure);
	v_old := E'\t\tinsert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)\n\t\tvalues (v_session.id,p_path_version,''kickoff'',v_user_id,v_assignment) returning id into v_input;';
	v_new := E'\t\tselect thread.* into v_session from public.qorpera_shared_sessions thread\n\t\twhere thread.id = coalesce((select room.session_id from public.qorpera_company_rooms room\n\t\t\twhere room.profile_id = v_profile_id and room.bound_staff_agent_id = v_id and room.status = ''active''\n\t\t\t\tand room.session_id is not null),v_session.id);\n' || v_old;
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Agent projection kickoff seed differs'; end if;
	v_definition := replace(v_definition,v_old,v_new);
	v_old := E'\t\tvalues (v_profile_id,v_environment_id,v_id,v_session.id,v_input,p_path_version,v_assignment);';
	v_new := v_old || E'\n\t\tperform public.qorpera_queue_agent_first_run(v_profile_id,v_id,\n\t\t\tpublic.qorpera_member_first_run_sponsor(v_profile_id,v_user_id));';
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Agent projection first-run record differs'; end if;
	execute replace(v_definition,v_old,v_new);

	-- Company bootstrap: queue the Co-Founder's first run the same way (usually pending: a new company has no
	-- model account yet, and its founder starts it after connecting one).
	v_definition := pg_get_functiondef('public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);
	v_old := E'\tfrom public.qorpera_company_first_runs first_run where first_run.profile_id = v_job.profile_id\n\ton conflict (profile_id,staff_agent_id) do nothing;';
	v_new := v_old || E'\n\tperform public.qorpera_queue_agent_first_run(v_job.profile_id,v_job.cofounder_staff_agent_id,\n\t\tpublic.qorpera_member_first_run_sponsor(v_job.profile_id,v_job.created_by_user_id));';
	if (length(v_definition) - length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Company bootstrap first-run record differs'; end if;
	execute replace(v_definition,v_old,v_new);
end
$$;
