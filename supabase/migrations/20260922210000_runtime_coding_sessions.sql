-- Step 9, part 1 (contract 13.1): a coding session is a sponsored worker.
--
-- The agent starts it, one member owns and pays for it, one harness runs it.
-- Nothing new is invented for that: the worker row of Order 5 gets the species
-- "coding" and an owner binding, whose sponsor is the member's own provider
-- connection instead of the agent's standing authority. The session row keeps
-- what must survive turns (repository, branch, harness session, PR), and an
-- append-only event stream feeds the thread element. The parent is woken by
-- the Order 5 completion path; there is no second listener.
--
-- No executor is enabled and no repository is granted by this migration.

-- ---------------------------------------------------------------------------
-- The worker row: species and owner
-- ---------------------------------------------------------------------------
alter table public.qorpera_runtime_workers
	drop constraint qorpera_runtime_workers_species_check,
	add constraint qorpera_runtime_workers_species_check check (species in ('in-house','coding')),
	drop constraint qorpera_runtime_workers_sequence_check,
	add constraint qorpera_runtime_workers_sequence_check
		check (sequence between 1 and case when species = 'coding' then 64 else 12 end),
	add column owner_user_id uuid references auth.users(id) on delete restrict,
	add column owner_sponsor_binding_id uuid,
	add column owner_sponsor_version bigint,
	add constraint qorpera_runtime_workers_owner_check check (
		(species = 'in-house' and owner_user_id is null and owner_sponsor_binding_id is null and owner_sponsor_version is null)
		or (species = 'coding' and owner_user_id is not null and owner_sponsor_binding_id is not null and owner_sponsor_version is not null)),
	add foreign key (owner_sponsor_binding_id, owner_sponsor_version)
		references public.qorpera_execution_sponsor_versions(binding_id, version) on delete restrict;

-- ---------------------------------------------------------------------------
-- Deployment configuration: executors and repository grants
-- ---------------------------------------------------------------------------
create function public.qorpera_coding_repository_valid(p_repository jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_repository) = 'object'
		and p_repository - array['host','owner','name','baseBranch'] = '{}'::jsonb
		and p_repository ->> 'host' = 'github.com'
		and jsonb_typeof(p_repository -> 'owner') = 'string'
		and p_repository ->> 'owner' ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
		and jsonb_typeof(p_repository -> 'name') = 'string'
		and p_repository ->> 'name' ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$'
		and jsonb_typeof(p_repository -> 'baseBranch') = 'string'
		and p_repository ->> 'baseBranch' ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
		and p_repository ->> 'baseBranch' not like '%..%'
		and not exists (select 1 from unnest(string_to_array(p_repository ->> 'baseBranch','/')) part
			where part = '' or left(part,1) = '.' or right(part,1) = '.' or right(part,5) = '.lock'), false)
$$;

create table public.qorpera_coding_executors (
	environment_id uuid primary key references public.qorpera_company_environments(id) on delete restrict,
	owner text not null check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	enabled boolean not null default false,
	harnesses text[] not null default array['codex'] check (harnesses <@ array['codex','claude-code'] and cardinality(harnesses) >= 1),
	updated_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_coding_repository_grants (
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	staff_agent_id uuid not null,
	repository jsonb not null check (public.qorpera_coding_repository_valid(repository)),
	enabled boolean not null default false,
	primary key (environment_id, staff_agent_id, repository)
);

-- ---------------------------------------------------------------------------
-- The session and its event stream
-- ---------------------------------------------------------------------------
create table public.qorpera_coding_sessions (
	worker_id uuid primary key references public.qorpera_runtime_workers(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	harness text not null check (harness in ('codex','claude-code')),
	model text check (model is null or model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
	repository jsonb not null check (public.qorpera_coding_repository_valid(repository)),
	branch text not null unique,
	base_sha text check (base_sha is null or base_sha ~ '^[0-9a-f]{40}$'),
	-- queued: waiting for an executor; input_ready: a follow-up or answer arrived; the rest are the executor's.
	phase text not null default 'queued' check (phase in
		('queued','preparing','running','awaiting_input','input_ready','publishing','completed','failed','cancelled')),
	lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	lease_token uuid,
	lease_until timestamptz,
	harness_session_ref text check (harness_session_ref is null or octet_length(harness_session_ref) between 1 and 512),
	vm_allocation_id uuid,
	storage_volume_id uuid,
	pull_request jsonb check (pull_request is null or (jsonb_typeof(pull_request) = 'object' and pg_column_size(pull_request) <= 4096)),
	checks jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array' and pg_column_size(checks) <= 8192),
	artifacts jsonb not null default '[]'::jsonb check (jsonb_typeof(artifacts) = 'array' and pg_column_size(artifacts) <= 8192),
	last_step text check (last_step is null or octet_length(last_step) between 1 and 200),
	files_changed integer not null default 0 check (files_changed >= 0),
	started_at timestamptz,
	finished_at timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check ((lease_token is null) = (lease_until is null) and (lease_token is null) = (lease_owner is null))
);
create index qorpera_coding_sessions_claimable on public.qorpera_coding_sessions (environment_id, updated_at)
	where phase in ('queued','input_ready','preparing','running','publishing');

create table public.qorpera_coding_session_events (
	id bigint generated always as identity primary key,
	worker_id uuid not null references public.qorpera_coding_sessions(worker_id) on delete restrict,
	sequence integer not null check (sequence > 0),
	kind text not null check (kind in ('phase','step','text','needs_input','input','delegated','published','finished','failed')),
	actor text not null check (actor in ('kernel','harness','member','agent','executor')),
	body jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object' and pg_column_size(body) <= 16384),
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_coding_session_events_stream on public.qorpera_coding_session_events (worker_id, id);

do $$ declare n text; begin
	foreach n in array array['qorpera_coding_executors','qorpera_coding_repository_grants','qorpera_coding_sessions','qorpera_coding_session_events'] loop
		execute format('alter table public.%I enable row level security', n);
		execute format('revoke all on public.%I from public, anon, authenticated, service_role', n);
	end loop;
end $$;

create function public.qorpera_coding_event(p_worker_id uuid, p_sequence integer, p_kind text, p_actor text, p_body jsonb default '{}'::jsonb)
returns bigint language sql volatile security definer set search_path = '' as $$
	insert into public.qorpera_coding_session_events (worker_id, sequence, kind, actor, body)
	values (p_worker_id, p_sequence, p_kind, p_actor, coalesce(p_body, '{}'::jsonb)) returning id
$$;

-- The thread element renders from this, never from the agent's prose.
create function public.qorpera_coding_session_view(p_session public.qorpera_coding_sessions, p_worker public.qorpera_runtime_workers)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-session/v1','workerId',p_worker.id,'workerKey',p_worker.worker_key,
		'title',p_worker.title,'agentId',p_worker.staff_agent_id,'ownerUserId',p_worker.owner_user_id,
		'harness',p_session.harness,'model',p_session.model,'repository',p_session.repository,'branch',p_session.branch,
		'baseSha',p_session.base_sha,'sequence',p_worker.sequence,'workerState',p_worker.state,'phase',p_session.phase,
		'lastStep',p_session.last_step,'filesChanged',p_session.files_changed,'pullRequest',p_session.pull_request,
		'checks',p_session.checks,'artifacts',p_session.artifacts,'needs',p_worker.result ->> 'needs',
		'summary',p_worker.result ->> 'summary','startedAt',p_session.started_at,'finishedAt',p_session.finished_at,
		'updatedAt',p_session.updated_at,'harnessSessionRef',p_session.harness_session_ref)
$$;

-- ---------------------------------------------------------------------------
-- The owner's sponsor: the member's own connection for the harness's provider
-- ---------------------------------------------------------------------------
-- Returns the sponsor version the coding wakes run under. The member must own
-- an active connection for the provider, at a version that allows autonomous
-- use: that flag is the member's standing consent for background work on their
-- account. An existing member_connection sponsor is reused; otherwise one is
-- bound under a deterministic client id so repeated dispatches never fork it.
create function public.qorpera_coding_owner_sponsor(p_profile_id uuid, p_owner_user_id uuid, p_harness text)
returns table (binding_id uuid, version bigint, connection_id uuid, connection_version bigint)
language plpgsql volatile security definer set search_path = '' as $$
declare v_provider text; v_native text; v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype; v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_client uuid;
begin
	v_provider := case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end;
	v_native := case p_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end;
	if v_provider is null then raise exception 'Coding harness is unknown' using errcode = '22023'; end if;
	if not exists (select 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = p_owner_user_id) then
		raise exception 'The session owner is not a member of this company' using errcode = '42501'; end if;
	select connection.* into v_connection
	from public.qorpera_provider_connections connection
	where connection.profile_id = p_profile_id and connection.owner_user_id = p_owner_user_id
		and connection.provider = v_provider and connection.status = 'active'
		and exists (select 1 from public.qorpera_provider_connection_versions v where v.connection_id = connection.id
			and v.authorization_state = 'active' and v.native_harness = v_native)
	order by connection.created_at desc limit 1;
	if v_connection.id is not null then
		select v.* into v_version from public.qorpera_provider_connection_versions v where v.connection_id = v_connection.id
			and v.authorization_state = 'active' and v.native_harness = v_native order by v.version desc limit 1;
	end if;
	if v_connection.id is null then
		raise exception 'The session owner has no active % account connected for %', v_provider, p_harness using errcode = '42501'; end if;
	if not v_version.allow_autonomous then
		raise exception 'The session owner has not allowed background work on their % account', v_provider using errcode = '42501'; end if;
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions sponsor
	join public.qorpera_execution_sponsor_bindings b on b.id = sponsor.binding_id
	where b.profile_id = p_profile_id and b.status = 'active' and sponsor.sponsor_kind = 'member_connection'
		and sponsor.provider_connection_id = v_connection.id and sponsor.provider_connection_version = v_version.version
		and sponsor.created_by_user_id = p_owner_user_id and sponsor.allow_autonomous
		and sponsor.version = (select max(later.version) from public.qorpera_execution_sponsor_versions later where later.binding_id = b.id)
	order by sponsor.created_at desc limit 1;
	if v_sponsor.binding_id is null then
		v_client := encode(extensions.digest(convert_to('qorpera-coding-owner:' || v_connection.id::text || ':' || v_version.version::text, 'utf8'), 'sha256'), 'hex')::text;
		v_client := (left(v_client, 8) || '-' || substr(v_client, 9, 4) || '-4' || substr(v_client, 14, 3) || '-8' || substr(v_client, 18, 3) || '-' || substr(v_client, 21, 12))::uuid;
		select * into v_binding from public.qorpera_execution_sponsor_bindings where profile_id = p_profile_id and client_binding_id = v_client for update;
		if v_binding.id is null then
			insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
			values (p_profile_id, v_client, p_owner_user_id) returning * into v_binding;
		elsif v_binding.created_by_user_id <> p_owner_user_id or v_binding.status <> 'active' then
			raise exception 'The session owner''s sponsor binding is unavailable' using errcode = '42501'; end if;
		select sponsor.* into v_sponsor from public.qorpera_execution_sponsor_versions sponsor
		where sponsor.binding_id = v_binding.id order by sponsor.version desc limit 1;
		if v_sponsor.binding_id is null or v_sponsor.provider_connection_version <> v_version.version or not v_sponsor.allow_autonomous then
			insert into public.qorpera_execution_sponsor_versions (binding_id, version, sponsor_kind, provider_connection_id,
				provider_connection_version, allow_autonomous, created_by_user_id)
			values (v_binding.id, coalesce(v_sponsor.version, 0) + 1, 'member_connection', v_connection.id, v_version.version, true, p_owner_user_id)
			returning * into v_sponsor;
		end if;
	end if;
	binding_id := v_sponsor.binding_id; version := v_sponsor.version; connection_id := v_connection.id; connection_version := v_version.version;
	return next;
end
$$;

-- ---------------------------------------------------------------------------
-- Admission: a coding wake runs under the owner's sponsor, not the agent's
-- ---------------------------------------------------------------------------
create function pg_temp.coding_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.coding_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id end;$old$,
	$new$		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id end;
		if new.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
			where w.id = new.source_id and w.species = 'coding') then
			select w.owner_sponsor_binding_id, w.owner_sponsor_version into new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_runtime_workers w where w.id = new.source_id;
		end if;$new$);

select pg_temp.coding_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$		if not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and sponsor_binding_id = p_wake.sponsor_binding_id
			and sponsor_version = v_standing_version
			and logical_computer_id is not distinct from p_wake.logical_computer_id) then return false; end if;$old$,
	$new$		if not (p_wake.source_kind = 'worker-dispatch' and exists (select 1 from public.qorpera_runtime_workers w
				where w.id = p_wake.source_id and w.species = 'coding' and w.profile_id = p_wake.profile_id
					and w.owner_sponsor_binding_id = p_wake.sponsor_binding_id and w.owner_sponsor_version = p_wake.sponsor_version
					and exists (select 1 from public.qorpera_profile_members m where m.profile_id = w.profile_id and m.user_id = w.owner_user_id)))
			and not exists(select 1 from public.qorpera_staff_execution_authorities where profile_id = p_wake.profile_id
			and staff_agent_id = p_wake.staff_agent_id and sponsor_binding_id = p_wake.sponsor_binding_id
			and sponsor_version = v_standing_version
			and logical_computer_id is not distinct from p_wake.logical_computer_id) then return false; end if;$new$);

-- A coding run's finished wake is not the worker's report: the executor
-- publishes after the run and reports then. Only in-house children fail here.
select pg_temp.coding_patch('public.qorpera_drain_worker_wakes(integer)'::regprocedure,
	$old$				elsif v_wake_status in ('completed','failed','cancelled','requires_review') then$old$,
	$new$				elsif v_worker.species = 'in-house' and v_wake_status in ('completed','failed','cancelled','requires_review') then$new$);

-- ---------------------------------------------------------------------------
-- Cancellation also settles the session
-- ---------------------------------------------------------------------------
create or replace function public.qorpera_cancel_worker(p_worker public.qorpera_runtime_workers, p_run_id uuid, p_reason text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
	-- A queued dispatch never starts; a running child is fenced at its next governed effect and cannot report.
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(),
		blocked_reason = 'Worker was cancelled' where id = p_worker.occurrence_id and status = 'queued';
	update public.qorpera_runtime_workers set state = 'cancelled', epoch = epoch + 1, completion_state = 'suppressed',
		result = jsonb_build_object('outcome','cancelled','summary','Cancelled before it reported.','reason',p_reason,'outputs','[]'::jsonb),
		reported_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_worker.id and state = 'active';
	if found then
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (p_worker.id, p_worker.sequence, 'cancelled', p_run_id, jsonb_build_object('reason', p_reason));
		if p_worker.species = 'coding' then
			-- The executor sees the phase at its next heartbeat and stops the turn; the workspace is kept.
			update public.qorpera_coding_sessions set phase = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(),
				lease_owner = null, lease_token = null, lease_until = null where worker_id = p_worker.id;
			perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, 'phase', 'kernel', jsonb_build_object('phase','cancelled','reason',p_reason));
		end if;
	end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Dispatch and follow-up: the coding species on manage_worker
-- ---------------------------------------------------------------------------
-- Queues a coding turn for the executor. In-house workers are admitted through
-- the wake bus at once; a coding turn needs its VM first, so the executor
-- admits the wake when the workspace is ready (qorpera_begin_coding_turn).
create function public.qorpera_coding_session_queue(p_worker public.qorpera_runtime_workers, p_action text, p_run_id uuid, p_text text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
	update public.qorpera_coding_sessions set phase = case p_action when 'dispatch' then 'queued' else 'input_ready' end,
		finished_at = null, lease_owner = null, lease_token = null, lease_until = null, updated_at = clock_timestamp()
	where worker_id = p_worker.id;
	perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, case p_action when 'dispatch' then 'phase' else 'input' end,
		case p_action when 'dispatch' then 'kernel' else 'agent' end,
		case p_action when 'dispatch' then jsonb_build_object('phase','queued') else jsonb_build_object('text', p_text, 'runId', p_run_id) end);
end
$$;

create or replace function public.qorpera_manage_agent_worker(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_action text := p_request ->> 'action';
	v_todo public.qorpera_runtime_agent_todos%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_digest text; v_receipt uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb; v_allowed text[];
	v_dispatch jsonb; v_source jsonb; v_wake public.qorpera_wake_occurrences%rowtype; v_occurrence uuid; v_text text;
	v_species text; v_owner uuid; v_sponsor_binding uuid; v_sponsor_version bigint;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	-- Only the agent's own ordinary run dispatches; a worker cannot delegate further (13).
	if v_run.staff_agent_id is null or v_run.audience_kind <> 'company' or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Worker authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or v_action is null
		or v_action not in ('status','dispatch','followup','cancel','decide') then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;

	if v_action = 'status' then
		if exists (select 1 from jsonb_object_keys(p_request) key where key not in ('action','todoKey','workerKey'))
			or (p_request ? 'todoKey' and coalesce(p_request ->> 'todoKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$')
			or (p_request ? 'workerKey' and (not p_request ? 'todoKey'
				or coalesce(p_request ->> 'workerKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$')) then
			raise exception 'Worker request is invalid' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.agent-workers/v1','runId',v_run.id,'workers',coalesce((
			-- One named worker is shown in full; a listing keeps summaries short so many fit one result.
			select jsonb_agg(public.qorpera_worker_view(listed.worker, p_request ? 'workerKey') || jsonb_build_object('todoKey', listed.todo_key)
				|| coalesce((select jsonb_build_object('coding', public.qorpera_coding_session_view(session, listed.worker))
					from public.qorpera_coding_sessions session where session.worker_id = (listed.worker).id), '{}'::jsonb)
				order by (listed.worker).updated_at desc, (listed.worker).id) from (
				select worker, todo.todo_key from public.qorpera_runtime_workers worker
				join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
				where worker.profile_id = v_run.profile_id and worker.environment_id = v_run.environment_id
					and worker.staff_agent_id = v_run.staff_agent_id
					and (p_request ->> 'todoKey' is null or todo.todo_key = p_request ->> 'todoKey')
					and (p_request ->> 'workerKey' is null or worker.worker_key = p_request ->> 'workerKey')
					and (p_request ->> 'todoKey' is not null or todo.state in ('open','blocked')
						or worker.updated_at > clock_timestamp() - interval '7 days')
				order by worker.updated_at desc, worker.id limit 16) listed), '[]'::jsonb));
	end if;

	v_allowed := case v_action
		when 'dispatch' then array['action','operationKey','todoKey','workerKey','title','goal','definitionOfDone','context','sources','access','revival',
			'species','harness','repository','owner']
		when 'followup' then array['action','operationKey','todoKey','workerKey','text']
		when 'decide' then array['action','operationKey','todoKey','workerKey','decision','note']
		else array['action','operationKey','todoKey','workerKey'] end;
	if exists (select 1 from jsonb_object_keys(p_request) key where key <> all(v_allowed))
		or coalesce(p_request ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(p_request ->> 'todoKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
		or coalesce(p_request ->> 'workerKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
		or position(E'\\u0000' in (p_request::text)) > 0 then
		raise exception 'Worker request is invalid' using errcode = '22023'; end if;

	if v_action = 'dispatch' then
		-- Contract 13: a blank child receives a complete dispatch. Nothing is inferred from the parent's conversation.
		if octet_length(btrim(coalesce(p_request ->> 'title',''))) not between 1 and 200 or (p_request ->> 'title') ~ E'[\r\n]'
			or octet_length(btrim(coalesce(p_request ->> 'goal',''))) not between 1 and 4000
			or octet_length(btrim(coalesce(p_request ->> 'definitionOfDone',''))) not between 1 and 2000
			or octet_length(coalesce(p_request ->> 'context','')) > 4000
			or coalesce(p_request ->> 'access','') not in ('read','write')
			or coalesce(p_request ->> 'revival','batch') not in ('each','batch')
			or (p_request ? 'sources' and (jsonb_typeof(p_request -> 'sources') <> 'array' or jsonb_array_length(p_request -> 'sources') > 8)) then
			raise exception 'Worker dispatch is incomplete or exceeds its bounds' using errcode = '22023'; end if;
		for v_source in select value from jsonb_array_elements(coalesce(p_request -> 'sources','[]'::jsonb)) loop
			if jsonb_typeof(v_source) <> 'string' or octet_length(v_source #>> '{}') not between 1 and 512 then
				raise exception 'Worker source is invalid' using errcode = '22023'; end if;
			-- A source the agent and its requester cannot read is not a source.
			if not coalesce(public.qorpera_wake_path_authorized(v_run.environment_id, v_run.requested_by_user_id,
				v_run.staff_agent_id, v_source #>> '{}'), false) then
				raise exception 'Worker source is unavailable' using errcode = '42501'; end if;
		end loop;
		-- A coding session (13.1): one harness, one granted repository, one owning member whose account pays.
		v_species := coalesce(p_request ->> 'species', 'in-house');
		if v_species not in ('in-house','coding')
			or (v_species = 'in-house' and (p_request ? 'harness' or p_request ? 'repository' or p_request ? 'owner')) then
			raise exception 'Worker species is invalid' using errcode = '22023'; end if;
		if v_species = 'coding' then
			if coalesce(p_request ->> 'harness','') not in ('codex','claude-code')
				or not public.qorpera_coding_repository_valid(p_request -> 'repository')
				or p_request ->> 'access' <> 'read'
				or (p_request ? 'owner' and coalesce(p_request ->> 'owner','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
				raise exception 'A coding session needs a harness, a repository and read access' using errcode = '22023'; end if;
			v_owner := coalesce((p_request ->> 'owner')::uuid, v_run.requested_by_user_id);
			if not exists (select 1 from public.qorpera_coding_executors executor where executor.environment_id = v_run.environment_id
				and executor.enabled and (p_request ->> 'harness') = any(executor.harnesses)) then
				raise exception 'No coding executor serves this company for %', p_request ->> 'harness' using errcode = '55000'; end if;
			if not exists (select 1 from public.qorpera_coding_repository_grants grant_row where grant_row.environment_id = v_run.environment_id
				and grant_row.staff_agent_id = v_run.staff_agent_id and grant_row.repository = p_request -> 'repository' and grant_row.enabled) then
				raise exception 'This agent has no grant for that repository' using errcode = '42501'; end if;
			select sponsor.binding_id, sponsor.version into v_sponsor_binding, v_sponsor_version
			from public.qorpera_coding_owner_sponsor(v_run.profile_id, v_owner, p_request ->> 'harness') sponsor;
		end if;
	elsif v_action = 'followup' then
		v_text := btrim(coalesce(p_request ->> 'text',''));
		if octet_length(v_text) not between 1 and 4000 then raise exception 'Worker follow-up is invalid' using errcode = '22023'; end if;
	elsif v_action = 'decide' then
		if coalesce(p_request ->> 'decision','') not in ('accept','reject') or octet_length(coalesce(p_request ->> 'note','')) > 1000 then
			raise exception 'Worker decision is invalid' using errcode = '22023'; end if;
	end if;

	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding, v_receipt, 'worker:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':worker:' || (p_request ->> 'operationKey'),'utf8'),'sha256'),'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'state' <> 'executing' or (v_begun ->> 'receiptId')::uuid <> v_receipt then
		raise exception 'Worker operation needs reconciliation' using errcode = '55000'; end if;

	select * into v_todo from public.qorpera_runtime_agent_todos todo
	where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
		and todo.staff_agent_id = v_run.staff_agent_id and todo.todo_key = p_request ->> 'todoKey' for update;
	if v_todo.id is null then raise exception 'Todo is unavailable; create it first' using errcode = 'P0002'; end if;
	select * into v_worker from public.qorpera_runtime_workers worker
	where worker.todo_id = v_todo.id and worker.worker_key = p_request ->> 'workerKey' for update;

	if v_action in ('dispatch','followup') then
		if v_todo.state not in ('open','blocked') then
			raise exception 'Todo is closed; use a new todo for new work' using errcode = '55000'; end if;
		if not exists (select 1 from public.qorpera_staff_execution_authorities authority
			where authority.profile_id = v_run.profile_id and authority.staff_agent_id = v_run.staff_agent_id) then
			raise exception 'No model account is set up for background work by this agent' using errcode = '55000'; end if;
		if (select count(*) from public.qorpera_runtime_workers worker where worker.profile_id = v_run.profile_id
			and worker.staff_agent_id = v_run.staff_agent_id and worker.state = 'active') >= 4 then
			raise exception 'Four workers are already active; wait for one or cancel one' using errcode = '54000'; end if;
		if (select count(*) from public.qorpera_runtime_worker_events event join public.qorpera_runtime_workers worker on worker.id = event.worker_id
			where worker.profile_id = v_run.profile_id and worker.staff_agent_id = v_run.staff_agent_id
				and event.kind in ('dispatched','followup') and event.created_at > clock_timestamp() - interval '1 hour') >= 24 then
			raise exception 'Worker dispatch limit for this hour is reached' using errcode = '54000'; end if;
	end if;

	if v_action = 'dispatch' then
		if v_worker.id is not null then
			raise exception 'This worker already exists; steer it with a follow-up instead of a second dispatch' using errcode = '55000'; end if;
		if (select count(*) from public.qorpera_runtime_workers worker where worker.todo_id = v_todo.id) >= 8 then
			raise exception 'This todo already has eight workers' using errcode = '54000'; end if;
		-- One coding session per owner and harness at a time: the owner's plan is one person's plan.
		if v_species = 'coding' and exists (select 1 from public.qorpera_runtime_workers worker
			join public.qorpera_coding_sessions session on session.worker_id = worker.id
			where worker.profile_id = v_run.profile_id and worker.owner_user_id = v_owner and worker.state = 'active'
				and session.harness = p_request ->> 'harness') then
			raise exception 'The owner already has a coding session running in %; wait for it or follow it up', p_request ->> 'harness' using errcode = '54000'; end if;
		v_dispatch := jsonb_build_object('goal', btrim(p_request ->> 'goal'), 'definitionOfDone', btrim(p_request ->> 'definitionOfDone'),
			'context', coalesce(p_request ->> 'context',''), 'sources', coalesce(p_request -> 'sources','[]'::jsonb),
			'followUp', null,
			'authority', case when v_species = 'coding'
				then 'Work only in the repository and branch the cloud selected. Company File sources are read-only context. Publication is a draft PR through the trusted path.'
				when p_request ->> 'access' = 'write'
				then 'Read what this agent may read. Write only inside outputFolder, or where this agent already holds a write grant.'
				else 'Read what this agent may read. Write nothing.' end,
			'output', case when v_species = 'coding'
				then 'Finish through coding_finish with the commit to publish, or ask the owner through coding_ask when a decision is theirs.'
				else 'Report once through report_work: outcome, a summary the parent can act on, and the files you wrote.' end,
			'cancellation', 'Ends with its todo, or when the parent cancels it. A cancelled worker cannot report.',
			'completion', case when coalesce(p_request ->> 'revival','batch') = 'each' then 'The parent is revived as soon as you report.'
				else 'The parent is revived once every worker it dispatched together has reported, or at once when you are blocked.' end);
		insert into public.qorpera_runtime_workers(profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access, revival,
			dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
		values (v_run.profile_id, v_run.environment_id, v_run.staff_agent_id, v_todo.id, p_request ->> 'workerKey', v_species,
			btrim(p_request ->> 'title'), p_request ->> 'access', coalesce(p_request ->> 'revival','batch'), v_dispatch,
			v_run.requested_by_user_id, v_run.id, v_owner, v_sponsor_binding, v_sponsor_version) returning * into v_worker;
		if v_species = 'coding' then
			insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch)
			values (v_worker.id, v_run.profile_id, v_run.environment_id, p_request ->> 'harness', p_request -> 'repository',
				'qorpera/coding/' || v_worker.id::text);
		end if;
	elsif v_worker.id is null then raise exception 'Worker is unavailable' using errcode = 'P0002';
	elsif v_action = 'followup' then
		-- One worker per coherent stream: the same worker continues with its own history.
		if v_worker.state = 'active' then
			raise exception 'This worker is still working; wait for its report or cancel it' using errcode = '55000'; end if;
		-- A coding session keeps its branch, workspace and PR through cancellation; an in-house worker does not.
		if (v_worker.species = 'in-house' and (v_worker.state = 'cancelled' or v_worker.sequence >= 12))
			or (v_worker.species = 'coding' and v_worker.sequence >= 64) then
			raise exception 'This worker cannot continue; dispatch a new one' using errcode = '55000'; end if;
		update public.qorpera_runtime_workers set sequence = sequence + 1, state = 'active', result = null, reported_at = null,
			acceptance = null, acceptance_note = null, accepted_by_run_id = null, accepted_at = null,
			-- An earlier delivery stays in the wake ledger; the row tracks the current sequence only.
			completion_state = 'none', completion_occurrence_id = null, occurrence_id = case when species = 'coding' then null else occurrence_id end,
			dispatch = dispatch || jsonb_build_object('followUp', v_text), steering_run_id = v_run.id, updated_at = clock_timestamp()
		where id = v_worker.id returning * into v_worker;
	elsif v_action = 'cancel' then
		perform public.qorpera_cancel_worker(v_worker, v_run.id, 'parent_cancelled');
		select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
	else
		if v_worker.state = 'active' or (p_request ->> 'decision' = 'accept' and v_worker.state <> 'succeeded') then
			raise exception 'Only a finished, successful result can be accepted' using errcode = '55000'; end if;
		update public.qorpera_runtime_workers set acceptance = case p_request ->> 'decision' when 'accept' then 'accepted' else 'rejected' end,
			acceptance_note = nullif(btrim(coalesce(p_request ->> 'note','')),''), accepted_by_run_id = v_run.id, accepted_at = clock_timestamp(),
			completion_state = case when completion_state = 'waiting' then 'suppressed' else completion_state end, updated_at = clock_timestamp()
		where id = v_worker.id returning * into v_worker;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, case p_request ->> 'decision' when 'accept' then 'accepted' else 'rejected' end, v_run.id,
			jsonb_build_object('note', v_worker.acceptance_note));
	end if;

	if v_action in ('dispatch','followup') and v_worker.species = 'in-house' then
		v_occurrence := extensions.gen_random_uuid();
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
			parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
		values (v_occurrence, v_run.profile_id, v_run.environment_id, 'agent', 'worker-dispatch', v_worker.id, v_run.staff_agent_id,
			v_run.id, 'worker-dispatch', 'worker-dispatch:' || v_worker.id::text || ':' || v_worker.sequence::text,
			clock_timestamp(), clock_timestamp(), public.qorpera_worker_dispatch_payload(v_worker, v_todo))
		returning * into v_wake;
		if v_wake.status <> 'queued' then
			raise exception 'Background work cannot start now: %', coalesce(v_wake.blocked_reason,'refused') using errcode = '55000'; end if;
		update public.qorpera_runtime_workers set occurrence_id = v_occurrence where id = v_worker.id returning * into v_worker;
	elsif v_action in ('dispatch','followup') then
		perform public.qorpera_coding_session_queue(v_worker, v_action, v_run.id, v_text);
	end if;
	if v_action in ('dispatch','followup') then
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, case v_action when 'dispatch' then 'dispatched' else 'followup' end, v_run.id,
			case v_action when 'dispatch' then v_worker.dispatch else jsonb_build_object('text', v_text) end);
	end if;
	v_todo := public.qorpera_touch_agent_todo(v_todo.id, v_run.id);

	v_result := jsonb_build_object('schema','qorpera.agent-worker-receipt/v1','runId',v_run.id,'receiptId',v_receipt,'action',v_action,
		'todoKey',v_todo.todo_key,'worker',public.qorpera_worker_view(v_worker),
		'publication',public.qorpera_agent_todo_document(v_todo))
		|| coalesce((select jsonb_build_object('coding', public.qorpera_coding_session_view(session, v_worker))
			from public.qorpera_coding_sessions session where session.worker_id = v_worker.id), '{}'::jsonb);
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_result);
	return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- The owner talks to the session; nobody else does
-- ---------------------------------------------------------------------------
create function public.qorpera_coding_session_owner_row(p_worker_id uuid)
returns public.qorpera_runtime_workers language plpgsql volatile security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype;
begin
	if auth.uid() is null then raise exception 'Sign in to answer a coding session' using errcode = '42501'; end if;
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id and species = 'coding' for update;
	if v_worker.id is null or not public.qorpera_can_read_profile(v_worker.profile_id) then
		raise exception 'Coding session is unavailable' using errcode = '42501'; end if;
	if v_worker.owner_user_id <> auth.uid() then
		raise exception 'Only the owner of this coding session can talk to it; ask the agent to steer it' using errcode = '42501'; end if;
	return v_worker;
end
$$;

-- The owner's answer or follow-up: the same continuation the agent's follow-up
-- makes, attributed to the member and recorded in the thread as an event.
create function public.qorpera_answer_coding_session(p_worker_id uuid, p_text text, p_client_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype; v_text text := btrim(coalesce(p_text,''));
	v_todo public.qorpera_runtime_agent_todos%rowtype;
begin
	if p_client_request_id is null or octet_length(v_text) not between 1 and 4000 or position(E'\\u0000' in v_text) > 0 then
		raise exception 'Coding session answer is invalid' using errcode = '22023'; end if;
	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id for update;
	if exists (select 1 from public.qorpera_coding_session_events event where event.worker_id = v_worker.id
		and event.kind = 'input' and event.body ->> 'clientRequestId' = p_client_request_id::text) then
		return public.qorpera_coding_session_view(v_session, v_worker); end if;
	if v_worker.state = 'active' then
		raise exception 'The session is still working; wait for its question or its result' using errcode = '55000'; end if;
	if v_worker.sequence >= 64 then raise exception 'This session cannot continue; start a new one' using errcode = '55000'; end if;
	perform 1 from public.qorpera_runtime_agent_todos where id = v_worker.todo_id for update;
	update public.qorpera_runtime_workers set sequence = sequence + 1, state = 'active', result = null, reported_at = null,
		acceptance = null, acceptance_note = null, accepted_by_run_id = null, accepted_at = null,
		completion_state = 'none', completion_occurrence_id = null, occurrence_id = null,
		dispatch = dispatch || jsonb_build_object('followUp', v_text), updated_at = clock_timestamp()
	where id = v_worker.id returning * into v_worker;
	update public.qorpera_coding_sessions set phase = 'input_ready', finished_at = null, lease_owner = null, lease_token = null, lease_until = null,
		updated_at = clock_timestamp() where worker_id = v_worker.id returning * into v_session;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'input', 'member',
		jsonb_build_object('text', v_text, 'userId', auth.uid(), 'clientRequestId', p_client_request_id));
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'followup', null, jsonb_build_object('text', v_text, 'byUserId', auth.uid()));
	v_todo := public.qorpera_touch_agent_todo(v_worker.todo_id, null);
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;

-- "Let the agent decide": recorded for the thread; the agent already holds the
-- question through the blocked completion and answers with its own follow-up.
create function public.qorpera_delegate_coding_session(p_worker_id uuid, p_client_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
begin
	if p_client_request_id is null then raise exception 'Coding session delegation is invalid' using errcode = '22023'; end if;
	v_worker := public.qorpera_coding_session_owner_row(p_worker_id);
	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
	if v_worker.state <> 'blocked' then raise exception 'The session is not waiting for an answer' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_coding_session_events event where event.worker_id = v_worker.id
		and event.kind = 'delegated' and event.body ->> 'clientRequestId' = p_client_request_id::text) then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'delegated', 'member',
			jsonb_build_object('userId', auth.uid(), 'clientRequestId', p_client_request_id));
	end if;
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;

-- What the thread element reads: the session, its worker, and events after a cursor.
create function public.qorpera_read_coding_session(p_worker_id uuid, p_after_event bigint default 0, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype;
begin
	if auth.uid() is null or p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Coding session read is invalid' using errcode = '22023'; end if;
	select * into v_worker from public.qorpera_runtime_workers where id = p_worker_id and species = 'coding';
	if v_worker.id is null or not public.qorpera_can_read_profile(v_worker.profile_id) then
		raise exception 'Coding session is unavailable' using errcode = '42501'; end if;
	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
	return jsonb_build_object('schema','qorpera.coding-session-read/v1','session',public.qorpera_coding_session_view(v_session, v_worker),
		'isOwner', v_worker.owner_user_id = auth.uid(),
		'events', coalesce((select jsonb_agg(jsonb_build_object('id',event.id,'sequence',event.sequence,'kind',event.kind,'actor',event.actor,
			'body',event.body,'at',event.created_at) order by event.id)
			from (select * from public.qorpera_coding_session_events event where event.worker_id = v_worker.id and event.id > coalesce(p_after_event, 0)
				order by event.id limit p_limit) event), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- The executor: claim, heartbeat, phases, the turn's wake, completion
-- ---------------------------------------------------------------------------
create function public.qorpera_configure_coding_executor(p_environment_id uuid, p_owner text, p_enabled boolean, p_harnesses text[] default array['codex'])
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding deployment authority required' using errcode = '42501'; end if;
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses) values (p_environment_id, p_owner, p_enabled, p_harnesses)
	on conflict (environment_id) do update set owner = excluded.owner, enabled = excluded.enabled, harnesses = excluded.harnesses, updated_at = clock_timestamp();
end
$$;

create function public.qorpera_set_coding_repository_grant(p_environment_id uuid, p_staff_agent_id uuid, p_repository jsonb, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding deployment authority required' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_company_environments environment join public.qorpera_profile_staff staff on staff.profile_id = environment.profile_id
		where environment.id = p_environment_id and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active') then
		raise exception 'Coding staff unavailable' using errcode = '42501'; end if;
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values (p_environment_id, p_staff_agent_id, p_repository, p_enabled)
	on conflict (environment_id, staff_agent_id, repository) do update set enabled = excluded.enabled;
end
$$;

create function public.qorpera_coding_session_claim_json(p_session public.qorpera_coding_sessions, p_worker public.qorpera_runtime_workers)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-session-claim/v1','workerId',p_worker.id,'sequence',p_worker.sequence,
		'leaseToken',p_session.lease_token,'leaseUntil',p_session.lease_until,'profileId',p_worker.profile_id,'environmentId',p_worker.environment_id,
		'agentId',p_worker.staff_agent_id,'ownerUserId',p_worker.owner_user_id,
		'sponsor',jsonb_build_object('bindingId',p_worker.owner_sponsor_binding_id,'version',p_worker.owner_sponsor_version),
		'harness',p_session.harness,'model',p_session.model,'repository',p_session.repository,'branch',p_session.branch,'baseSha',p_session.base_sha,
		'harnessSessionRef',p_session.harness_session_ref,'pullRequest',p_session.pull_request,'title',p_worker.title,
		'dispatch',p_worker.dispatch,'followUp',p_worker.dispatch ->> 'followUp','todoId',p_worker.todo_id)
$$;

create function public.qorpera_claim_coding_session(p_owner text, p_lease_seconds integer default 60)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	if p_lease_seconds is null or p_lease_seconds not between 30 and 300 or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
		raise exception 'Coding lease invalid' using errcode = '22023'; end if;
	for v_session in select session.* from public.qorpera_coding_sessions session
		join public.qorpera_coding_executors executor on executor.environment_id = session.environment_id and executor.enabled and executor.owner = p_owner
			and session.harness = any(executor.harnesses)
		where session.phase in ('queued','input_ready') or (session.phase in ('preparing','running','publishing') and session.lease_until <= clock_timestamp())
		order by session.updated_at, session.worker_id limit 8 loop
		begin
			-- Lock order is todo, then worker, then session, as everywhere in Order 5.
			select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
			perform 1 from public.qorpera_runtime_agent_todos where id = v_worker.todo_id for update nowait;
			select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update nowait;
			select * into v_session from public.qorpera_coding_sessions where worker_id = v_session.worker_id for update nowait;
			if v_worker.state <> 'active' then continue; end if;
			if v_session.phase in ('preparing','running','publishing') then
				if v_session.lease_until > clock_timestamp() then continue; end if;
				-- The executor that held this turn is gone. The session fails visibly and keeps its workspace;
				-- a follow-up starts the next turn. Nothing is replayed.
				update public.qorpera_coding_sessions set phase = 'failed', finished_at = clock_timestamp(), lease_owner = null, lease_token = null,
					lease_until = null, updated_at = clock_timestamp() where worker_id = v_session.worker_id;
				update public.qorpera_runtime_workers set state = 'failed', reported_at = clock_timestamp(), completion_state = 'waiting', updated_at = clock_timestamp(),
					result = jsonb_build_object('outcome','failed','outputs','[]'::jsonb,'sequence',v_worker.sequence,'reason','executor-lease-expired',
						'summary','The coding executor stopped responding; the workspace is kept.') where id = v_worker.id;
				perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'failed', 'kernel', jsonb_build_object('reason','executor-lease-expired'));
				perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				continue;
			end if;
			update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = p_owner, lease_token = extensions.gen_random_uuid(),
				lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), started_at = coalesce(started_at, clock_timestamp()),
				finished_at = null, updated_at = clock_timestamp() where worker_id = v_session.worker_id returning * into v_session;
			perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase','preparing','owner',p_owner));
			return public.qorpera_coding_session_claim_json(v_session, v_worker);
		exception when lock_not_available then continue;
		end;
	end loop;
	return null;
end
$$;

-- The leased session, or an error. A cancelled session is reported as such so the executor stops the turn.
create function public.qorpera_coding_leased_session(p_worker_id uuid, p_lease_token uuid)
returns public.qorpera_coding_sessions language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode = '42501'; end if;
	select * into v_session from public.qorpera_coding_sessions where worker_id = p_worker_id for update;
	if v_session.worker_id is null then raise exception 'Coding session lease unavailable' using errcode = '42501'; end if;
	if v_session.phase = 'cancelled' then raise exception 'Coding session was cancelled' using errcode = '55000'; end if;
	if v_session.lease_token is distinct from p_lease_token or v_session.lease_until <= clock_timestamp()
		or v_session.phase not in ('preparing','running','publishing') then
		raise exception 'Coding session lease unavailable' using errcode = '42501'; end if;
	return v_session;
end
$$;

create function public.qorpera_heartbeat_coding_session(p_worker_id uuid, p_lease_token uuid, p_lease_seconds integer default 60)
returns timestamptz language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_until timestamptz;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'Coding lease invalid' using errcode = '22023'; end if;
	update public.qorpera_coding_sessions set lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
	where worker_id = v_session.worker_id returning lease_until into v_until;
	return v_until;
end
$$;

-- Progress from the executor and the harness: a phase, the current step, and bounded events for the thread.
create function public.qorpera_record_coding_progress(p_worker_id uuid, p_lease_token uuid, p_phase text default null, p_last_step text default null,
	p_files_changed integer default null, p_events jsonb default '[]'::jsonb, p_harness_session_ref text default null, p_base_sha text default null,
	p_vm_allocation_id uuid default null, p_storage_volume_id uuid default null, p_model text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype; v_event jsonb;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	if (p_phase is not null and p_phase not in ('preparing','running','publishing'))
		or (p_phase = 'running' and v_session.phase = 'preparing' and v_worker.occurrence_id is null)
		or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 64
		or (p_files_changed is not null and p_files_changed < 0) then
		raise exception 'Coding progress is invalid' using errcode = '22023'; end if;
	for v_event in select value from jsonb_array_elements(p_events) loop
		if jsonb_typeof(v_event) <> 'object' or coalesce(v_event ->> 'kind','') not in ('step','text','published')
			or coalesce(v_event ->> 'actor','') not in ('harness','executor') or jsonb_typeof(v_event -> 'body') is distinct from 'object' then
			raise exception 'Coding event is invalid' using errcode = '22023'; end if;
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, v_event ->> 'kind', v_event ->> 'actor', v_event -> 'body');
	end loop;
	update public.qorpera_coding_sessions set phase = coalesce(p_phase, phase), last_step = coalesce(p_last_step, last_step),
		files_changed = coalesce(p_files_changed, files_changed), harness_session_ref = coalesce(p_harness_session_ref, harness_session_ref),
		base_sha = coalesce(base_sha, p_base_sha), vm_allocation_id = coalesce(vm_allocation_id, p_vm_allocation_id),
		storage_volume_id = coalesce(storage_volume_id, p_storage_volume_id), model = coalesce(p_model, model), updated_at = clock_timestamp()
	where worker_id = v_session.worker_id returning * into v_session;
	if p_phase is not null then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase', p_phase)); end if;
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;

-- The turn's wake: admitted only when the workspace is ready, under the owner's sponsor.
create function public.qorpera_begin_coding_turn(p_worker_id uuid, p_lease_token uuid, p_coding jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype; v_todo public.qorpera_runtime_agent_todos%rowtype;
	v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype; v_occurrence uuid := extensions.gen_random_uuid();
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if v_session.phase <> 'preparing' or jsonb_typeof(p_coding) is distinct from 'object' or pg_column_size(p_coding) > 2048 then
		raise exception 'Coding turn cannot begin in phase %', v_session.phase using errcode = '55000'; end if;
	perform 1 from public.qorpera_runtime_agent_todos where id = (select todo_id from public.qorpera_runtime_workers where id = v_session.worker_id) for update;
	select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update;
	select * into v_todo from public.qorpera_runtime_agent_todos where id = v_worker.todo_id;
	if v_worker.state <> 'active' or v_worker.occurrence_id is not null then
		raise exception 'Coding turn is already admitted or the worker is not active' using errcode = '55000'; end if;
	select * into v_run from public.qorpera_execution_runs where id = v_worker.steering_run_id;
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
		parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
	values (v_occurrence, v_worker.profile_id, v_worker.environment_id, 'agent', 'worker-dispatch', v_worker.id, v_worker.staff_agent_id,
		v_worker.steering_run_id, 'worker-dispatch', 'worker-dispatch:' || v_worker.id::text || ':' || v_worker.sequence::text,
		clock_timestamp(), clock_timestamp(),
		public.qorpera_worker_dispatch_payload(v_worker, v_todo) || jsonb_build_object('coding', p_coding || jsonb_build_object(
			'harness', v_session.harness, 'repository', v_session.repository, 'branch', v_session.branch, 'baseSha', v_session.base_sha,
			'harnessSessionRef', v_session.harness_session_ref, 'sequence', v_worker.sequence)))
	returning * into v_wake;
	if v_wake.status <> 'queued' then
		raise exception 'Coding turn cannot start now: %', coalesce(v_wake.blocked_reason,'refused') using errcode = '55000'; end if;
	update public.qorpera_runtime_workers set occurrence_id = v_occurrence, updated_at = clock_timestamp() where id = v_worker.id;
	update public.qorpera_coding_sessions set phase = 'running', updated_at = clock_timestamp() where worker_id = v_worker.id;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase','running','occurrenceId',v_occurrence));
	return jsonb_build_object('schema','qorpera.coding-turn/v1','workerId',v_worker.id,'sequence',v_worker.sequence,'occurrenceId',v_occurrence);
end
$$;

-- The executor reports the turn: a result, a question for the owner, or a failure.
-- The Order 5 completion path carries it to the parent; the session keeps its state for the next turn.
create function public.qorpera_complete_coding_turn(p_worker_id uuid, p_lease_token uuid, p_outcome text, p_summary text, p_needs text default null,
	p_pull_request jsonb default null, p_checks jsonb default null, p_artifacts jsonb default null, p_harness_session_ref text default null,
	p_files_changed integer default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype; v_summary text := btrim(coalesce(p_summary,''));
	v_needs text := nullif(btrim(coalesce(p_needs,'')),''); v_report jsonb;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if p_outcome not in ('succeeded','blocked','failed') or octet_length(v_summary) not between 1 and 4000
		or ((p_outcome = 'blocked') <> (v_needs is not null)) or octet_length(coalesce(v_needs,'')) > 1000
		or (p_pull_request is not null and (jsonb_typeof(p_pull_request) <> 'object'
			or p_pull_request - array['url','number','headSha'] <> '{}'::jsonb
			or p_pull_request ->> 'url' is distinct from 'https://github.com/' || (v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name') || '/pull/' || (p_pull_request ->> 'number')
			or coalesce(p_pull_request ->> 'headSha','') !~ '^[0-9a-f]{40}$'))
		or (p_checks is not null and jsonb_typeof(p_checks) <> 'array') or (p_artifacts is not null and jsonb_typeof(p_artifacts) <> 'array')
		or (p_files_changed is not null and p_files_changed < 0) then
		raise exception 'Coding turn result is invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_runtime_agent_todos where id = (select todo_id from public.qorpera_runtime_workers where id = v_session.worker_id) for update;
	select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update;
	if v_worker.state <> 'active' then raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;
	v_report := jsonb_build_object('outcome', p_outcome, 'summary', v_summary, 'needs', v_needs, 'outputs', '[]'::jsonb,
		'pullRequest', coalesce(p_pull_request, v_session.pull_request), 'runId', null, 'sequence', v_worker.sequence);
	update public.qorpera_runtime_workers set state = p_outcome, result = v_report, reported_at = clock_timestamp(),
		completion_state = 'waiting', updated_at = clock_timestamp() where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'reported', null, v_report);
	update public.qorpera_coding_sessions set
		phase = case p_outcome when 'succeeded' then 'completed' when 'blocked' then 'awaiting_input' else 'failed' end,
		finished_at = case when p_outcome = 'blocked' then null else clock_timestamp() end,
		pull_request = coalesce(p_pull_request, pull_request), checks = coalesce(p_checks, checks), artifacts = coalesce(p_artifacts, artifacts),
		harness_session_ref = coalesce(p_harness_session_ref, harness_session_ref), files_changed = coalesce(p_files_changed, files_changed),
		lease_owner = null, lease_token = null, lease_until = null, updated_at = clock_timestamp()
	where worker_id = v_worker.id returning * into v_session;
	if p_pull_request is not null then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'published', 'executor', p_pull_request); end if;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence,
		case p_outcome when 'succeeded' then 'finished' when 'blocked' then 'needs_input' else 'failed' end, 'executor',
		jsonb_build_object('summary', v_summary, 'needs', v_needs));
	perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_coding_repository_valid(jsonb), public.qorpera_coding_event(uuid, integer, text, text, jsonb),
	public.qorpera_coding_session_view(public.qorpera_coding_sessions, public.qorpera_runtime_workers),
	public.qorpera_coding_owner_sponsor(uuid, uuid, text), public.qorpera_coding_session_queue(public.qorpera_runtime_workers, text, uuid, text),
	public.qorpera_coding_session_owner_row(uuid), public.qorpera_answer_coding_session(uuid, text, uuid), public.qorpera_delegate_coding_session(uuid, uuid),
	public.qorpera_read_coding_session(uuid, bigint, integer), public.qorpera_configure_coding_executor(uuid, text, boolean, text[]),
	public.qorpera_set_coding_repository_grant(uuid, uuid, jsonb, boolean),
	public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions, public.qorpera_runtime_workers),
	public.qorpera_claim_coding_session(text, integer), public.qorpera_coding_leased_session(uuid, uuid),
	public.qorpera_heartbeat_coding_session(uuid, uuid, integer),
	public.qorpera_record_coding_progress(uuid, uuid, text, text, integer, jsonb, text, text, uuid, uuid, text),
	public.qorpera_begin_coding_turn(uuid, uuid, jsonb), public.qorpera_complete_coding_turn(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_answer_coding_session(uuid, text, uuid), public.qorpera_delegate_coding_session(uuid, uuid),
	public.qorpera_read_coding_session(uuid, bigint, integer) to authenticated;
grant execute on function public.qorpera_configure_coding_executor(uuid, text, boolean, text[]), public.qorpera_set_coding_repository_grant(uuid, uuid, jsonb, boolean),
	public.qorpera_claim_coding_session(text, integer), public.qorpera_heartbeat_coding_session(uuid, uuid, integer),
	public.qorpera_record_coding_progress(uuid, uuid, text, text, integer, jsonb, text, text, uuid, uuid, text),
	public.qorpera_begin_coding_turn(uuid, uuid, jsonb), public.qorpera_complete_coding_turn(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, integer),
	public.qorpera_manage_agent_worker(jsonb, jsonb) to service_role;

-- The patched kernel functions keep their owners; those owners read the coding columns and sessions.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_pin_wake_occurrence()'::regprocedure,
		'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
		'public.qorpera_drain_worker_wakes(integer)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Coding integration function has an API owner'; end if;
		execute format('grant select, insert, update on public.qorpera_coding_sessions, public.qorpera_coding_session_events to %I', v_owner);
		execute format('grant execute on function public.qorpera_coding_event(uuid, integer, text, text, jsonb) to %I', v_owner);
	end loop;
end $$;
