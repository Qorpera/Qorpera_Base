-- The founding lobby's hardening (from #776's review). L3: renaming a table checks the name exactly as Open
-- (qorpera_folder_company_open) and the seed (qorpera_folder_company_seed) do. L2: the table shows how the
-- Co-Founder's first run stands.
--
-- qorpera_update_company_founding only required 1 to 120 characters after trim. Open and the seed also refuse control
-- characters, line separators, and a name made only of spaces (including the non-ASCII ones). So after such a rename,
-- Start refused with "Company seed input is invalid" and the founders had to guess why. Now the rename itself refuses
-- (22023, "Company details are invalid"), as Open does.
--
-- And L2: the founders' table says how the Co-Founder's first run stands (start.firstRun), so the web can say when it
-- could not start on its own, instead of a silent thread: `queued` (its turn request waits for the materializer),
-- `started` (a run took the kickoff, whatever that run's outcome: a failed run shows in the thread), `waiting_for_login`
-- (no usable login when the company was created, so no turn request), `failed` (the request or the kickoff failed, or
-- the request was cancelled or its kickoff released), or null before the creation wrote the first run.
-- The inserted text names this migration (20260930039000), for deploy guards.

set local lock_timeout = '3s';

do $$
declare v_target constant regprocedure := 'public.qorpera_update_company_founding(uuid,bigint,text,text)';
	v_definition text := pg_get_functiondef(v_target);
	c_old constant text := $old$	if v_name is null or char_length(v_name) not between 1 and 120
		or p_vision is null or octet_length(p_vision) > 16384 then$old$;
	c_new constant text := $new$	-- 20260930039000: the name rules of Open and the seed, so Start never refuses a name the table accepted.
	if v_name is null or char_length(v_name) not between 1 and 120
		or v_name ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]' or v_name ~ '^[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*$'
		or p_vision is null or octet_length(p_vision) > 16384 then$new$;
begin
	if (length(v_definition) - length(replace(v_definition, c_old, ''))) / length(c_old) <> 1 then
		raise exception 'Founding name check anchor not found in %', v_target; end if;
	execute replace(v_definition, c_old, c_new);
end $$;

-- How the creation's Co-Founder's first run stands (see the header). Read in the table's JSON only.
create function public.qorpera_folder_company_first_run_state(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930039000: L2.
	select case
		when input.completed_at is not null or input.execution_run_id is not null then 'started'
		when input.failed_at is not null or request.status = 'failed' then 'failed'
		when request.status = 'queued' then 'queued'
		when request.id is null then 'waiting_for_login'
		else 'failed' end
	from public.qorpera_folder_company_creations as creation
	join public.qorpera_agent_first_runs as first_run on first_run.profile_id = creation.profile_id
		and first_run.staff_agent_id = creation.cofounder_id
	join public.qorpera_session_inputs as input on input.id = first_run.input_id
	left join public.qorpera_session_turn_requests as request on request.input_id = input.id
	where creation.profile_id = p_profile_id
$$;
revoke all on function public.qorpera_folder_company_first_run_state(uuid) from public, anon, authenticated, service_role;

do $$
declare v_target constant regprocedure := 'public.qorpera_company_founding_json(uuid)';
	v_definition text := pg_get_functiondef(v_target);
	c_old constant text := $old$'companySetup',public.qorpera_folder_company_setup(p_profile_id)) end);$old$;
	c_new constant text := $new$'companySetup',public.qorpera_folder_company_setup(p_profile_id),
			-- 20260930039000: how the Co-Founder's first run stands.
			'firstRun',public.qorpera_folder_company_first_run_state(p_profile_id)) end);$new$;
begin
	if (length(v_definition) - length(replace(v_definition, c_old, ''))) / length(c_old) <> 1 then
		raise exception 'Founding table first-run anchor not found in %', v_target; end if;
	execute replace(v_definition, c_old, c_new);
end $$;
