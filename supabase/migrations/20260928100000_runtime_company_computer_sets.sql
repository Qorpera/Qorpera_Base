-- A company runs one or more Company Computers.
--
-- Contract section 12 and the 2026-09-16 amendment: a company starts with one
-- Company Computer, six screens each, and another computer for the same company
-- starts when all screens are occupied. Until now `environment_id` was unique
-- on the computer table, so a second computer could never exist.
--
-- Everything below the company is already keyed by computer: generation,
-- start intent, allocation, provider, activation, idle cycle, screens, access
-- and browser profiles. This migration only lifts the one-per-company rule and
-- numbers the computers of a company environment from 1 in the order they were
-- made. The first computer is still registered by an owner
-- (qorpera_register_runtime_office). Later ones are added by
-- qorpera_add_runtime_office_computer when an agent needs a screen and every
-- running computer is full (20260928100100). Adding a computer records demand
-- only: the host still has to be prepared for it before it can start.

alter table public.qorpera_runtime_offices
	drop constraint qorpera_runtime_offices_environment_id_key,
	add column computer_number integer not null default 1 check (computer_number >= 1),
	add constraint qorpera_runtime_offices_environment_computer_key unique (environment_id, computer_number);

comment on column public.qorpera_runtime_offices.computer_number is
	'Company Computer number within the company environment, from 1 in creation order. Never reused.';

-- Who asked for each computer after the first, and which computer it copies.
create table public.qorpera_runtime_office_additions (
	office_id uuid primary key references public.qorpera_runtime_offices(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	computer_number integer not null check (computer_number >= 2),
	template_office_id uuid not null references public.qorpera_runtime_offices(id) on delete restrict,
	requested_by text not null check (requested_by in ('agent', 'member')),
	staff_agent_id uuid not null,
	run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	user_id uuid references auth.users(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	check ((requested_by = 'agent') = (run_id is not null and user_id is null)),
	check ((requested_by = 'member') = (user_id is not null and run_id is null)),
	unique (environment_id, computer_number)
);
alter table public.qorpera_runtime_office_additions enable row level security;
revoke all on public.qorpera_runtime_office_additions from public, anon, authenticated, service_role;

-- Internal. The caller holds the company's GC fence and the environment's seat
-- lock (qorpera_lock_runtime_office_seats), and has decided that a computer is
-- needed. The new computer copies the image, bootstrap and screen count of the
-- company's newest computer, so every host that is prepared for this company
-- can run it. Its default agent access and company browser profiles come from
-- the existing insert triggers, exactly as for the first computer. An agent
-- whose access was revoked on any of the company's computers is revoked on the
-- new one too: a grant revoked on purpose stays revoked.
create function public.qorpera_add_runtime_office_computer(
	p_environment_id uuid, p_requested_by text, p_staff_agent_id uuid, p_run_id uuid, p_user_id uuid
)
returns public.qorpera_runtime_offices
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_template public.qorpera_runtime_offices%rowtype;
	v_office public.qorpera_runtime_offices%rowtype;
	v_logical uuid := extensions.gen_random_uuid();
	v_number integer;
begin
	select * into v_template from public.qorpera_runtime_offices
		where environment_id = p_environment_id and state <> 'retired'
		order by computer_number desc limit 1;
	if not found then raise exception 'Company Computer template unavailable' using errcode = '55000'; end if;
	select max(computer_number) + 1 into strict v_number from public.qorpera_runtime_offices
		where environment_id = p_environment_id;
	insert into public.qorpera_runtime_offices(profile_id, environment_id, logical_computer_id, client_computer_id,
		image_sha256, bootstrap_sha256, max_screens, created_by_user_id, computer_number)
	values (v_template.profile_id, p_environment_id, v_logical, extensions.gen_random_uuid(),
		v_template.image_sha256, v_template.bootstrap_sha256, v_template.max_screens, v_template.created_by_user_id, v_number)
	returning * into v_office;
	insert into public.qorpera_logical_computers(id, profile_id, client_computer_id, display_name, template_key,
		template_version, capabilities, policy, computer_class, created_by_user_id)
	values (v_logical, v_office.profile_id, v_office.client_computer_id, 'Shared office', 'qorpera-shared-office', 'v1',
		'["company_substrate"]', public.qorpera_runtime_office_policy(), 'company_computer', v_template.created_by_user_id);
	insert into public.qorpera_runtime_office_additions(office_id, profile_id, environment_id, computer_number,
		template_office_id, requested_by, staff_agent_id, run_id, user_id)
	values (v_office.id, v_office.profile_id, p_environment_id, v_number, v_template.id, p_requested_by,
		p_staff_agent_id, p_run_id, p_user_id);
	return v_office;
end
$$;
revoke all on function public.qorpera_add_runtime_office_computer(uuid, text, uuid, uuid, uuid)
	from public, anon, authenticated, service_role;

-- Computer access is company-wide: an agent's grant (state and capabilities)
-- is the same on all of the company's computers. Changing it on one changes it
-- on the others, and a grant made on a new computer (a new computer, or an
-- agent hired or re-hired) takes the agent's grant on the company's other
-- computers, so an agent revoked on purpose is never placed on, or given,
-- another computer.
create function public.qorpera_runtime_office_access_company_wide()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_runtime_office_access other
		set state = new.state, capabilities = new.capabilities, version = other.version + 1,
			configured_by_user_id = new.configured_by_user_id
	from public.qorpera_runtime_offices changed, public.qorpera_runtime_offices office
	where changed.id = new.office_id and office.environment_id = changed.environment_id
		and office.id <> new.office_id and office.state <> 'retired'
		and other.office_id = office.id and other.staff_agent_id = new.staff_agent_id
		and (other.state is distinct from new.state or other.capabilities is distinct from new.capabilities);
	return null;
end
$$;
create function public.qorpera_runtime_office_access_inherit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_sibling public.qorpera_runtime_office_access%rowtype;
begin
	select other.* into v_sibling from public.qorpera_runtime_office_access other
		join public.qorpera_runtime_offices office on office.id = other.office_id
		join public.qorpera_runtime_offices added on added.id = new.office_id
		where office.environment_id = added.environment_id and office.id <> new.office_id and office.state <> 'retired'
			and other.staff_agent_id = new.staff_agent_id
		order by office.computer_number limit 1;
	if not found then return null; end if;
	if current_setting('qorpera.runtime_office_access_explicit', true) = 'on' then
		-- An owner's explicit grant on a computer that had no row for the agent:
		-- the owner's state wins and spreads to the other computers; only the
		-- capabilities come from them (the new row keeps version 1, as returned).
		if v_sibling.capabilities is distinct from new.capabilities then
			update public.qorpera_runtime_office_access set capabilities = v_sibling.capabilities
				where office_id = new.office_id and staff_agent_id = new.staff_agent_id;
		end if;
		update public.qorpera_runtime_office_access other
			set state = new.state, version = other.version + 1, configured_by_user_id = new.configured_by_user_id
		from public.qorpera_runtime_offices changed, public.qorpera_runtime_offices office
		where changed.id = new.office_id and office.environment_id = changed.environment_id
			and office.id <> new.office_id and office.state <> 'retired'
			and other.office_id = office.id and other.staff_agent_id = new.staff_agent_id
			and other.state is distinct from new.state;
	elsif v_sibling.state is distinct from new.state or v_sibling.capabilities is distinct from new.capabilities then
		update public.qorpera_runtime_office_access
			set state = v_sibling.state, capabilities = v_sibling.capabilities, version = version + 1,
				configured_by_user_id = v_sibling.configured_by_user_id
			where office_id = new.office_id and staff_agent_id = new.staff_agent_id;
	end if;
	return null;
end
$$;
revoke all on function public.qorpera_runtime_office_access_company_wide(),
	public.qorpera_runtime_office_access_inherit() from public, anon, authenticated, service_role;
create trigger qorpera_runtime_office_access_company_wide
	after update of state, capabilities on public.qorpera_runtime_office_access
	for each row when (old.state is distinct from new.state or old.capabilities is distinct from new.capabilities)
	execute function public.qorpera_runtime_office_access_company_wide();
create trigger qorpera_runtime_office_access_inherit
	after insert on public.qorpera_runtime_office_access
	for each row execute function public.qorpera_runtime_office_access_inherit();

-- An owner's explicit grant marks its insert, so the inherit trigger keeps the
-- owner's choice instead of copying the other computers'.
do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean)'::regprocedure);
	v_old text;
	v_new text;
begin
	v_old := $old$	insert into public.qorpera_runtime_office_access(office_id,staff_agent_id,profile_id,state,capabilities,configured_by_user_id)
	values(p_office_id,$old$;
	v_new := $new$	perform set_config('qorpera.runtime_office_access_explicit', 'on', true);
	insert into public.qorpera_runtime_office_access(office_id,staff_agent_id,profile_id,state,capabilities,configured_by_user_id)
	values(p_office_id,$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office access grant insert differs'; end if;
	v_definition := replace(v_definition, v_old, v_new);
	v_old := $old$	returning * into v_access;
	return jsonb_build_object('grantId',v_access.grant_id,'version',v_access.version,'state',v_access.state);$old$;
	v_new := $new$	returning * into v_access;
	perform set_config('qorpera.runtime_office_access_explicit', 'off', true);
	return jsonb_build_object('grantId',v_access.grant_id,'version',v_access.version,'state',v_access.state);$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office access grant return differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;

-- Registration and the member catalog keep meaning "the company's first
-- computer": an owner registers computer 1, and clients that predate several
-- computers keep seeing it. Without an order these lookups would take an
-- arbitrary row once a second computer exists.
do $patch$
declare
	v_definition text;
	v_old text;
	v_new text;
begin
	v_definition := pg_get_functiondef('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)'::regprocedure);
	v_old := $old$	select * into v_office from public.qorpera_runtime_offices where environment_id=p_environment_id for update;$old$;
	v_new := $new$	select * into v_office from public.qorpera_runtime_offices where environment_id=p_environment_id
		order by computer_number limit 1 for update;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office registration lookup differs'; end if;
	execute replace(v_definition, v_old, v_new);

	v_definition := pg_get_functiondef('public.qorpera_member_office_catalog(uuid,uuid)'::regprocedure);
	v_old := $old$ select * into v_office from public.qorpera_runtime_offices where environment_id=p_environment_id and profile_id=v_company;$old$;
	v_new := $new$ select * into v_office from public.qorpera_runtime_offices where environment_id=p_environment_id and profile_id=v_company
  order by state='retired',computer_number limit 1;$new$;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Office catalog lookup differs'; end if;
	execute replace(v_definition, v_old, v_new);
end
$patch$;
