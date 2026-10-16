-- A routine never watches a reserved path (launch checklist L23.2, 16 October 2026).
--
-- An agent's manage_routine saved a file-change routine watching inbox/. No save ever lands on a reserved path
-- (qorpera_folder_path_reserved: .qorpera, trail, inbox, credentials and secrets, and .git or node_modules outside code/;
-- the folder commit refuses them for every actor), so that routine would never wake. The routine rules
-- (qorpera_company_state_routine_rules, 20260928259310 and P29's 20260928479120) now refuse such a watch as they refuse
-- the other file-change problems: structured_rule, one value problem that names the watch. The check comes first among
-- the file-change checks, so a reserved watch the agent may not read either (credentials, secrets) gets this reason.
-- The watch is checked by its folder key, as the trigger stores it, so Inbox, inbox and inbox/x.md are all refused. The
-- rules run on every save of a routine file (a write or a restore), so a routine saved with such a watch before this
-- can be changed to watch another path, or deleted, but no longer saved as it is. Folder-v2 only. The patched body
-- carries the marker 20260930493000.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure),
		'20260930493000') > 0 then
		raise exception 'Routine reserved watch (20260930493000) is already applied'; end if;
end $$;

create function pg_temp.reserved_watch_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Routine reserved watch anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The rules: before P29's read check, a watch on a reserved path is refused.
select pg_temp.reserved_watch_replace('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure,
	$old$	-- 20260930020000 (P29): file-change routines run on the folder's journal.$old$,
	$new$	-- 20260930493000 (L23.2): no save lands on a reserved path, so a routine watching one would never wake.
	elsif v_when = 'file-change'
		and public.qorpera_folder_path_reserved(public.qorpera_folder_key(p_parse -> 'trigger' ->> 'watch')) then
		v_problem := left(p_parse -> 'trigger' ->> 'watch', 100) || ' is reserved: nothing is ever saved there, so this '
			|| 'routine would never wake; watch a folder the company writes, like orders';
	-- 20260930020000 (P29): file-change routines run on the folder's journal.$new$);

drop function pg_temp.reserved_watch_replace(regprocedure, text, text);

-- The patched body keeps P29's and E2a's markers, which their migrations check, and carries this one.
do $$
declare v_source text := (select prosrc from pg_proc
	where oid = 'public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure);
begin
	if strpos(v_source, '20260930493000') = 0 or strpos(v_source, '20260930020000') = 0
		or strpos(v_source, '20260930061000') = 0 then
		raise exception 'Routine reserved watch (20260930493000): a marker is missing in the routine rules'; end if;
end $$;
