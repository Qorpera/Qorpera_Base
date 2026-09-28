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
	update public.qorpera_runtime_office_access access set state = 'revoked', version = access.version + 1
		where access.office_id = v_office.id and access.state = 'active'
			and exists(select 1 from public.qorpera_runtime_office_access other
				join public.qorpera_runtime_offices o on o.id = other.office_id
				where o.environment_id = p_environment_id and o.id <> v_office.id and o.state <> 'retired'
					and other.staff_agent_id = access.staff_agent_id and other.state = 'revoked');
	insert into public.qorpera_runtime_office_additions(office_id, profile_id, environment_id, computer_number,
		template_office_id, requested_by, staff_agent_id, run_id, user_id)
	values (v_office.id, v_office.profile_id, p_environment_id, v_number, v_template.id, p_requested_by,
		p_staff_agent_id, p_run_id, p_user_id);
	return v_office;
end
$$;
revoke all on function public.qorpera_add_runtime_office_computer(uuid, text, uuid, uuid, uuid)
	from public, anon, authenticated, service_role;

-- Computer access is company-wide: an agent's grant is the same on all of the
-- company's computers. Changing it on one changes it on the others, so an agent
-- revoked on purpose is never placed on, or given, another computer.
create function public.qorpera_runtime_office_access_company_wide()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_runtime_office_access other
		set state = new.state, version = other.version + 1, configured_by_user_id = new.configured_by_user_id
	from public.qorpera_runtime_offices changed, public.qorpera_runtime_offices office
	where changed.id = new.office_id and office.environment_id = changed.environment_id
		and office.id <> new.office_id and office.state <> 'retired'
		and other.office_id = office.id and other.staff_agent_id = new.staff_agent_id
		and other.state is distinct from new.state;
	return null;
end
$$;
revoke all on function public.qorpera_runtime_office_access_company_wide() from public, anon, authenticated, service_role;
create trigger qorpera_runtime_office_access_company_wide
	after update of state on public.qorpera_runtime_office_access
	for each row when (old.state is distinct from new.state)
	execute function public.qorpera_runtime_office_access_company_wide();

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
