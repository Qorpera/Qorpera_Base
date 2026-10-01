-- Quiet coding check-ins (#466, 20260929850000) and computer hours: a company at zero is not asked.
--
-- Its question would only wait for hours (the wake bus holds new work of a company at zero, 6a), while
-- the session already records the mark as asked and the thread says "asked the agent" days before the
-- agent sees it, with a day count that is stale by then. So, like a paused company, a company at zero
-- (`qorpera_company_at_zero`) is left out of the candidate filter, and checked again after the locks.
-- Its mark stays unasked: once hours are added, the next scan asks the latest mark reached, with the
-- right day count. While the zero rule is off `qorpera_company_at_zero` is false and nothing changes.

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
