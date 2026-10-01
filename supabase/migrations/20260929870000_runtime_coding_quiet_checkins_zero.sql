-- Quiet coding check-ins (#466, 20260929850000) and computer hours: a company at zero is not asked,
-- and archiving a session withdraws a question about it that no run has taken yet.
--
-- Its question would only wait for hours (the wake bus holds new work of a company at zero, 6a), while
-- the session already records the mark as asked and the thread says "asked the agent" days before the
-- agent sees it, with a day count that is stale by then. So, like a paused company, a company at zero
-- (`qorpera_company_at_zero`) is left out of the candidate filter, and checked again after the locks.
-- Its mark stays unasked: once hours are added, the next scan asks the latest mark reached, with the
-- right day count. While the zero rule is off `qorpera_company_at_zero` is false and nothing changes.
--
-- Archiving (the owner, the agent, the 30-day scan or company deletion, all through
-- `qorpera_archive_coding_worker`) withdraws a question about the session still waiting, as a new turn
-- does (#466): one asked just before the company ran out, held for hours past the automatic archive,
-- would otherwise run for an archived session once hours are added.

set local lock_timeout = '3s';

do $patch$
declare
	v_definition text := pg_get_functiondef('public.qorpera_ask_quiet_coding_sessions(text)'::regprocedure);
	v_patches constant text[][] := array[
		array[$o$			and not exists (select 1 from public.qorpera_company_execution_pauses pause where pause.profile_id = worker.profile_id)
$o$, $n$			and not exists (select 1 from public.qorpera_company_execution_pauses pause where pause.profile_id = worker.profile_id)
			-- A company out of computer hours (20260929870000): its question would only wait for hours.
			and not public.qorpera_company_at_zero(worker.profile_id, clock_timestamp())
$n$],
		array[$o$			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
$o$, $n$			if public.qorpera_company_execution_paused(v_worker.profile_id) then continue; end if;
			if public.qorpera_company_at_zero(v_worker.profile_id, clock_timestamp()) then continue; end if;
$n$]];
	v_index integer;
begin
	for v_index in 1 .. array_length(v_patches, 1) loop
		if (length(v_definition) - length(replace(v_definition, v_patches[v_index][1], ''))) / length(v_patches[v_index][1]) <> 1 then
			raise exception 'Quiet coding check-ins differ (patch %)', v_index;
		end if;
		v_definition := replace(v_definition, v_patches[v_index][1], v_patches[v_index][2]);
	end loop;
	execute v_definition;
end
$patch$;

do $archive$
declare
	v_definition text := pg_get_functiondef(
		'public.qorpera_archive_coding_worker(public.qorpera_runtime_workers,text,uuid,uuid,uuid)'::regprocedure);
	v_old text := $o$		jsonb_build_object('text', 'Archived', 'archived', true, 'by', p_by, 'userId', p_user_id, 'clientRequestId', p_client_request_id));
	return true;$o$;
	v_new text := $n$		jsonb_build_object('text', 'Archived', 'archived', true, 'by', p_by, 'userId', p_user_id, 'clientRequestId', p_client_request_id));
	-- A question about the session that no run has taken yet goes with it (20260929870000), as on a new turn.
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp()
	where status = 'queued' and source_kind = 'worker-completion' and source_id = p_worker.id and occurrence_key like 'coding-quiet:%';
	return true;$n$;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Coding session archive differs';
	end if;
	execute replace(v_definition, v_old, v_new);
end
$archive$;
