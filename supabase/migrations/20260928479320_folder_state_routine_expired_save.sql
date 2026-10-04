-- A routine file saved past its end no longer revives its routine (from Q1's review of #775; C1C §6.9). The file of an
-- ended routine still says `status: active`, so before this any save of it (a member changing only its quiet hours, say)
-- set the routine active again; the scheduler then offered slots that were each refused until the next tick expired it
-- again, and the save counted as a restart, so a member with no paying login could not save the file at all.
-- 1. The index writer ends a routine whose `ends` has passed at the save, as it already does for used-up runs, so a
--    save revives an expired routine only when its end is later than now (or removed) and runs remain.
-- 2. A save restarts an expired routine only when it revives it, and lengthens its end or its runs only when that leaves
--    time or runs to run; otherwise it needs no paying login.
-- Folder-v2 only (the routine index of company state files). Bodies carry the marker 20260930056000.

create function pg_temp.r56_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Routine end anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. An end that has passed ends the routine at the save (anchored on P15's text, which follows the used-up runs).
select pg_temp.r56_replace('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	$old$		v_status := 'expired'; v_reason := null; end if;
	-- 20260930022000 (P15): a routine never runs under an archived or retired agent.$old$,
	$new$		v_status := 'expired'; v_reason := null; end if;
	-- 20260930056000: so does an end that has passed, whatever the file says.
	if v_status = 'active' and p_parse ->> 'ends' is not null
		and (p_parse ->> 'ends')::timestamptz <= statement_timestamp() then
		v_status := 'expired'; v_reason := null; end if;
	-- 20260930022000 (P15): a routine never runs under an archived or retired agent.$new$);

-- 2. Whether the file leaves a routine time and runs: no end or one later than now, and no runs or more than it has made.
create function public.qorpera_company_state_routine_has_time(p_row public.qorpera_cloud_routines, p_parse jsonb)
returns boolean language sql stable set search_path = '' as $$
	-- 20260930056000.
	select (p_parse ->> 'ends' is null or (p_parse ->> 'ends')::timestamptz > statement_timestamp())
		and (p_parse ->> 'runs' is null or p_row.id is null
			or public.qorpera_routine_occurrence_count(p_row.id) < (p_parse ->> 'runs')::integer)
$$;
revoke all on function public.qorpera_company_state_routine_has_time(public.qorpera_cloud_routines, jsonb)
	from public, anon, authenticated, service_role;

-- Whether a save starts or extends a routine's work: a first save, a restore, a resume, a reopen, reviving an ended
-- routine that has time and runs left, or lengthening an end or runs so that time or runs are left.
create or replace function public.qorpera_company_state_routine_restarts(p_row public.qorpera_cloud_routines, p_prev jsonb,
	p_parse jsonb, p_actor_kind text)
returns boolean language sql stable set search_path = '' as $$
	-- 20260928399960 (W4c), 20260930056000: an ended routine the save leaves ended is no restart.
	select coalesce(p_parse ->> 'status' = 'active' and (p_row.id is null or p_row.status = 'retired'
			or (p_row.status = 'expired' and public.qorpera_company_state_routine_has_time(p_row, p_parse))
			or (p_row.status <> 'expired' and p_prev ->> 'status' is distinct from 'active')), false)
		or (p_row.max_occurrences is not null and coalesce((p_parse ->> 'runs')::integer > p_row.max_occurrences, true)
			and public.qorpera_company_state_routine_has_time(p_row, p_parse))
		or (p_row.expires_at is not null and coalesce((p_parse ->> 'ends')::timestamptz > p_row.expires_at, true)
			and public.qorpera_company_state_routine_has_time(p_row, p_parse))
		or public.qorpera_company_state_routine_resumes(p_row, p_prev, p_parse, p_actor_kind)
$$;
