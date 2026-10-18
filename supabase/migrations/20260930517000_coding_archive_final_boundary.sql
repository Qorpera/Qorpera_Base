-- 20260930517000: F3 step 5g-5 (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Boundaries": "Detach, sleep or
-- archive of a session: a final boundary for its view, then close and unmount"). An archive keeps its session's coding
-- view for that final boundary.
-- The archive (qorpera_archive_coding_worker) sets archived_at and ends the attachment now, and
-- qorpera_coding_attachment_refusal then answers ARCHIVED, so the view stopped being valid at the archive itself: its
-- next renewal closed it ('ended'), seconds later, and the executor's take-off, which cancels the session's commands,
-- stops the session and only then asks for the final boundary, found no view and failed CODING_FOLDER_VIEW_UNSAVED
-- (what the session wrote last went unsaved); its retry detached the session.
-- 1. qorpera_folder_view_valid, its coding_session branch only: a session archived while its attachment was live (the
--    archive leaves attachment_until at or after archived_at; one that had already lapsed keeps its earlier end) keeps
--    its view as the refusal would with the archive taken away and the attachment ending 240 s after it. Nothing renews
--    that end. Every other refusal (the owner left, the repository withdrawn, the executor switched off) still ends the
--    view at once, as do the token (the executor's detach clears it) and, in resolve and renew, a staff archive. The
--    view's open, its renewal and the keep are unchanged: an archived session's view never opens again, and the keep
--    still answers release.
-- Why 240 s: the take-off's own bounds before its final boundary saves are about 190 s: the executor's next keep pass
-- (every 10 s, a machine's step 15 s at most), the cancel of the session's commands (20 s), the guest's quiesce, which
-- stops what is left of the session (120 s), and the boundary's ask (20 s), with the 2 s quiet period of a write just
-- before it, and a few seconds of custody and LXD calls between. 240 s adds a quarter. A take-off slower than that ends
-- as it did before this migration: unsaved, then detached by its retry.
-- Where it ends: a save is refused at archived_at + 240 s (each commit checks this predicate again after its anchor
-- step). The folder service serves what the view has listed without asking the core, so its reads end at its next
-- renewal after that, at most 40 s later; with the core unreachable, at the view's lease (120 s after its last
-- renewal), as for every view.
-- Exact-text patch: it fails unless the function has the text given exactly once. The patched function names this
-- migration (20260930517000); the earlier markers stay.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure), '20260930517000') > 0
		then raise exception 'The coding archive''s final boundary (20260930517000) is already applied'; end if;
end $$;

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.coding_archive_final_boundary_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '% does not have the text this migration expects (% times): %', p_target, v_found,
				left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. The coding session's validity.
select pg_temp.coding_archive_final_boundary_patch('public.qorpera_folder_view_valid(public.qorpera_folder_views)', array[
	$old$			where cs.worker_id = p_view.worker_id and cs.attachment_token = p_view.attachment_token
				and public.qorpera_coding_attachment_refusal(cs, w, m) is null)$old$,
	$new$			where cs.worker_id = p_view.worker_id and cs.attachment_token = p_view.attachment_token
				and (public.qorpera_coding_attachment_refusal(cs, w, m) is null
					-- 20260930517000 (F3 5g-5): an archive keeps the view of an attachment it found live, for the
					-- session's final boundary (the executor takes the session off, saves, closes the view and records the
					-- detach), until 240 s after the archive at most; nothing renews that. Any other refusal ends it.
					or (cs.archived_at is not null and cs.attachment_until >= cs.archived_at
						and public.qorpera_coding_attachment_refusal(jsonb_populate_record(cs, jsonb_build_object(
							'archived_at', null, 'attachment_until', cs.archived_at + interval '240 seconds')), w, m) is null)))$new$
]);
