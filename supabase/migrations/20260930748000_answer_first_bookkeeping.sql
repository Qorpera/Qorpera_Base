-- 20260930748000: the answer first, then the bookkeeping (the 2026-11-13 amendment, proposed; lanes/agent-box-20261113,
-- B2). After its final send a run may still write its own bookkeeping: the folder receipts of `update_wall`,
-- `manage_todo`, `organize_apps` and `organize_sidebar`. Nothing else.
--
-- Why: the kernel refused every governed effect after a run's final send (the wake's work gate, 20260828023000:306-307,
-- reached from every folder receipt's begin, 20260928279540:160-161), so an agent kept its wall, to-do list, apps layout
-- and sidebar up to date BEFORE its answer, and the member waited through it: 5.7 s of a chat turn on average, 8.5 s in
-- the 30 of 45 measured chat turns that did any (Part D's extracts, 8-13 Nov 2026). The runtime now keeps the turn open
-- after the answer for those four tools alone (the tool boundary); this lets their writes through.
--
-- * qorpera_folder_begin_run_receipt marks the transaction (`qorpera.after_answer` = the run's id) around its call of the
--   wake's work gate when the receipt is a company revision whose key names one of the four tools. The runtime keys
--   every receipt `<tool>:<the tool's own key>` with the tool's fixed name (cloud-native-tool-operations.ts), and the
--   kernel's own effects key theirs `coworker:`, `worker:`, `hook:`, so no other call names one of the four. The mark is
--   cleared right after the gate, as the send's marker is (20260928279560's `qorpera.folder_send`).
-- * qorpera_assert_wake_work_allowed refuses "Wake public output is already final" as before, unless that mark names
--   this run. Every other check of the gate stands, in its order and for every receipt: the wake's authority, a
--   cancelled worker, a paused company, the acknowledgement (which a final send already needed).
-- Unchanged: the send (a second send after the final is still refused, so nothing after the answer speaks); every other
-- caller of the gate (cards, coworker messages, hooks, machines, mail, the secret broker and the rest) and every other
-- receipt, which the gate refuses after the final as before; a run cut off after its final still never resumes
-- (20260930547000); the functions' names, arguments, results, settings, owners and grants; the tables and the data.
-- Rolling: this migration before the runtime bundle that keeps the turn open (the release train's activation orders
-- them). An older runtime never writes after its final, so with this applied nothing changes for it. A newer runtime
-- on a kernel without this has its bookkeeping after the answer refused, and nothing is written; its answer stands.
-- Rollback: leave it applied; with an older runtime nothing reaches the new branch.
-- Every inserted text names this migration (20260930748000), for the deploy guard. SQL test 1242.

do $$
declare v_gate text := pg_get_functiondef('public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure);
	v_begin text := pg_get_functiondef('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure);
begin
	if strpos(v_gate, '20260930748000') > 0 or strpos(v_begin, '20260930748000') > 0 then
		raise exception '20260930748000 is already applied'; end if;
	if strpos(v_begin, '20260930539000') = 0 then
		raise exception '20260930748000 needs the receipts resume (20260930539000) in the receipt''s begin'; end if;
end $$;

set local lock_timeout = '3s';

-- The catalog check's baseline: every public function's catalog row apart from its body, and its body's md5.
create temporary table af_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

-- One exact anchor, found once, replaced.
create function pg_temp.af_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930748000: the anchor is not once in %', p_function; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The wake's work gate: after the final, only a receipt the begin marked for this run ---------------------------------

select pg_temp.af_replace('public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure,
	$old$	if exists(select 1 from public.qorpera_agent_sends where run_id = p_run_id and phase = 'final') then
$old$,
	$new$	if exists(select 1 from public.qorpera_agent_sends where run_id = p_run_id and phase = 'final')
		-- 20260930748000: the run's bookkeeping after its answer, as the receipt's begin marks it.
		and current_setting('qorpera.after_answer', true) is distinct from p_run_id::text then
$new$);

-- The receipt's begin marks the four bookkeeping tools' revisions for the gate, and only for its call ---------------

select pg_temp.af_replace('public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure,
	E'\tperform public.qorpera_assert_wake_work_allowed(v_run.id);\n',
	$new$	-- 20260930748000 (the answer first): after its final send a run still writes its own wall, to-do list, apps layout
	-- and sidebar. The runtime keys each receipt with its tool's fixed name first.
	if p_requires_company_revision is true
		and p_logical_operation_key ~ '^(update_wall|manage_todo|organize_apps|organize_sidebar):' then
		perform set_config('qorpera.after_answer', v_run.id::text, true); end if;
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	perform set_config('qorpera.after_answer', '', true);
$new$);

drop function pg_temp.af_replace(regprocedure, text, text);

-- The deploy guard -----------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_assert_wake_work_allowed(uuid)',
		'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930748000') = 0 then
			raise exception '20260930748000 marker is missing in %', v_function; end if;
	end loop;
	-- The resume's fence stays where it was, after the gate (20260930539000).
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure),
		'20260930539000') = 0 then
		raise exception '20260930748000 lost the receipts resume (20260930539000)'; end if;
end $guard$;

-- The catalog check ------------------------------------------------------------------------------------------------------

-- Exactly these two functions changed, only in their bodies; every other public function is as it was, and none came or
-- went.
do $$ begin
	if (select count(*) from pg_temp.af_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> 2
		or exists (select 1 from pg_temp.af_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and prior.oid not in (
					'public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure,
					'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure)))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.af_before as prior)) then
		raise exception '20260930748000: the catalog did not change as expected'; end if;
end $$;

drop table pg_temp.af_before;
