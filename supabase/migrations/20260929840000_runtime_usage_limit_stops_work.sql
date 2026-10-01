-- A usage limit stops the work (founder decision 2026-10-01, Sign in with ChatGPT choice 3).
--
-- Until now, when the login paying for a run reached its usage limit, the runner's failure report moved the
-- run to another login of the same member that had room left (contract 17's sponsor handoff,
-- qorpera_handoff_run_sponsor) and queued it again. OpenAI's terms for ChatGPT plan use forbid rotating
-- accounts to get round usage limits, and the founder applied the same rule to Codex logins: the work stops.
-- The run now fails like any other run that reaches its limit. The member is told by the usage-limit notice
-- (qorpera_record_provider_usage_signal, unchanged), and the thread shows why the work stopped. No company
-- account exists yet (it was deferred), so nothing else takes the work over either.
--
-- The handoff function itself stays as it is (its own tests and checks read it); the failure report no
-- longer asks it. Undoing this change is one line. Locks: none added; the failure report takes exactly the
-- locks it took before, minus the handoff's.

set local lock_timeout = '3s';

do $$
declare
	v_target regprocedure := 'public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_anchor text;
	v_count integer;
begin
	if position('20260929840000' in v_definition) = 0 then
		v_anchor := E'\t-- Contract 17: a usage limit on the sponsoring connection continues the run\n'
			|| E'\t-- on the next eligible connection of the same principal instead of failing it.\n'
			|| E'\tif v_job.run_id is not null then\n'
			|| E'\t\tv_handoff := public.qorpera_handoff_run_sponsor(v_job.run_id, v_error);\n';
		v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
		if v_count <> 1 then raise exception 'Runner failure report source differs (% matches)', v_count; end if;
		execute replace(v_definition, v_anchor,
			E'\t-- A usage limit stops the work (founder decision 2026-10-01, 20260929840000): a run never moves to\n'
				|| E'\t-- another login of the same member, so the handoff is no longer asked and the run fails below.\n'
				|| E'\tif v_job.run_id is not null then\n'
				|| E'\t\tv_handoff := null;\n');
	end if;
end
$$;
