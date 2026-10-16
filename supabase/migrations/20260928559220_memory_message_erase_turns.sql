-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10), the memory eraser's turns: each erase the
-- eraser takes goes behind every other erase due. The queue listed the longest waiting erases first, and a step that
-- failed rolled back, so its erase kept its place: a thousand erases whose steps kept failing (the queue's bound) hid
-- every erase behind them, and the eraser had to remember turns of its own to reach past fewer.
--
-- qorpera_memory_message_erase_due(p_limit, p_resting) lists the longest waiting erases not done or refused, passing
-- over the ones the eraser names as resting (a step of theirs failed a moment ago) and any a step holds now (SKIP
-- LOCKED); listing moves none of them. Its old form (integer) goes; the eraser is its only caller.
-- qorpera_memory_message_erase_take(p_erase_id) is the eraser's call before an erase's first step in a pass, in a call
-- of its own: it sets the erase's updated_at to the time it was taken. So an erase taken comes after every erase due
-- that was not, whatever its steps do then, and one the pass listed but never reached (its deadline came first) keeps
-- its place. Both lock rows, so both are volatile: the API runs a stable function in a read-only transaction.

drop function public.qorpera_memory_message_erase_due(integer);

-- The memory eraser's queue: each erase not yet done, the longest waiting first, past the resting ones. The state
-- names its next step.
create function public.qorpera_memory_message_erase_due(p_limit integer, p_resting uuid[] default '{}')
returns table (environment_id uuid, erase_id uuid, state text)
language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_limit is null or p_limit not between 1 and 1000 then
		raise exception 'Memory message erase limit is invalid' using errcode = '22023'; end if;
	if p_resting is null or cardinality(p_resting) > 1000
		or exists (select 1 from unnest(p_resting) r where r is null) then
		raise exception 'Memory message erase rests are invalid' using errcode = '22023'; end if;
	return query select e.environment_id, e.id, e.state from public.qorpera_memory_message_erases e
		where e.state not in ('done','refused') and e.id <> all(p_resting)
		order by e.updated_at, e.id limit p_limit for no key update skip locked;
end $$;

revoke all on function public.qorpera_memory_message_erase_due(integer, uuid[]) from public, anon, authenticated;
grant execute on function public.qorpera_memory_message_erase_due(integer, uuid[]) to service_role;

-- A pass of the memory eraser takes an erase, before its first step: the erase goes behind every other erase due.
-- False when it is done or refused, or a step holds it now (the pass leaves it alone then).
create function public.qorpera_memory_message_erase_take(p_erase_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_erase_id is null then raise exception 'Memory message erase is invalid' using errcode = '22023'; end if;
	update public.qorpera_memory_message_erases e set updated_at = clock_timestamp()
	where e.id = (select d.id from public.qorpera_memory_message_erases d
		where d.id = p_erase_id and d.state not in ('done','refused') for no key update skip locked);
	return found;
end $$;

revoke all on function public.qorpera_memory_message_erase_take(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_memory_message_erase_take(uuid) to service_role;
