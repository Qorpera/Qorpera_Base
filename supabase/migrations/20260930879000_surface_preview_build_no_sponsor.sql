-- WHY: Platform preview and publish builds run only the project's build command in a coding VM and never invoke a
-- model, so requiring a personal AI login broke teammates without one. Only surface-preview-build builders drop the
-- sponsor pin; normal coding sessions still require a sponsor and model-turn admission refuses sponsorless builders.

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_preview_builds') is null
		or to_regprocedure('public.qorpera_surface_preview_builder_kick(uuid)') is null
		or to_regprocedure('public.qorpera_surface_preview_kick_failed(uuid,text)') is null
		or to_regprocedure('public.qorpera_surface_request_build(text,uuid,uuid,text,text,jsonb,text)') is null
		or to_regprocedure('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_coding_session_owner_row(uuid)') is null
		or to_regprocedure('public.qorpera_surface_is_preview_builder(uuid)') is null then
		raise exception 'Surface preview build without sponsor (20260930879000) requires 20260930876000 first';
	end if;
	if strpos(coalesce((
		select pg_get_constraintdef(oid)
		from pg_constraint
		where conrelid = 'public.qorpera_runtime_workers'::regclass
			and conname = 'qorpera_runtime_workers_owner_check'
	), ''), 'surface-preview-build') > 0 then
		raise exception 'Surface preview build without sponsor (20260930879000) is already applied';
	end if;
end $$;

create function pg_temp.spbns_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930879000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930879000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_runtime_workers
	drop constraint qorpera_runtime_workers_owner_check;

update public.qorpera_runtime_workers
set owner_sponsor_binding_id = null,
	owner_sponsor_version = null,
	updated_at = clock_timestamp()
where species = 'coding'
	and surface_backed
	and surface_session_id is null
	and coalesce(dispatch ->> 'kind', '') = 'surface-preview-build'
	and (owner_sponsor_binding_id is not null or owner_sponsor_version is not null);

alter table public.qorpera_runtime_workers
	add constraint qorpera_runtime_workers_owner_check check (
		(species = 'in-house' and owner_user_id is null and owner_sponsor_binding_id is null and owner_sponsor_version is null)
		or (
			species = 'coding'
			and owner_user_id is not null
			and (
				(
					surface_backed
					and surface_session_id is null
					and coalesce(dispatch ->> 'kind', '') = 'surface-preview-build'
					and owner_sponsor_binding_id is null
					and owner_sponsor_version is null
				)
				or (
					not (surface_backed and surface_session_id is null and coalesce(dispatch ->> 'kind', '') = 'surface-preview-build')
					and owner_sponsor_binding_id is not null
					and owner_sponsor_version is not null
				)
			)
		)
	);

select pg_temp.spbns_patch('public.qorpera_surface_preview_builder_kick(uuid)'::regprocedure, array[
$old$	v_sponsor jsonb;
$old$,
$new$$new$,
$old$	if not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_builder.profile_id and m.user_id = v_builder.member_user_id
	) then
		return 'no_member';
	end if;$old$,
$new$	if not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_builder.profile_id and m.user_id = v_builder.member_user_id
			and m.role in ('owner', 'admin', 'contributor')
	) then
		return 'no_member';
	end if;$new$,
$old$	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(
		v_builder.profile_id, v_cofounder.environment_id, v_builder.member_user_id, true,
		(select cs.harness from public.qorpera_coding_sessions cs where cs.worker_id = v_worker.id),
		v_worker.id is not null
	);
	if coalesce(v_sponsor ->> 'status', '') <> 'ok' then
		return coalesce(nullif(v_sponsor ->> 'status', ''), 'no_sponsor');
	end if;
	v_harness := v_sponsor ->> 'harness';
	perform public.qorpera_coding_executor_enroll(v_cofounder.environment_id, v_harness);
	if not exists (
		select 1 from public.qorpera_coding_executors e
		where e.environment_id = v_cofounder.environment_id and e.enabled and v_harness = any(e.harnesses)
	) then
		return 'no_coding_executor';
	end if;$old$,
$new$	perform public.qorpera_coding_executor_enroll(v_cofounder.environment_id, null);
	select available.h into v_harness
	from (
		select distinct h
		from public.qorpera_coding_executors e, unnest(e.harnesses) as h
		where e.environment_id = v_cofounder.environment_id and e.enabled
	) available
	order by
		(available.h = (select cs.harness from public.qorpera_coding_sessions cs where cs.worker_id = v_worker.id)) desc nulls last,
		(available.h = 'codex') desc,
		available.h asc
	limit 1;
	if v_harness is null then
		return 'no_coding_executor';
	end if;$new$,
$old$			v_builder.member_user_id, (v_sponsor ->> 'bindingId')::uuid, (v_sponsor ->> 'version')::bigint,$old$,
$new$			v_builder.member_user_id, null, null,$new$,
$old$		owner_sponsor_binding_id = (v_sponsor ->> 'bindingId')::uuid,
		owner_sponsor_version = (v_sponsor ->> 'version')::bigint,$old$,
$new$		owner_sponsor_binding_id = null,
		owner_sponsor_version = null,$new$,
$old$	update public.qorpera_coding_sessions
	set phase = 'input_ready', finished_at = null, lease_owner = null, lease_token = null, lease_until = null,
		claim_after = null, updated_at = v_now
	where worker_id = v_worker.id;$old$,
$new$	update public.qorpera_coding_sessions
	set harness = v_harness, phase = 'input_ready', finished_at = null, lease_owner = null, lease_token = null, lease_until = null,
		claim_after = null, updated_at = v_now
	where worker_id = v_worker.id;$new$
]);

select pg_temp.spbns_patch('public.qorpera_surface_preview_kick_failed(uuid,text)'::regprocedure, array[
$old$			case p_reason
				when 'no_sponsor' then 'No AI model account of the member who asked can run coding sessions, so no machine could be opened for the build.'
				when 'no_coding_executor' then 'No coding service runs for this company, so no machine could be opened for the build.'
				when 'surface_missing' then 'The interface was deleted.'
				else 'No machine could be opened for the build (' || p_reason || ').'
			end$old$,
$new$			case p_reason
				when 'no_coding_executor' then 'No coding service runs for this company, so no machine could be opened for the build.'
				when 'surface_missing' then 'The interface was deleted.'
				when 'no_member' then 'No member who can build this interface is available, so no machine could be opened for the build.'
				else 'No machine could be opened for the build (' || p_reason || ').'
			end$new$
]);

select pg_temp.spbns_patch('public.qorpera_surface_request_build(text,uuid,uuid,text,text,jsonb,text)'::regprocedure, array[
$old$	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m where m.profile_id = v_surface.profile_id and m.user_id = v_member
	) then
		v_member := v_surface.created_by_user_id;
	end if;
	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m where m.profile_id = v_surface.profile_id and m.user_id = v_member
	) then
		select m.user_id into v_member from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id order by (m.role = 'owner') desc, m.joined_at asc limit 1;
	end if;$old$,
$new$	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.user_id = v_member
			and m.role in ('owner', 'admin', 'contributor')
	) then
		v_member := v_surface.created_by_user_id;
	end if;
	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.user_id = v_member
			and m.role in ('owner', 'admin', 'contributor')
	) then
		select m.user_id into v_member from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id and m.role in ('owner', 'admin', 'contributor')
		order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.joined_at asc limit 1;
	end if;$new$
]);

select pg_temp.spbns_patch('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure, array[
$old$	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if public.qorpera_company_execution_paused(v_worker.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;$old$,
$new$	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if v_worker.owner_sponsor_binding_id is null or v_worker.owner_sponsor_version is null
		or public.qorpera_surface_is_preview_builder(v_worker.id) then
		raise exception 'Preview builder sessions do not run model turns' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_worker.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;$new$
]);

select pg_temp.spbns_patch('public.qorpera_coding_session_owner_row(uuid)'::regprocedure, array[
$old$	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id and species = 'coding';
	if v_worker.id is null or not public.qorpera_can_read_profile(v_worker.profile_id) then
		raise exception 'Coding session is unavailable' using errcode = '42501'; end if;$old$,
$new$	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id and species = 'coding';
	if v_worker.id is null or v_worker.owner_sponsor_binding_id is null
		or public.qorpera_surface_is_preview_builder(v_worker.id)
		or not public.qorpera_can_read_profile(v_worker.profile_id) then
		raise exception 'Coding session is unavailable' using errcode = '42501'; end if;$new$
]);

drop function pg_temp.spbns_patch(regprocedure, text[]);

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
			'public.qorpera_coding_session_owner_row(uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Patched coding session function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_is_preview_builder(uuid) to %I', v_owner);
	end loop;
end $$;
