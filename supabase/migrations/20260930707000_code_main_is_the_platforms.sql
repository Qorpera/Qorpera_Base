-- 20260930707000: only the platform moves the main branch of a repository kept in Qorpera, and a turn that lapsed there
-- is told in that repository's words (own code storage, step 1 "Dependable"; the audit of 10 Nov 2026).
--
-- 1. The mark of a repository kept in Qorpera, refs/qorpera/** in its repo.git (the code host writes
--    refs/qorpera/kept-here at its start), is the platform's alone. Until now a coding session could take a lease on it
--    and remove it, and a member could write or restore it with no lease: without it every later start and landing is
--    refused, and a new session is told the place holds a copy of a GitHub repository.
-- 2. In a repository that has the mark, a coding session's lease is never for the default branch (refs/heads/main: one
--    repository, one default branch, 20260930670000), packed-refs or shallow. A session could take them and move or
--    rewind main itself, past the landing and whatever comes to stand before it. Its own branch and the other refs it
--    makes stay its own, under a lease as before. A copy of a GitHub repository is as it was.
-- 3. A turn whose executor stopped while it handed in a commit says so in the repository's words: there is no pull
--    request for a repository kept in Qorpera.
-- A member's restore of refs/heads/main is not changed here: the commit's rule reads a key alone, and whether a member
-- sees repo.git in the web folder is still to be checked. The changed bodies carry the marker 20260930707000.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create or replace function pg_temp.dependable_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	if position('20260930707000' in v_definition) > 0 then
		raise exception '20260930707000 is already in %', p_target; end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930707000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. The mark is the platform's. -----------------------------------------------------------------------------------------
select pg_temp.dependable_patch('public.qorpera_folder_git_refusal(text,text,text,uuid)'::regprocedure, array[
	$old$	if v_rest in ('packed-refs','shallow') then$old$,
	$new$	-- 20260930707000: the mark of a repository kept in Qorpera, and its log, are the platform's alone.
	if v_rest ~ '^(logs/)?refs/qorpera(/|$)' then return 'git_platform_only'; end if;
	if v_rest in ('packed-refs','shallow') then$new$]);

-- 2. In a repository kept in Qorpera, a session's lease is never for main, packed-refs or shallow. --------------------------
select pg_temp.dependable_patch('public.qorpera_folder_git_lease_take(uuid,jsonb,text)'::regprocedure, array[
	$old$		if v_reason <> 'git_lease_required' then
			return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','refused','reason',v_reason); end if;$old$,
	$new$		-- 20260930707000: where the repository is kept in Qorpera (its mark is there), only the platform moves the default
		-- branch: never a session's lease on it, or on the two files that would move it for every reader.
		if v_reason = 'git_lease_required' and v_key ~ '^code/[^/]+/[^/]+/repo\.git/(refs/heads/main|packed-refs|shallow)$'
			and public.qorpera_folder_git_version(p_environment_id,
				substring(v_key from '^code/[^/]+/[^/]+/repo\.git/') || 'refs/qorpera/kept-here') is not null then
			v_reason := 'git_platform_only'; end if;
		if v_reason <> 'git_lease_required' then
			return jsonb_build_object('schema','qorpera.folder-git-lease/v1','state','refused','reason',v_reason); end if;$new$]);

-- 3. A lapsed hand-in, in the repository's words. ------------------------------------------------------------------------
select pg_temp.dependable_patch('public.qorpera_claim_coding_session(text,integer)'::regprocedure, array[
	$old$								then ' was being published; the draft pull request may exist. A follow-up publishes or confirms it.'
								else ' was submitted but not published; a follow-up can publish it.' end end$old$,
	$new$								-- 20260930707000: a repository kept in Qorpera has no pull request; its commit goes into main.
								then case when v_session.repository ->> 'host' = 'qorpera'
									then ' was being handed in and may or may not have reached main. A follow-up hands it in again or confirms it.'
									else ' was being published; the draft pull request may exist. A follow-up publishes or confirms it.' end
								else case when v_session.repository ->> 'host' = 'qorpera'
									then ' was handed in but had not reached main; a follow-up hands it in again.'
									else ' was submitted but not published; a follow-up can publish it.' end end end$new$]);
