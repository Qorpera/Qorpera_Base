-- Durable room sessions retain their original Company File pin. Each room
-- delivery is admitted against the current head, just like other wake runs.
-- Accept only a same-environment successor; all audience, staff, membership,
-- assignment, lease and public-send checks remain at the existing boundaries.
create or replace function public.qorpera_run_head_follows_session_pin(
	p_run public.qorpera_execution_runs, p_session_snapshot_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_session_snapshot_id = p_run.company_snapshot_id
		or (p_run.source_kind in ('wake', 'room_delivery') and exists (
			with recursive successor(snapshot_id, depth) as (
				select p_session_snapshot_id, 0
				union all
				select revision.snapshot_id, successor.depth + 1
				from public.qorpera_company_path_revisions as revision
				join successor on successor.snapshot_id = revision.parent_snapshot_id
				where revision.environment_id = p_run.environment_id and successor.depth < 4096
			)
			select 1 from successor where successor.snapshot_id = p_run.company_snapshot_id and successor.depth > 0))
$$;

-- Expired/terminal claims cannot become valid by retrying the same transaction.
-- PostgREST 14.5 retries serialization_failure (40001) indefinitely, even after
-- its HTTP caller times out. Keep the closed errors and every authority check,
-- but report these terminal application states as object_not_in_prerequisite_state.
-- Checked replacements preserve each deployed function's owner, ACL and body.
do $$
declare
	v_target regprocedure;
	v_definition text;
	v_old text;
	v_expected integer;
begin
	for v_target, v_old, v_expected in select * from (values
		('public.qorpera_assign_runner_job(uuid,uuid,uuid,uuid,text,integer)'::regprocedure,
			'raise exception ''orchestrator claim is unavailable'' using errcode = ''40001'';', 1),
		('public.qorpera_renew_runner_job_claim(uuid,uuid,integer)'::regprocedure,
			'raise exception ''orchestrator claim is unavailable'' using errcode = ''40001'';', 2),
		('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)'::regprocedure,
			'raise exception ''orchestrator claim replay is unavailable'' using errcode = ''40001'';', 1)
	) expected(target, old_statement, occurrences) loop
		v_definition := pg_get_functiondef(v_target);
		if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> v_expected then
			raise exception 'Terminal claim function differs from its approved upgrade source: %', v_target;
		end if;
		execute replace(v_definition, v_old, replace(v_old, '''40001''', '''55000'''));
	end loop;
end
$$;
