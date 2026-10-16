-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10), the copies in a member's answer. Step 3 keeps
-- the copies P18 names for each block (qorpera_memory_message_erase_blocks.copies): files at paths no tree owns that hold
-- a version's bytes, which the erase leaves. P18 looks in every folder-v2 environment of the company, so a copy is named by
-- its environment and its path. A member erases such a copy there, so the answer to a member's request and to a status
-- read names them: copies [{environmentId, path, live}], each copy once and sorted, live when the path is in that folder
-- now (else only its history holds the copy), empty before step 3. The copies are those of every erase of the message: a
-- duplicate request's erase, written once the first is done, ends done with no blocks of its own, and a later request
-- answers with that newer row. The steps' answers, which only the eraser reads, stay as they were. The patched bodies
-- carry the marker 20260930470000 (M3 copies).

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if to_regprocedure('public.qorpera_memory_message_erase_answer(uuid)') is not null then
		raise exception 'Memory message erase copies (20260930470000) is already applied'; end if;
end $$;

create function pg_temp.m3_copies_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Memory message erase copies anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- Every erase of a message, whatever its state: the answer gathers their copies.
create index qorpera_memory_message_erases_message on public.qorpera_memory_message_erases(environment_id, event_id);

-- An erase as a member reads it: where it stands, and the copies the blocks' erasures named, of this erase and of every
-- other erase of its message. Two blocks may name one copy; it is live when any of them found it live.
create function public.qorpera_memory_message_erase_answer(p_erase_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	select public.qorpera_memory_message_erase_reply(p_erase_id) || jsonb_build_object('copies', coalesce((
		select jsonb_agg(jsonb_build_object('environmentId', c.environment_id, 'path', c.path, 'live', c.live)
			order by c.environment_id, c.path)
		from (select (x ->> 'environmentId') collate "C" as environment_id, (x ->> 'path') collate "C" as path,
				bool_or((x ->> 'live')::boolean) as live
			from public.qorpera_memory_message_erases e
			join public.qorpera_memory_message_erases o on o.environment_id = e.environment_id and o.event_id = e.event_id
			join public.qorpera_memory_message_erase_blocks b on b.erase_id = o.id
			cross join jsonb_array_elements(b.copies) x
			where e.id = p_erase_id group by 1, 2) c), '[]'::jsonb))
$$;

revoke all on function public.qorpera_memory_message_erase_answer(uuid) from public, anon, authenticated, service_role;

select pg_temp.m3_copies_replace('public.qorpera_memory_message_erase_request(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$	return public.qorpera_memory_message_erase_reply(v_id);$old$,
	$new$	-- 20260930470000 (M3 copies): the member's answer names the copies.
	return public.qorpera_memory_message_erase_answer(v_id);$new$);
select pg_temp.m3_copies_replace('public.qorpera_memory_message_erase_status(uuid,uuid,uuid)'::regprocedure,
	$old$	return public.qorpera_memory_message_erase_reply(p_erase_id);$old$,
	$new$	-- 20260930470000 (M3 copies): the member's answer names the copies.
	return public.qorpera_memory_message_erase_answer(p_erase_id);$new$);

drop function pg_temp.m3_copies_replace(regprocedure, text, text);
