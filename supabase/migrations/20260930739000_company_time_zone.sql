-- 20260930739000: a company has a time zone, taken once from a member's browser, and the executor's list of machines
-- names it, so the clock of an agent's desktop computer shows the company's time (Jonas, 12 November 2026, asked "Give
-- each company a time zone, taken from the founder's browser, so the clock is right?": "Yes, from the browser"). Until
-- now the product kept a time zone per routine only, and a desktop's clock was on UTC, an hour off for a Danish founder.
--
-- * qorpera_profiles.time_zone: one IANA zone name per company, null while it is not known. The company's own row is
--   the home of the company's own facts (its name lives there); the company folder holds what agents and members work
--   on, and nothing in it is a company setting. The executor's list reads the row by its key, once per placement.
-- * qorpera_ensure_company_time_zone(profile, zone), for authenticated: a member who may act for the company (owner,
--   admin, contributor: qorpera_can_write_profile; a viewer and an outsider are refused, 42501) hands in the zone their
--   browser shows times in. It is taken ONLY while the company has none, in one statement, so of two members at once the
--   first is taken and the second is answered the first's. It answers the company's zone either way. A name the
--   database does not know is refused (22023): the name must be one of pg_timezone_names, read from the product's own
--   copy of that set (qorpera_runtime_time_zone_names, 20260905000400, which SQL test 325 holds equal to it and a
--   routine's time zone is checked against; a scan of pg_timezone_names itself took 1.5 s on the deployed database), and
--   must have the shape the machine accepts before it uses the word as part of a path: letters, digits, `_`, `+`, `-`,
--   at most two `/`, at most 64 characters (the column's own check).
-- * Nothing else changes it: no setting, no agent tool. A later change is one more function (or one statement by an
--   operator) that updates the column; the executor writes a changed zone into the machine on its next pass, and a
--   desktop shows it from its next start.
-- * qorpera_profile_team_info, the read a client makes when a company opens, gains `time_zone` (the name, or null): the
--   web hands its zone in only when that key is there and null. A client from before this ignores the key (its readers
--   take the keys they know). The list of companies (qorpera_list_hosted_profiles) is NOT changed: the member web's
--   reader refuses a company with a key it does not know.
-- * qorpera_list_executor_machines gains `timeZone` in each placement's entry: the company's zone, null while it is not
--   known. The executor writes the word into the machine's /etc/qorpera-machine/desktop-timezone, as it writes the
--   starter's figure (20260930737000), also for a machine no run started (the zone is the company's, not a run's). An
--   executor that does not know the key ignores it; one that knows it and meets an SQL without it writes nothing.
-- * A routine's own time zone is not touched and does not take the company's as its default. The machine's system time
--   zone stays UTC: only its desktop's clock and backdrop follow the company.
-- * Each patched body is patched by one exact anchor, keeps the markers of what patched it before, and names this
--   migration, for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_ensure_company_time_zone(uuid,text)') is not null then
		raise exception '20260930739000 is already applied'; end if;
	if position('20260930737000' in pg_get_functiondef('public.qorpera_list_executor_machines(text,text)'::regprocedure)) = 0 then
		raise exception '20260930739000 needs the machine''s starter in the executor''s list (20260930737000)'; end if;
	if to_regprocedure('public.qorpera_runtime_time_zone_name_valid(text)') is null then
		raise exception '20260930739000 needs the time zone names (20260905000400)'; end if;
end $$;

-- The new column and replacing the functions take locks: never queue behind a long transaction.
set local lock_timeout = '3s';

-- (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs left it,
-- and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.company_time_zone_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930739000' in v_definition) > 0 then
		raise exception '20260930739000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930739000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930739000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. The company's zone ----------------------------------------------------------------------------------------------------

-- A new column without a default rewrites nothing; its check reads the company rows once (every one passes: null).
alter table public.qorpera_profiles
	add column time_zone text,
	add constraint qorpera_profiles_time_zone_shape check (time_zone is null
		or (char_length(time_zone) between 1 and 64 and time_zone ~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$'));
comment on column public.qorpera_profiles.time_zone is
	'The company''s time zone, an IANA name; null while no member''s browser has handed one in (20260930739000).';

-- 2. A member's browser hands its zone in, once ------------------------------------------------------------------------------

create function public.qorpera_ensure_company_time_zone(p_profile_id uuid, p_time_zone text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_taken boolean; v_zone text;
begin
	-- 20260930739000
	if auth.uid() is null or p_profile_id is null then
		raise exception 'Company time zone is invalid' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	-- The word comes from a browser: the shape the machine accepts, and a name the database knows, exactly as spelt.
	if p_time_zone is null or char_length(p_time_zone) not between 1 and 64
		or p_time_zone !~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}$'
		or not public.qorpera_runtime_time_zone_name_valid(p_time_zone) then
		raise exception 'Time zone is unknown' using errcode = '22023'; end if;
	-- Taken only while the company has none. One statement: a second member's at the same moment waits for the first's
	-- row, reads it again, and changes nothing.
	update public.qorpera_profiles set time_zone = p_time_zone where id = p_profile_id and time_zone is null;
	v_taken := found;
	select profile.time_zone into strict v_zone from public.qorpera_profiles as profile where profile.id = p_profile_id;
	return jsonb_build_object('schema', 'qorpera.company-time-zone/v1', 'timeZone', v_zone, 'taken', v_taken);
end
$$;
revoke all on function public.qorpera_ensure_company_time_zone(uuid, text)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_ensure_company_time_zone(uuid, text) to authenticated;

-- 3. The read a client makes when a company opens says the zone ---------------------------------------------------------------

do $$ begin execute pg_temp.company_time_zone_patched(
	'public.qorpera_profile_team_info(uuid)'::regprocedure,
	array[$old$		'profile_id', p_profile_id,
		'role', v_role,
$old$,
	$new$		'profile_id', p_profile_id,
		-- 20260930739000: the company's time zone, an IANA name; null while no member's browser has handed one in.
		'time_zone', (select profile.time_zone from public.qorpera_profiles as profile where profile.id = p_profile_id),
		'role', v_role,
$new$]); end $$;

-- 4. The executor's list of machines says the zone ----------------------------------------------------------------------------

do $$ begin execute pg_temp.company_time_zone_patched(
	'public.qorpera_list_executor_machines(text,text)'::regprocedure,
	array[$old$				where staff.profile_id = machine.profile_id and staff.staff_agent_id = machine.started_by_staff_agent_id),
$old$,
	$new$				where staff.profile_id = machine.profile_id and staff.staff_agent_id = machine.started_by_staff_agent_id),
			-- 20260930739000: the company's time zone, null while it is not known. The executor writes it into the
			-- machine, where its desktop's clock reads it.
			'timeZone',(select profile.time_zone from public.qorpera_profiles profile where profile.id = machine.profile_id),
$new$]); end $$;

-- The patched functions may have a private owner in production: it reaches what their new text reads.
do $$
declare v_owner name;
begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_profile_team_info(uuid)'::regprocedure,
		'public.qorpera_list_executor_machines(text,text)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930739000: a patched function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_profiles to %I', v_owner);
		end if;
	end loop;
end $$;

-- 5. The deploy guard: every new or patched body carries the marker, the patched ones keep theirs, and each stays in
-- the hands it was in.
do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_ensure_company_time_zone(uuid,text)',
		'public.qorpera_profile_team_info(uuid)',
		'public.qorpera_list_executor_machines(text,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930739000') = 0 then
			raise exception '20260930739000 marker is missing in %', v_function; end if;
	end loop;
	if exists (select 1 from unnest(array['20260930010000', '20260930330000']) marker
			where strpos((select prosrc from pg_proc where oid = 'public.qorpera_profile_team_info(uuid)'::regprocedure), marker) = 0)
		or exists (select 1 from unnest(array['20260929730000', '20260930055000', '20260930737000']) marker
			where strpos((select prosrc from pg_proc
				where oid = 'public.qorpera_list_executor_machines(text,text)'::regprocedure), marker) = 0) then
		raise exception '20260930739000: a patched body lost its earlier marker'; end if;
	if has_function_privilege('anon', 'public.qorpera_list_executor_machines(text,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_list_executor_machines(text,text)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_list_executor_machines(text,text)', 'execute') then
		raise exception '20260930739000: the executor''s machine list changed hands'; end if;
	if not has_function_privilege('authenticated', 'public.qorpera_profile_team_info(uuid)', 'execute') then
		raise exception '20260930739000: the team read changed hands'; end if;
	if has_function_privilege('anon', 'public.qorpera_ensure_company_time_zone(uuid,text)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_ensure_company_time_zone(uuid,text)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_ensure_company_time_zone(uuid,text)', 'execute') then
		raise exception '20260930739000: the company''s time zone is not the members'' alone'; end if;
	-- The new function runs as its owner, who must reach the time zone names: refused here, not at a member's call.
	if not has_function_privilege((select proowner from pg_proc
			where oid = 'public.qorpera_ensure_company_time_zone(uuid,text)'::regprocedure),
			'public.qorpera_runtime_time_zone_name_valid(text)', 'execute') then
		raise exception '20260930739000: the owner of the company''s time zone cannot read the time zone names'; end if;
end $guard$;

drop function pg_temp.company_time_zone_patched(regprocedure, text[]);
