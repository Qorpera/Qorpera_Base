-- 20260930415000: the legacy sweep, step D16 (the old Company Computer bindings). The governed Company Computer and the
-- legacy computer teardown go (folder-v2 only, the founder's decision of 3 October). Both served the version-1 Company
-- File cutover: a governed binding admitted a company-path-v1 computer beside a version-1 Company File, and a teardown
-- attested that a retired legacy computer was gone. A folder-v2 company never has either: the governed registration
-- needs a ready version-1 Company File, which the qorpera_company_files check forbids on folder-v2, and nothing calls the
-- teardown's registration. Nothing outside these two migrations (20260828013500, 20260828017000) calls either register.
-- 1. The office's first registration and the Company File interlock stop asking for a governed binding or a teardown;
--    the office's own binding still admits its computer. Each is patched in place from its live text, so its header,
--    its grants and the other migrations' changes to it stay; each anchor must occur exactly once.
-- 2. Company computer work stays refused. Only a governed binding admitted a turn, a run, a runner or an assignment of
--    worker class company_computer, so the three guards now refuse it outright, with the same errors. They keep their
--    names and triggers: a trigger's name sets its place in the firing order.
-- 3. Dropped: the governed binding's registration, description (the one member function), policy, match and update
--    guard; the teardown's registration, match, authority digest, immutability guard, torn-down history guard and work
--    guards; their six triggers on other tables.
-- 4. The tables qorpera_governed_company_computers and qorpera_legacy_company_computer_teardowns, which must be empty.
-- Every patched body names this migration (20260930415000), and every earlier marker in it stays.
set local lock_timeout = '3s';

create function pg_temp.d16_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep D16 anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The office's registration and the interlock. --------------------------------------------------------------------

select pg_temp.d16_patch('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)'::regprocedure,
$old$			and not public.qorpera_governed_company_computer_matches(computer)
			and not public.qorpera_runtime_office_matches(computer)
			and not public.qorpera_legacy_company_computer_teardown_matches(computer)) then
			raise exception 'Legacy office requires verified teardown or adoption' using errcode='55000';
$old$,
$new$			and not public.qorpera_runtime_office_matches(computer)) then
			-- 20260930415000 (legacy sweep D16): no governed binding or teardown adopts another company computer.
			raise exception 'Legacy office requires verified teardown or adoption' using errcode='55000';
$new$);

select pg_temp.d16_patch('public.qorpera_enforce_company_path_computer_interlock()'::regprocedure,
$old$		if public.qorpera_governed_company_computer_matches(new)
			or public.qorpera_runtime_office_matches(new)
			or public.qorpera_legacy_company_computer_teardown_matches(new) then return new; end if;
$old$,
$new$		-- 20260930415000 (legacy sweep D16): only the office's own binding admits a company computer.
		if public.qorpera_runtime_office_matches(new) then return new; end if;
$new$);

select pg_temp.d16_patch('public.qorpera_enforce_company_path_computer_interlock()'::regprocedure,
$old$			and not public.qorpera_governed_company_computer_matches(computer)
			and not public.qorpera_runtime_office_matches(computer)
			and not public.qorpera_legacy_company_computer_teardown_matches(computer)) then
$old$,
$new$			and not public.qorpera_runtime_office_matches(computer)) then
$new$);

-- 2. Company computer work stays refused. ----------------------------------------------------------------------------

create or replace function public.qorpera_enforce_governed_company_computer_work()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930415000 (legacy sweep D16): only a governed binding admitted company computer work, and there is none.
	if new.worker_class <> 'company_computer' then return new; end if;
	raise exception 'Company computer work requires cloud-governed path mediation'
		using errcode = '42501';
end
$$;

create or replace function public.qorpera_enforce_governed_company_computer_runner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930415000 (legacy sweep D16): only a governed binding admitted a company computer runner, and there is none.
	-- An existing one may still be revoked.
	if new.worker_class is distinct from 'company_computer' then return new; end if;
	if tg_op = 'UPDATE' and old.worker_class = 'company_computer'
		and new.status = 'revoked' then return new; end if;
	raise exception 'Company computer runner requires cloud-governed path mediation'
		using errcode = '42501';
end
$$;

create or replace function public.qorpera_enforce_governed_company_computer_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_runner public.qorpera_runners%rowtype;
begin
	-- 20260930415000 (legacy sweep D16): only a governed binding admitted a company computer runner's assignment, and
	-- there is none.
	select runner.* into strict v_runner
	from public.qorpera_runners as runner where runner.id = new.runner_id;
	if v_runner.worker_class is distinct from 'company_computer' then return new; end if;
	raise exception 'Company computer assignment requires cloud-governed path mediation'
		using errcode = '42501';
end
$$;

-- 3. The bindings' functions and their triggers on other tables. -----------------------------------------------------

drop trigger qorpera_guard_governed_company_computer_update on public.qorpera_logical_computers;
drop function public.qorpera_guard_governed_company_computer_update();
drop function public.qorpera_register_governed_company_computer(uuid,uuid,uuid,text,text,text,uuid);
drop function public.qorpera_describe_governed_company_computer(uuid);
drop function public.qorpera_governed_company_computer_matches(public.qorpera_logical_computers);
drop function public.qorpera_governed_company_computer_policy();

drop trigger qorpera_guard_torn_down_legacy_company_computer on public.qorpera_logical_computers;
drop trigger qorpera_guard_torn_down_legacy_computer_runner on public.qorpera_runners;
drop trigger qorpera_guard_torn_down_legacy_computer_run on public.qorpera_execution_runs;
drop trigger qorpera_guard_torn_down_legacy_computer_turn on public.qorpera_session_turn_requests;
drop trigger qorpera_guard_torn_down_legacy_computer_assignment on public.qorpera_runner_assignments;
drop function public.qorpera_guard_torn_down_legacy_company_computer();
drop function public.qorpera_guard_torn_down_legacy_computer_work();
drop function public.qorpera_guard_torn_down_legacy_computer_assignment();
drop function public.qorpera_register_legacy_company_computer_teardown(uuid,uuid,uuid,text,text,text,text,uuid);
drop function public.qorpera_legacy_company_computer_teardown_matches(public.qorpera_logical_computers);
drop function public.qorpera_legacy_company_computer_authority_sha256(public.qorpera_logical_computers);

-- 4. Last, because dropping the tables locks the tables their foreign keys name (the company, its logical computers,
-- compute identities and auth.users) until the migration commits. They go only while empty; the lock keeps a binding
-- or a teardown from arriving between the check and the drop. All in one statement, as 20260930330000 does: a bare
-- LOCK TABLE fails where each statement commits. The teardowns' immutability trigger goes with its table.
do $$
begin
	lock table public.qorpera_governed_company_computers, public.qorpera_legacy_company_computer_teardowns
		in access exclusive mode;
	if exists (select 1 from public.qorpera_governed_company_computers)
		or exists (select 1 from public.qorpera_legacy_company_computer_teardowns) then
		raise exception 'Legacy sweep D16 drops the governed Company Computers and the legacy teardowns only while there are none'
			using errcode = '55000'; end if;
	drop table public.qorpera_legacy_company_computer_teardowns;
	drop table public.qorpera_governed_company_computers;
end $$;
drop function public.qorpera_guard_legacy_company_computer_teardown();

-- Nothing that runs may still name them.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_(governed_company_computers|legacy_company_computer_teardowns)\M'
				|| '|qorpera_(register|describe)_governed_company_computer\M|qorpera_governed_company_computer_(matches|policy)\M'
				|| '|qorpera_guard_governed_company_computer_update\M'
				|| '|qorpera_register_legacy_company_computer_teardown\M|qorpera_legacy_company_computer_(teardown_matches|authority_sha256)\M'
				|| '|qorpera_guard_(legacy_company_computer_teardown|torn_down_legacy_company_computer)\M'
				|| '|qorpera_guard_torn_down_legacy_computer_(work|assignment)\M')
	loop
		raise exception 'Function % still names the old Company Computer bindings', v_name;
	end loop;
end $$;
