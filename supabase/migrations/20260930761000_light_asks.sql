-- Light asks (deploy/first-node/RUNTIME-LIGHT-ASK.md; Jonas, 14 November 2026, on a group just made in the apps drawer:
-- "when a new group is created, I would like to run a light call, having an agent name it"; asked how, he chose "Build
-- the light call").
--
-- A light ask is one small question a member's own action raises, answered by one call to the small model with no tools,
-- with nothing shown in any conversation. It is a wake, as every activation is (contract 8): an `agent` wake with the
-- source kind `light-ask`, no parent run and no conversation, made as the human-task wake is (P31, 20260930065000).
-- 1. The asking member calls qorpera_request_light_ask with a kind and that kind's input, never a prompt. The ask is a
--    row of qorpera_light_asks, which also holds the answer.
-- 2. The wake goes to the Co-Founder. The asker pays with their own login, the one with the most room. A ChatGPT plan
--    may pay: the ask is its owner's own request, made now, as a message of theirs is. Nobody else's login and no
--    company account pays.
-- 3. The run reads the kind and the input from its wake, asks the model, and stores the answer with
--    qorpera_native_light_ask_answer. It says nothing: an agent wake's policy forbids a send, and the run has no
--    conversation. It offers no tool: its admission takes an empty tool catalog, and only an empty one.
-- 4. The asker reads the answer with qorpera_read_light_ask. An ask not answered within ten minutes reads as failed, and
--    its wake no longer runs.
-- Bounds: 8 waiting asks a member in a company; an input of 4 KiB; an answer of 200 characters; asks a day old go when
-- the member asks again.

-- Every patch of one function in one text, then one execute: its anchors each stand there exactly once.
create function pg_temp.light_ask_replace(p_function regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930761000' in v_definition) > 0 then
		raise exception '20260930761000 is already in %', p_function; end if;
	for v_index in 1 .. array_length(p_pairs, 1) loop
		if p_pairs[v_index][1] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index][1], '')))
				/ length(p_pairs[v_index][1]) <> 1 then
			raise exception '20260930761000 anchor differs in %: %', p_function, left(p_pairs[v_index][1], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index][1], p_pairs[v_index][2]);
	end loop;
	execute v_definition;
end $$;

-- 1. The wake source kind, keeping whatever kinds master already has ---------------------------------------------------

do $$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint
	where conname = 'qorpera_wake_occurrences_source_kind_check' and conrelid = 'public.qorpera_wake_occurrences'::regclass;
	if v_definition is null or v_definition !~ '^CHECK \(\(source_kind = ANY \(ARRAY\[' then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	select array_agg(match[1] order by ordinality) into v_kinds
	from regexp_matches(v_definition, '''([a-z0-9_-]+)''::text', 'g') with ordinality as found(match, ordinality);
	if not ('human-task' = any (v_kinds) and 'room' = any (v_kinds)) or 'light-ask' = any (v_kinds)
		or cardinality(v_kinds) <> (length(v_definition) - length(replace(v_definition, '::text', ''))) / length('::text') then
		raise exception 'Wake source kinds differ: %', v_definition; end if;
	alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
	execute format('alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
		check (source_kind = any (array[%s]))',
		(select string_agg(quote_literal(kind), ', ' order by ordinality) from unnest(v_kinds || array['light-ask'])
			with ordinality as listed(kind, ordinality)));
end
$$;

-- 2. The asks --------------------------------------------------------------------------------------------------------------
-- One per ask: who asked, what, and the answer once the run stored it. The folder clock cascade, as the human-task
-- markers have it: the deletion purge takes the fence first.
create table public.qorpera_light_asks (
	id uuid primary key,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null,
	requested_by_user_id uuid not null,
	client_ask_id uuid not null,
	kind text not null check (kind in ('name-app-group')),
	input jsonb not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 4096),
	-- pending: no wake yet (only inside the asking call); woken: its wake was made; answered; failed.
	state text not null default 'pending' check (state in ('pending','woken','answered','failed')),
	wake_id uuid unique,
	answer text check (answer is null or char_length(answer) between 1 and 200),
	problem text check (problem is null or char_length(problem) between 1 and 64),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (profile_id, requested_by_user_id, client_ask_id),
	check ((state = 'answered') = (answer is not null)),
	check ((state = 'failed') = (problem is not null)),
	check (state not in ('woken','answered') or wake_id is not null)
);
create index qorpera_light_asks_member on public.qorpera_light_asks(profile_id, requested_by_user_id, created_at);
alter table public.qorpera_light_asks enable row level security;
revoke all on public.qorpera_light_asks from public, anon, authenticated, service_role;

-- 3. Helpers -------------------------------------------------------------------------------------------------------------

-- When an ask stops waiting: ten minutes after it was made.
create function public.qorpera_light_ask_expires_at(p_created_at timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
	-- 20260930761000 (light asks).
	select p_created_at + interval '10 minutes'
$$;

-- Whether a run is a light ask's: the run of an `agent` wake whose source is a light ask.
create function public.qorpera_run_answers_light_ask(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930761000 (light asks).
	select exists (select 1 from public.qorpera_wake_occurrences wake
		where wake.run_id = p_run_id and wake.wake_kind = 'agent' and wake.source_kind = 'light-ask')
$$;

-- A kind's input, as the cloud takes it. `name-app-group`: the apps of a new group of the member's apps drawer (2 to
-- 12, each a name of 1 to 80 characters and, when it has one, a line about it of at most 200), and the member's
-- language (`en`, `da`, `en-GB`). No other key, and no control character in any text.
create function public.qorpera_light_ask_input_valid(p_kind text, p_input jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_app jsonb;
begin
	-- 20260930761000 (light asks).
	if p_kind is distinct from 'name-app-group' or jsonb_typeof(p_input) is distinct from 'object'
		or pg_column_size(p_input) > 4096 or p_input - array['apps','language'] <> '{}'::jsonb
		or jsonb_typeof(p_input -> 'apps') is distinct from 'array'
		or jsonb_array_length(p_input -> 'apps') not between 2 and 12
		or jsonb_typeof(p_input -> 'language') is distinct from 'string'
		or p_input ->> 'language' !~ '^[a-z]{2}(-[A-Z]{2})?$' then return false; end if;
	for v_app in select value from jsonb_array_elements(p_input -> 'apps') loop
		if jsonb_typeof(v_app) is distinct from 'object' or v_app - array['name','about'] <> '{}'::jsonb
			or jsonb_typeof(v_app -> 'name') is distinct from 'string'
			or char_length(v_app ->> 'name') not between 1 and 80 or v_app ->> 'name' !~ '[^[:space:]]'
			or v_app ->> 'name' ~ '[[:cntrl:]]'
			or (v_app ? 'about' and (jsonb_typeof(v_app -> 'about') is distinct from 'string'
				or char_length(v_app ->> 'about') not between 1 and 200 or v_app ->> 'about' ~ '[[:cntrl:]]')) then
			return false; end if;
	end loop;
	return true;
end $$;

-- The login that pays for a member's light ask: the member's own, the one with the most room, whether or not it allows
-- unattended use (a ChatGPT plan too: the ask is its owner's own request, made now). Never a company account and never
-- another member's login. Only a Codex login can answer (the run asks through Codex). Null: none.
create function public.qorpera_light_ask_sponsor(p_profile_id uuid, p_requester uuid)
returns table(binding_id uuid, version bigint) language sql stable security definer set search_path = '' as $$
	-- 20260930761000 (light asks): qorpera_starter_sponsor's own logins, without its unattended-use conditions.
	select binding.id, sponsor.version
	from public.qorpera_execution_sponsor_bindings as binding
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
			where latest.binding_id = binding.id)
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
		and version.version = sponsor.provider_connection_version
	where binding.profile_id = p_profile_id and binding.status = 'active'
		and sponsor.sponsor_kind = 'member_connection'
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and connection.owner_user_id = p_requester and connection.provider = 'openai'
		and version.authorization_state = 'active' and version.authentication_mode = 'native_subscription'
		and version.native_harness = 'codex-cli'
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection.id and newer.version > version.version)
		and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
		and exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_requester)
	order by public.qorpera_native_account_rank(connection.id, version.version), sponsor.created_at desc, binding.id
	limit 1
$$;

-- An ask as its member reads it. An ask still waiting past its time reads as failed.
create function public.qorpera_light_ask_json(p_ask public.qorpera_light_asks)
returns jsonb language sql stable set search_path = '' as $$
	-- 20260930761000 (light asks).
	select jsonb_build_object('schema', 'qorpera.light-ask/v1', 'id', p_ask.id, 'kind', p_ask.kind,
		'state', case when p_ask.state in ('pending','woken') then
				case when public.qorpera_light_ask_expires_at(p_ask.created_at) > clock_timestamp() then 'waiting' else 'failed' end
			else p_ask.state end,
		'answer', p_ask.answer,
		'problem', case when p_ask.state in ('pending','woken')
				and public.qorpera_light_ask_expires_at(p_ask.created_at) <= clock_timestamp() then 'expired'
			else p_ask.problem end)
$$;

-- 4. The member asks -------------------------------------------------------------------------------------------------------
-- An owner, admin or contributor of a folder-v2 company asks. The same client id with the same kind and input answers
-- the ask already made. What stops an ask is said in its state, never raised: no login of the member's own can pay
-- (`no_payer`), the company has no Co-Founder (`unavailable`), or the member has 8 asks waiting (`too_many`); such an
-- ask is failed at once and never runs. A company that is paused or being deleted keeps no ask at all: the answer is
-- failed (`unavailable`) under an id that names no row.
create function public.qorpera_request_light_ask(p_profile_id uuid, p_client_ask_id uuid, p_kind text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare v_user uuid := auth.uid(); v_environment uuid; v_cofounder uuid; v_problem text;
	v_ask public.qorpera_light_asks%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
begin
	-- 20260930761000 (light asks).
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'A light ask requires a member' using errcode = '42501'; end if;
	if p_profile_id is null or p_client_ask_id is null or public.qorpera_light_ask_input_valid(p_kind, p_input) is not true then
		raise exception 'The light ask is invalid' using errcode = '22023'; end if;
	select file.environment_id into v_environment from public.qorpera_company_files file
	where file.profile_id = p_profile_id and file.core = 'folder-v2';
	if v_environment is null or not exists (select 1 from public.qorpera_profile_members member
		where member.profile_id = p_profile_id and member.user_id = v_user and member.role in ('owner','admin','contributor')) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	-- One ask of a member at a time, so the count below holds and a repeated call finds the first.
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'qorpera.light-ask:' || p_profile_id::text || ':' || v_user::text, 0));
	select * into v_ask from public.qorpera_light_asks ask
	where ask.profile_id = p_profile_id and ask.requested_by_user_id = v_user and ask.client_ask_id = p_client_ask_id;
	if found then
		if v_ask.kind <> p_kind or v_ask.input <> p_input then
			raise exception 'Light ask id is bound to different content' using errcode = '23505'; end if;
		return public.qorpera_light_ask_json(v_ask);
	end if;
	v_cofounder := (select c.staff_agent_id from public.qorpera_company_cofounders c where c.profile_id = p_profile_id);
	-- The fence, then the rows the wake's admission reads (the asker, the woken agent and its authority, key share),
	-- before any row of the asks is written: an ask's row hangs on the folder's clock, which the deletion purge takes
	-- away under the fence, so the fence comes first here as it does for every table that hangs there.
	begin
		perform public.qorpera_folder_company_enter(v_environment, p_profile_id,
			jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
				'key', p_profile_id::text || ':' || v_user::text, 'mode', 'keyshare', 'required', true))
			|| case when v_cofounder is null then '[]'::jsonb else jsonb_build_array(
				jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
					'key', p_profile_id::text || ':' || v_cofounder::text, 'mode', 'keyshare', 'required', false),
				jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
					'key', p_profile_id::text || ':' || v_cofounder::text, 'mode', 'keyshare', 'required', false)) end,
			true);
	exception when sqlstate '55000' then
		-- A stop that holds the company (a pause, a deletion): no ask is kept. It is answered as failed, under an id
		-- that names no row.
		return jsonb_build_object('schema', 'qorpera.light-ask/v1', 'id', extensions.gen_random_uuid(), 'kind', p_kind,
			'state', 'failed', 'answer', null, 'problem', 'unavailable');
	end;
	delete from public.qorpera_light_asks ask
	where ask.profile_id = p_profile_id and ask.requested_by_user_id = v_user
		and ask.created_at < clock_timestamp() - interval '1 day';
	if (select count(*) from public.qorpera_light_asks ask
		where ask.profile_id = p_profile_id and ask.requested_by_user_id = v_user and ask.state in ('pending','woken')
			and public.qorpera_light_ask_expires_at(ask.created_at) > clock_timestamp()) >= 8 then
		v_problem := 'too_many';
	end if;
	insert into public.qorpera_light_asks(id, environment_id, profile_id, requested_by_user_id, client_ask_id, kind, input)
	values (extensions.gen_random_uuid(), v_environment, p_profile_id, v_user, p_client_ask_id, p_kind, p_input)
	returning * into v_ask;
	if v_problem is null then
		begin
			perform public.qorpera_folder_admit_wakes(p_profile_id);
			-- The pin trigger takes the agent, the payer and the payload from the ask.
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id,
				trigger_id, occurrence_key, scheduled_for, not_before)
			values (extensions.gen_random_uuid(), p_profile_id, v_environment, 'agent', 'light-ask', v_ask.id,
				'light-ask', 'light-ask:' || v_ask.id::text, clock_timestamp(), clock_timestamp())
			returning * into v_wake;
			-- The pin trigger leaves a paused company's wake cancelled; the fence above has refused a pause already.
			if v_wake.status <> 'queued' then v_problem := 'unavailable'; end if;
		exception
			-- No login of the member's own can pay, or there is no agent to wake: the ask fails, and nothing of the wake stays.
			when insufficient_privilege then
				v_wake := null;
				v_problem := case when sqlerrm = 'No model account can pay for this work' then 'no_payer' else 'unavailable' end;
		end;
	end if;
	if v_problem is null then
		update public.qorpera_light_asks set state = 'woken', wake_id = v_wake.id, updated_at = clock_timestamp()
		where id = v_ask.id returning * into v_ask;
	else
		update public.qorpera_light_asks set state = 'failed', problem = v_problem, updated_at = clock_timestamp()
		where id = v_ask.id returning * into v_ask;
	end if;
	return public.qorpera_light_ask_json(v_ask);
end $$;

-- The member reads their own ask; null when there is none of that id.
create function public.qorpera_read_light_ask(p_profile_id uuid, p_ask_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_ask public.qorpera_light_asks%rowtype;
begin
	-- 20260930761000 (light asks).
	if auth.role() is distinct from 'authenticated' or v_user is null then
		raise exception 'A light ask requires a member' using errcode = '42501'; end if;
	select * into v_ask from public.qorpera_light_asks ask
	where ask.id = p_ask_id and ask.profile_id = p_profile_id and ask.requested_by_user_id = v_user
		and exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.user_id = v_user);
	if not found then return null; end if;
	return public.qorpera_light_ask_json(v_ask);
end $$;

-- 5. The run stores the answer --------------------------------------------------------------------------------------------
-- The run of a light ask's wake, through the native host (scope `binding`). The answer is one line: runs of white space
-- are one space. An empty one, one over 200 characters or one with a control character is no answer (`no_answer`), as
-- is null, which the run sends when the model gave none. An answer that comes after the ask's ten minutes is not kept:
-- the ask is failed as `expired`, as its asker has read it since then. The first call decides; a later one answers
-- what stands.
create function public.qorpera_native_light_ask_answer(p_binding jsonb, p_answer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_ask public.qorpera_light_asks%rowtype; v_answer text; v_replayed boolean := true;
begin
	-- 20260930761000 (light asks).
	if auth.role() is distinct from 'service_role' then
		raise exception 'Light ask answers require native host authority' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	select * into v_wake from public.qorpera_wake_occurrences wake
	where wake.run_id = v_run.id and wake.wake_kind = 'agent' and wake.source_kind = 'light-ask';
	if not found then raise exception 'The run answers no light ask' using errcode = '42501'; end if;
	select * into v_ask from public.qorpera_light_asks ask where ask.id = v_wake.source_id and ask.wake_id = v_wake.id for update;
	if not found then raise exception 'The run answers no light ask' using errcode = '42501'; end if;
	if v_ask.state = 'woken' then
		v_replayed := false;
		v_answer := btrim(regexp_replace(coalesce(p_answer, ''), '[[:space:]]+', ' ', 'g'));
		if public.qorpera_light_ask_expires_at(v_ask.created_at) <= clock_timestamp() then
			-- Past its time the asker has read it as failed (`expired`), and that stands: a late answer is not kept.
			update public.qorpera_light_asks set state = 'failed', problem = 'expired', updated_at = clock_timestamp()
			where id = v_ask.id returning * into v_ask;
		elsif v_answer = '' or char_length(v_answer) > 200 or v_answer ~ '[[:cntrl:]]' then
			update public.qorpera_light_asks set state = 'failed', problem = 'no_answer', updated_at = clock_timestamp()
			where id = v_ask.id returning * into v_ask;
		else
			update public.qorpera_light_asks set state = 'answered', answer = v_answer, updated_at = clock_timestamp()
			where id = v_ask.id returning * into v_ask;
		end if;
	end if;
	return jsonb_build_object('schema', 'qorpera.light-ask-answer/v1', 'askId', v_ask.id, 'state', v_ask.state,
		'replayed', v_replayed);
end $$;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_native_light_ask_answer', 'binding');

-- 6. The wake's acceptance ------------------------------------------------------------------------------------------------

select pg_temp.light_ask_replace('public.qorpera_pin_wake_occurrence()'::regprocedure, array[
	array[$old$	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype; v_p31_task public.qorpera_folder_human_task_index%rowtype;$old$,
		$new$	v_p31_mark public.qorpera_folder_human_task_wakes%rowtype; v_p31_task public.qorpera_folder_human_task_index%rowtype;
	v_la_ask public.qorpera_light_asks%rowtype;$new$],
	array[$old$	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$old$,
		$new$	elsif new.wake_kind = 'agent' and new.source_kind = 'light-ask' then
		-- 20260930761000 (light asks): a light ask's wake has no parent run and no conversation. Its waiting ask (named by
		-- the source) gives the payer, who is the asker, and the payload; the Co-Founder is woken. Nothing the inserter
		-- sends is trusted.
		select * into v_la_ask from public.qorpera_light_asks a where a.id = new.source_id and a.profile_id = new.profile_id
			and a.environment_id = new.environment_id and a.state = 'pending' and a.wake_id is null;
		if not public.qorpera_company_is_folder_v2(new.profile_id) or v_la_ask.id is null
			or new.parent_run_id is not null or new.file_event_id is not null or new.run_id is not null then
			raise exception 'Wake ask is unavailable' using errcode = '42501'; end if;
		new.staff_agent_id := (select c.staff_agent_id from public.qorpera_company_cofounders c where c.profile_id = new.profile_id);
		new.requested_by_user_id := v_la_ask.requested_by_user_id;
		new.trigger_id := 'light-ask';
		new.occurrence_key := 'light-ask:' || v_la_ask.id::text;
		new.payload := jsonb_build_object('schema', 'qorpera.light-ask-wake/v1', 'askId', v_la_ask.id, 'kind', v_la_ask.kind,
			'input', v_la_ask.input, 'expiresAt', to_char(public.qorpera_light_ask_expires_at(v_la_ask.created_at) at time zone 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
		-- The asker's own login pays, a ChatGPT plan too: the ask is its owner's own request, made now.
		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_light_ask_sponsor(new.profile_id, new.requested_by_user_id) as payer;
		if new.sponsor_binding_id is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		new.logical_computer_id := null;
		new.session_id := null;
		v_actor := null;
	elsif new.wake_kind = 'agent' and new.source_kind = 'human-task' then$new$]
]);

select pg_temp.light_ask_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure, array[
	array[$old$		if p_wake.source_kind = 'human-task' then$old$,
		$new$		-- 20260930761000 (light asks): a light ask's wake has its ask, no parent and no conversation; before its run, the
		-- ask is still waiting and not past its time. Its chain is itself.
		if p_wake.source_kind = 'light-ask' then
			if p_wake.parent_run_id is not null or p_wake.session_id is not null
				or not exists (select 1 from public.qorpera_light_asks a where a.id = p_wake.source_id and a.wake_id = p_wake.id
					and a.profile_id = p_wake.profile_id and a.environment_id = p_wake.environment_id
					and a.requested_by_user_id = p_wake.requested_by_user_id
					and (p_wake.run_id is not null or (a.state = 'woken'
						and public.qorpera_light_ask_expires_at(a.created_at) > clock_timestamp()))) then
				return false; end if;
			v_ancestry := public.qorpera_wake_ancestry(null, null, p_wake.staff_agent_id, p_wake.id);
			return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
				and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
		end if;
		if p_wake.source_kind = 'human-task' then$new$]
]);

select pg_temp.light_ask_replace('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure, array[
	array[$old$			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$old$,
		$new$			-- 20260930761000 (light asks): a light ask's wake has its ask, no parent and no conversation.
			or (v_wake.source_kind = 'light-ask' and (v_wake.parent_run_id is not null or v_wake.session_id is not null
				or not exists (select 1 from public.qorpera_light_asks a where a.id = v_wake.source_id and a.wake_id = v_wake.id)))
			-- 20260930065000 (P31): a human task's wake has its marker and no parent.$new$],
	array[$old$					'human-task','machine-checkin'))))) -- 20260930098000$old$,
		$new$					'human-task','machine-checkin','light-ask'))))) -- 20260930098000$new$]
]);

select pg_temp.light_ask_replace('public.qorpera_folder_read_wake(jsonb)'::regprocedure, array[
	array[$old$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation') then '{}'::jsonb$old$,
		$new$			|| case when v_wake.source_kind in ('worker-dispatch','office-activation','light-ask') /* 20260930761000 */ then '{}'::jsonb$new$]
]);

select pg_temp.light_ask_replace('public.qorpera_folder_materialize_company(uuid, integer)'::regprocedure, array[
	array[$old$					and (v_wake.wake_kind = 'room' or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($old$,
		$new$					-- 20260930761000 (light asks): a light ask is its payer's own request, made now, as a post is.
					and (v_wake.wake_kind = 'room' or v_wake.source_kind = 'light-ask'
						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($new$]
]);

select pg_temp.light_ask_replace('public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure, array[
	array[$old$	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;$old$,
		$new$	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;
	-- 20260930761000 (light asks): a light ask is its payer's own request, made now: the asker's own login pays, whether
	-- or not it allows unattended use (the pin trigger chose it; the wake's authority checks the asker).
	if p_run.source_kind = 'wake' and exists (select 1 from public.qorpera_wake_occurrences w
		where w.id = p_run.source_id and (w.run_id is null or w.run_id = p_run.id) and w.wake_kind = 'agent'
			and w.source_kind = 'light-ask' and w.profile_id = p_run.profile_id
			and w.requested_by_user_id = p_run.requested_by_user_id) then return true; end if;$new$]
]);

select pg_temp.light_ask_replace('public.qorpera_begin_native_company_execution_v3(jsonb, text, text, text, text)'::regprocedure, array[
	array[$old$	if jsonb_array_length(v_catalog -> 'tools') < 1
$old$,
		$new$	-- 20260930761000 (light asks): a light ask's run offers no tool, and every other run at least one.
	if (jsonb_array_length(v_catalog -> 'tools') < 1) is distinct from public.qorpera_run_answers_light_ask(v_run.id)
$new$]
]);

select pg_temp.light_ask_replace('public.qorpera_begin_native_company_execution_v2(jsonb, text, text, text, text, text, integer)'::regprocedure, array[
	array[$old$	if jsonb_array_length(v_catalog -> 'tools') < 1
$old$,
		$new$	-- 20260930761000 (light asks): a light ask's run offers no tool, and every other run at least one.
	if (jsonb_array_length(v_catalog -> 'tools') < 1) is distinct from public.qorpera_run_answers_light_ask(v_run.id)
$new$]
]);

-- 7. Who may call what ----------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_light_ask_expires_at(timestamptz),
	public.qorpera_run_answers_light_ask(uuid),
	public.qorpera_light_ask_input_valid(text, jsonb),
	public.qorpera_light_ask_sponsor(uuid, uuid),
	public.qorpera_light_ask_json(public.qorpera_light_asks),
	public.qorpera_request_light_ask(uuid, uuid, text, jsonb),
	public.qorpera_read_light_ask(uuid, uuid),
	public.qorpera_native_light_ask_answer(jsonb, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_request_light_ask(uuid, uuid, text, jsonb),
	public.qorpera_read_light_ask(uuid, uuid) to authenticated;
grant execute on function public.qorpera_native_light_ask_answer(jsonb, text) to service_role;

comment on function public.qorpera_request_light_ask(uuid, uuid, text, jsonb) is
	'A member asks one small question the small model answers with no tools, paid by the member''s own login, with nothing shown in a conversation (20260930761000).';
comment on function public.qorpera_read_light_ask(uuid, uuid) is
	'The caller''s own light ask: waiting, answered with its answer, or failed with why (20260930761000).';

-- The deploy guard: every changed body carries the marker.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_pin_wake_occurrence()',
		'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)',
		'public.qorpera_runtime_wake_policy_internal(uuid)',
		'public.qorpera_folder_read_wake(jsonb)',
		'public.qorpera_folder_materialize_company(uuid, integer)',
		'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)',
		'public.qorpera_begin_native_company_execution_v3(jsonb, text, text, text, text)',
		'public.qorpera_begin_native_company_execution_v2(jsonb, text, text, text, text, text, integer)'
	]::regprocedure[] loop
		if position('20260930761000' in pg_get_functiondef(v_function)) = 0 then
			raise exception '% does not carry 20260930761000', v_function; end if;
	end loop;
end
$guard$;
