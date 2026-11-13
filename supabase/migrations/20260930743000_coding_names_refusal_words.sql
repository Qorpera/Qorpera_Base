-- 20260930743000: a landing the code host refused for its files keeps the executor's words (own code storage, the
-- import's follow-ups: the cross-check's follow-up of seam 8, 13 Nov 2026; the founder: "address the open issue").
--
-- A change a coding session hands in is refused by the code host when its tree holds names the company folder does not
-- take (the folder's rule, not UTF-8, not NFC, names one by case) or a file over 256 MiB. The coding executor's words
-- say what to rename or take out; they now end with a code of their own, [code=CODING_LAND_NAMES_REFUSED] or
-- [code=CODING_LAND_FILE_TOO_LARGE], so a member's page can say the change was not saved (and not that the session
-- could not start, which a workspace refused for the same reasons says: its codes are the code host's own). A landing's
-- turn has a run, so without this a summary that ends in a code is replaced by "The coding turn stopped because of a
-- problem on Qorpera's side." (20260930560000): qorpera_coding_turn_failure now keeps those words, without the code, as
-- the report, and the code as the reason, exactly as 20260930721000 does for the checks' CODING_CHECKS_* codes.
-- Everything else the function does is unchanged (the patch inserts one branch before the line 20260930721000 put its
-- own before; SQL test 1237 pins the rest of the body byte for byte against production's, read 13 Nov 2026).
--
-- Order: before the coding executor that sends the codes. An executor from before sends neither code, so nothing it
-- sends reaches the new branch. An executor that sends them before this migration would have the agent's words replaced
-- with Qorpera's-side words, so the release's executor step must wait for this migration.
-- Who may call: unchanged (the function is no API role's). Locks: the function replaced in place, nothing else.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.coding_names_refusal_patch(p_target regprocedure, p_edits text[]) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930743000' in v_definition) > 0 then
		raise exception '20260930743000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930743000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- A landing refused for its files keeps the executor's words and its code.
select pg_temp.coding_names_refusal_patch('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure, array[
	$old$	elsif v_job.id is not null and v_code ~ '^[A-Z0-9_]{1,42}(:[A-Z0-9_]{1,42})?$'$old$,
	$new$	-- 20260930743000: the code host refused the landing for its files' names or a file too large (the executor's
	-- CODING_LAND_ codes, read at the very end of its words, as the checks' are: the paths in them may hold any text). The
	-- executor's words are the report (what to rename or take out, and that nothing went into main); the code stays the
	-- reason.
	elsif substring(p_summary from '\[code=(CODING_LAND_[A-Z_]{1,40})\]\s*$') in ('CODING_LAND_NAMES_REFUSED',
		'CODING_LAND_FILE_TOO_LARGE') then
		v_code := substring(p_summary from '\[code=(CODING_LAND_[A-Z_]{1,40})\]\s*$');
		v_report := coalesce(nullif(regexp_replace(p_summary, '\s*\[code=CODING_LAND_[A-Z_]{1,40}\]\s*$', ''), ''), p_summary);
	elsif v_job.id is not null and v_code ~ '^[A-Z0-9_]{1,42}(:[A-Z0-9_]{1,42})?$'$new$]);

-- The changed body carries the marker.
do $guard$
begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure), '20260930743000') = 0 then
		raise exception '20260930743000 is missing from qorpera_coding_turn_failure'; end if;
end $guard$;
