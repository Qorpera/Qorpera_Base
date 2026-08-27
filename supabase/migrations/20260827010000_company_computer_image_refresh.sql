-- Atomically admit a same-dataset image refresh. The registry row lock
-- conflicts with the screen-open and job-lease guards installed by the live
-- NAS migration, so no work can become live between the idle check and the
-- recovering transition.

create function public.qorpera_prepare_company_computer_image_refresh(
	p_company_computer_id uuid,
	p_from_image_fingerprint text,
	p_to_image_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_registry public.qorpera_company_computers%rowtype;
begin
	if auth.role() is distinct from 'service_role'
		or p_from_image_fingerprint is null
		or p_to_image_fingerprint is null
		or p_from_image_fingerprint !~ '^[0-9a-f]{64}$'
		or p_to_image_fingerprint !~ '^[0-9a-f]{64}$'
		or p_from_image_fingerprint = p_to_image_fingerprint then
		raise exception 'company computer image refresh authority is invalid' using errcode = '42501';
	end if;
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.id = p_company_computer_id
	for update;
	if not found or v_registry.lifecycle_state <> 'active' then
		raise exception 'company computer image refresh requires active lifecycle'
			using errcode = '55000';
	end if;
	if exists (
		select 1
		from public.qorpera_company_computer_screens as screen
		where screen.company_computer_id = v_registry.id
			and screen.status = 'active' and screen.power_state = 'open'
	) or exists (
		select 1
		from public.qorpera_runner_jobs as job
		join public.qorpera_execution_runs as run on run.job_id = job.id
		where run.logical_computer_id = v_registry.logical_computer_id
			and job.status = 'leased'
	) then
		raise exception 'company computer image refresh requires an idle computer'
			using errcode = '55000';
	end if;
	update public.qorpera_company_computers
	set lifecycle_state = 'recovering',
		updated_at = statement_timestamp()
	where id = v_registry.id
	returning * into v_registry;
	perform public.qorpera_append_company_computer_event(
		v_registry.profile_id,
		v_registry.id,
		'company_computer_lifecycle',
		jsonb_build_object(
			'from', 'active',
			'to', 'recovering',
			'node_key', null,
			'detail', jsonb_build_object(
				'reason', 'signed_image_refresh',
				'dataset', v_registry.nas_dataset,
				'from_image_fingerprint', p_from_image_fingerprint,
				'to_image_fingerprint', p_to_image_fingerprint
			)
		)
	);
	return public.qorpera_describe_company_computer(v_registry.logical_computer_id);
end
$$;

revoke all on function public.qorpera_prepare_company_computer_image_refresh(uuid, text, text) from public;
grant execute on function public.qorpera_prepare_company_computer_image_refresh(uuid, text, text) to service_role;
