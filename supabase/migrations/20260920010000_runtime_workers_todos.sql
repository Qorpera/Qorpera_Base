-- Contract 13, Order 5: workers and durable todos.
--
-- "The parent agent is a dispatcher, not a hero process." A parent run hands
-- bounded work to an in-house worker and ends its own turn, so a new human
-- message reaches the agent while the work continues (7.3). A worker is a blank
-- child run of the same agent, admitted through the wake bus like every other
-- activation: wake kind agent, source kind worker-dispatch, no conversation and
-- therefore no public mouth. Its report is a durable row, and the kernel, not
-- model polling, revives the parent with a typed internal continuation (8.1):
-- wake kind agent, source kind worker-completion, in the parent's conversation,
-- where the agent may speak a bounded number of times or stay silent.
--
-- Todos and worker handles are durable kernel objects. Each change advances the
-- todo revision and returns the canonical todo document, which the run
-- publishes to the Company File under work/todos/<agent>/ through the governed
-- path gateway; accepted worker outputs are Company File revisions written by
-- the worker and named in that document. Coding, media and listener workers
-- belong to Orders 9, 7 and 8 and are refused here.
create table public.qorpera_runtime_agent_todos (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	todo_key text not null check (todo_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	revision bigint not null default 1 check (revision > 0),
	title text not null check (octet_length(title) between 1 and 200 and title !~ E'[\r\n]'),
	detail text not null default '' check (octet_length(detail) <= 4000),
	state text not null default 'open' check (state in ('open','blocked','done','cancelled')),
	requested_by_user_id uuid not null,
	created_by_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	updated_by_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	published_revision bigint not null default 0 check (published_revision >= 0),
	published_version uuid,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (profile_id, environment_id, staff_agent_id, todo_key),
	check (published_revision <= revision)
);
create index qorpera_runtime_agent_todos_open on public.qorpera_runtime_agent_todos(profile_id, staff_agent_id, updated_at desc)
	where state in ('open','blocked');

create table public.qorpera_runtime_workers (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	todo_id uuid not null references public.qorpera_runtime_agent_todos(id) on delete cascade,
	worker_key text not null check (worker_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	species text not null default 'in-house' check (species = 'in-house'),
	title text not null check (octet_length(title) between 1 and 200 and title !~ E'[\r\n]'),
	access text not null check (access in ('read','write')),
	revival text not null check (revival in ('each','batch')),
	dispatch jsonb not null check (jsonb_typeof(dispatch) = 'object'),
	-- active covers queued and running; the view derives which from the child job.
	state text not null default 'active' check (state in ('active','succeeded','blocked','failed','cancelled')),
	sequence integer not null default 1 check (sequence between 1 and 12),
	epoch integer not null default 1 check (epoch > 0),
	requested_by_user_id uuid not null,
	-- The run that issued the current sequence; the continuation returns to it.
	steering_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	occurrence_id uuid references public.qorpera_wake_occurrences(id) on delete restrict,
	result jsonb check (result is null or jsonb_typeof(result) = 'object'),
	reported_at timestamptz,
	acceptance text check (acceptance in ('accepted','rejected')),
	acceptance_note text check (acceptance_note is null or octet_length(acceptance_note) <= 1000),
	accepted_by_run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	accepted_at timestamptz,
	completion_state text not null default 'none'
		check (completion_state in ('none','waiting','delivered','suppressed','undeliverable')),
	completion_occurrence_id uuid references public.qorpera_wake_occurrences(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	scanned_at timestamptz not null default '-infinity',
	unique (todo_id, worker_key),
	check ((state = 'active') = (result is null)),
	check ((acceptance is null) = (accepted_by_run_id is null)),
	check ((completion_state = 'delivered') = (completion_occurrence_id is not null))
);
create index qorpera_runtime_workers_active on public.qorpera_runtime_workers(profile_id, staff_agent_id) where state = 'active';
create index qorpera_runtime_workers_scan on public.qorpera_runtime_workers(scanned_at, created_at, id)
	where state = 'active' or completion_state = 'waiting';
create index qorpera_runtime_workers_steering on public.qorpera_runtime_workers(steering_run_id);

-- The worker's own stream: what it was asked, what it reported, what the parent decided.
create table public.qorpera_runtime_worker_events (
	id bigint generated always as identity primary key,
	worker_id uuid not null references public.qorpera_runtime_workers(id) on delete cascade,
	sequence integer not null check (sequence between 1 and 12),
	kind text not null check (kind in ('dispatched','followup','reported','ended','cancelled','accepted','rejected')),
	run_id uuid references public.qorpera_execution_runs(id) on delete restrict,
	body jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object'),
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_runtime_worker_events_stream on public.qorpera_runtime_worker_events(worker_id, id);

alter table public.qorpera_runtime_agent_todos enable row level security;
alter table public.qorpera_runtime_workers enable row level security;
alter table public.qorpera_runtime_worker_events enable row level security;
revoke all on public.qorpera_runtime_agent_todos, public.qorpera_runtime_workers, public.qorpera_runtime_worker_events
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
	check (source_kind in ('input','schedule','company-file','coworker','room','office-activation','worker-dispatch','worker-completion'));

-- work/todos/<agent>/... is the agent's own working state in the Company File.
create function public.qorpera_agent_todo_path(p_staff_agent_id uuid, p_todo_key text)
returns text language sql immutable set search_path = '' as $$
	select 'work/todos/' || p_staff_agent_id::text || '/' || p_todo_key || '.json'
$$;

-- The run of a worker, or null. A worker run is recognised by its admitted wake, never by a flag it carries.
create function public.qorpera_run_worker(p_run_id uuid)
returns public.qorpera_runtime_workers language sql stable security definer set search_path = '' as $$
	select worker from public.qorpera_wake_occurrences wake
	join public.qorpera_runtime_workers worker on worker.id = wake.source_id
	where wake.run_id = p_run_id and wake.wake_kind = 'agent' and wake.source_kind = 'worker-dispatch'
$$;

create function public.qorpera_worker_view(p_worker public.qorpera_runtime_workers, p_full boolean default true)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('workerKey', p_worker.worker_key, 'title', p_worker.title,
		'state', case when p_worker.state <> 'active' then p_worker.state
			when exists (select 1 from public.qorpera_wake_occurrences wake
				join public.qorpera_runner_jobs job on job.run_id = wake.run_id
				where wake.id = p_worker.occurrence_id and job.status = 'leased') then 'running' else 'queued' end,
		'sequence', p_worker.sequence, 'access', p_worker.access, 'revival', p_worker.revival,
		'outcome', p_worker.result ->> 'outcome',
		'summary', case when p_full then p_worker.result ->> 'summary' else left(p_worker.result ->> 'summary', 400) end,
		'needs', p_worker.result ->> 'needs', 'outputs', coalesce(p_worker.result -> 'outputs', '[]'::jsonb),
		'reportedAt', p_worker.reported_at,
		'decision', case when p_worker.acceptance is null then null else jsonb_build_object('decision', p_worker.acceptance,
			'note', p_worker.acceptance_note, 'at', p_worker.accepted_at) end)
$$;

-- The canonical todo document. It is derived from the kernel rows, so the same
-- revision always publishes the same bytes.
create function public.qorpera_agent_todo_document(p_todo public.qorpera_runtime_agent_todos)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('path', public.qorpera_agent_todo_path(p_todo.staff_agent_id, p_todo.todo_key),
		'revision', p_todo.revision, 'expectedVersion', p_todo.published_version,
		'text', jsonb_pretty(jsonb_build_object('schema', 'qorpera.agent-todo/v1', 'todoKey', p_todo.todo_key,
			'agentId', p_todo.staff_agent_id, 'title', p_todo.title, 'detail', p_todo.detail, 'state', p_todo.state,
			'revision', p_todo.revision, 'requestedByUserId', p_todo.requested_by_user_id,
			'createdAt', p_todo.created_at, 'updatedAt', p_todo.updated_at,
			'workers', coalesce((select jsonb_agg(public.qorpera_worker_view(worker) order by worker.created_at, worker.id)
				from public.qorpera_runtime_workers worker where worker.todo_id = p_todo.id), '[]'::jsonb))) || E'\n')
$$;

create function public.qorpera_agent_todo_view(p_todo public.qorpera_runtime_agent_todos)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('todoKey', p_todo.todo_key, 'title', p_todo.title, 'detail', p_todo.detail,
		'state', p_todo.state, 'revision', p_todo.revision,
		'path', public.qorpera_agent_todo_path(p_todo.staff_agent_id, p_todo.todo_key),
		'published', p_todo.published_revision = p_todo.revision, 'updatedAt', p_todo.updated_at,
		'workers', coalesce((select jsonb_agg(public.qorpera_worker_view(worker, false) order by worker.created_at, worker.id)
			from public.qorpera_runtime_workers worker where worker.todo_id = p_todo.id), '[]'::jsonb))
$$;

create function public.qorpera_touch_agent_todo(p_todo_id uuid, p_run_id uuid)
returns public.qorpera_runtime_agent_todos language sql volatile security definer set search_path = '' as $$
	update public.qorpera_runtime_agent_todos set revision = revision + 1, updated_at = clock_timestamp(),
		updated_by_run_id = coalesce(p_run_id, updated_by_run_id) where id = p_todo_id returning *
$$;

-- An agent writes its own todo area without a member's write grant: it is the
-- agent's working state, in the company audience, never member-private. A
-- worker writes there too, which is where its outputs land by default.
alter function public.qorpera_company_path_allowed(jsonb, text, text)
	rename to qorpera_company_path_allowed_before_workers;
create function public.qorpera_company_path_allowed(p_actor jsonb, p_path text, p_permission text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
	v_profile uuid := (p_actor ->> 'companyId')::uuid; v_staff uuid := nullif(p_actor ->> 'staffAgentId','')::uuid;
	v_key text; v_resource public.qorpera_company_path_resources%rowtype;
begin
	if public.qorpera_company_path_allowed_before_workers(p_actor, p_path, p_permission) then return true; end if;
	if p_permission is null or p_permission not in ('read','write') or p_actor ->> 'audience' is distinct from 'company'
		or v_staff is null then return false; end if;
	v_key := public.qorpera_company_path_key(p_path);
	if v_key not in ('work', 'work/todos', 'work/todos/' || v_staff::text)
		and left(v_key, length('work/todos/' || v_staff::text || '/')) <> 'work/todos/' || v_staff::text || '/' then
		return false; end if;
	v_resource := public.qorpera_company_path_resource((p_actor ->> 'environmentId')::uuid, p_path);
	return v_resource.scope <> 'member_private' and v_resource.policy <> 'protected'
		and public.qorpera_company_path_principal_allowed(v_profile, v_resource, 'member', (p_actor ->> 'userId')::uuid, 'read')
		and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = v_profile
			and staff.staff_agent_id = v_staff and staff.employment_status = 'active' and staff.deleted_at is null);
end
$$;

-- A revival keeps its parent's causal chain (the same rule as an office
-- continuation): the same agent continues, no coworker hop is added.
create function public.qorpera_worker_wake_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	select * into v_worker from public.qorpera_runtime_workers where id = p_wake.source_id;
	select * into v_parent from public.qorpera_execution_runs where id = p_wake.parent_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	if v_worker.id is null or v_parent.id is null or v_wake.id is null or p_wake.wake_kind <> 'agent'
		or p_wake.source_kind not in ('worker-dispatch','worker-completion')
		or p_wake.trigger_id is distinct from p_wake.source_kind
		or v_worker.profile_id is distinct from p_wake.profile_id or v_worker.environment_id is distinct from p_wake.environment_id
		or v_worker.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.profile_id is distinct from p_wake.profile_id or v_parent.environment_id is distinct from p_wake.environment_id
		or v_parent.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.requested_by_user_id is distinct from p_wake.requested_by_user_id
		or p_wake.file_event_id is not null
		or (p_wake.source_kind = 'worker-dispatch' and p_wake.session_id is not null)
		or (p_wake.source_kind = 'worker-completion' and p_wake.session_id is distinct from v_parent.session_id)
		-- A worker never dispatches: its parent is always an ordinary run of the agent.
		or (p_wake.source_kind = 'worker-dispatch' and v_wake.source_kind = 'worker-dispatch')
		or v_wake.causal_root_id is null or cardinality(v_wake.causal_agent_ids) not between 1 and 16
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_parent.staff_agent_id then
		return null; end if;
	return jsonb_build_object('rootId', v_wake.causal_root_id, 'agentIds', to_jsonb(v_wake.causal_agent_ids));
end
$$;

create function pg_temp.worker_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Worker integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- Admission. The sponsor stays the agent's standing authority, like every
-- agent wake; a continuation speaks in its parent's conversation.
select pg_temp.worker_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$if new.source_kind not in ('coworker','office-activation') then$old$,
	$new$if new.source_kind not in ('coworker','office-activation','worker-dispatch','worker-completion') then$new$);
select pg_temp.worker_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$new.logical_computer_id := v_authority.logical_computer_id; new.session_id := null;$old$,
	$new$new.logical_computer_id := v_authority.logical_computer_id;
		new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id end;$new$);
select pg_temp.worker_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$ if new.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(new);$old$,
	$new$ if new.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(new);
 elsif new.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(new);$new$);

select pg_temp.worker_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$ if p_wake.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(p_wake);$old$,
	$new$ if p_wake.source_kind='office-activation' then v_ancestry:=public.qorpera_office_activation_wake_ancestry(p_wake);
 elsif p_wake.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);$new$);
-- A continuation returns to the conversation its parent ran in, which for an
-- agent thread is the room session the agent is bound to.
select pg_temp.worker_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$(staff_agent_id = p_wake.staff_agent_id::text or (p_wake.wake_kind = 'room' and staff_agent_id is null$old$,
	$new$(staff_agent_id = p_wake.staff_agent_id::text or ((p_wake.wake_kind = 'room' or (p_wake.source_kind = 'worker-completion'
					and public.qorpera_company_room_session_staff(id, p_wake.staff_agent_id))) and staff_agent_id is null$new$);

select pg_temp.worker_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$and p_reporting in ('optional','required','silent') then$old$,
	$new$and p_reporting in ('optional','required','silent','continuation') then$new$);
select pg_temp.worker_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$		elsif p_kind = 'agent' then$old$,
	$new$		elsif p_kind = 'agent' and p_reporting = 'continuation' then
			-- A worker completion continues the agent's own work in its conversation: speak when it matters, briefly.
			v_initial := 'optional'; v_final := 'optional'; v_max := 3;
		elsif p_kind = 'agent' then$new$);
select pg_temp.worker_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation'))$old$,
	$new$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion'))$new$);
select pg_temp.worker_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$old$,
	$new$	if v_wake.source_kind = 'worker-completion' and v_wake.session_id is not null then v_reporting := 'continuation'; end if;
	return public.qorpera_wake_policy_value(v_wake.wake_kind,v_reporting);$new$);

-- A worker starts blank: it does not inherit what its parent had read. A
-- continuation is the same agent resuming, so it does.
select pg_temp.worker_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$	elsif v_wake.wake_kind = 'agent' then
		for v_path in$old$,
	$new$	elsif v_wake.wake_kind = 'agent' and v_wake.source_kind <> 'worker-dispatch' then
		for v_path in$new$);
select pg_temp.worker_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$ if v_wake.source_kind='office-activation' then v_sender:=null; v_actor_user:=null; end if;$old$,
	$new$ if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion') then v_sender:=null; v_actor_user:=null; end if;$new$);

select pg_temp.worker_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$	perform public.qorpera_drain_office_activation_wakes(p_limit);$old$,
	$new$	perform public.qorpera_drain_office_activation_wakes(p_limit);
	perform public.qorpera_drain_worker_wakes(p_limit);$new$);
select pg_temp.worker_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$			elsif v_wake.source_kind='office-activation' then$old$,
	$new$			elsif v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion') then$new$);

-- A cancelled or superseded worker is fenced at its next governed effect. A worker that has
-- reported may still publish its todo document and replay its own receipt.
select pg_temp.worker_patch('public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure,
	$old$	if exists (select 1 from public.qorpera_execution_runs run join public.qorpera_company_execution_pauses pause$old$,
	$new$	if exists (select 1 from public.qorpera_wake_occurrences wake join public.qorpera_runtime_workers worker on worker.id = wake.source_id
		where wake.run_id = p_run_id and wake.source_kind = 'worker-dispatch'
			and (worker.state = 'cancelled' or worker.occurrence_id is distinct from wake.id)) then
		raise exception 'Worker was cancelled' using errcode = '55000'; end if;
	if exists (select 1 from public.qorpera_execution_runs run join public.qorpera_company_execution_pauses pause$new$);

-- ---------------------------------------------------------------------------
-- Todos
-- ---------------------------------------------------------------------------
create function public.qorpera_manage_agent_todo(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_action text := p_request ->> 'action';
	v_key text := p_request ->> 'todoKey'; v_todo public.qorpera_runtime_agent_todos%rowtype;
	v_digest text; v_receipt uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb;
	v_title text; v_detail text; v_state text; v_allowed text[]; v_worker public.qorpera_runtime_workers%rowtype;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or v_run.audience_kind <> 'company' or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Todo authority is unavailable' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object' or v_action is null
		or v_action not in ('list','upsert','done','cancel') then
		raise exception 'Todo request is invalid' using errcode = '22023'; end if;

	if v_action = 'list' then
		if exists (select 1 from jsonb_object_keys(p_request) key where key not in ('action','includeClosed'))
			or (p_request ? 'includeClosed' and jsonb_typeof(p_request -> 'includeClosed') <> 'boolean') then
			raise exception 'Todo request is invalid' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.agent-todos/v1','runId',v_run.id,'todos',coalesce((
			select jsonb_agg(public.qorpera_agent_todo_view(todo) order by todo.updated_at desc, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id
					and (todo.state in ('open','blocked') or coalesce((p_request ->> 'includeClosed')::boolean, false))
				order by todo.updated_at desc, todo.id limit 32) todo), '[]'::jsonb),
			-- Documents a previous run changed but did not manage to publish.
			'unpublished', coalesce((select jsonb_agg(public.qorpera_agent_todo_document(todo) order by todo.updated_at, todo.id) from (
				select * from public.qorpera_runtime_agent_todos todo
				where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
					and todo.staff_agent_id = v_run.staff_agent_id and todo.published_revision < todo.revision
				order by todo.updated_at, todo.id limit 4) todo), '[]'::jsonb));
	end if;

	v_allowed := case when v_action = 'upsert' then array['action','operationKey','todoKey','title','detail','state']
		else array['action','operationKey','todoKey'] end;
	if exists (select 1 from jsonb_object_keys(p_request) key where key <> all(v_allowed))
		or coalesce(p_request ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(v_key,'') !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
		raise exception 'Todo request is invalid' using errcode = '22023'; end if;
	if v_action = 'upsert' then
		v_title := btrim(coalesce(p_request ->> 'title','')); v_detail := btrim(coalesce(p_request ->> 'detail',''));
		v_state := coalesce(p_request ->> 'state','open');
		if octet_length(v_title) not between 1 and 200 or v_title ~ E'[\r\n]' or octet_length(v_detail) > 4000
			or position(E'\\u0000' in (p_request::text)) > 0 or v_state not in ('open','blocked') then
			raise exception 'Todo request is invalid' using errcode = '22023'; end if;
	end if;

	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding, v_receipt, 'todo:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':todo:' || (p_request ->> 'operationKey'),'utf8'),'sha256'),'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'state' <> 'executing' or (v_begun ->> 'receiptId')::uuid <> v_receipt then
		raise exception 'Todo operation needs reconciliation' using errcode = '55000'; end if;

	select * into v_todo from public.qorpera_runtime_agent_todos todo
	where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
		and todo.staff_agent_id = v_run.staff_agent_id and todo.todo_key = v_key for update;
	if v_action = 'upsert' then
		if v_todo.id is null then
			if (select count(*) from public.qorpera_runtime_agent_todos todo where todo.profile_id = v_run.profile_id
				and todo.staff_agent_id = v_run.staff_agent_id and todo.state in ('open','blocked')) >= 64 then
				raise exception 'Too many open todos; finish or cancel some first' using errcode = '54000'; end if;
			insert into public.qorpera_runtime_agent_todos(profile_id, environment_id, staff_agent_id, todo_key, title, detail, state,
				requested_by_user_id, created_by_run_id, updated_by_run_id)
			values (v_run.profile_id, v_run.environment_id, v_run.staff_agent_id, v_key, v_title, v_detail, v_state,
				v_run.requested_by_user_id, v_run.id, v_run.id) returning * into v_todo;
		elsif v_todo.state in ('done','cancelled') then
			raise exception 'Todo is closed; use a new todoKey for new work' using errcode = '55000';
		elsif (v_todo.title, v_todo.detail, v_todo.state) is distinct from (v_title, v_detail, v_state) then
			update public.qorpera_runtime_agent_todos set title = v_title, detail = v_detail, state = v_state where id = v_todo.id;
			v_todo := public.qorpera_touch_agent_todo(v_todo.id, v_run.id);
		end if;
	else
		if v_todo.id is null then raise exception 'Todo is unavailable' using errcode = 'P0002'; end if;
		if v_action = 'done' and exists (select 1 from public.qorpera_runtime_workers worker
			where worker.todo_id = v_todo.id and worker.state = 'active') then
			raise exception 'A worker is still active on this todo; wait for it or cancel it' using errcode = '55000'; end if;
		if v_todo.state in ('open','blocked') then
			if v_action = 'cancel' then
				-- Cancellation policy: a worker lives no longer than its todo.
				for v_worker in select * from public.qorpera_runtime_workers worker
					where worker.todo_id = v_todo.id and worker.state = 'active' for update loop
					perform public.qorpera_cancel_worker(v_worker, v_run.id, 'todo_cancelled');
				end loop;
			end if;
			update public.qorpera_runtime_agent_todos set state = case v_action when 'done' then 'done' else 'cancelled' end
			where id = v_todo.id;
			v_todo := public.qorpera_touch_agent_todo(v_todo.id, v_run.id);
		end if;
	end if;

	v_result := jsonb_build_object('schema','qorpera.agent-todo-receipt/v1','runId',v_run.id,'receiptId',v_receipt,
		'action',v_action,'todo',public.qorpera_agent_todo_view(v_todo),
		'publication',case when v_todo.published_revision < v_todo.revision then public.qorpera_agent_todo_document(v_todo) end);
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_result);
	return v_result;
end
$$;

-- The run reports the Company File version it wrote for a revision. Only a
-- revision written by this run counts, and a newer revision stays unpublished.
create function public.qorpera_confirm_agent_todo_publication(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_todo public.qorpera_runtime_agent_todos%rowtype;
	v_revision bigint; v_snapshot uuid; v_path text;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) key where key not in ('todoKey','revision','snapshotId'))
		or coalesce(p_request ->> 'todoKey','') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
		or coalesce(p_request ->> 'revision','') !~ '^[1-9][0-9]{0,15}$'
		or coalesce(p_request ->> 'snapshotId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Todo publication is invalid' using errcode = '22023'; end if;
	v_revision := (p_request ->> 'revision')::bigint; v_snapshot := (p_request ->> 'snapshotId')::uuid;
	select * into v_todo from public.qorpera_runtime_agent_todos todo
	where todo.profile_id = v_run.profile_id and todo.environment_id = v_run.environment_id
		and todo.staff_agent_id = v_run.staff_agent_id and todo.todo_key = p_request ->> 'todoKey' for update;
	if v_todo.id is null then raise exception 'Todo is unavailable' using errcode = 'P0002'; end if;
	v_path := public.qorpera_agent_todo_path(v_todo.staff_agent_id, v_todo.todo_key);
	if not exists (select 1 from public.qorpera_company_path_revisions revision
		where revision.snapshot_id = v_snapshot and revision.environment_id = v_run.environment_id and revision.run_id = v_run.id
			and public.qorpera_company_path_key(revision.change #>> '{plan,path}') = public.qorpera_company_path_key(v_path)) then
		raise exception 'Todo publication was not written by this run' using errcode = '42501'; end if;
	if v_revision > v_todo.revision then raise exception 'Todo publication is invalid' using errcode = '22023'; end if;
	if v_revision > v_todo.published_revision then
		update public.qorpera_runtime_agent_todos set published_revision = v_revision,
			published_version = (select (revision.change ->> 'version')::uuid from public.qorpera_company_path_revisions revision
				where revision.snapshot_id = v_snapshot)
		where id = v_todo.id returning * into v_todo;
	end if;
	return jsonb_build_object('schema','qorpera.agent-todo-publication/v1','runId',v_run.id,'todoKey',v_todo.todo_key,
		'revision',v_todo.revision,'publishedRevision',v_todo.published_revision,'published',v_todo.published_revision = v_todo.revision);
end
$$;

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------
create function public.qorpera_cancel_worker(p_worker public.qorpera_runtime_workers, p_run_id uuid, p_reason text)
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
	end if;
end
$$;

create function public.qorpera_worker_dispatch_payload(p_worker public.qorpera_runtime_workers, p_todo public.qorpera_runtime_agent_todos)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.worker-dispatch/v1','workerId',p_worker.id,'workerKey',p_worker.worker_key,
		'sequence',p_worker.sequence,'species',p_worker.species,'title',p_worker.title,
		'todo',jsonb_build_object('todoKey',p_todo.todo_key,'title',p_todo.title,
			'path',public.qorpera_agent_todo_path(p_todo.staff_agent_id,p_todo.todo_key)),
		'parentRunId',p_worker.steering_run_id,'access',p_worker.access,
		'outputFolder','work/todos/' || p_worker.staff_agent_id::text || '/' || p_todo.todo_key || '/' || p_worker.worker_key,
		'dispatch',p_worker.dispatch)
$$;

create function public.qorpera_manage_agent_worker(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_action text := p_request ->> 'action';
	v_todo public.qorpera_runtime_agent_todos%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_digest text; v_receipt uuid := extensions.gen_random_uuid(); v_begun jsonb; v_result jsonb; v_allowed text[];
	v_dispatch jsonb; v_source jsonb; v_wake public.qorpera_wake_occurrences%rowtype; v_occurrence uuid; v_text text;
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
		when 'dispatch' then array['action','operationKey','todoKey','workerKey','title','goal','definitionOfDone','context','sources','access','revival']
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
		v_dispatch := jsonb_build_object('goal', btrim(p_request ->> 'goal'), 'definitionOfDone', btrim(p_request ->> 'definitionOfDone'),
			'context', coalesce(p_request ->> 'context',''), 'sources', coalesce(p_request -> 'sources','[]'::jsonb),
			'followUp', null,
			'authority', case when p_request ->> 'access' = 'write'
				then 'Read what this agent may read. Write only inside outputFolder, or where this agent already holds a write grant.'
				else 'Read what this agent may read. Write nothing.' end,
			'output', 'Report once through report_work: outcome, a summary the parent can act on, and the files you wrote.',
			'cancellation', 'Ends with its todo, or when the parent cancels it. A cancelled worker cannot report.',
			'completion', case when coalesce(p_request ->> 'revival','batch') = 'each' then 'The parent is revived as soon as you report.'
				else 'The parent is revived once every worker it dispatched together has reported, or at once when you are blocked.' end);
		insert into public.qorpera_runtime_workers(profile_id, environment_id, staff_agent_id, todo_id, worker_key, title, access, revival,
			dispatch, requested_by_user_id, steering_run_id)
		values (v_run.profile_id, v_run.environment_id, v_run.staff_agent_id, v_todo.id, p_request ->> 'workerKey',
			btrim(p_request ->> 'title'), p_request ->> 'access', coalesce(p_request ->> 'revival','batch'), v_dispatch,
			v_run.requested_by_user_id, v_run.id) returning * into v_worker;
	elsif v_worker.id is null then raise exception 'Worker is unavailable' using errcode = 'P0002';
	elsif v_action = 'followup' then
		-- One worker per coherent stream: the same worker continues with its own history.
		if v_worker.state = 'active' then
			raise exception 'This worker is still working; wait for its report or cancel it' using errcode = '55000'; end if;
		if v_worker.state = 'cancelled' or v_worker.sequence >= 12 then
			raise exception 'This worker cannot continue; dispatch a new one' using errcode = '55000'; end if;
		update public.qorpera_runtime_workers set sequence = sequence + 1, state = 'active', result = null, reported_at = null,
			acceptance = null, acceptance_note = null, accepted_by_run_id = null, accepted_at = null,
			-- An earlier delivery stays in the wake ledger; the row tracks the current sequence only.
			completion_state = 'none', completion_occurrence_id = null,
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

	if v_action in ('dispatch','followup') then
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
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, v_worker.sequence, case v_action when 'dispatch' then 'dispatched' else 'followup' end, v_run.id,
			case v_action when 'dispatch' then v_worker.dispatch else jsonb_build_object('text', v_text) end);
	end if;
	v_todo := public.qorpera_touch_agent_todo(v_todo.id, v_run.id);

	v_result := jsonb_build_object('schema','qorpera.agent-worker-receipt/v1','runId',v_run.id,'receiptId',v_receipt,'action',v_action,
		'todoKey',v_todo.todo_key,'worker',public.qorpera_worker_view(v_worker),
		'publication',public.qorpera_agent_todo_document(v_todo));
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_result);
	return v_result;
end
$$;

-- The worker's only way out: one durable report per sequence, to its parent.
create function public.qorpera_report_worker_result(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype; v_actor jsonb; v_worker public.qorpera_runtime_workers%rowtype;
	v_todo public.qorpera_runtime_agent_todos%rowtype; v_digest text; v_receipt uuid := extensions.gen_random_uuid();
	v_begun jsonb; v_result jsonb; v_output jsonb; v_outputs jsonb := '[]'::jsonb; v_snapshot uuid; v_report jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_actor := public.qorpera_company_path_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	v_worker := public.qorpera_run_worker(v_run.id);
	if v_worker.id is null then raise exception 'Only a worker reports to a parent' using errcode = '42501'; end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) key where key not in ('operationKey','outcome','summary','needs','outputs'))
		or coalesce(p_request ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'
		or coalesce(p_request ->> 'outcome','') not in ('succeeded','blocked','failed')
		or octet_length(btrim(coalesce(p_request ->> 'summary',''))) not between 1 and 4000
		or octet_length(coalesce(p_request ->> 'needs','')) > 1000
		or ((p_request ->> 'outcome' = 'blocked') <> (octet_length(btrim(coalesce(p_request ->> 'needs',''))) > 0))
		or (p_request ? 'outputs' and (jsonb_typeof(p_request -> 'outputs') <> 'array' or jsonb_array_length(p_request -> 'outputs') > 4))
		or position(E'\\u0000' in (p_request::text)) > 0 then
		raise exception 'Worker report is invalid' using errcode = '22023'; end if;

	v_digest := encode(extensions.digest(convert_to(p_request::text,'utf8'),'sha256'),'hex');
	v_begun := public.qorpera_begin_native_tool_operation(p_binding, v_receipt, 'report:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':report:' || (p_request ->> 'operationKey'),'utf8'),'sha256'),'hex'), false);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'state' <> 'executing' or (v_begun ->> 'receiptId')::uuid <> v_receipt then
		raise exception 'Worker report needs reconciliation' using errcode = '55000'; end if;

	select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id for update;
	if v_worker.state <> 'active' or not exists (select 1 from public.qorpera_wake_occurrences wake
		where wake.id = v_worker.occurrence_id and wake.run_id = v_run.id) then
		raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;
	-- An output is a Company File revision this very run wrote. Anything else is a claim, not an output.
	for v_output in select value from jsonb_array_elements(coalesce(p_request -> 'outputs','[]'::jsonb)) loop
		if jsonb_typeof(v_output) <> 'string' or octet_length(v_output #>> '{}') not between 1 and 256 then
			raise exception 'Worker output is invalid' using errcode = '22023'; end if;
		select revision.snapshot_id into v_snapshot from public.qorpera_company_path_revisions revision
		where revision.environment_id = v_run.environment_id and revision.run_id = v_run.id and revision.proposal_id is null
			and public.qorpera_company_path_key(revision.change #>> '{plan,path}') = public.qorpera_company_path_key(v_output #>> '{}')
		order by revision.created_at desc limit 1;
		if v_snapshot is null then
			raise exception 'An output must be a file this worker wrote: %', v_output #>> '{}' using errcode = '22023'; end if;
		v_outputs := v_outputs || jsonb_build_array(jsonb_build_object('path', v_output #>> '{}', 'snapshotId', v_snapshot));
	end loop;
	v_report := jsonb_build_object('outcome', p_request ->> 'outcome', 'summary', btrim(p_request ->> 'summary'),
		'needs', nullif(btrim(coalesce(p_request ->> 'needs','')),''), 'outputs', v_outputs,
		'runId', v_run.id, 'sequence', v_worker.sequence);
	update public.qorpera_runtime_workers set state = p_request ->> 'outcome', result = v_report, reported_at = clock_timestamp(),
		completion_state = 'waiting', updated_at = clock_timestamp() where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'reported', v_run.id, v_report);
	v_todo := public.qorpera_touch_agent_todo(v_worker.todo_id, null);

	v_result := jsonb_build_object('schema','qorpera.worker-report-receipt/v1','runId',v_run.id,'receiptId',v_receipt,
		'workerKey',v_worker.worker_key,'outcome',v_worker.state,'outputs',v_outputs,
		'publication',public.qorpera_agent_todo_document(v_todo));
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_result);
	return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- Durable completion reaches the parent
-- ---------------------------------------------------------------------------
create function public.qorpera_worker_completion_payload(p_steering_run_id uuid, p_worker_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.worker-completion/v1','parentRunId',p_steering_run_id,
		'completions',(select jsonb_agg(jsonb_build_object('workerKey',worker.worker_key,'todoKey',todo.todo_key,'title',worker.title,
				'sequence',worker.sequence,'outcome',worker.result ->> 'outcome',
				'summary',left(worker.result ->> 'summary',1200),'summaryTruncated',length(worker.result ->> 'summary') > 1200,
				'needs',worker.result ->> 'needs','outputs',coalesce(worker.result -> 'outputs','[]'::jsonb))
				order by worker.reported_at, worker.id)
			from public.qorpera_runtime_workers worker join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
			where worker.id = any(p_worker_ids)),
		'stillActive',(select count(*) from public.qorpera_runtime_workers worker
			where worker.steering_run_id = p_steering_run_id and worker.state = 'active'))
$$;

create function public.qorpera_drain_worker_wakes(p_limit integer default 32)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_status text; v_wake_status text; v_parent public.qorpera_execution_runs%rowtype;
	v_ids uuid[]; v_id uuid; v_first public.qorpera_runtime_workers%rowtype; v_inserted public.qorpera_wake_occurrences%rowtype;
	v_ceiling record;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Worker wake admission authority or bound is invalid' using errcode = '42501'; end if;
	for v_worker in select * from public.qorpera_runtime_workers where state = 'active' or completion_state = 'waiting'
		order by scanned_at, created_at, id for update skip locked limit p_limit loop
		update public.qorpera_runtime_workers set scanned_at = clock_timestamp() where id = v_worker.id;
		begin
			select * into v_parent from public.qorpera_execution_runs where id = v_worker.steering_run_id;
			select status into v_status from public.qorpera_runner_jobs where id = v_parent.job_id;
			if v_worker.state = 'active' then
				-- A child that ended, or never started, without a report still completes durably: as a failure the parent hears about.
				select wake.status into v_wake_status from public.qorpera_wake_occurrences wake where wake.id = v_worker.occurrence_id;
				if v_status = 'cancelled' then
					-- The parent was stopped by a person: its workers stop with it.
					perform public.qorpera_cancel_worker(v_worker, null, 'parent_stopped');
					perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				elsif v_wake_status in ('completed','failed','cancelled','requires_review') then
					update public.qorpera_runtime_workers set state = 'failed', reported_at = clock_timestamp(), completion_state = 'waiting',
						updated_at = clock_timestamp(), result = jsonb_build_object('outcome','failed','outputs','[]'::jsonb,'sequence',v_worker.sequence,
							'reason', case when v_wake_status = 'cancelled' then 'not_started' else 'ended_without_report' end,
							'summary', case when v_wake_status = 'cancelled' then 'The background work could not start.'
								else 'The background work ended without reporting a result.' end)
					where id = v_worker.id;
					insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
					values (v_worker.id, v_worker.sequence, 'ended', jsonb_build_object('occurrenceStatus', v_wake_status));
					perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				end if;
				continue;
			end if;
			-- The parent is never raced: its own run ends first, then it is revived.
			if v_status is null or v_status in ('queued','leased') then continue; end if;
			if v_status = 'cancelled' then
				update public.qorpera_runtime_workers set completion_state = 'suppressed' where id = v_worker.id; continue;
			end if;
			-- Completion policy: a batch waits for the workers dispatched together, unless someone is blocked.
			if v_worker.revival = 'batch' and v_worker.state <> 'blocked' and exists (select 1 from public.qorpera_runtime_workers sibling
				where sibling.steering_run_id = v_worker.steering_run_id and sibling.state = 'active') then continue; end if;
			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
			select * into strict v_ceiling from public.qorpera_company_execution_ceiling(v_worker.profile_id);
			if public.qorpera_company_wakes_last_hour(v_worker.profile_id) >= v_ceiling.wakes_per_hour then continue; end if;
			select array_agg(ready.id order by ready.reported_at, ready.id) into v_ids from (
				select sibling.id, sibling.reported_at from public.qorpera_runtime_workers sibling
				where sibling.steering_run_id = v_worker.steering_run_id and sibling.completion_state = 'waiting'
				order by sibling.reported_at, sibling.id limit 4 for update skip locked) ready;
			if v_ids is null or not (v_worker.id = any(v_ids)) then continue; end if;
			select * into v_first from public.qorpera_runtime_workers where id = v_ids[1];
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
				parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
			values (v_id, v_worker.profile_id, v_worker.environment_id, 'agent', 'worker-completion', v_first.id, v_worker.staff_agent_id,
				v_worker.steering_run_id, 'worker-completion',
				'worker-completion:' || v_first.id::text || ':' || v_first.sequence::text,
				clock_timestamp(), clock_timestamp(), public.qorpera_worker_completion_payload(v_worker.steering_run_id, v_ids))
			returning * into v_inserted;
			update public.qorpera_runtime_workers set completion_state = 'delivered', completion_occurrence_id = v_id where id = any(v_ids);
		exception when lock_not_available then continue;
			when insufficient_privilege or no_data_found or object_not_in_prerequisite_state then
				-- The agent, the requester or the conversation is gone. The result stays in the todo.
				update public.qorpera_runtime_workers set completion_state = 'undeliverable' where id = v_worker.id;
		end;
	end loop;
end
$$;

-- What a revived parent, or a continued worker, reads before it works.
create function public.qorpera_worker_run_continuation(p_run public.qorpera_execution_runs, p_depth integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_parent_wake public.qorpera_wake_occurrences%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_inputs jsonb; v_receipts jsonb; v_sends jsonb; v_result jsonb;
begin
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run.id
		and source_kind in ('worker-dispatch','worker-completion');
	if not found then return null; end if;
	if v_wake.source_kind = 'worker-dispatch' then
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_wake.source_id;
		if (v_wake.payload ->> 'sequence')::integer = 1 then return null; end if;
		-- The worker's own earlier stream, never the parent's conversation.
		return jsonb_build_object('schema','qorpera.worker-stream/v1','runId',p_run.id,'workerKey',v_worker.worker_key,
			'sequence',(v_wake.payload ->> 'sequence')::integer,
			'history',coalesce((select jsonb_agg(jsonb_build_object('sequence',event.sequence,'kind',event.kind,'at',event.created_at,'body',event.body)
				order by event.id) from public.qorpera_runtime_worker_events event
				where event.worker_id = v_worker.id and event.sequence < (v_wake.payload ->> 'sequence')::integer),'[]'::jsonb));
	end if;
	if p_depth > 2 then return jsonb_build_object('schema','qorpera.worker-completion-continuation/v1','omitted','earlier history'); end if;
	select * into strict v_parent from public.qorpera_execution_runs where id = v_wake.parent_run_id
		and profile_id = p_run.profile_id and environment_id = p_run.environment_id and staff_agent_id = p_run.staff_agent_id;
	select * into strict v_parent_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	select coalesce(jsonb_agg(public.qorpera_company_context_source(v_parent,'input',input_id) order by ordinal),'[]') into v_inputs
	from unnest(v_parent.input_ids) with ordinality ids(input_id, ordinal);
	select coalesce(jsonb_agg(jsonb_build_object('receiptId',id,'logicalOperationKey',logical_operation_key,'completedAt',completed_at,
		'result',result,'outputSnapshotId',output_snapshot_id,'companyPathProposalId',company_path_proposal_id) order by completed_at, id),'[]')
	into v_receipts from public.qorpera_run_operation_receipts where run_id = v_parent.id and status = 'completed';
	select coalesce(jsonb_agg(jsonb_build_object('eventId',event.event_id,'sequence',event.sequence,'body',event.body) order by event.sequence),'[]')
	into v_sends from public.qorpera_agent_sends send join public.qorpera_session_events event on event.event_id = send.event_id
	where send.run_id = v_parent.id;
	v_result := jsonb_build_object('schema','qorpera.worker-completion-continuation/v1','runId',p_run.id,'parentRunId',v_parent.id,
		'parentOutcome',(select status from public.qorpera_runner_jobs where id = v_parent.job_id),
		'completions',(select coalesce(jsonb_agg(public.qorpera_worker_view(worker) || jsonb_build_object('todoKey',todo.todo_key)
				order by worker.reported_at, worker.id),'[]')
			from public.qorpera_runtime_workers worker join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
			where worker.completion_occurrence_id = v_wake.id or worker.id = v_wake.source_id),
		'todos',(select coalesce(jsonb_agg(public.qorpera_agent_todo_view(todo) order by todo.updated_at desc, todo.id),'[]')
			from public.qorpera_runtime_agent_todos todo where todo.id in (select worker.todo_id from public.qorpera_runtime_workers worker
				where worker.steering_run_id = v_parent.id)),
		'parentInputs',v_inputs,
		'parentWake',jsonb_build_object('kind',v_parent_wake.wake_kind,'sourceKind',v_parent_wake.source_kind,
			'routineIntent',(select prompt from public.qorpera_cloud_routine_versions
				where routine_id = v_parent_wake.routine_id and version = v_parent_wake.routine_version),
			'roomPost',(select jsonb_build_object('kind','historical_room_input','id',id,'authorUserId',author_user_id,'body',body)
				from public.qorpera_session_inputs where v_parent_wake.source_kind = 'room' and id = v_parent_wake.source_id
					and session_id = v_parent.session_id and kind = 'user_message')),
		'receipts',v_receipts,'priorSends',v_sends,
		'earlier',public.qorpera_worker_run_continuation(v_parent, p_depth + 1));
	if octet_length(v_result::text) > 33554432 then raise exception 'Worker continuation exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;

select pg_temp.worker_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
	$old$if not found then return public.qorpera_office_run_continuation(p_run); end if;$old$,
	$new$if not found then return coalesce(public.qorpera_office_run_continuation(p_run), public.qorpera_worker_run_continuation(p_run)); end if;$new$);

revoke all on function public.qorpera_agent_todo_path(uuid, text), public.qorpera_run_worker(uuid),
	public.qorpera_worker_view(public.qorpera_runtime_workers, boolean),
	public.qorpera_agent_todo_document(public.qorpera_runtime_agent_todos), public.qorpera_agent_todo_view(public.qorpera_runtime_agent_todos),
	public.qorpera_touch_agent_todo(uuid, uuid), public.qorpera_company_path_allowed(jsonb, text, text),
	public.qorpera_worker_wake_ancestry(public.qorpera_wake_occurrences),
	public.qorpera_manage_agent_todo(jsonb, jsonb), public.qorpera_confirm_agent_todo_publication(jsonb, jsonb),
	public.qorpera_cancel_worker(public.qorpera_runtime_workers, uuid, text),
	public.qorpera_worker_dispatch_payload(public.qorpera_runtime_workers, public.qorpera_runtime_agent_todos),
	public.qorpera_manage_agent_worker(jsonb, jsonb), public.qorpera_report_worker_result(jsonb, jsonb),
	public.qorpera_worker_completion_payload(uuid, uuid[]), public.qorpera_drain_worker_wakes(integer),
	public.qorpera_worker_run_continuation(public.qorpera_execution_runs, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_manage_agent_todo(jsonb, jsonb), public.qorpera_confirm_agent_todo_publication(jsonb, jsonb),
	public.qorpera_manage_agent_worker(jsonb, jsonb), public.qorpera_report_worker_result(jsonb, jsonb) to service_role;

-- The patched kernel functions keep their owners; those owners call the new helpers.
do $$ declare v_owner name; begin
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_pin_wake_occurrence()'::regprocedure,
		'public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
		'public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
		'public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
		'public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure,
		'public.qorpera_company_path_allowed_before_workers(jsonb, text, text)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Worker integration function has an API owner'; end if;
		execute format('grant execute on function public.qorpera_worker_wake_ancestry(public.qorpera_wake_occurrences),
			public.qorpera_drain_worker_wakes(integer), public.qorpera_worker_run_continuation(public.qorpera_execution_runs, integer),
			public.qorpera_company_path_allowed(jsonb, text, text) to %I', v_owner);
		execute format('grant select, insert, update on public.qorpera_runtime_agent_todos, public.qorpera_runtime_workers,
			public.qorpera_runtime_worker_events to %I', v_owner);
	end loop;
end $$;
