-- Threads open at their newest messages (web audit fix #15). The web client read a thread's
-- whole transcript oldest-first, 500 events at a time, before it could draw anything; it now
-- reads the newest events first and, on "Show earlier", the page before the oldest one it has.
--
-- qorpera_read_session_events_tail(p_session_id, p_before_sequence, p_limit) returns the newest
-- p_limit events with a sequence below p_before_sequence (all events when null), oldest first,
-- in exactly the shape of qorpera_read_session_events. It is that read on a window chosen from
-- the end: the transcript read itself authorizes the caller (the session's audience and company
-- membership, qorpera_can_read_session and qorpera_can_read_profile as they are live), checks the
-- page (1 to 500 events; a null limit reads the default 200) and adds each public send's
-- speaker. So every refusal of the transcript read is this read's refusal too, in the same
-- order, and a later change to the transcript read applies here without a copy to keep in step.
-- Nothing is refused before it: the window query cannot fail on any argument. Older clients keep
-- reading forward; nothing existing changes.
--
-- Paging back never skips or repeats an event: a page is every event below the given sequence,
-- newest first up to the limit, and new events only ever take higher sequences. Both reads run
-- in the calling statement's snapshot (stable functions), so the window and its events agree.

create function public.qorpera_read_session_events_tail(
	p_session_id uuid,
	p_before_sequence bigint default null,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	-- A null limit reads the default page (the transcript read would take null as "everything").
	v_limit integer := coalesce(p_limit, 200);
	v_after bigint;
	v_events jsonb;
begin
	-- Where the window starts: just before the oldest of the newest p_limit events below
	-- p_before_sequence. This decides nothing and returns nothing by itself. The limit is only
	-- kept to a valid size here, so the transcript read below refuses a bad page as it always has.
	-- Two queries, so the sequence bound is an index bound whatever plan is cached.
	if p_before_sequence is null then
		select min(tail.sequence) - 1 into v_after
		from (
			select event.sequence
			from public.qorpera_session_events as event
			where event.session_id = p_session_id
			order by event.sequence desc
			limit greatest(least(v_limit, 500), 1)
		) as tail;
	else
		select min(tail.sequence) - 1 into v_after
		from (
			select event.sequence
			from public.qorpera_session_events as event
			where event.session_id = p_session_id and event.sequence < p_before_sequence
			order by event.sequence desc
			limit greatest(least(v_limit, 500), 1)
		) as tail;
	end if;
	-- The transcript read authorizes, checks the page and shapes the events; an empty window
	-- goes through it as well (from the start: the filter below keeps nothing at or after
	-- p_before_sequence), so a caller who may not read the thread is refused either way.
	v_events := public.qorpera_read_session_events(p_session_id, coalesce(v_after, 0), v_limit);
	if p_before_sequence is null then
		return v_events;
	end if;
	-- A window shorter than the limit (the start of the thread) may bring events at or after
	-- p_before_sequence along: the caller has those already.
	return coalesce((
		select jsonb_agg(item.value order by item.ordinality)
		from jsonb_array_elements(v_events) with ordinality as item(value, ordinality)
		where (item.value ->> 'sequence')::bigint < p_before_sequence
	), '[]'::jsonb);
end
$$;

-- Members only, as the transcript read (20260828019850): a new function would otherwise carry
-- PUBLIC's default EXECUTE.
revoke all on function public.qorpera_read_session_events_tail(uuid, bigint, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_read_session_events_tail(uuid, bigint, integer) to authenticated;
