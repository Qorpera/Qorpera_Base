-- Step 3 screens audit (ratified option 2): periodic content-addressed
-- keyframes of an occupied screen, recorded as ordinary artifacts so they
-- inherit the artifact catalog's retention and GC lifecycle instead of
-- inventing a parallel one. The screen agent captures with provider
-- authority; the artifact is attributed to the occupying run's requesting
-- user, and the registry audit trail binds artifact <-> run <-> screen.
-- Continuous video stays deliberately out (see STEP-3-SCREENS-DECISION.md).
--
-- Design artifact for the Step 3 branch: written to sort after every applied
-- migration and not applied to any project by this change.

alter table public.qorpera_company_computer_events
	drop constraint qorpera_company_computer_events_event_type_check;
alter table public.qorpera_company_computer_events
	add constraint qorpera_company_computer_events_event_type_check check (event_type in (
		'company_computer_registered', 'company_computer_lifecycle',
		'company_computer_screen_registered', 'company_computer_screen_attached',
		'company_computer_screen_detached', 'company_computer_screen_retired',
		'company_computer_screen_claimed', 'company_computer_screen_released',
		'company_computer_screen_viewed', 'company_computer_screen_keyframe'
	));

create function public.qorpera_record_company_computer_screen_keyframe(
	p_screen_id uuid,
	p_run_id uuid,
	p_client_artifact_id uuid,
	p_root_object_sha256 text,
	p_content_sha256 text,
	p_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_screen public.qorpera_company_computer_screens%rowtype;
	v_registry public.qorpera_company_computers%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_artifacts%rowtype;
	v_artifact public.qorpera_artifacts%rowtype;
	v_name text;
begin
	if auth.role() <> 'service_role' then
		raise exception 'company computer screen keyframe requires provider authority' using errcode = '42501';
	end if;
	if p_client_artifact_id is null
		or p_root_object_sha256 !~ '^[0-9a-f]{64}$'
		or p_content_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes not between 1 and 33554432 then
		raise exception 'company computer screen keyframe is invalid' using errcode = '22023';
	end if;
	select screen.* into v_screen
	from public.qorpera_company_computer_screens as screen
	where screen.id = p_screen_id;
	if not found then
		raise exception 'company computer screen is unknown' using errcode = '55000';
	end if;
	if v_screen.status <> 'active' or v_screen.occupying_run_id is distinct from p_run_id then
		raise exception 'company computer screen keyframe does not match the occupying task' using errcode = '55000';
	end if;
	select registry.* into strict v_registry
	from public.qorpera_company_computers as registry
	where registry.id = v_screen.company_computer_id;
	select run.* into strict v_run
	from public.qorpera_execution_runs as run
	where run.id = p_run_id;
	if v_run.profile_id <> v_screen.profile_id
		or v_run.logical_computer_id is distinct from v_registry.logical_computer_id then
		raise exception 'company computer screen keyframe run is outside the computer' using errcode = '55000';
	end if;
	if not exists (
		select 1
		from storage.objects as object
		where object.bucket_id = 'qorpera-profile-objects'
			and object.name = v_screen.profile_id::text || '/' || p_root_object_sha256
	) then
		raise exception 'company computer screen keyframe object is unavailable' using errcode = '22023';
	end if;
	select artifact.* into v_existing
	from public.qorpera_artifacts as artifact
	where artifact.profile_id = v_screen.profile_id
		and artifact.client_artifact_id = p_client_artifact_id;
	if found then
		if v_existing.root_object_sha256 <> p_root_object_sha256
			or v_existing.content_sha256 <> p_content_sha256
			or v_existing.bytes <> p_bytes then
			raise exception 'company computer screen keyframe client id is already bound' using errcode = '23505';
		end if;
		return public.qorpera_artifact_json(v_existing);
	end if;
	v_name := 'Screen ' || v_screen.screen_ordinal || ' keyframe';
	insert into public.qorpera_artifacts (
		profile_id, environment_id, client_artifact_id, session_id,
		artifact_type, name, root_object_sha256, content_sha256, bytes,
		media_type, created_by_user_id
	) values (
		v_screen.profile_id, v_run.environment_id, p_client_artifact_id, v_run.session_id,
		'screen_keyframe', v_name, p_root_object_sha256, p_content_sha256, p_bytes,
		'image/png', v_run.created_by_user_id
	) returning * into v_artifact;
	perform public.qorpera_append_company_computer_event(
		v_screen.profile_id, v_registry.id, 'company_computer_screen_keyframe',
		jsonb_build_object(
			'screen_id', v_screen.id,
			'screen_ordinal', v_screen.screen_ordinal,
			'run_id', p_run_id,
			'artifact_id', v_artifact.id,
			'root_object_sha256', p_root_object_sha256
		)
	);
	return public.qorpera_artifact_json(v_artifact);
end
$$;

revoke all on function public.qorpera_record_company_computer_screen_keyframe(
	uuid, uuid, uuid, text, text, bigint
) from public;
grant execute on function public.qorpera_record_company_computer_screen_keyframe(
	uuid, uuid, uuid, text, text, bigint
) to service_role;
