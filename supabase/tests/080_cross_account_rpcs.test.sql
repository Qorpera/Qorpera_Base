-- Cross-account denial across the granted RPC surface.
--
-- Every client RPC is security definer, so RLS is not what separates accounts
-- there -- the function's own auth.uid()/qorpera_can_* checks are. Suite 040
-- covers direct table access and a service-only entry point; this covers
-- the RPCs themselves, which is where the authorisation logic actually lives.
-- Account A's company is a folder-v2 company (040). The old core's RPCs
-- (artifact GC candidates and plans, workspaces, Company File revisions) are
-- not listed: they go with the old core.
--
-- Account B calls each RPC against account A's identifiers, which B is
-- assumed to have learned (ids are not secrets; the boundary must hold when
-- the attacker knows them). A pass is a 42501 denial, or a result carrying no
-- data. A leak is any payload. Anything else -- including a signature that no
-- longer exists -- fails loudly rather than passing quietly, because an
-- assertion that silently stops testing anything is worse than none.
--
-- Only RPCs keyed by an identifier account A actually owns are listed. Others
-- in the granted surface are keyed by a workspace, plan, version or job id
-- and would test nothing here; covering those needs fixtures that create
-- those objects for A first, and is left for when this suite grows them.

select set_config('qorpera_test.rpc_profile_a',
	(select profile.id::text from public.qorpera_profiles as profile
	where profile.name = 'Separation A' limit 1), false);
select set_config('qorpera_test.rpc_environment_a',
	(select environment.id::text from public.qorpera_company_environments as environment
	where environment.profile_id = current_setting('qorpera_test.rpc_profile_a')::uuid
	limit 1), false);

select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_a text := current_setting('qorpera_test.rpc_profile_a');
	v_env text := current_setting('qorpera_test.rpc_environment_a');
	v_expected integer := 13;
	v_case record;
	v_sql text;
	v_retset boolean;
	v_oid oid;
	v_count bigint;
	v_leaked text[] := '{}';
	v_missing text[] := '{}';
	v_unexpected text[] := '{}';
	v_denied integer := 0;
	v_empty integer := 0;
begin
	if current_user <> 'authenticated' then
		raise exception 'cross-account rpc suite is not running as authenticated (got %)', current_user;
	end if;
	if v_a is null or v_env is null then
		raise exception 'cross-account rpc suite lost its fixtures';
	end if;
	if not public.qorpera_company_is_folder_v2(v_a::uuid) then
		raise exception 'the cross-account rpc suite''s company is not a folder-v2 company';
	end if;

	for v_case in
		select *
		from (values
			-- profile-keyed reads
			('qorpera_list_profile_staff(uuid)', format('public.qorpera_list_profile_staff(%L)', v_a)),
			('qorpera_member_role(uuid)', format('public.qorpera_member_role(%L)', v_a)),
			('qorpera_profile_team_info(uuid)', format('public.qorpera_profile_team_info(%L)', v_a)),
			('qorpera_list_runners(uuid)', format('public.qorpera_list_runners(%L)', v_a)),
			('qorpera_list_runner_jobs(uuid, integer)', format('public.qorpera_list_runner_jobs(%L, 10)', v_a)),
			('qorpera_list_runner_usage(uuid, bigint, integer)', format('public.qorpera_list_runner_usage(%L, 0, 10)', v_a)),
			('qorpera_list_runner_audit(uuid, bigint, integer)', format('public.qorpera_list_runner_audit(%L, 0, 10)', v_a)),
			('qorpera_list_runner_model_usage(uuid, bigint, integer)', format('public.qorpera_list_runner_model_usage(%L, 0, 10)', v_a)),
			('qorpera_profile_object_writes_allowed(uuid)', format('public.qorpera_profile_object_writes_allowed(%L)', v_a)),
			-- environment-keyed reads
			('qorpera_get_company_file(uuid)', format('public.qorpera_get_company_file(%L)', v_env)),
			('qorpera_list_shared_sessions(uuid)', format('public.qorpera_list_shared_sessions(%L)', v_env)),
			-- writes
			('qorpera_invite_profile_member(uuid, text, public.qorpera_profile_role)', format('public.qorpera_invite_profile_member(%L, %L, ''contributor'')', v_a, 'cross-account@example.test')),
			('qorpera_create_shared_session(uuid, text, text, uuid)', format('public.qorpera_create_shared_session(%L, ''Hijack'', null, null)', v_env))
		) as t(sig, call)
	loop
		v_oid := to_regprocedure(v_case.sig);
		if v_oid is null then
			-- A drifted signature would make the call below raise
			-- undefined_function, which a naive handler would score as a
			-- denial. Fail instead.
			v_missing := v_missing || v_case.sig;
			continue;
		end if;
		select proretset into v_retset from pg_proc where oid = v_oid;

		if v_retset then
			v_sql := 'select count(*) from ' || v_case.call || ' as probe';
		else
			-- Scalar results count as a leak only when they actually carry
			-- something: null, false, and empty json are all refusals.
			v_sql := 'select count(*) from (select (' || v_case.call || ')::text as value) as probe'
				|| ' where probe.value is not null'
				|| ' and probe.value not in (''false'', ''[]'', ''{}'', ''null'', '''')';
		end if;

		begin
			execute v_sql into v_count;
			if v_count > 0 then
				v_leaked := v_leaked || v_case.sig;
			else
				v_empty := v_empty + 1;
			end if;
		exception
			when insufficient_privilege then
				v_denied := v_denied + 1;
			when others then
				v_unexpected := v_unexpected || (v_case.sig || ' -> ' || sqlstate || ' ' || sqlerrm);
		end;
	end loop;

	if array_length(v_missing, 1) is not null then
		raise exception 'rpc signatures no longer exist (test would pass vacuously): %', array_to_string(v_missing, '; ');
	end if;
	if array_length(v_leaked, 1) is not null then
		raise exception 'cross-account leak from: %', array_to_string(v_leaked, '; ');
	end if;
	if array_length(v_unexpected, 1) is not null then
		-- Not necessarily a vulnerability, but the call did not prove denial,
		-- so it must not be counted as covered.
		raise exception 'inconclusive cross-account results: %', array_to_string(v_unexpected, '; ');
	end if;
	if v_denied + v_empty < v_expected then
		raise exception 'only % of % rpc cases reached a verdict', v_denied + v_empty, v_expected;
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Positive control: account A reaches its own data through the same RPCs, so
-- the denials above are separation rather than a uniformly broken surface.
select set_config('request.jwt.claims', '{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_a uuid := current_setting('qorpera_test.rpc_profile_a')::uuid;
	v_env uuid := current_setting('qorpera_test.rpc_environment_a')::uuid;
	v_role text;
	v_team jsonb;
begin
	select public.qorpera_member_role(v_a) into v_role;
	if v_role is distinct from 'owner' then
		raise exception 'owning account reads its own role as % (expected owner)', v_role;
	end if;
	select public.qorpera_profile_team_info(v_a) into v_team;
	if v_team is null then
		raise exception 'owning account cannot read its own team info';
	end if;
	if public.qorpera_get_company_file(v_env) is null then
		raise exception 'owning account cannot read its own Company File';
	end if;
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);
