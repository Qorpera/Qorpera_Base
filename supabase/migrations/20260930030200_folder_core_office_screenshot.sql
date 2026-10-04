-- Company folder core, C1c-3l part 3 (the coordinator's audit P06c): an agent's screenshot of the Company Computer on a
-- folder-v2 company is refused before its operation's receipt begins (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md
-- §6.17).
--
-- Before, qorpera_native_office_capture refused folder-v2 with 0A000 only after the screenshot operation's receipt had
-- begun: the receipt stayed open and fenced the run's later operations. Now qorpera_native_office_operation refuses a
-- screenshot on folder-v2 at its authorize, before any receipt, and at every later step; the run goes on. Real
-- screenshots on folder-v2 need the pixels carried from the office service to the native host and a capture in the
-- folder-v2 context view, which is their own design. Folder-v2 only (the founder's decision of 3 October): nothing else
-- changes. The patched function names this migration (20260930030200) in its body, for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.c1c3l3_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-3l part 3 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
begin
	perform pg_temp.c1c3l3_replace('public.qorpera_native_office_operation(jsonb,jsonb,jsonb,text,text,uuid,text)',
		E'\tif v_operation#>>''{arguments,kind}''=''screen'' then\n',
		E'\t-- C1c-3l (20260930030200): no screenshot on folder-v2 yet. It is refused at authorize, before its receipt begins,\n'
		|| E'\t-- and at every later step.\n'
		|| E'\tif v_operation#>>''{arguments,kind}''=''screenshot'' and public.qorpera_binding_is_folder_v2(p_binding) then\n'
		|| E'\t\traise exception ''Screenshots are not available on this computer yet'' using errcode=''0A000''; end if;\n'
		|| E'\tif v_operation#>>''{arguments,kind}''=''screen'' then\n', 1);
end $$;

drop function pg_temp.c1c3l3_replace(regprocedure, text, text, integer);
