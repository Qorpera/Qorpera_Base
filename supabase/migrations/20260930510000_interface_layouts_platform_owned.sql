-- 20260930510000: C6, the Interfaces write-path boundary (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §2,
-- "Containment"). Interfaces are Qorpera's own pages: agents create and redesign none, and no file decides which page
-- is active (20260930509000 keeps that in its own table). Whatever carries an agent's change (a tool call, an older
-- or replayed call, an approved review, a file write, a shell or a mounted folder, a proposal applied later), the
-- folder core's save check refuses each unit of it that changes anything under interfaces/, or the tables/ root, a
-- table's folder or its table.toml, with the stable code layout_authoring: "page and table layout authoring is not
-- available". The commit's other units are decided as before.
-- * The check is the first of qorpera_company_state_interface_paths, which qorpera_folder_structured_decide runs for
--   every unit of every commit, at commit time (a staged or reviewed change is checked again when it commits, and a
--   view's unit is decided before it could be parked as a proposal). Its actor is the hook actor: kind staff_agent for
--   every agent's run, routine, coding session, computer and test machine, and never for a member or the platform.
-- * An agent still reads all of it, copies out of interfaces/, and writes a table's rows.csv under the claim rule.
-- * Members and the platform (company creation, the platform writer) keep every rule as it was. Stored definitions,
--   offers and rows stay as they are; nothing is deleted.
-- Every patched body names this migration (20260930510000), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.c6_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_i integer; v_count integer;
begin
	for v_i in 1 .. coalesce(array_length(p_edits, 1), 0) / 2 loop
		v_count := (length(v_definition) - length(replace(v_definition, p_edits[2 * v_i - 1], ''))) / nullif(length(p_edits[2 * v_i - 1]), 0);
		if v_count is distinct from 1 then
			raise exception 'C6 anchor found % time(s) in %: %', coalesce(v_count, 0), p_target, left(p_edits[2 * v_i - 1], 120); end if;
		v_definition := replace(v_definition, p_edits[2 * v_i - 1], p_edits[2 * v_i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.c6_patch('public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure,
	array[$old$	if p_key !~ '^(interfaces|tables)(/|$)' and coalesce(p_to_key, '') !~ '^(interfaces|tables)(/|$)' then return null; end if;
$old$,
	$new$	if p_key !~ '^(interfaces|tables)(/|$)' and coalesce(p_to_key, '') !~ '^(interfaces|tables)(/|$)' then return null; end if;
	-- 20260930510000 (C6): an agent authors no page or table layout, whatever carries the unit: nothing it changes or
	-- lands may be at or under interfaces/, the tables/ root, a table's folder or its table.toml (a copy changes only
	-- its target). Before every other rule, so the agent always hears the same code.
	if p_actor ->> 'kind' = 'staff_agent'
		and ((p_op <> 'copy' and p_key ~ '^(interfaces(/|$)|tables(/[^/]+(/table\.toml)?)?$)')
			or coalesce(p_to_key, '') ~ '^(interfaces(/|$)|tables(/[^/]+(/table\.toml)?)?$)') then
		return public.qorpera_interface_refused('layout_authoring', 'page and table layout authoring is not available');
	end if;
$new$]);
