-- Company creation on the folder core (C2-create, P14a): deploy/first-node/RUNTIME-COMPANY-FOLDER-CREATION.md.
--
-- Fills the founding lobby's stubs (20260928248200) and adds the creation's own rows:
-- * Open makes the company row, its owner and its environment, already on folder-v2 (no seeded tree, no Co-Founder,
--   no old setup chain). The same transaction switches the Company File row to folder-v2.
-- * Start (seed) records one creation with the founders' input and the ids the seed tree uses.
-- * The object gateway's creation worker (P14b, off by default) claims it, stages the seed tree's bytes as the
--   platform, and calls qorpera_folder_company_create: one transaction with the creation commit, the Co-Founder (its
--   staff row, thread and cofounders row, through the hook), and the Co-Founder's silent first run (the kickoff and
--   its turn request, written by the hook's apply). The first-run wake comes when C4 (P28) materializes the turn.
-- * Ready is that transaction having landed; until then the company is hidden.
-- * An operator makes a folder-v2 company through the same path (operator_open, operator_start), as the owner role.
-- Nothing changes for customers: qorpera_company_founding_available() stays false (C5, P39).
--
-- Locks (§3, §7): the creation row, the pause, the folder fence FOR NO KEY UPDATE (the mode member management takes),
-- the pause again, then the commit's own order. No new company-wide lock.
-- Each inserted text names this migration (20260930010000), for deploy guards.

set local lock_timeout = '3s';

create function pg_temp.p14a_creation_replace(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P14a anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The creation row -------------------------------------------------------------------------------------------------

-- One per company. The input is the founders' prose between Start and the commit (runtime state with a bounded life:
-- nulled at completion, kept only while a creation is failed, for the requeue).
create table public.qorpera_folder_company_creations (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null unique references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	state text not null default 'queued' check (state in ('queued','leased','completed','failed','blocked')),
	input jsonb check (input is null or (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 65536)),
	-- The member who pressed Start: the kickoff's author and the first run's requester. Departure is refused while
	-- the creation is queued or leased; an account deleted anyway (a company being deleted lets members go) leaves it
	-- null, and the create then answers failed (kickoff_member_left).
	kickoff_user_id uuid references auth.users(id) on delete set null,
	-- The seed tree's ids, made once here so every attempt builds the same tree.
	cofounder_id uuid not null,
	first_todo_id uuid not null,
	lease_owner uuid,
	lease_until timestamptz,
	generation bigint not null default 0 check (generation >= 0),
	attempts integer not null default 0 check (attempts >= 0),
	not_before timestamptz,
	last_problem text check (last_problem is null or last_problem ~ '^[a-z][a-z0-9_]{0,63}$'),
	-- A failed creation's commit outcomes, or the worker's code, for the operator.
	failure jsonb check (failure is null or jsonb_typeof(failure) = 'object'),
	commit_id uuid,
	result jsonb check (result is null or jsonb_typeof(result) = 'object'),
	operator_reason text check (operator_reason is null or char_length(btrim(operator_reason)) between 1 and 500),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	completed_at timestamptz,
	foreign key (profile_id, environment_id)
		references public.qorpera_company_files(profile_id, environment_id) on delete cascade,
	check ((state = 'leased') = (lease_owner is not null and lease_until is not null)),
	check (state not in ('queued','leased') or input is not null),
	check ((state = 'completed') = (completed_at is not null and commit_id is not null and result is not null)),
	check (state <> 'completed' or input is null),
	check ((state = 'failed') = (failure is not null))
);
create index qorpera_folder_company_creations_due on public.qorpera_folder_company_creations (created_at, id)
	where state in ('queued','leased');
alter table public.qorpera_folder_company_creations enable row level security;
revoke all on public.qorpera_folder_company_creations from public, anon, authenticated, service_role;

-- The setting the create function sets for its commit: {environmentId, creationId, operationKey}, or null.
create function public.qorpera_folder_company_create_request()
returns jsonb language sql stable set search_path = '' as $$
	select case when coalesce(current_setting('qorpera.folder_company_create', true), '') = '' then null
		else current_setting('qorpera.folder_company_create', true)::jsonb end
$$;
revoke all on function public.qorpera_folder_company_create_request() from public, anon, authenticated, service_role;

-- 2. Enabling the folder core -----------------------------------------------------------------------------------------

-- The body of qorpera_folder_enable without the role check, for Open, which runs as the member. It refuses an
-- environment with a bootstrap job (#444): a company made the old way never switches cores.
create function public.qorpera_folder_enable_internal(p_environment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype;
begin
	-- 20260930010000 (P14a): a bootstrap job (the old chain) makes a company touched (#444).
	if exists (select 1 from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2') then
		return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',false);
	end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id for update;
	if not found then raise exception 'Company File is unavailable' using errcode = '42501'; end if;
	if v_file.core = 'folder-v2' then
		return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',false);
	end if;
	if v_file.state <> 'provisioning' or v_file.head_snapshot_id is not null or v_file.path_gateway_version is not null
		or exists (select 1 from public.qorpera_company_snapshots where environment_id = p_environment_id)
		or exists (select 1 from public.qorpera_event_hooks where environment_id = p_environment_id and status <> 'removed')
		or exists (select 1 from public.qorpera_company_bootstrap_jobs where environment_id = p_environment_id) then
		raise exception 'Only an untouched company can use the folder core' using errcode = '55000'; end if;
	perform set_config('qorpera.folder_enable', 'on', true);
	update public.qorpera_company_files set core = 'folder-v2', state = 'ready', updated_at = statement_timestamp()
	where environment_id = p_environment_id;
	perform set_config('qorpera.folder_enable', '', true);
	insert into public.qorpera_folder_clocks(environment_id) values (p_environment_id);
	insert into public.qorpera_folder_fences(profile_id) values (v_file.profile_id) on conflict (profile_id) do nothing;
	insert into public.qorpera_folder_admissions(profile_id) values (v_file.profile_id) on conflict (profile_id) do nothing;
	insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, policy, created_by_user_id)
	values (p_environment_id, '', 'subtree', 'company_shared', 'normal', v_file.created_by_user_id),
		(p_environment_id, 'rules', 'subtree', 'company_rules', 'normal', v_file.created_by_user_id)
	on conflict (environment_id, path_key_sha256) do nothing;
	return jsonb_build_object('schema','qorpera.folder-enable/v1','environmentId',p_environment_id,'changed',true);
end $$;
revoke all on function public.qorpera_folder_enable_internal(uuid) from public, anon, authenticated, service_role;

-- 3. Open, seed and ready (the lobby's stubs) --------------------------------------------------------------------------

-- Open: the company row, its owner and its environment, on folder-v2. No staff, no thread, no seed, no wake, and never
-- the old chain. Repeat-safe per (user, creation id): the creation request is read first, so a repeat never inserts
-- the owner row again (the lobby's member guard would refuse it once the table is open). The owner's email and name
-- come from the account, so the operator's path (no member session) uses the same body.
create or replace function public.qorpera_folder_company_open(p_user_id uuid, p_client_creation_id uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(p_name); v_request public.qorpera_company_creation_requests%rowtype;
	v_account auth.users%rowtype; v_email text; v_profile uuid; v_environment uuid;
begin
	-- 20260930010000 (P14a): C2's open.
	-- A name is one heading line (the seed tree's vision.md refuses controls and line separators).
	if p_user_id is null or p_client_creation_id is null or v_name is null or char_length(v_name) not between 1 and 120
		or v_name ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]' then
		raise exception 'Company details are invalid' using errcode = '22023'; end if;
	insert into public.qorpera_company_creation_requests(created_by_user_id, client_creation_id, profile_name, contract_version)
	values (p_user_id, p_client_creation_id, v_name, 2)
	on conflict (created_by_user_id, client_creation_id) do nothing returning * into v_request;
	if not found then
		select * into strict v_request from public.qorpera_company_creation_requests
		where created_by_user_id = p_user_id and client_creation_id = p_client_creation_id for update;
		if v_request.profile_name <> v_name or v_request.contract_version <> 2 then
			raise exception 'company creation id is already bound to another request' using errcode = '23505'; end if;
		-- A creation id the old path used names a company with a bootstrap job: never a folder-v2 company.
		select environment.id into v_environment from public.qorpera_company_environments as environment
		join public.qorpera_company_files as file on file.environment_id = environment.id and file.core = 'folder-v2'
		where environment.profile_id = v_request.profile_id;
		if v_request.profile_id is null or v_environment is null
			or exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_request.profile_id) then
			raise exception 'This company already exists' using errcode = '23505'; end if;
		return jsonb_build_object('profile_id', v_request.profile_id, 'environment_id', v_environment);
	end if;
	select * into v_account from auth.users where id = p_user_id;
	v_email := lower(coalesce(v_account.email, ''));
	if v_account.id is null or v_email = '' then
		raise exception 'account email is unavailable' using errcode = '22023'; end if;
	insert into public.qorpera_profiles(name, created_by_user_id) values (v_name, p_user_id) returning id into v_profile;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, avatar_url, role)
	values (v_profile, p_user_id, v_email, left(public.qorpera_account_display_name(v_account.raw_user_meta_data), 256),
		left(nullif(coalesce(v_account.raw_user_meta_data ->> 'avatar_url', v_account.raw_user_meta_data ->> 'picture'), ''),
			2048), 'owner');
	-- The provision trigger makes the snapshot-v1 provisioning Company File row; it switches to folder-v2 at once.
	insert into public.qorpera_company_environments(profile_id, name, contract_version, created_by_user_id)
	values (v_profile, v_name, 2, p_user_id) returning id into v_environment;
	update public.qorpera_company_creation_requests set profile_id = v_profile
	where created_by_user_id = p_user_id and client_creation_id = p_client_creation_id;
	perform public.qorpera_folder_enable_internal(v_environment);
	return jsonb_build_object('profile_id', v_profile, 'environment_id', v_environment);
end $$;

-- Seed: one creation row from the seed input, inside Start's locks (or the operator's start). It checks the input as
-- the lobby keeps it, and that the company is folder-v2 with no old setup chain. A second call returns the row.
create or replace function public.qorpera_folder_company_seed(p_profile_id uuid, p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_environment uuid; v_creation uuid; v_kickoff uuid;
begin
	-- 20260930010000 (P14a): C2's seed records the creation; the worker commits it.
	select id into v_creation from public.qorpera_folder_company_creations where profile_id = p_profile_id;
	if found then return v_creation; end if;
	select file.environment_id into v_environment from public.qorpera_company_files as file
	where file.profile_id = p_profile_id and file.core = 'folder-v2';
	if v_environment is null or exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = p_profile_id)
		or exists (select 1 from public.qorpera_company_cofounders where profile_id = p_profile_id) then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_input) is distinct from 'object'
		or (select array_agg(k order by k) from jsonb_object_keys(p_input) k)
			is distinct from array['companyName','founders','kickoffRequestedBy','schema','vision']
		or p_input ->> 'schema' is distinct from 'qorpera.company-seed-input/v1'
		or jsonb_typeof(p_input -> 'companyName') is distinct from 'string'
		or char_length(btrim(p_input ->> 'companyName')) not between 1 and 120
		or p_input ->> 'companyName' is distinct from (select name from public.qorpera_profiles where id = p_profile_id)
		or (p_input ->> 'companyName') ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
		or jsonb_typeof(p_input -> 'vision') is distinct from 'string' or octet_length(p_input ->> 'vision') > 16384
		or coalesce(p_input ->> 'kickoffRequestedBy', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or jsonb_typeof(p_input -> 'founders') is distinct from 'array'
		or jsonb_array_length(p_input -> 'founders') not between 1 and 8
		or exists (select 1 from jsonb_array_elements(p_input -> 'founders') f
			where jsonb_typeof(f) <> 'object'
				or (select array_agg(k order by k) from jsonb_object_keys(f) k) is distinct from array['displayName','role','userId']
				or coalesce(f ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				or jsonb_typeof(f -> 'displayName') <> 'string' or char_length(f ->> 'displayName') > 256
				or jsonb_typeof(f -> 'role') <> 'string' or char_length(f ->> 'role') > 300
				-- Every founder owns the company (Start made them owners).
				or not exists (select 1 from public.qorpera_profile_members as member where member.profile_id = p_profile_id
					and member.user_id = (f ->> 'userId')::uuid and member.role = 'owner'))
		or (select count(distinct f ->> 'userId') from jsonb_array_elements(p_input -> 'founders') f)
			<> jsonb_array_length(p_input -> 'founders')
		or not exists (select 1 from jsonb_array_elements(p_input -> 'founders') f
			where f ->> 'userId' = p_input ->> 'kickoffRequestedBy') then
		raise exception 'Company seed input is invalid' using errcode = '22023'; end if;
	v_kickoff := (p_input ->> 'kickoffRequestedBy')::uuid;
	insert into public.qorpera_folder_company_creations(profile_id, environment_id, input, kickoff_user_id, cofounder_id,
		first_todo_id)
	values (p_profile_id, v_environment, p_input, v_kickoff, extensions.gen_random_uuid(), extensions.gen_random_uuid())
	returning id into v_creation;
	return v_creation;
end $$;

-- Ready: the creation commit has landed.
create or replace function public.qorpera_folder_company_ready(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930010000 (P14a): the creation is completed.
	select exists (select 1 from public.qorpera_folder_company_creations
		where profile_id = p_profile_id and state = 'completed')
$$;
revoke all on function public.qorpera_folder_company_open(uuid,uuid,text),
	public.qorpera_folder_company_seed(uuid,jsonb), public.qorpera_folder_company_ready(uuid)
	from public, anon, authenticated, service_role;

-- What the founders' table shows while their company is set up: pending, ready or failed (also for a company being
-- deleted before its creation was made).
create function public.qorpera_folder_company_setup(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select case creation.state when 'completed' then 'ready' when 'failed' then 'failed' when 'blocked' then 'failed'
		else 'pending' end
	from public.qorpera_folder_company_creations as creation where creation.profile_id = p_profile_id
$$;
revoke all on function public.qorpera_folder_company_setup(uuid) from public, anon, authenticated, service_role;

-- 4. The first run, written by the hook's apply for the creation's own Co-Founder -----------------------------------

-- Called by qorpera_folder_structured_apply after it indexed an agent file. Only inside a creation (the setting), only
-- for the environment and operation key the setting names and the creation row the create function holds, and only
-- for the row's cofounder_id. Writes the silent kickoff in the Co-Founder's thread, the first-run row, and the turn
-- request on the kickoff member's own login when one is usable now. No wake: C4 (P28) materializes the turn.
create function public.qorpera_folder_company_first_run(p_environment_id uuid, p_commit_id uuid, p_staff_agent_id uuid,
	p_path_version uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_request jsonb := public.qorpera_folder_company_create_request(); v_creation public.qorpera_folder_company_creations%rowtype;
	v_session uuid; v_input uuid; v_body jsonb; v_sponsor jsonb;
begin
	-- 20260930010000 (P14a): the creation commit's first run (the seam C4/P28 builds on).
	if v_request is null then return; end if;
	if v_request ->> 'environmentId' is distinct from p_environment_id::text
		or not exists (select 1 from public.qorpera_folder_commits where id = p_commit_id
			and environment_id = p_environment_id and operation_key = v_request ->> 'operationKey') then
		raise exception 'Company creation does not match its commit' using errcode = 'XX000'; end if;
	-- Only the create function sets the setting, after it took this row FOR UPDATE with its lease checked, and clears
	-- it on every answer; so a leased row here is the one this transaction holds.
	select * into v_creation from public.qorpera_folder_company_creations
	where id = (v_request ->> 'creationId')::uuid and environment_id = p_environment_id and state = 'leased';
	if not found then raise exception 'Company creation does not match its commit' using errcode = 'XX000'; end if;
	if p_staff_agent_id is distinct from v_creation.cofounder_id then return; end if;
	select room.session_id into v_session from public.qorpera_company_rooms as room
	where room.profile_id = v_creation.profile_id and room.bound_staff_agent_id = p_staff_agent_id and room.status = 'active'
		and room.session_id is not null;
	if v_session is null then raise exception 'The Co-Founder has no thread' using errcode = 'XX000'; end if;
	v_body := jsonb_build_object('schema', 'qorpera.company-first-run/v1', 'assignment', jsonb_build_object(
		'kind', 'company_founding', 'companyId', v_creation.profile_id, 'creationId', v_creation.id,
		'cofounderStaffAgentId', p_staff_agent_id,
		'firstTodo', 'agents/co-founder/todos/start-with-the-founders.md'));
	insert into public.qorpera_session_inputs(session_id, client_input_id, kind, author_user_id, body)
	values (v_session, md5('qorpera.folder-company-create/kickoff:' || v_creation.id)::uuid, 'kickoff',
		v_creation.kickoff_user_id, v_body)
	returning id into v_input;
	insert into public.qorpera_agent_first_runs(profile_id, environment_id, staff_agent_id, session_id, input_id,
		source_path_version, startup_assignment)
	values (v_creation.profile_id, p_environment_id, p_staff_agent_id, v_session, v_input, p_path_version, v_body);
	-- The member who started the work pays, as Start checked; read again now. With no usable login the kickoff stays
	-- pending, and its author starts it (qorpera_start_agent_first_run).
	v_sponsor := public.qorpera_member_first_run_sponsor(v_creation.profile_id, v_creation.kickoff_user_id);
	if v_sponsor is not null and public.qorpera_sponsor_serves_requester(v_creation.profile_id,
		(v_sponsor ->> 'sponsorBindingId')::uuid, (v_sponsor ->> 'sponsorVersion')::bigint, v_creation.kickoff_user_id) then
		perform public.qorpera_queue_agent_first_run(v_creation.profile_id, p_staff_agent_id, v_sponsor);
	end if;
end $$;
revoke all on function public.qorpera_folder_company_first_run(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;

-- 5. The creation worker's calls (service role: the object gateway, P14b) ---------------------------------------------

-- Takes one due creation for p_lease_seconds: queued and past its back-off, or leased with an expired lease. Null when
-- nothing is due. Only the creation rows are locked, SKIP LOCKED. The answer carries what the seed tree needs.
create function public.qorpera_folder_company_creation_claim(p_worker uuid, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_creation public.qorpera_folder_company_creations%rowtype;
begin
	-- 20260930010000 (P14a): only the creation row is locked.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
		raise exception 'Company creation claim is invalid' using errcode = '22023'; end if;
	select creation.* into v_creation from public.qorpera_folder_company_creations as creation
	where (creation.state = 'queued' and (creation.not_before is null or creation.not_before <= clock_timestamp()))
		or (creation.state = 'leased' and creation.lease_until < clock_timestamp())
	order by creation.created_at, creation.id
	limit 1
	for update skip locked;
	if v_creation.id is null then return null; end if;
	update public.qorpera_folder_company_creations
	set state = 'leased', lease_owner = p_worker, lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
		generation = generation + 1, attempts = attempts + 1, updated_at = clock_timestamp()
	where id = v_creation.id
	returning * into v_creation;
	return jsonb_build_object('schema', 'qorpera.company-creation-claim/v1', 'creationId', v_creation.id,
		'profileId', v_creation.profile_id, 'environmentId', v_creation.environment_id,
		'generation', v_creation.generation, 'attempt', v_creation.attempts, 'leaseUntil', v_creation.lease_until,
		'operationKey', 'company-create:' || v_creation.id, 'cofounderId', v_creation.cofounder_id,
		'firstTodoId', v_creation.first_todo_id, 'kickoffRequestedBy', v_creation.kickoff_user_id,
		'input', v_creation.input);
end $$;

-- Gives a claim back with a code: the creation is due again after a back-off of 2^attempts seconds, at most an hour.
-- Only the claim's own worker and generation release it; a blocked or finished creation stays as it is.
create function public.qorpera_folder_company_creation_release(p_worker uuid, p_creation_id uuid, p_generation bigint,
	p_problem text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930010000 (P14a): only the creation row is locked.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_creation_id is null or p_generation is null
		or coalesce(p_problem, '') !~ '^[a-z][a-z0-9_]{0,63}$' then
		raise exception 'Company creation release is invalid' using errcode = '22023'; end if;
	update public.qorpera_folder_company_creations
	set state = 'queued', lease_owner = null, lease_until = null, last_problem = p_problem,
		not_before = clock_timestamp() + least(make_interval(secs => power(2, least(attempts, 12))::integer),
			interval '1 hour'),
		updated_at = clock_timestamp()
	where id = p_creation_id and state = 'leased' and lease_owner = p_worker and generation = p_generation;
	return jsonb_build_object('schema', 'qorpera.company-creation-release/v1', 'released', found);
end $$;

-- A final failure the worker found before the commit (a seed tree its parser refuses, a staging refusal): the
-- founders' table shows "failed", and an operator requeues it after fixing the cause.
create function public.qorpera_folder_company_creation_fail(p_worker uuid, p_creation_id uuid, p_generation bigint,
	p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930010000 (P14a): only the creation row is locked.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_creation_id is null or p_generation is null
		or coalesce(p_code, '') !~ '^[a-z][a-z0-9_]{0,63}$' then
		raise exception 'Company creation failure is invalid' using errcode = '22023'; end if;
	update public.qorpera_folder_company_creations
	set state = 'failed', lease_owner = null, lease_until = null, last_problem = p_code,
		failure = jsonb_build_object('code', p_code, 'by', 'worker'), updated_at = clock_timestamp()
	where id = p_creation_id and state = 'leased' and lease_owner = p_worker and generation = p_generation;
	return jsonb_build_object('schema', 'qorpera.company-creation-fail/v1', 'failed', found);
end $$;

-- The operator queues a failed creation again (owner role, through the coordinator's lane). Not for a company being
-- deleted, nor once the member who started it has left.
create function public.qorpera_folder_company_creation_requeue(p_creation_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_creation public.qorpera_folder_company_creations%rowtype;
begin
	-- 20260930010000 (P14a): only the creation row is locked.
	if p_creation_id is null or p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
		raise exception 'Company creation requeue is invalid' using errcode = '22023'; end if;
	select * into v_creation from public.qorpera_folder_company_creations where id = p_creation_id for update;
	if not found or v_creation.state <> 'failed' or public.qorpera_company_deleting(v_creation.profile_id)
		or not exists (select 1 from public.qorpera_profile_members where profile_id = v_creation.profile_id
			and user_id = v_creation.kickoff_user_id) then
		raise exception 'Only a failed creation of a company that stays is queued again' using errcode = '55000'; end if;
	update public.qorpera_folder_company_creations
	set state = 'queued', failure = null, not_before = null, attempts = 0, operator_reason = btrim(p_reason),
		updated_at = clock_timestamp()
	where id = p_creation_id;
	return jsonb_build_object('schema', 'qorpera.company-creation-requeue/v1', 'creationId', p_creation_id,
		'state', 'queued');
end $$;

-- 6. The creation transaction ------------------------------------------------------------------------------------------

-- One transaction: the creation row, the pause, the folder fence FOR NO KEY UPDATE (the mode member management takes,
-- so a join, a leave or a role change and the creation run one after the other), the pause again, then the platform
-- commit with the operation key company-create:<id> in its own order. The hook's apply writes the Co-Founder (its
-- staff row, thread and cofounders row) and, under the setting, its first run. The commit runs in one exception block:
-- unless every unit saved and the Co-Founder and its one first run match the row, it raises QFC01, the block rolls
-- the commit back, and the answer is retry (only bytes_unverified: a deleting object, the writer restages after GC) or
-- failed (anything else; the outcomes are kept on the row). Errors the block does not catch roll everything back; the
-- worker backs off. Answers: completed (also a replay of a completed creation), failed, retry, or stale (not this
-- worker's lease).
create function public.qorpera_folder_company_create(p_worker uuid, p_creation_id uuid, p_generation bigint,
	p_units jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_creation public.qorpera_folder_company_creations%rowtype; v_key text; v_result jsonb; v_units jsonb;
	v_problem text; v_answer jsonb; v_first public.qorpera_agent_first_runs%rowtype;
begin
	-- 20260930010000 (P14a): C2's creation commit.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_worker is null or p_creation_id is null or p_generation is null or jsonb_typeof(p_units) is distinct from 'array'
		or jsonb_array_length(p_units) = 0 then
		raise exception 'Company creation is invalid' using errcode = '22023'; end if;
	-- The job's place (core §3 step 2): the creation row.
	select * into v_creation from public.qorpera_folder_company_creations where id = p_creation_id for update;
	if not found then raise exception 'Company creation is unavailable' using errcode = '42501'; end if;
	if v_creation.state = 'completed' then return v_creation.result || jsonb_build_object('replay', true); end if;
	if v_creation.state <> 'leased' or v_creation.lease_owner is distinct from p_worker
		or v_creation.generation <> p_generation then
		return jsonb_build_object('schema', 'qorpera.company-creation/v1', 'creationId', p_creation_id, 'state', 'stale');
	end if;
	-- Step 3: the pause, the fence, the pause again (a company being deleted is paused).
	if public.qorpera_company_execution_paused(v_creation.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	perform 1 from public.qorpera_folder_fences where profile_id = v_creation.profile_id for no key update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_creation.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	v_key := 'company-create:' || v_creation.id;
	-- The old chain never ran, nobody recorded a Co-Founder, and the member who started it is still here (the
	-- departure guard holds them while the creation is queued or leased; this is the check behind it).
	if exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_creation.profile_id) then
		v_problem := 'old_chain';
	elsif exists (select 1 from public.qorpera_company_cofounders where profile_id = v_creation.profile_id) then
		v_problem := 'cofounder_exists';
	elsif not exists (select 1 from public.qorpera_profile_members where profile_id = v_creation.profile_id
		and user_id = v_creation.kickoff_user_id) then
		v_problem := 'kickoff_member_left';
	end if;
	if v_problem is null then
		-- Set before the block, so the catch does not undo it; cleared on every answer below.
		perform set_config('qorpera.folder_company_create', jsonb_build_object('environmentId', v_creation.environment_id,
			'creationId', v_creation.id, 'operationKey', v_key)::text, true);
		begin
			v_result := public.qorpera_folder_commit(v_creation.environment_id, jsonb_build_object('kind', 'platform'),
				v_key, p_units, null, null);
			v_units := v_result -> 'units';
			if v_result ->> 'seq' is null or coalesce((v_result ->> 'replay')::boolean, false)
				or jsonb_array_length(v_units) <> jsonb_array_length(p_units)
				or exists (select 1 from jsonb_array_elements(v_units) u where u ->> 'outcome' is distinct from 'saved') then
				v_problem := case when not exists (select 1 from jsonb_array_elements(v_units) u
						where u ->> 'outcome' is distinct from 'saved' and u ->> 'reason' is distinct from 'bytes_unverified')
					and exists (select 1 from jsonb_array_elements(v_units) u where u ->> 'outcome' is distinct from 'saved')
					then 'bytes_unverified' else 'refused' end;
				raise exception 'Company creation did not save every unit' using errcode = 'QFC01';
			end if;
			-- The Co-Founder the commit recorded is the row's, with exactly one first run and one kickoff, and its first
			-- todo is indexed.
			select * into v_first from public.qorpera_agent_first_runs
			where profile_id = v_creation.profile_id and staff_agent_id = v_creation.cofounder_id;
			if not exists (select 1 from public.qorpera_company_cofounders where profile_id = v_creation.profile_id
					and staff_agent_id = v_creation.cofounder_id)
				or v_first.input_id is null
				or (select count(*) from public.qorpera_agent_first_runs where profile_id = v_creation.profile_id) <> 1
				or (select count(*) from public.qorpera_session_inputs where session_id = v_first.session_id
					and kind = 'kickoff') <> 1
				or not exists (select 1 from public.qorpera_runtime_agent_todos where profile_id = v_creation.profile_id
					and id = v_creation.first_todo_id and staff_agent_id = v_creation.cofounder_id) then
				v_problem := 'cofounder_mismatch';
				raise exception 'Company creation did not record its Co-Founder and first run' using errcode = 'QFC01';
			end if;
		exception when sqlstate 'QFC01' then
			null;
		end;
		perform set_config('qorpera.folder_company_create', '', true);
	end if;
	if v_problem = 'bytes_unverified' then
		-- The row stays leased; the worker releases it and restages.
		update public.qorpera_folder_company_creations set last_problem = v_problem, updated_at = clock_timestamp()
		where id = v_creation.id;
		return jsonb_build_object('schema', 'qorpera.company-creation/v1', 'creationId', v_creation.id, 'state', 'retry',
			'problem', v_problem);
	elsif v_problem is not null then
		update public.qorpera_folder_company_creations
		set state = 'failed', lease_owner = null, lease_until = null, last_problem = v_problem,
			failure = jsonb_strip_nulls(jsonb_build_object('code', v_problem, 'by', 'create', 'units',
				(select jsonb_agg(u order by (u ->> 'unit')::integer) from jsonb_array_elements(v_units) u
					where u ->> 'outcome' is distinct from 'saved'))),
			updated_at = clock_timestamp()
		where id = v_creation.id;
		return jsonb_build_object('schema', 'qorpera.company-creation/v1', 'creationId', v_creation.id, 'state', 'failed',
			'problem', v_problem);
	end if;
	-- After the folder clock: the creation row, already held. The files now hold the vision and the roles.
	v_answer := jsonb_build_object('schema', 'qorpera.company-creation/v1', 'creationId', v_creation.id,
		'state', 'completed', 'profileId', v_creation.profile_id, 'environmentId', v_creation.environment_id,
		'commitId', v_result ->> 'commitId', 'seq', (v_result ->> 'seq')::bigint, 'cofounderId', v_creation.cofounder_id,
		'firstRunInputId', v_first.input_id, 'replay', false);
	update public.qorpera_folder_company_creations
	set state = 'completed', lease_owner = null, lease_until = null, input = null, last_problem = null,
		commit_id = (v_result ->> 'commitId')::uuid, result = v_answer, completed_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = v_creation.id;
	return v_answer;
end $$;
revoke all on function public.qorpera_folder_company_creation_claim(uuid,integer),
	public.qorpera_folder_company_creation_release(uuid,uuid,bigint,text),
	public.qorpera_folder_company_creation_fail(uuid,uuid,bigint,text),
	public.qorpera_folder_company_create(uuid,uuid,bigint,jsonb)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_company_creation_claim(uuid,integer),
	public.qorpera_folder_company_creation_release(uuid,uuid,bigint,text),
	public.qorpera_folder_company_creation_fail(uuid,uuid,bigint,text),
	public.qorpera_folder_company_create(uuid,uuid,bigint,jsonb)
	to service_role;
revoke all on function public.qorpera_folder_company_creation_requeue(uuid,text)
	from public, anon, authenticated, service_role;

-- 7. The operator's path (C5 step 2, P38): revoked from every API role; the coordinator's lane calls them as the
-- owner role. ---------------------------------------------------------------------------------------------------------

-- Open for an account whose email is confirmed. No reason here: the lane calls operator_start right after, and that
-- reason is kept on the creation row.
create function public.qorpera_folder_company_operator_open(p_owner_user_id uuid, p_client_creation_id uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930010000 (P14a): the operator's open.
	if p_owner_user_id is null or not exists (select 1 from auth.users where id = p_owner_user_id
		and email_confirmed_at is not null) then
		raise exception 'A verified account is required' using errcode = '42501'; end if;
	return public.qorpera_folder_company_open(p_owner_user_id, p_client_creation_id, p_name);
end $$;

-- Start for a company the operator opened: never a lobby's company, the owner still its owner and with a usable
-- login (the first run is paid as the lobby's Start requires), then seed's own checks, with the owner as the only
-- founder and the kickoff's author.
create function public.qorpera_folder_company_operator_start(p_profile_id uuid, p_vision text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_member public.qorpera_profile_members%rowtype; v_sponsor jsonb; v_creation uuid;
begin
	-- 20260930010000 (P14a): the operator's start.
	if p_profile_id is null or p_vision is null or octet_length(p_vision) > 16384
		or p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
		raise exception 'Company start is invalid' using errcode = '22023'; end if;
	-- The fence and the company row as the lobby's Start takes them.
	perform 1 from public.qorpera_folder_fences where profile_id = p_profile_id for no key update;
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	select created_by_user_id into v_owner from public.qorpera_profiles where id = p_profile_id for no key update;
	if exists (select 1 from public.qorpera_company_foundings where profile_id = p_profile_id) then
		raise exception 'This company has a founding table' using errcode = '55000'; end if;
	select * into v_member from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_owner;
	if v_member.user_id is null or v_member.role <> 'owner' then
		raise exception 'The company''s owner must still own it' using errcode = '55000'; end if;
	-- A creation already recorded is answered as it is (its row is never locked here: create takes it before the fence).
	select id into v_creation from public.qorpera_folder_company_creations where profile_id = p_profile_id;
	if v_creation is not null then
		return jsonb_build_object('schema', 'qorpera.company-operator-start/v1', 'profileId', p_profile_id,
			'creationId', v_creation);
	end if;
	v_sponsor := public.qorpera_member_first_run_sponsor(p_profile_id, v_owner);
	if v_sponsor is null or not public.qorpera_sponsor_serves_requester(p_profile_id,
		(v_sponsor ->> 'sponsorBindingId')::uuid, (v_sponsor ->> 'sponsorVersion')::bigint, v_owner) then
		raise exception 'The owner''s ChatGPT account cannot pay for the first run' using errcode = '55000'; end if;
	v_creation := public.qorpera_folder_company_seed(p_profile_id, jsonb_build_object(
		'schema', 'qorpera.company-seed-input/v1',
		'companyName', (select name from public.qorpera_profiles where id = p_profile_id),
		'vision', p_vision, 'kickoffRequestedBy', v_owner,
		'founders', jsonb_build_array(jsonb_build_object('userId', v_owner, 'displayName', v_member.display_name,
			'role', ''))));
	-- The row seed inserted just now, in this transaction.
	update public.qorpera_folder_company_creations set operator_reason = btrim(p_reason) where id = v_creation;
	return jsonb_build_object('schema', 'qorpera.company-operator-start/v1', 'profileId', p_profile_id,
		'creationId', v_creation);
end $$;
revoke all on function public.qorpera_folder_company_operator_open(uuid,uuid,text),
	public.qorpera_folder_company_operator_start(uuid,text,text)
	from public, anon, authenticated, service_role;

-- 8. Patches to shared live functions (each inserted text names 20260930010000) ------------------------------------

-- The hook's apply: the creation commit's first run, after the agent's index row (and its staff-insert triggers).
select pg_temp.p14a_creation_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
$o$				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
$o$,
$n$				perform public.qorpera_company_state_index_agent(p_environment_id, v_profile, p_commit_id, v_user, v_file.path,
					v_version, v_entry -> 'parse', v_actor);
				-- 20260930010000 (P14a): inside a creation, the first run of the creation's own Co-Founder.
				perform public.qorpera_folder_company_first_run(p_environment_id, p_commit_id, (v_entry -> 'parse' ->> 'id')::uuid,
					v_version);
$n$);

-- The hub: a folder-v2 company is hidden until its creation is completed (one condition; the keys the web reads stay).
select pg_temp.p14a_creation_replace('public.qorpera_list_hosted_profiles()'::regprocedure,
$o$		and not exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = profile.id)
$o$,
$n$		and not exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = profile.id)
		-- 20260930010000 (P14a): a folder-v2 company shows once its creation is completed.
		and (not exists (select 1 from public.qorpera_company_files as file where file.profile_id = profile.id and file.core = 'folder-v2')
			or exists (select 1 from public.qorpera_folder_company_creations as creation where creation.profile_id = profile.id
				and creation.state = 'completed'))
$n$);

-- Departure: the member a creation runs for stays until it is made, as for a bootstrap job.
select pg_temp.p14a_creation_replace('public.qorpera_guard_founder_departure()'::regprocedure,
$o$		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	return coalesce(new, old);
$o$,
$n$		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	-- 20260930010000 (P14a): so does a folder-v2 creation, for the member who started it.
	if exists (select 1 from public.qorpera_folder_company_creations as creation
		where creation.profile_id = old.profile_id and creation.kickoff_user_id = old.user_id
			and creation.state in ('queued', 'leased')) then
		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	return coalesce(new, old);
$n$);

-- The team page's leave capability says the same.
select pg_temp.p14a_creation_replace('public.qorpera_profile_team_info(uuid)'::regprocedure,
$o$					where job.profile_id = p_profile_id and job.created_by_user_id = auth.uid()
						and job.state in ('queued', 'leased')),
$o$,
$n$					where job.profile_id = p_profile_id and job.created_by_user_id = auth.uid()
						and job.state in ('queued', 'leased'))
				-- 20260930010000 (P14a): nor a folder-v2 creation.
				and not exists (select 1 from public.qorpera_folder_company_creations as creation
					where creation.profile_id = p_profile_id and creation.kickoff_user_id = auth.uid()
						and creation.state in ('queued', 'leased')),
$n$);

-- Company delete: creations not yet made are blocked, SKIP LOCKED, as runner jobs.
select pg_temp.p14a_creation_replace('public.qorpera_stop_company_work(uuid)'::regprocedure,
$o$	where profile_id = p_profile_id and state in ('queued', 'leased');

	-- Coding:$o$,
$n$	where profile_id = p_profile_id and state in ('queued', 'leased');
	-- 20260930010000 (P14a): a folder-v2 creation not yet made is blocked. One a worker holds now (its row sits before
	-- the fence) is skipped: it refuses after its fence (the pause covers a deletion) or completes, and the finisher's next
	-- pass marks it. A release never turns blocked back into queued.
	update public.qorpera_folder_company_creations
	set state = 'blocked', lease_owner = null, lease_until = null, input = null, last_problem = 'company_deleted',
		updated_at = clock_timestamp()
	where id in (select creation.id from public.qorpera_folder_company_creations as creation
		where creation.profile_id = p_profile_id and creation.state in ('queued', 'leased') for update skip locked);

	-- Coding:$n$);

-- The old chain's job refuses folder-v2 (its old body stays as it was).
select pg_temp.p14a_creation_replace('public.qorpera_enqueue_company_bootstrap(uuid,boolean)'::regprocedure,
$o$	v_job public.qorpera_company_bootstrap_jobs%rowtype; v_owner uuid;
begin
$o$,
$n$	v_job public.qorpera_company_bootstrap_jobs%rowtype; v_owner uuid;
begin
	-- 20260930010000 (P14a): a folder-v2 company never runs the old chain.
	if public.qorpera_company_is_folder_v2(p_profile_id) then
		raise exception 'The folder core sets this company up' using errcode = '55000'; end if;
$n$);

-- The founders' table: start.companySetup.
select pg_temp.p14a_creation_replace('public.qorpera_company_founding_json(uuid)'::regprocedure,
$o$'companyReady',public.qorpera_folder_company_ready(p_profile_id)) end);$o$,
$n$'companyReady',public.qorpera_folder_company_ready(p_profile_id),
			-- 20260930010000 (P14a): pending, ready or failed.
			'companySetup',public.qorpera_folder_company_setup(p_profile_id)) end);$n$);

-- qorpera_folder_enable: a role check around qorpera_folder_enable_internal (which adds the bootstrap-job refusal). The
-- body it replaces is the 20260928259260 text; anything else refuses this migration.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_folder_enable(uuid)'::regprocedure);
begin
	if md5(v_definition) <> '996d0e2f633aec92788d1a1fe796d447' then
		raise exception 'qorpera_folder_enable differs from 20260928259260'; end if;
end $$;
create or replace function public.qorpera_folder_enable(p_environment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930010000 (P14a): the service role's call; Open uses the internal body as the member.
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	return public.qorpera_folder_enable_internal(p_environment_id);
end $$;
