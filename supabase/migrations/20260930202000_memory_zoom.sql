-- Summary trees M1b, part 3 (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §8, §10): the zoom.
--
-- 1. qorpera_memory_conversation: a zoom ref (`.`, thread:<agent>, group:<group>) to its conversation in the company,
--    from the live index rows (plain reads). run:<id> names none until W1 adds run logs.
-- 2. qorpera_memory_event and qorpera_memory_events: included events (§3) by message number, as the transcript holds
--    them: the speaker, the text (a quoted message in its fenced form, never the «» text), attachments, a card's data,
--    and the run that wrote an agent's event. An erased event keeps its speaker and holds nothing else.
-- 3. qorpera_memory_tree_read: a conversation's live tree from the index (§4.4), its lines and the blocks they are in,
--    for a zoom with no line and for the view (W4).
-- 4. qorpera_memory_zoom, a native host call (scope binding): the run check, the ref, the line's checks, the receipt by
--    target and range, the target session FOR SHARE, then the read. This replaces §8's generation recheck: an erase
--    takes the session FOR UPDATE at the same step and scans receipts after it, so each finds the other done.
-- 5. 'zoom' joins the observation vocabulary.
-- Every patched body carries the marker 20260930202000 for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; M1a comes first.
do $$ begin
	if to_regprocedure('public.qorpera_memory_zoom(jsonb,jsonb)') is not null then
		raise exception 'M1b-3 (20260930202000) is already applied'; end if;
	if to_regclass('public.qorpera_memory_read_receipts') is null then
		raise exception 'M1b-3 (20260930202000) needs M1a (20260928509150)'; end if;
end $$;

create function pg_temp.m1b3_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'M1b-3 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The conversation a ref names -------------------------------------------------------------------------------------

-- A zoom ref's conversation in the environment (§8), from the live index rows (plain reads): `.` is the run's own,
-- thread:<agent> the thread of the agent at agents/<agent>, group:<group> the group chat at agents/groups/<group>, each
-- matched as a folder key, so case does not matter. Returns its session id, kind and name; null when the ref names none.
-- run:<id> names none until W1.
create function public.qorpera_memory_conversation(p_environment_id uuid, p_ref text, p_own_session_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_key text; v_session uuid;
begin
	if p_ref = '.' then
		v_session := p_own_session_id;
	elsif p_ref ~ '^thread:.' then
		v_key := public.qorpera_folder_key('agents/' || substr(p_ref, 8) || '/agent.md');
		if v_key !~ '^agents/[^/]+/agent\.md$' or v_key ~ '^agents/(groups|\.\.?)/' then return null; end if;
		select r.session_id into v_session
		from public.qorpera_profile_staff s
		join public.qorpera_company_rooms r on r.profile_id = s.profile_id and r.bound_staff_agent_id = s.staff_agent_id
		where s.folder_environment_id = p_environment_id and s.folder_retired_at is null and s.deleted_at is null
			and s.folder_path is not null and public.qorpera_folder_key(s.folder_path) = v_key
		limit 1;
	elsif p_ref ~ '^group:.' then
		v_key := public.qorpera_folder_key('agents/groups/' || substr(p_ref, 7) || '/group.md');
		if v_key !~ '^agents/groups/[^/]+/group\.md$' or v_key ~ '^agents/groups/\.\.?/' then return null; end if;
		select r.session_id into v_session
		from public.qorpera_company_rooms r
		where r.folder_environment_id = p_environment_id and r.folder_retired_at is null and r.folder_path is not null
			and public.qorpera_folder_key(r.folder_path) = v_key
		limit 1;
	end if;
	if v_session is null then return null; end if;
	return (select jsonb_build_object('sessionId', s.id,
			'kind', case when r.bound_staff_agent_id is not null then 'thread' when r.id is not null then 'group' else 'conversation' end,
			'name', coalesce(st.display_name, r.name, s.title))
		from public.qorpera_shared_sessions s
		left join public.qorpera_company_rooms r on r.session_id = s.id
		left join public.qorpera_profile_staff st on st.profile_id = r.profile_id and st.staff_agent_id = r.bound_staff_agent_id
		where s.id = v_session and s.environment_id = p_environment_id);
end $$;
revoke all on function public.qorpera_memory_conversation(uuid, text, uuid) from public, anon, authenticated, service_role;

-- 2. The events -------------------------------------------------------------------------------------------------------

-- An included event (§3) as zoom returns it (§8), with its message number `index`. The speaker is a member (an input of
-- the conversation, or a user message), by name; an agent (an event a run wrote), by the name it spoke under; else the
-- platform. `runId` is the run that wrote it. A quoted message comes in its fenced form (20260928459100): the member's
-- words with [quote N] and the quote records, and a message whose quotes cannot be fenced carries no text, so the «»
-- text never comes back as the member's words. A card (any event but a message) carries its type and data. An erased
-- event keeps its speaker and holds nothing else.
create function public.qorpera_memory_event(p_profile_id uuid, p_event public.qorpera_session_events, p_index bigint)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
	v_entry jsonb := p_event.body -> 'entry';
	v_erased boolean := p_event.body = '{"erased":true}'::jsonb;
	v_speaker public.qorpera_session_event_speakers%rowtype;
	v_input public.qorpera_session_inputs%rowtype;
	v_run_id uuid; v_kind text; v_name text; v_fenced jsonb; v_text text; v_attachments jsonb; v_card_type text; v_card jsonb;
begin
	select * into v_speaker from public.qorpera_session_event_speakers where event_id = p_event.event_id;
	select * into v_input from public.qorpera_session_inputs where id = p_event.session_input_id and session_id = p_event.session_id;
	v_run_id := coalesce(case when p_event.execution_kind = 'run' then p_event.execution_id end, v_speaker.run_id);
	v_kind := case
		when v_input.id is not null then 'member'
		when v_speaker.event_id is not null or p_event.execution_kind is not null or v_entry #>> '{message,role}' = 'assistant' then 'agent'
		when v_entry #>> '{message,role}' = 'user' then 'member'
		else 'platform' end;
	v_name := case v_kind
		when 'member' then coalesce(public.qorpera_review_member_name(p_profile_id, coalesce(v_input.author_user_id, p_event.actor_user_id)),
			'Member')
		when 'agent' then coalesce(nullif(btrim(v_speaker.display_name), ''),
			(select nullif(btrim(s.display_name), '') from public.qorpera_profile_staff s where s.profile_id = p_profile_id
				and s.staff_agent_id = coalesce(v_speaker.staff_agent_id,
					(select r.staff_agent_id from public.qorpera_execution_runs r where r.id = v_run_id))),
			'Agent')
		else 'Qorpera' end;
	if not v_erased then
		if v_input.id is not null then v_fenced := public.qorpera_member_message_fenced(v_input.id, v_input.body); end if;
		v_text := case
			when v_fenced is not null then v_fenced ->> 'text'
			when v_entry ? 'qorperaQuotes' then null
			when jsonb_typeof(v_entry #> '{message,content}') = 'string' then v_entry #>> '{message,content}'
			else (select string_agg(part.value ->> 'text', E'\n' order by part.n)
				from jsonb_array_elements(case when jsonb_typeof(v_entry #> '{message,content}') = 'array'
					then v_entry #> '{message,content}' else '[]'::jsonb end) with ordinality as part(value, n)
				where part.value ->> 'type' = 'text' and jsonb_typeof(part.value -> 'text') = 'string')
		end;
		v_attachments := (select jsonb_agg(jsonb_build_object('mediaType', a.value -> 'mediaType', 'bytes', a.value -> 'bytes') order by a.n)
			from jsonb_array_elements(case when jsonb_typeof(v_entry -> 'qorperaAttachments') = 'array'
				then v_entry -> 'qorperaAttachments' else '[]'::jsonb end) with ordinality as a(value, n));
		if p_event.event_type <> 'message' then
			v_card_type := coalesce(v_entry ->> 'customType', p_event.event_type);
			v_card := v_entry -> 'data';
		end if;
	end if;
	return jsonb_build_object('index', p_index, 'sequence', p_event.sequence, 'eventId', p_event.event_id,
		'eventHash', p_event.event_hash, 'type', p_event.event_type,
		'at', to_char(p_event.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'erased', v_erased,
		'runId', v_run_id, 'speakerKind', v_kind, 'speaker', v_name, 'role', v_entry #>> '{message,role}', 'text', v_text,
		'quotes', v_fenced -> 'quotes', 'attachments', v_attachments, 'cardType', v_card_type, 'card', v_card);
end $$;
revoke all on function public.qorpera_memory_event(uuid, public.qorpera_session_events, bigint)
	from public, anon, authenticated, service_role;

-- A conversation's included events [p_start, p_start + p_count) by message number, oldest first; [] past its end.
create function public.qorpera_memory_events(p_session_id uuid, p_start bigint, p_count integer)
returns jsonb language sql stable set search_path = '' as $$
	select coalesce(jsonb_agg(public.qorpera_memory_event(s.profile_id, x.e, x.n) order by x.n), '[]'::jsonb)
	from public.qorpera_shared_sessions s
	cross join lateral (select e, row_number() over (order by e.sequence) - 1 as n
		from public.qorpera_session_events e
		where e.session_id = s.id
			and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')
		order by e.sequence offset p_start limit p_count) as x
	where s.id = p_session_id
$$;
revoke all on function public.qorpera_memory_events(uuid, bigint, integer) from public, anon, authenticated, service_role;

-- 3. The tree ---------------------------------------------------------------------------------------------------------

-- A conversation's live tree from the index (§4.4): its message count, root and node size, the blocks its lines are in
-- (path and version, for the platform read that releases them), and every line with its block's number in `blocks`.
-- A conversation with no live tree has no lines. Null when the session is not the environment's.
create function public.qorpera_memory_tree_read(p_environment_id uuid, p_session_id uuid)
returns jsonb language sql stable set search_path = '' as $$
	with tree as (
		select t.root_path, t.node_bytes from public.qorpera_memory_trees t
		where t.environment_id = p_environment_id and t.session_id = p_session_id and t.retired_at is null
	), nodes as (
		select n.l, n.k, n.text, n.block_path, n.block_path_version,
			dense_rank() over (order by n.block_path, n.block_path_version) - 1 as block
		from public.qorpera_memory_tree_nodes n
		where n.environment_id = p_environment_id and n.session_id = p_session_id and n.run_id is null
			and exists (select 1 from tree)
	)
	select jsonb_build_object('sessionId', s.id, 'generation', s.memory_generation,
		'messages', (select count(*) from public.qorpera_session_events e where e.session_id = s.id
			and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')),
		'root', (select tree.root_path from tree), 'nodeBytes', (select tree.node_bytes from tree),
		'blocks', coalesce((select jsonb_agg(jsonb_build_object('path', b.block_path, 'version', b.block_path_version) order by b.block)
			from (select distinct nodes.block, nodes.block_path, nodes.block_path_version from nodes) b), '[]'::jsonb),
		'lines', coalesce((select jsonb_agg(jsonb_build_object('l', nodes.l, 'k', nodes.k, 'text', nodes.text, 'block', nodes.block)
			order by nodes.l, nodes.k) from nodes), '[]'::jsonb))
	from public.qorpera_shared_sessions s
	where s.id = p_session_id and s.environment_id = p_environment_id
$$;
revoke all on function public.qorpera_memory_tree_read(uuid, uuid) from public, anon, authenticated, service_role;

-- 4. The zoom ---------------------------------------------------------------------------------------------------------

-- zoom (§8) for the binding's run. The request is {callId, conversation?, line?, from?}; JSON null is an absent argument.
-- Answers with schema qorpera.memory-zoom/v1, the conversation ({ref, sessionId, kind, name}), the line, the message
-- count and `from`, and one of:
-- - missing 'conversation' (a ref that names none) or 'line' (not an address of [0, T): size a power of two, start a
--   multiple of it, start + size <= T), with nothing read and no receipt;
-- - no line: the tree (qorpera_memory_tree_read), to fold to one page;
-- - size 1: the event (qorpera_memory_event), from the transcript, never a summary;
-- - size > 1: the two lines below, each with its address, the dates of its first and last event, its text and block
--   (null text when it is not built).
-- The receipt keeps the target's session id, start, size (T when there is no line) and `from`. A retried call keeps
-- its first receipt (with no line it matches by target and start, and its size grows to the count read); the same call
-- id for another read refuses (22023), as does a malformed request.
create function public.qorpera_memory_zoom(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	c_schema constant text := 'qorpera.memory-zoom/v1';
	v_run public.qorpera_execution_runs%rowtype; v_receipt public.qorpera_memory_read_receipts%rowtype;
	v_ref_json jsonb; v_line_json jsonb; v_from_json jsonb; v_ref text; v_line text; v_from bigint;
	v_conversation jsonb; v_session uuid; v_count bigint; v_match text[]; v_start bigint; v_size bigint; v_half bigint;
	v_child_l integer; v_tree jsonb; v_answer jsonb;
begin
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, public.qorpera_folder_tool_run(p_binding, '[]'::jsonb) -> 'run');
	if jsonb_typeof(p_request) is distinct from 'object' then
		raise exception 'zoom request is malformed' using errcode = '22023'; end if;
	v_ref_json := nullif(p_request -> 'conversation', 'null'::jsonb);
	v_line_json := nullif(p_request -> 'line', 'null'::jsonb);
	v_from_json := nullif(p_request -> 'from', 'null'::jsonb);
	if exists (select 1 from jsonb_object_keys(p_request) as key(name) where key.name not in ('callId','conversation','line','from'))
		or jsonb_typeof(p_request -> 'callId') is distinct from 'string'
		or char_length(p_request ->> 'callId') not between 1 and 256
		or jsonb_typeof(coalesce(v_ref_json, '"."'::jsonb)) <> 'string'
		or jsonb_typeof(coalesce(v_line_json, '""'::jsonb)) <> 'string'
		or jsonb_typeof(coalesce(v_from_json, '0'::jsonb)) <> 'number'
		or coalesce(v_from_json #>> '{}', '0') !~ '^[0-9]{1,16}$' then
		raise exception 'zoom request is malformed' using errcode = '22023'; end if;
	v_from := coalesce(v_from_json #>> '{}', '0')::bigint;
	if v_from > 9007199254740991 then raise exception 'zoom request is malformed' using errcode = '22023'; end if;
	v_ref := coalesce(v_ref_json #>> '{}', '.');
	v_line := v_line_json #>> '{}';

	v_conversation := public.qorpera_memory_conversation(v_run.environment_id, v_ref, v_run.session_id);
	if v_conversation is null then
		return jsonb_build_object('schema', c_schema, 'missing', 'conversation', 'conversation', jsonb_build_object('ref', v_ref));
	end if;
	v_session := (v_conversation ->> 'sessionId')::uuid;
	v_conversation := jsonb_build_object('ref', v_ref) || v_conversation;
	v_count := (select count(*) from public.qorpera_session_events e where e.session_id = v_session
		and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision'));
	if v_line is null then
		v_start := 0;
		v_size := v_count;
	else
		v_match := regexp_match(v_line, '^(0|[1-9][0-9]{0,17})\+([1-9][0-9]{0,17})$');
		v_start := v_match[1]::bigint;
		v_size := v_match[2]::bigint;
		if v_match is null or (v_size & (v_size - 1)) <> 0 or v_start % v_size <> 0 or v_start + v_size > v_count then
			return jsonb_build_object('schema', c_schema, 'missing', 'line', 'conversation', v_conversation, 'line', v_line,
				'messages', v_count);
		end if;
	end if;

	-- The receipt (§8, §10), with the run's rows under the run mutex: what this call reads, by target and range.
	insert into public.qorpera_memory_read_receipts(environment_id, run_id, call_id, tool, target_session_id, start, size, from_offset)
	values (v_run.environment_id, v_run.id, p_request ->> 'callId', 'zoom', v_session, v_start, v_size, v_from)
	on conflict (run_id, call_id) do nothing
	returning * into v_receipt;
	if v_receipt.id is null then
		select * into strict v_receipt from public.qorpera_memory_read_receipts
		where run_id = v_run.id and call_id = p_request ->> 'callId' for update;
		if v_receipt.tool <> 'zoom' or v_receipt.target_session_id is distinct from v_session or v_receipt.start <> v_start
			or v_receipt.from_offset <> v_from or (v_line is not null and v_receipt.size <> v_size) then
			raise exception 'zoom call id was used for another read' using errcode = '22023'; end if;
	end if;
	-- Core §3's session step, last: the target conversation FOR SHARE, and every read in the statements after it. An
	-- erase takes the session FOR UPDATE at the same step and scans receipts in a later statement (§10), so either the
	-- erase waits and finds this receipt, or this waits and reads what the erase left. Nothing is retried. The receipt's
	-- foreign keys hold KEY SHARE on the run and the clock, which their updates (FOR NO KEY UPDATE) never wait on.
	perform 1 from public.qorpera_shared_sessions where id = v_session for share;

	if v_line is null then
		v_tree := public.qorpera_memory_tree_read(v_run.environment_id, v_session);
		-- The whole conversation as read: its count after the lock, so an erase of any message in it matches.
		v_count := greatest(v_count, (v_tree ->> 'messages')::bigint);
		if v_receipt.size < v_count then
			update public.qorpera_memory_read_receipts set size = v_count where id = v_receipt.id;
		end if;
		v_answer := jsonb_build_object('tree', v_tree);
	elsif v_size = 1 then
		v_answer := jsonb_build_object('event', public.qorpera_memory_events(v_session, v_start, 1) -> 0);
	else
		v_half := v_size / 2;
		v_child_l := length(ltrim(v_half::bit(64)::text, '0')) - 1;
		select jsonb_agg(jsonb_build_object('line', format('%s+%s', v_start + c.c * v_half, v_half),
				'from', d.first_at, 'to', d.last_at, 'text', n.text,
				'block', case when n.text is not null then jsonb_build_object('path', n.block_path, 'version', n.block_path_version) end)
			order by c.c)
		into v_answer
		from (values (0::bigint), (1::bigint)) as c(c)
		left join (select (x.n - v_start) / v_half as c,
				to_char(min(x.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as first_at,
				to_char(max(x.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_at
			from (select e.created_at, row_number() over (order by e.sequence) - 1 as n
				from public.qorpera_session_events e
				where e.session_id = v_session
					and e.event_type in ('message','interaction_request','interaction_answer','authorization_request','authorization_decision')
				order by e.sequence offset v_start limit v_size) as x
			group by 1) as d on d.c = c.c
		left join public.qorpera_memory_tree_nodes n on n.environment_id = v_run.environment_id and n.session_id = v_session
			and n.run_id is null and n.l = v_child_l and n.k = v_start / v_half + c.c
			and public.qorpera_memory_session_tree_root(v_run.environment_id, v_session) is not null;
		v_answer := jsonb_build_object('lines', v_answer);
	end if;
	return jsonb_build_object('schema', c_schema, 'conversation', v_conversation, 'line', v_line, 'messages', v_count,
		'from', v_from) || v_answer;
end $$;
revoke all on function public.qorpera_memory_zoom(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_memory_zoom(jsonb, jsonb) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_memory_zoom', 'binding');

-- 5. The vocabulary ---------------------------------------------------------------------------------------------------

-- Observations name the tool, after the proposals'.
select pg_temp.m1b3_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'apply_proposal','discard_proposal',$old$,
	$new$'apply_proposal','discard_proposal',/* 20260930202000 (M1b-3) */'zoom',$new$);

drop function pg_temp.m1b3_replace(regprocedure, text, text);
