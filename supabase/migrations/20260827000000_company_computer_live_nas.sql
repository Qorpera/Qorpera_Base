-- Adopt the already-live company NAS root as the Company Computer's working
-- world. Dataset rebinding is a recovery-only service operation: no member,
-- screen, or running job can move the share out from under active work.

-- The live NAS tree no longer follows a cloud publication head. Retire the
-- service-only resolver so an old guest cannot silently reintroduce sync.
drop function public.qorpera_company_computer_sync_head(uuid);

alter table public.qorpera_company_computer_events
	drop constraint qorpera_company_computer_events_event_type_check;
alter table public.qorpera_company_computer_events
	add constraint qorpera_company_computer_events_event_type_check check (event_type in (
		'company_computer_registered', 'company_computer_lifecycle',
		'company_computer_dataset_relocated',
		'company_computer_screen_registered', 'company_computer_screen_attached',
		'company_computer_screen_detached', 'company_computer_screen_retired',
		'company_computer_screen_claimed', 'company_computer_screen_released',
		'company_computer_screen_viewed', 'company_computer_screen_keyframe',
		'company_computer_screen_opened', 'company_computer_screen_closed'
	));

-- A relocation holds the registry row FOR UPDATE. These two guards take a
-- conflicting KEY SHARE lock exactly when work or a screen is about to become
-- live. Whichever transaction wins makes the other re-check lifecycle/state,
-- closing the race between the relocation's idle check and its commit.
create function public.qorpera_guard_company_computer_job_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_lifecycle text;
begin
	if new.run_id is null then
		raise exception 'runner lease has no execution run' using errcode = '23514';
	end if;
	select registry.lifecycle_state into v_lifecycle
	from public.qorpera_execution_runs as run
	join public.qorpera_company_computers as registry
		on registry.logical_computer_id = run.logical_computer_id
	where run.id = new.run_id
	for key share of registry;
	if found and v_lifecycle not in ('provisioning', 'active', 'snapshotting') then
		raise exception 'company computer is unavailable for a runner lease' using errcode = '40001';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_guard_company_computer_job_lease() from public;

create trigger qorpera_guard_company_computer_job_lease
before update of status on public.qorpera_runner_jobs
for each row
when (new.status = 'leased' and old.status is distinct from 'leased')
execute function public.qorpera_guard_company_computer_job_lease();

create function public.qorpera_guard_company_computer_screen_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_lifecycle text;
begin
	if new.status <> 'active' or new.power_state <> 'open' then
		return new;
	end if;
	if tg_op = 'UPDATE'
		and old.status = 'active'
		and old.power_state = 'open'
		and old.company_computer_id = new.company_computer_id then
		return new;
	end if;
	select registry.lifecycle_state into v_lifecycle
	from public.qorpera_company_computers as registry
	where registry.id = new.company_computer_id
	for key share;
	if not found or v_lifecycle not in ('provisioning', 'active', 'snapshotting') then
		raise exception 'company computer is unavailable for an open screen' using errcode = '55000';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_guard_company_computer_screen_open() from public;

create trigger qorpera_guard_company_computer_screen_open_insert
before insert on public.qorpera_company_computer_screens
for each row execute function public.qorpera_guard_company_computer_screen_open();

create trigger qorpera_guard_company_computer_screen_open_update
before update of status, power_state, company_computer_id on public.qorpera_company_computer_screens
for each row execute function public.qorpera_guard_company_computer_screen_open();

create function public.qorpera_relocate_company_computer_dataset(
	p_company_computer_id uuid,
	p_nas_dataset text,
	p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_registry public.qorpera_company_computers%rowtype;
	v_previous_dataset text;
begin
	if auth.role() is distinct from 'service_role'
		or p_nas_dataset is null
		or p_nas_dataset !~ '^[a-z0-9][a-z0-9._-]{0,180}(/[a-z0-9][a-z0-9._-]{0,180}){0,7}$'
		or p_nas_dataset ~ '\.\.'
		or jsonb_typeof(coalesce(p_detail, '{}'::jsonb)) <> 'object'
		or pg_column_size(coalesce(p_detail, '{}'::jsonb)) > 4096 then
		raise exception 'company computer dataset relocation authority is invalid' using errcode = '42501';
	end if;
	select registry.* into v_registry
	from public.qorpera_company_computers as registry
	where registry.id = p_company_computer_id
	for update;
	if not found or v_registry.lifecycle_state <> 'active' then
		raise exception 'company computer dataset relocation requires active lifecycle'
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
		raise exception 'company computer dataset relocation requires an idle computer'
			using errcode = '55000';
	end if;
	if v_registry.nas_dataset = p_nas_dataset then
		return public.qorpera_describe_company_computer(v_registry.logical_computer_id);
	end if;
	v_previous_dataset := v_registry.nas_dataset;
	update public.qorpera_company_computers
	set nas_dataset = p_nas_dataset,
		lifecycle_state = 'recovering',
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
				'reason', 'dataset_relocation',
				'from', v_previous_dataset,
				'to', p_nas_dataset
			)
		)
	);
	perform public.qorpera_append_company_computer_event(
		v_registry.profile_id,
		v_registry.id,
		'company_computer_dataset_relocated',
		jsonb_build_object(
			'from', v_previous_dataset,
			'to', p_nas_dataset,
			'detail', coalesce(p_detail, '{}'::jsonb)
		)
	);
	return public.qorpera_describe_company_computer(v_registry.logical_computer_id);
end
$$;

revoke all on function public.qorpera_relocate_company_computer_dataset(uuid, text, jsonb) from public;
grant execute on function public.qorpera_relocate_company_computer_dataset(uuid, text, jsonb) to service_role;
