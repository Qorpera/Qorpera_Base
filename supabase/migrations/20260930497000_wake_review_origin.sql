-- A run that carries on the agent's own earlier work is reviewed against the request that started that work (finding
-- 881f1f21, L12.2, 16 October 2026).
--
-- The action review reads a run's request from its member inputs or its routine (a coworker's message is never the
-- request, contract 9.2). A run of a chain the agent started itself has neither: a worker's report
-- (worker-completion), the worker's own run (worker-dispatch), a machine event or check-in (machine-event,
-- machine-checkin) and an office start (office-activation). On TESTCO the review read "No member request" for the run
-- woken by a worker's report and denied its follow-up to that worker (routine 7d26f746, run e89f892a, worker run
-- 92c51cb4, completion wake 878621c0, run 3e4ecb18, review 881f1f21).
--
-- 1. qorpera_wake_occurrences.origin_run_id: for those five kinds only, the run whose request started the chain. A
--    BEFORE INSERT trigger sets it from the platform's own parent_run_id, never from the inserter: the parent run's own
--    origin when the parent was itself woken by one of the five kinds, else the parent run. The parent must be a run of
--    the same company, environment, agent and requester (all five already require that); otherwise, and for every
--    other kind (a coworker's wake has the sender's run as its parent), it is null. A chain whose parent wake has no
--    origin (written before this migration) stays without one. qorpera_guard_wake_identity already refuses any later
--    change. No foreign key: the review re-reads the run, and an origin it cannot find reads as none.
-- 2. qorpera_run_review_origin(run): that origin run's request, with the lookups describe and
--    qorpera_worker_run_continuation use: its member inputs, the room posts its wake names and its routine's intent.
--    Never a coworker's message (contract 9.2), and not what a member's short reply answered. Null when the run has
--    no origin or the origin has none of them, and when a source is refused (qorpera_company_context_source's 42501),
--    so the review reads what it reads today.
-- 3. qorpera_describe_company_run_context adds the key 'origin' with it when it is not null. The runtime gives it only
--    to the action review, never to the model: a worker starts blank by design.
--
-- human-task wakes are left out (their parent is a member's task, not the agent's own work).
--
-- Deploy order: apply this only after every node runs a runtime that parses 'origin' (runtime CHANGELOG, finding
-- 881f1f21), never in a roll's 10-migration step: an older runtime refuses a context with an unknown key, so its
-- chain runs would fail. Before a reverse to such a runtime, undo step 3 (restore describe's body without the origin
-- statement) first.

alter table public.qorpera_wake_occurrences add column origin_run_id uuid;

create function public.qorpera_wake_origin(p_wake public.qorpera_wake_occurrences)
returns uuid language sql stable security definer set search_path = '' as $$
	select case when parent_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event',
			'machine-checkin') then parent_wake.origin_run_id else parent.id end
	from public.qorpera_execution_runs parent
	left join public.qorpera_wake_occurrences parent_wake on parent_wake.run_id = parent.id
	where p_wake.wake_kind = 'agent'
		and p_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event','machine-checkin')
		and parent.id = p_wake.parent_run_id and parent.profile_id = p_wake.profile_id
		and parent.environment_id = p_wake.environment_id and parent.staff_agent_id = p_wake.staff_agent_id
		and parent.requested_by_user_id = p_wake.requested_by_user_id
$$;
revoke all on function public.qorpera_wake_origin(public.qorpera_wake_occurrences)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_set_wake_origin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	new.origin_run_id := public.qorpera_wake_origin(new);
	return new;
end
$$;
revoke all on function public.qorpera_set_wake_origin() from public, anon, authenticated, service_role, qorpera_secret_broker;
-- After qorpera_wake_occurrence_pin (BEFORE triggers fire by name), so it reads the pinned wake.
create trigger qorpera_wake_origin before insert on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_set_wake_origin();

create function public.qorpera_run_review_origin(p_run public.qorpera_execution_runs)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_origin public.qorpera_execution_runs%rowtype;
	v_origin_wake public.qorpera_wake_occurrences%rowtype; v_id uuid; v_source jsonb; v_inputs jsonb := '[]';
	v_routine text;
begin
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run.id and origin_run_id is not null;
	if not found then return null; end if;
	select * into v_origin from public.qorpera_execution_runs where id = v_wake.origin_run_id and id <> p_run.id
		and profile_id = p_run.profile_id and environment_id = p_run.environment_id
		and staff_agent_id = p_run.staff_agent_id and requested_by_user_id = p_run.requested_by_user_id;
	if not found then return null; end if;
	select * into v_origin_wake from public.qorpera_wake_occurrences where run_id = v_origin.id;
	begin
		foreach v_id in array v_origin.input_ids loop
			v_source := public.qorpera_company_context_source(v_origin,'input',v_id);
			v_inputs := v_inputs || jsonb_build_array((v_source-'text') || jsonb_build_object('content',
				public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096)));
		end loop;
		-- A room post the origin's wake names, as the run's own review reads it (its payload's inputIds).
		if v_origin_wake.source_kind = 'room' and jsonb_typeof(v_origin_wake.payload -> 'inputIds') = 'array' then
			for v_id in select value::uuid from jsonb_array_elements_text(v_origin_wake.payload -> 'inputIds')
					with ordinality as ids(value, ordinal)
				where value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' order by ordinal limit 32 loop
				v_source := public.qorpera_company_context_source(v_origin,'history',v_id);
				v_inputs := v_inputs || jsonb_build_array((v_source-'text') || jsonb_build_object('content',
					public.qorpera_company_context_excerpt(v_source ->> 'text',0,4096)));
			end loop;
		end if;
	exception when insufficient_privilege then
		-- A refused source: no origin, so the review reads what the run itself names.
		return null;
	end;
	if jsonb_array_length(v_inputs) > 32 then return null; end if;
	if v_origin_wake.wake_kind = 'routine' then
		v_routine := (select left(prompt, 4096) from public.qorpera_cloud_routine_versions
			where routine_id = v_origin_wake.routine_id and version = v_origin_wake.routine_version);
	end if;
	-- A coworker's message is another agent's words, never the request (contract 9.2): a chain it started has none.
	if jsonb_array_length(v_inputs) = 0 and v_routine is null then return null; end if;
	return jsonb_build_object('runId', v_origin.id, 'inputs', v_inputs, 'routineIntent', v_routine);
end
$$;
revoke all on function public.qorpera_run_review_origin(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.o_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930497000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.o_replace('public.qorpera_describe_company_run_context(jsonb)',
	E'\tif octet_length(v_result::text) > 1048576 then raise exception ''Cloud context exceeds its bound'' using errcode = ''54000''; end if;\n',
	E'\t-- 20260930497000: the request that started the agent''s own chain, for the action review only.\n'
	|| E'\tv_result := v_result || coalesce((select jsonb_build_object(''origin'', origin)\n'
	|| E'\t\tfrom public.qorpera_run_review_origin(v_run) as origin where origin is not null), ''{}''::jsonb);\n'
	|| E'\tif octet_length(v_result::text) > 1048576 then raise exception ''Cloud context exceeds its bound'' using errcode = ''54000''; end if;\n');
