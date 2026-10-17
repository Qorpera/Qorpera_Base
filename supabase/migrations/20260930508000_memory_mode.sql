-- C5 (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §1, §4): memory containment. Agent notebooks are every company's
-- memory by default; the shared context (the summary trees and run logs of RUNTIME-AGENT-MEMORY-TREE.md) is a beta a
-- company chooses in Settings, and can leave.
-- * The choice: qorpera_company_memory_modes, one row per company that chose; no row is Agent notebooks. Owners and
--   admins set it (qorpera_set_company_memory_mode), every member reads it (qorpera_company_memory_mode). A database
--   setting, not a company file: an agent can write every company file, so a file could turn the beta on.
-- * Offered: the beta can be chosen only by a company on the operator's test list (qorpera_memory_tree_companies). The
--   list alone never turns it on. Effective: Shared context only when chosen and offered; anything else is notebooks.
-- * Per run: qorpera_execution_runs.memory_mode, pinned when the run row is made (one indexed read of the company's
--   effective mode) and never changed after. A change applies to runs made after it; a run already made, active or
--   resumed, keeps its mode. A run made before this migration has none, and none is notebooks everywhere (no backfill;
--   the column is nullable, so adding it rewrites no table). A failed lookup pins notebooks, never the tree.
-- * The gate is by the run's mode, in every place that starts or reads the shared context: the view
--   (qorpera_memory_view_of), a new run log (qorpera_memory_run_log_place and qorpera_memory_run_log_paths), the
--   conversation tree's writes (qorpera_memory_run_tree_problem), and the run tools over it (branches, zoom, release,
--   view record, events, view reference check). A log already made goes on, as before.
-- * The gate stays until an explicit product decision. This supersedes 20260930352000's note that W1d drops it.
--   Nothing is deleted or rewritten: switching keeps every tree and log, and erasure works on them in both modes.
-- Background tree work that no run holds (master at this migration), each run in every mode:
-- * None folds or composes. §15 rejected a background summarizer; folding (W2), the lines' settle and closing work
--   (log close, lines finish, the compactor) run inside a run's lease, under its recorded mode. A worker run (W4) is a
--   run of its own and gets the company's mode when it is made.
-- * Erasure and retention, which always run and read no mode: the prune (qorpera_memory_tree_prune, pg_cron jobs
--   qorpera-memory-tree-prune and qorpera-memory-tree-prune-log, 20260928549460); the folder erase hooks
--   (qorpera_memory_tree_deleted, qorpera_memory_run_log_deleted); the message eraser (the object gateway's
--   memory-message-eraser over qorpera_memory_message_erase_*). Test 687 holds this list.
-- Every inserted text names this migration (20260930508000), for the deploy guard.

do $$ begin
	if to_regclass('public.qorpera_company_memory_modes') is not null then
		raise exception 'C5 (20260930508000) is already applied'; end if;
	if to_regprocedure('public.qorpera_memory_run_log_place(uuid,uuid)') is null
		or strpos(coalesce((select prosrc from pg_proc
			where oid = to_regprocedure('public.qorpera_memory_run_log_place(uuid,uuid)')), ''), '20260930352000') = 0 then
		raise exception 'C5 (20260930508000) needs W1c-3 (20260930352000)'; end if;
	if to_regprocedure('public.qorpera_memory_view_reference_check_run(jsonb,jsonb)') is null then
		raise exception 'C5 (20260930508000) needs W4b''s worker view reference check'; end if;
end $$;

set local lock_timeout = '3s';

-- 1. The choice -----------------------------------------------------------------------------------------------------------

create table public.qorpera_company_memory_modes (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	mode text not null check (mode in ('notebooks', 'tree')),
	set_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_company_memory_modes enable row level security;
revoke all on public.qorpera_company_memory_modes from public, anon, authenticated, service_role;
comment on table public.qorpera_company_memory_modes is
	'C5 (20260930508000): the company''s memory choice in Settings: notebooks (Agent notebooks) or tree (Shared context '
	'— Beta). No row is notebooks. Read through qorpera_company_memory_mode_effective; set by owners and admins.';

comment on table public.qorpera_memory_tree_companies is
	'Summary trees M1, C5 (20260930508000): the operator''s test list, the companies that may choose Shared context — '
	'Beta in Settings. The list alone never turns the beta on (qorpera_company_memory_modes).';

create function public.qorpera_company_memory_beta_offered(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_memory_tree_companies c where c.profile_id = p_profile_id)
$$;
revoke all on function public.qorpera_company_memory_beta_offered(uuid) from public, anon, authenticated, service_role;

-- One statement, two primary-key probes: the read every new run makes.
create function public.qorpera_company_memory_mode_effective(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select case when exists (select 1 from public.qorpera_company_memory_modes m
		join public.qorpera_memory_tree_companies c on c.profile_id = m.profile_id
		where m.profile_id = p_profile_id and m.mode = 'tree') then 'tree' else 'notebooks' end
$$;
revoke all on function public.qorpera_company_memory_mode_effective(uuid) from public, anon, authenticated, service_role;

-- 2. The run's mode -------------------------------------------------------------------------------------------------------

alter table public.qorpera_execution_runs add column memory_mode text
	constraint qorpera_execution_runs_memory_mode_check check (memory_mode in ('notebooks', 'tree'));
comment on column public.qorpera_execution_runs.memory_mode is
	'C5 (20260930508000): the company''s effective memory mode when the run was made, never changed after. Null (a run '
	'made before C5) is notebooks.';

-- Whatever the inserter asks, the run gets the company's effective mode; a failed lookup gets notebooks.
create function public.qorpera_pin_execution_memory_mode()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_op = 'UPDATE' then
		if new.memory_mode is distinct from old.memory_mode then
			raise exception 'Execution memory mode is immutable' using errcode = '42501'; end if;
		return new;
	end if;
	new.memory_mode := 'notebooks';
	begin
		new.memory_mode := coalesce(public.qorpera_company_memory_mode_effective(new.profile_id), 'notebooks');
	exception when others then
		new.memory_mode := 'notebooks';
	end;
	return new;
end $$;
revoke all on function public.qorpera_pin_execution_memory_mode() from public, anon, authenticated, service_role;

create trigger qorpera_execution_run_memory_mode
	before insert or update of memory_mode on public.qorpera_execution_runs
	for each row execute function public.qorpera_pin_execution_memory_mode();

-- 3. Settings -------------------------------------------------------------------------------------------------------------

-- The choice, what runs use now, whether the beta is offered, and the runs still working in the other mode (made
-- before the last change; each finishes in its own mode), so Settings can explain the transition.
create function public.qorpera_company_memory_mode(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_row public.qorpera_company_memory_modes%rowtype; v_effective text;
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only members of this company can read its memory' using errcode = '42501'; end if;
	select * into v_row from public.qorpera_company_memory_modes m where m.profile_id = p_profile_id;
	v_effective := public.qorpera_company_memory_mode_effective(p_profile_id);
	return jsonb_build_object('schema', 'qorpera.company-memory-mode/v1', 'profileId', p_profile_id,
		'mode', coalesce(v_row.mode, 'notebooks'), 'setAt', v_row.set_at, 'effective', v_effective,
		'betaOffered', public.qorpera_company_memory_beta_offered(p_profile_id),
		'canManage', public.qorpera_can_authorize_profile(p_profile_id),
		'runsInOtherMode', (select count(*) from public.qorpera_runner_jobs j
			join public.qorpera_execution_runs r on r.job_id = j.id
			where j.profile_id = p_profile_id and j.status in ('queued', 'leased')
				and coalesce(r.memory_mode, 'notebooks') <> v_effective));
end $$;
revoke all on function public.qorpera_company_memory_mode(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_company_memory_mode(uuid) to authenticated;

-- Owners and admins choose. Shared context only while it is offered; notebooks always. The same choice again changes
-- nothing (not even setAt).
create function public.qorpera_set_company_memory_mode(p_profile_id uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if p_mode is null or p_mode not in ('notebooks', 'tree') then
		raise exception 'Memory mode is invalid' using errcode = '22023'; end if;
	if public.qorpera_member_role(p_profile_id) is null then
		raise exception 'Only members of this company can change its memory' using errcode = '42501'; end if;
	if not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'Only owners and admins change the company''s memory' using errcode = '42501'; end if;
	-- No lock on the company row (core §3): the upsert's row lock orders two choices, and its foreign key keeps the
	-- company while the first is written.
	if p_mode = 'tree' and not public.qorpera_company_memory_beta_offered(p_profile_id) then
		raise exception 'Shared context is not available for this company yet' using errcode = '55000'; end if;
	insert into public.qorpera_company_memory_modes as m (profile_id, mode) values (p_profile_id, p_mode)
	on conflict (profile_id) do update set mode = excluded.mode, set_at = clock_timestamp()
		where m.mode is distinct from excluded.mode;
	return public.qorpera_company_memory_mode(p_profile_id);
end $$;
revoke all on function public.qorpera_set_company_memory_mode(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_set_company_memory_mode(uuid, text) to authenticated;

-- 4. The gate, by the run's mode ------------------------------------------------------------------------------------------

create function pg_temp.c5_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C5 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The view: none for a notebook run (the runtime then composes the history, as before).
select pg_temp.c5_replace('public.qorpera_memory_view_of(uuid)'::regprocedure,
	$old$	if v_run.session_id is null
		or not exists (select 1 from public.qorpera_memory_tree_companies c where c.profile_id = v_run.profile_id) then
		return null; end if;
$old$,
	$new$	-- 20260930508000 (C5): a view only for a run recorded in the beta (Shared context).
	if v_run.session_id is null or v_run.memory_mode is distinct from 'tree' then
		return null; end if;
$new$);

-- A new log's place: off for a notebook run. A log already made goes on (answered before this).
select pg_temp.c5_replace('public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure,
	$old$	-- 20260930352000 (W1c-3): run logs only for listed companies, until W1d (erasure of work) is live: then this gate
	-- drops here, in one place. A log already made goes on.
	if exists (select 1 from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id
		and not exists (select 1 from public.qorpera_memory_tree_companies c where c.profile_id = r.profile_id)) then
		return jsonb_build_object('off', true); end if;
$old$,
	$new$	-- 20260930352000 (W1c-3), 20260930508000 (C5): run logs only for runs recorded in the beta (Shared context). The
	-- gate stays until an explicit product decision. A log already made goes on.
	if exists (select 1 from public.qorpera_execution_runs r where r.id = p_run_id and r.environment_id = p_environment_id
		and r.memory_mode is distinct from 'tree') then
		return jsonb_build_object('off', true); end if;
$new$);
comment on function public.qorpera_memory_run_log_place(uuid, uuid) is
	'Where a run''s log is or goes. C5 (20260930508000): a new log only for a run recorded in the beta; the gate stays '
	'until an explicit product decision, superseding 20260930352000''s note that W1d drops it.';

-- A new log's first write, whoever writes it: only a run recorded in the beta.
select pg_temp.c5_replace(
	'public.qorpera_memory_run_log_paths(uuid,jsonb,text,text,jsonb,text)'::regprocedure,
	E'\tv_home := public.qorpera_memory_run_log_home(p_environment_id, v_run);\n',
	$new$	-- 20260930508000 (C5): a new log only for a run recorded in the beta (Shared context).
	if not exists (select 1 from public.qorpera_execution_runs r where r.id = v_run and r.environment_id = p_environment_id
		and r.memory_mode = 'tree') then
		return jsonb_build_object('ok', false, 'reason', 'structured_rule', 'problems', jsonb_build_array(
			public.qorpera_company_state_problem('value', null, null, 'a notebook run keeps no run log'))); end if;
	v_home := public.qorpera_memory_run_log_home(p_environment_id, v_run);
$new$);

-- The conversation tree's writes: only a run recorded in the beta.
select pg_temp.c5_replace(
	'public.qorpera_memory_run_tree_problem(uuid,jsonb,text,text)'::regprocedure,
	E'\tselect r.session_id, public.qorpera_memory_conversation_root(r.environment_id, r.profile_id, r.session_id), t.root_key\n',
	$new$	-- 20260930508000 (C5): only a run recorded in the beta (Shared context) writes its conversation's tree.
	if not exists (select 1 from public.qorpera_execution_runs r where r.id = (p_actor ->> 'runId')::uuid
		and r.environment_id = p_environment_id and r.memory_mode = 'tree') then
		return 'a notebook run writes no conversation tree'; end if;
	select r.session_id, public.qorpera_memory_conversation_root(r.environment_id, r.profile_id, r.session_id), t.root_key
$new$);

-- The run tools over the shared context: refused for a notebook run, before anything else is read. The compaction
-- record is not one: it only counts compactor calls a run has made, and a notebook run makes none.
do $patch$
declare
	v_bound constant text := E'\tv_run := jsonb_populate_record(null::public.qorpera_execution_runs, '
		|| E'public.qorpera_folder_tool_run(p_binding, ''[]''::jsonb) -> ''run'');\n';
	v_refuse constant text := $new$	-- 20260930508000 (C5): the shared context is the beta's; a notebook run has none.
	if v_run.memory_mode is distinct from 'tree' then
		raise exception 'A notebook run has no shared context' using errcode = '42501'; end if;
$new$;
	v_function text;
begin
	foreach v_function in array array['public.qorpera_memory_branches(jsonb,jsonb)', 'public.qorpera_memory_zoom(jsonb,jsonb)',
		'public.qorpera_memory_release(jsonb,jsonb)'] loop
		perform pg_temp.c5_replace(v_function::regprocedure, v_bound, v_bound || v_refuse);
	end loop;
	perform pg_temp.c5_replace('public.qorpera_memory_view_record(jsonb,jsonb)'::regprocedure,
		E'\tv_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> ''run'');\n',
		E'\tv_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> ''run'');\n' || v_refuse);
	perform pg_temp.c5_replace('public.qorpera_memory_events_run(jsonb,jsonb)'::regprocedure,
		E'\t\tpublic.qorpera_folder_tool_run(p_binding, ''[]''::jsonb) -> ''run'');\n',
		E'\t\tpublic.qorpera_folder_tool_run(p_binding, ''[]''::jsonb) -> ''run'');\n' || v_refuse);
end $patch$;

select pg_temp.c5_replace('public.qorpera_memory_view_reference_check_run(jsonb,jsonb)'::regprocedure,
	E'\treturn public.qorpera_memory_view_reference_check((v_tool #>> ''{run,environment_id}'')::uuid, p_view);\n',
	$new$	-- 20260930508000 (C5): the shared context is the beta's; a notebook run has none.
	if (v_tool #>> '{run,memory_mode}') is distinct from 'tree' then
		return 'a notebook run has no shared context'; end if;
	return public.qorpera_memory_view_reference_check((v_tool #>> '{run,environment_id}')::uuid, p_view);
$new$);

-- 5. The deploy guard (create or replace keeps each function's grants) --------------------------------------------------

do $guard$
declare v_function text; v_readers text[];
begin
	foreach v_function in array array['public.qorpera_memory_view_of(uuid)', 'public.qorpera_memory_run_log_place(uuid,uuid)',
		'public.qorpera_memory_run_log_paths(uuid,jsonb,text,text,jsonb,text)',
		'public.qorpera_memory_run_tree_problem(uuid,jsonb,text,text)', 'public.qorpera_memory_branches(jsonb,jsonb)',
		'public.qorpera_memory_zoom(jsonb,jsonb)', 'public.qorpera_memory_release(jsonb,jsonb)',
		'public.qorpera_memory_view_record(jsonb,jsonb)', 'public.qorpera_memory_events_run(jsonb,jsonb)',
		'public.qorpera_memory_view_reference_check_run(jsonb,jsonb)'] loop
		if strpos((select prosrc from pg_proc where oid = v_function::regprocedure), '20260930508000') = 0 then
			raise exception 'C5 marker is missing in %', v_function; end if;
	end loop;
	select array_agg(p.proname::text order by p.proname) into v_readers from pg_proc p
	where p.pronamespace = 'public'::regnamespace and strpos(p.prosrc, 'qorpera_memory_tree_companies') > 0;
	if v_readers is distinct from array['qorpera_company_memory_beta_offered', 'qorpera_company_memory_mode_effective'] then
		raise exception 'C5: only the offer and the effective mode read the test list, not %', v_readers; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_memory_run_log_place(uuid,uuid)'::regprocedure),
		'20260930352000') = 0 then
		raise exception 'C5 lost the W1c-3 marker in the place'; end if;
end $guard$;
