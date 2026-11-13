-- @fixture 560_coding_turn_failure_plain_words.test.sql until "-- 1. ChatGPT's overload"
-- 20260930743000: a landing the code host refused for its files keeps the executor's words and its own code (own code
-- storage, the import's follow-ups: the cross-check's follow-up of seam 8). On 560's base (928's coding session 1 for
-- the owner on the owner's own login), whose turn has a run, so the rule for any other code replaces the words:
--   1. Each landing code at the end of the words keeps them, without the code, and is the reason: in the worker's
--      result, the failed event and the turn's outcome; a path in the words that holds another code decides nothing.
--   2. Everything else as before: the rest of the body byte for byte (production's on 13 Nov 2026, md5 and length), a
--      code of the checks, another CODING_LAND_ code, a landing code inside the words, and a plain summary.
--   3. The markers and the grants.

-- The branch this migration put in the body (its text exactly), before the line 20260930721000 put its own before.
create function pg_temp.nr_branch() returns text language sql immutable as $nr$
	select $b$	-- 20260930743000: the code host refused the landing for its files' names or a file too large (the executor's
	-- CODING_LAND_ codes, read at the very end of its words, as the checks' are: the paths in them may hold any text). The
	-- executor's words are the report (what to rename or take out, and that nothing went into main); the code stays the
	-- reason.
	elsif substring(p_summary from '\[code=(CODING_LAND_[A-Z_]{1,40})\]\s*$') in ('CODING_LAND_NAMES_REFUSED',
		'CODING_LAND_FILE_TOO_LARGE') then
		v_code := substring(p_summary from '\[code=(CODING_LAND_[A-Z_]{1,40})\]\s*$');
		v_report := coalesce(nullif(regexp_replace(p_summary, '\s*\[code=CODING_LAND_[A-Z_]{1,40}\]\s*$', ''), ''), p_summary);
$b$::text
$nr$;
create function pg_temp.nr_anchor() returns text language sql immutable as $nr$
	select $a$	elsif v_job.id is not null and v_code ~ '^[A-Z0-9_]{1,42}(:[A-Z0-9_]{1,42})?$'$a$::text
$nr$;
create function pg_temp.nr_body() returns text language sql as $$
	select pg_get_functiondef('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure)
$$;

-- 1. A landing refused for its files ------------------------------------------------------------------------------------
do $$
declare v_turn jsonb; w public.qorpera_runtime_workers%rowtype; v_event jsonb;
	v_names constant text := 'The change was not landed, and nothing changed on main: it holds file or folder names the company folder does not take (one that ends in a dot or a space, holds a backslash or a control character, or is longer than 255 bytes, or a path longer than 4,096 bytes where a session''s workspace holds it): "src/signin.tsx.", "quota [code=CODING_CHECKS_FAILED].". Rename them, commit and finish again.';
	v_large constant text := 'The change was not landed, and nothing changed on main: it holds files larger than 256 MiB, which a repository kept in Qorpera does not take: "assets/film.mov". Take them out, commit and finish again.';
begin
	v_turn := pg_temp.pw_turn();
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	-- The words and the code, for each code, at the very end (a line end after it too).
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, v_names || ' [code=CODING_LAND_NAMES_REFUSED]')
		= jsonb_build_object('reason', 'CODING_LAND_NAMES_REFUSED', 'summary', v_names), 'names: '
		|| public.qorpera_coding_turn_failure(w, v_names || ' [code=CODING_LAND_NAMES_REFUSED]')::text);
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, v_large || ' [code=CODING_LAND_FILE_TOO_LARGE]')
		= jsonb_build_object('reason', 'CODING_LAND_FILE_TOO_LARGE', 'summary', v_large), 'too large');
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, v_large || E' [code=CODING_LAND_FILE_TOO_LARGE]\n')
		= jsonb_build_object('reason', 'CODING_LAND_FILE_TOO_LARGE', 'summary', v_large), 'a line end after the code');
	-- Through the executor's report: the worker's result, the failed event and the turn's outcome.
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn('92800000-0000-4000-8000-0000000000b1', (v_turn ->> 'token')::uuid, 'failed',
		v_names || ' [code=CODING_LAND_NAMES_REFUSED]');
	w := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'failed' and w.result ->> 'summary' = v_names
		and w.result ->> 'reason' = 'CODING_LAND_NAMES_REFUSED', 'the worker''s result: ' || w.result::text);
	v_event := pg_temp.pw_event();
	perform pg_temp.base_assert(v_event ->> 'code' = 'CODING_LAND_NAMES_REFUSED' and v_event ->> 'summary' = v_names,
		'the failed event: ' || coalesce(v_event::text, 'none'));
	perform pg_temp.base_assert((select outcome ->> 'reason' = 'CODING_LAND_NAMES_REFUSED' and outcome ->> 'summary' = v_names
		from public.qorpera_coding_session_turns where worker_id = w.id and sequence = w.sequence), 'the turn''s outcome');
end $$;

-- 2. Everything else as before ------------------------------------------------------------------------------------------
do $$
declare w public.qorpera_runtime_workers%rowtype := pg_temp.c3_worker('92800000-0000-4000-8000-0000000000b1');
	v_qorpera constant text := 'The coding turn stopped because of a problem on Qorpera''s side. The files the turn wrote '
		|| 'stay in the session''s workspace as it left them; a follow-up turn continues from them.';
	v_failed constant text := 'Nothing went into main: the check "test" failed on this change. It ran `npm test` and ended '
		|| 'with exit code 1 after 41 s. Fix the cause in the code, commit and finish again.';
	v_before text;
begin
	-- The body without this migration's branch is the body production had on 13 November 2026 (and every migration
	-- before this one leaves), byte for byte, with the anchor once.
	v_before := replace(pg_temp.nr_body(), pg_temp.nr_branch() || pg_temp.nr_anchor(), pg_temp.nr_anchor());
	perform pg_temp.base_assert(strpos(pg_temp.nr_body(), pg_temp.nr_branch() || pg_temp.nr_anchor()) > 0
		and md5(v_before) = '0cf3cef91322fdc8998c23e037a4b300' and length(v_before) = 11471
		and (length(v_before) - length(replace(v_before, pg_temp.nr_anchor(), ''))) / length(pg_temp.nr_anchor()) = 1,
		'the rest of the body: ' || md5(v_before) || ' ' || length(v_before));
	-- A code of the checks keeps its words, as 20260930721000 has it.
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, v_failed || ' [code=CODING_CHECKS_FAILED]')
		= jsonb_build_object('reason', 'CODING_CHECKS_FAILED', 'summary', v_failed), 'the checks: '
		|| public.qorpera_coding_turn_failure(w, v_failed || ' [code=CODING_CHECKS_FAILED]')::text);
	-- Any other code at the end, a landing code that is not one of the two, and a landing code inside the words: the
	-- run's words for a code, as before.
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'Broke. [code=CODING_SOMETHING_ELSE]')
			= jsonb_build_object('reason', 'CODING_SOMETHING_ELSE', 'summary', v_qorpera)
		and public.qorpera_coding_turn_failure(w, 'Broke. [code=CODING_LAND_SOMETHING_ELSE]')
			= jsonb_build_object('reason', 'CODING_LAND_SOMETHING_ELSE', 'summary', v_qorpera)
		and public.qorpera_coding_turn_failure(w, 'It said [code=CODING_LAND_NAMES_REFUSED] and more.')
			= jsonb_build_object('reason', 'CODING_LAND_NAMES_REFUSED', 'summary', v_qorpera)
		and public.qorpera_coding_turn_failure(w, 'Broke. [code=CODING_LAND_NAMES_REFUSED:X]')
			= jsonb_build_object('reason', 'CODING_LAND_NAMES_REFUSED:X', 'summary', v_qorpera),
		'other codes: ' || public.qorpera_coding_turn_failure(w, 'Broke. [code=CODING_LAND_SOMETHING_ELSE]')::text);
	-- A plain summary stays as it is, with the reason the rows give.
	perform pg_temp.base_assert(public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.') ->> 'summary'
			= 'The coding turn did not finish.'
		and public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.') ->> 'reason' !~ '^CODING_LAND_',
		'a plain summary: ' || public.qorpera_coding_turn_failure(w, 'The coding turn did not finish.')::text);
end $$;

-- 3. The markers and the grants -----------------------------------------------------------------------------------------
select pg_temp.base_assert(position('20260930743000' in pg_temp.nr_body()) > 0 and position('20260930721000' in pg_temp.nr_body()) > 0
	and position('20260930729000' in pg_temp.nr_body()) > 0 and position('20260930560000' in pg_temp.nr_body()) > 0, 'the markers');
select pg_temp.base_assert(not has_function_privilege('authenticated',
	'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)', 'execute')
	and not has_function_privilege('anon', 'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)', 'execute'),
	'the grants');
