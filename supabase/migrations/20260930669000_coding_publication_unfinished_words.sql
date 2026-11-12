-- 20260930669000: a coding turn whose hand-in did not finish says so, in plain words (own code storage, slice 0;
-- 8 Nov 2026, PR #1541). The executor now fails such a turn while it holds its lease, with a summary that ends in
-- [code=CODING_PUBLICATION_UNFINISHED], instead of leaving the lease to lapse as "the executor stopped responding".
-- qorpera_coding_turn_failure turns every coded summary of a turn whose run exists into its class's words, and this
-- code had none, so the agent read "a problem on Qorpera's side". Now it reads that the work was done, its hand-in
-- did not finish, and finishing again hands it in, with the usual line on the kept files. The reason stays the code.
-- The changed body carries the marker 20260930669000.

set local lock_timeout = '3s';

do $do$
declare v_definition text := pg_get_functiondef(
		'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure);
	v_old text := $old$			when v_code ~ ':CANCELLED$' then 'Qorpera lost contact with the coding turn, so it stopped.'$old$;
	v_new text := $new$			-- 20260930669000: the work was done; only handing it in did not finish (the executor's PUBLICATION_UNFINISHED).
			when v_code = 'CODING_PUBLICATION_UNFINISHED' then
				'The coding turn did its work, but handing it in did not finish, so it may not have reached the repository yet. '
				|| 'Finishing again hands it in.'
			when v_code ~ ':CANCELLED$' then 'Qorpera lost contact with the coding turn, so it stopped.'$new$;
begin
	if position('20260930669000' in v_definition) > 0 then
		raise exception '20260930669000 is already in qorpera_coding_turn_failure'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930669000 anchor differs in qorpera_coding_turn_failure'; end if;
	execute replace(v_definition, v_old, v_new);
end $do$;
