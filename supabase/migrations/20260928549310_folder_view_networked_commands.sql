-- Networked commands' views: F3 step 4, slice 4b-2 (deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md), for the
-- contract's 2026-10-14 amendment ("machines work in the folder as on their own disk"), item 2: a command that uses the
-- network keeps the folder, as an offline command does.
-- 1. The open: the platform opens a networked command's view as an offline one's (20260930183000 refused it). Every
--    other check stands. A row the office's report made still gets none: it has no screen generation.
-- The row keeps `network` as the start said it; no view check reads it any more.
--
-- Exact-text patch: it fails unless the function has the text given exactly once. Body marker "20260930342000".

set local lock_timeout = '3s';

create function pg_temp.folder_view_networked_commands_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The open --------------------------------------------------------------------------------------------------------

select pg_temp.folder_view_networked_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$		-- 20260930183000 (C1b-3b): an offline command, before it runs: its row not ended, its run holding the screen in$old$,
	$new$		-- 20260930183000 (C1b-3b): a command, before it runs: its row not ended, its run holding the screen in$new$);
select pg_temp.folder_view_networked_commands_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$		if not coalesce(v_office.environment_id = p_environment_id and not v_command.network and v_command.ended_at is null$old$,
	$new$		-- 20260930342000 (F3 4b-2): a networked command's view opens as an offline one's (amended 14 October 2026).
		if not coalesce(v_office.environment_id = p_environment_id and v_command.ended_at is null$new$);
