-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10), the memory eraser's queue: each erase it lists
-- goes behind every other erase due. The queue listed the longest waiting erases first, and a step that failed rolled
-- back, so its erase kept its place: a thousand erases whose steps kept failing (the queue's bound) hid every erase
-- behind them, and the eraser had to remember turns of its own to reach past fewer.
--
-- qorpera_memory_message_erase_due(p_limit, p_resting) lists the longest waiting erases not done or refused, passes
-- over the ones the eraser names as resting (a step of theirs failed a moment ago) and any a step holds now (SKIP
-- LOCKED), and sets the updated_at of each one it lists to the time it listed them. So an erase listed again comes
-- after every erase due that was not, whatever its steps do. It writes, so it is volatile: the API runs a stable
-- function in a read-only transaction. Its old form (integer) goes; the eraser is its only caller.

drop function public.qorpera_memory_message_erase_due(integer);

-- The memory eraser's queue: each erase not yet done, the longest waiting first, past the resting ones; listing one
-- moves it behind every other. The state names its next step.
create function public.qorpera_memory_message_erase_due(p_limit integer, p_resting uuid[] default '{}')
returns table (environment_id uuid, erase_id uuid, state text)
language plpgsql security definer set search_path = '' as $$
declare
	v_ids uuid[];
	-- One time for all it lists: the ones listed together keep their order behind the rest.
	v_at timestamptz := clock_timestamp();
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 1000 then
		raise exception 'Memory message erase limit is invalid' using errcode = '22023'; end if;
	if p_resting is null or cardinality(p_resting) > 1000
		or exists (select 1 from unnest(p_resting) r where r is null) then
		raise exception 'Memory message erase rests are invalid' using errcode = '22023'; end if;
	v_ids := array(select e.id from public.qorpera_memory_message_erases e
		where e.state not in ('done','refused') and e.id <> all(p_resting)
		order by e.updated_at, e.id limit p_limit for no key update skip locked);
	update public.qorpera_memory_message_erases e set updated_at = v_at where e.id = any(v_ids);
	return query select e.environment_id, e.id, e.state
		from unnest(v_ids) with ordinality u(id, n) join public.qorpera_memory_message_erases e on e.id = u.id
		order by u.n;
end $$;

revoke all on function public.qorpera_memory_message_erase_due(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.qorpera_memory_message_erase_due(integer, uuid[]) to service_role;
