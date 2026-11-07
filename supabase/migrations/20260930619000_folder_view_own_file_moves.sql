-- 20260930619000: an agent's machine moving or deleting a file it wrote itself is ordinary work, not a deletion.
-- 7 November 2026: Blender saves room.blend by renaming the old copy to room.blend1 and writing a new room.blend. The test
-- machine sent the rename as a move, every delete or move from an agent's view was a deletion, and a view's deletion
-- with no review is parked: each save parked one more proposal, and the founder saw cards reading "Rename “Room” to
-- “Room”" for a file the worker had made minutes before.
-- Now a view's delete or move of a file whose live version this same view committed takes the structured hook's class
-- like any other unit, when neither its path nor where it moves is under QorperaOS/ (the company's agents, routines,
-- interfaces and tables keep every rule they had). Such a version is the view's own: it wrote or copied it, or moved one
-- of its own under this rule (Blender's next save deletes room.blend1). A view's move of anyone else's file parks, and
-- an approved proposal is applied by the run, not the view; a move never replaces anything (a taken name is refused,
-- 'exists'). A file anyone else last changed is still a deletion and still parks. Runs, members, the platform and
-- coding sessions are unchanged.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.own_file_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930619000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.own_file_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$			v_class := case when v_op in ('delete','move') then 'deletion'
$old$,
	$new$			-- 20260930619000: a view's delete or move of a file it wrote itself, outside QorperaOS/, takes the hook's class.
			v_class := case when v_op in ('delete','move') and not (v_actor_kind = 'view' and v_row.kind = 'file'
					and v_key not like 'qorperaos/%' and coalesce(v_to_key, '') not like 'qorperaos/%'
					and exists (select 1 from public.qorpera_folder_commits c where c.id = v_row.commit_id
						and c.view_id = v_view.id)) then 'deletion'
$new$
]);
