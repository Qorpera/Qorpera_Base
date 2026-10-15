-- Summary trees M3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10), the copies in a member's answer. Step 3 keeps
-- the copies P18 names for each block (qorpera_memory_message_erase_blocks.copies): files at paths no tree owns that hold
-- a version's bytes, which the erase leaves. A member erases such a copy by its path, so the answer to a member's request
-- and to a status read names them: copies [{path, live}], each path once and sorted, live when the path is in the folder
-- now (else only its history holds the copy), empty before step 3. The steps' answers, which only the eraser reads, stay
-- as they were. The patched bodies carry the marker 20260930470000 (M3 copies).

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

-- An erase as a member reads it: where it stands, and the copies its blocks' erasures named. Two blocks may name one
-- path; it is live when any of them found it live.
create function public.qorpera_memory_message_erase_answer(p_erase_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	select public.qorpera_memory_message_erase_reply(p_erase_id) || jsonb_build_object('copies', coalesce((
		select jsonb_agg(jsonb_build_object('path', c.path, 'live', c.live) order by c.path collate "C")
		from (select x ->> 'path' as path, bool_or((x ->> 'live')::boolean) as live
			from public.qorpera_memory_message_erase_blocks b cross join jsonb_array_elements(b.copies) x
			where b.erase_id = p_erase_id group by x ->> 'path') c), '[]'::jsonb))
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
