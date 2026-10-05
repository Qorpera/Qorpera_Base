-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- An agent pages through all of its todos on folder-v2 (ported from snapshot-v1 in the legacy sweep): Alice's run
-- lists the index of her todo files (qorpera_folder_agent_todos). A cursor continues the listing in creation order, so
-- walking to the end shows every todo once, and a change between two pages neither skips nor repeats one. Filters
-- narrow a walk; the counts say exactly how much a page left out. The prompt's open-work counts take only open todos,
-- and the workers of open todos, dispatched as worker folders. Todos are files the owner saves; workers are the run's
-- reviewed dispatches.
select pg_temp.base_claims('service_role');

-- Alice's run as the folder core's actor.
create function pg_temp.tw_actor() returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId')
	from (select current_setting('qorpera_test.base_binding')::jsonb b) binding
$$;
create function pg_temp.tw_list(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_agent_todos('92400000-0000-4000-8000-000000000020', pg_temp.tw_actor(), p_request)
$$;
-- Alice's todo file with this key, written as the parser sends it; an existing file keeps its id and is written over the
-- version read.
create function pg_temp.tw_todo(p_key text, p_title text, p_status text default 'open') returns jsonb language sql as $$
	select pg_temp.base_write('agents/alice/todos/' || p_key || '.md', 'todo',
		format(E'---\nid: %s\ntitle: %s\nstatus: %s\n---\n\n', todo.id, p_title, p_status),
		jsonb_build_object('kind', 'todo', 'id', todo.id, 'title', p_title, 'status', p_status, 'requestedBy', null, 'detail', ''),
		pg_temp.base_version('agents/alice/todos/' || p_key || '.md'))
	from (select coalesce((select id from public.qorpera_runtime_agent_todos where folder_path = 'agents/alice/todos/' || p_key || '.md'
		and folder_retired_at is null), md5('agents/alice/todos/' || p_key || '.md')::uuid) id) todo
$$;
-- A todo's file with its title and state changed.
create function pg_temp.tw_change(p_key text, p_title text default null, p_status text default null) returns jsonb language sql as $$
	select pg_temp.tw_todo(p_key, coalesce(p_title, todo.title), coalesce(p_status, todo.state))
	from public.qorpera_runtime_agent_todos todo where todo.folder_path = 'agents/alice/todos/' || p_key || '.md'
		and todo.folder_retired_at is null
$$;
-- Alice's open and blocked todos, as the index holds them.
create function pg_temp.tw_open() returns text[] language sql as $$
	select array(select todo_key from public.qorpera_runtime_agent_todos where staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and folder_path is not null and folder_retired_at is null and state in ('open', 'blocked'))
$$;
-- Walks the listing to its end from p_cursor. Every page is full unless it is the last, carries a cursor exactly when
-- more remain, and counts exactly what the pages after it hold. Returns the keys in the order they were listed.
create function pg_temp.tw_walk(p_request jsonb, p_cursor text default null) returns text[] language plpgsql as $$
declare v_page jsonb; v_cursor text := p_cursor; v_keys text[] := '{}'; v_mores integer[] := '{}'; v_lengths integer[] := '{}';
	v_more integer; v_length integer; v_index integer;
begin
	loop
		v_page := pg_temp.tw_list(p_request || case when v_cursor is null then '{}'::jsonb else jsonb_build_object('cursor', v_cursor) end);
		v_length := jsonb_array_length(v_page -> 'todos');
		v_more := (v_page ->> 'moreTodos')::integer;
		perform pg_temp.base_assert(v_more >= 0 and (v_more = 0) = (v_page ->> 'nextCursor' is null)
			and (v_more = 0 or v_length = 32) and v_length <= 32,
			'A page is full unless it is the last, and has a cursor exactly when more remain: ' || v_page::text);
		v_keys := v_keys || array(select item ->> 'todoKey' from jsonb_array_elements(v_page -> 'todos') with ordinality listed(item, ordinal)
			order by ordinal);
		v_mores := v_mores || v_more; v_lengths := v_lengths || v_length;
		exit when v_more = 0;
		v_cursor := v_page ->> 'nextCursor';
		perform pg_temp.base_assert(cardinality(v_lengths) < 100, 'A walk ends');
	end loop;
	for v_index in 1..cardinality(v_mores) loop
		perform pg_temp.base_assert(v_mores[v_index] = coalesce((select sum(length) from unnest(v_lengths[v_index + 1:]) length), 0),
			'Each page counts exactly what the pages after it hold');
	end loop;
	return v_keys;
end $$;
-- Whether two key lists hold the same keys, each exactly once.
create function pg_temp.tw_same_once(p_listed text[], p_expected text[]) returns boolean language sql as $$
	select cardinality(p_listed) = (select count(distinct key) from unnest(p_listed) key)
		and (select array_agg(key order by key) from unnest(p_listed) key) is not distinct from
			(select array_agg(key order by key) from unnest(p_expected) key)
$$;
-- The run's reviewed dispatch of a read-only worker on one of Alice's todos: its brief, staged by the run, saved in the
-- worker's folder under the todo's folder with the run's own allow of the call.
create function pg_temp.tw_dispatch(p_todo text, p_worker text) returns jsonb language plpgsql as $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_folder text := 'agents/alice/todos/' || p_todo || '/' || p_worker;
	v_brief jsonb := jsonb_build_object('kind', 'worker-brief', 'id', extensions.gen_random_uuid(), 'title', 'Side task ' || p_worker,
		'species', 'in-house', 'access', 'read', 'revival', 'batch',
		'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUps', 0, 'followedUpAt', null,
		'goal', 'Research ' || p_worker, 'doneWhen', 'A paragraph.', 'context', null, 'sources', '[]'::jsonb, 'followUp', null)
		|| public.qorpera_company_state_worker_standing('in-house', 'read', 'batch');
	v_units jsonb; v_action uuid; v_review jsonb; v_result jsonb;
begin
	v_units := case when pg_temp.base_version('agents/alice/todos/' || p_todo) is null
			then jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'agents/alice/todos/' || p_todo)) else '[]'::jsonb end
		|| jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', v_folder,
			'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file',
				'file', pg_temp.base_seal(pg_temp.tw_actor(), pg_temp.base_manifest(v_brief::text)) -> 'file')),
			'structured', jsonb_build_array(jsonb_build_object('path', v_folder || '/brief.md', 'kind', 'worker-brief', 'text', v_brief::text,
				'parse', v_brief, 'parserVersion', 1))));
	v_action := (public.qorpera_record_action_review(v_binding, jsonb_build_object('callId', 'dispatch-' || p_todo || '-' || p_worker,
		'tool', 'manage_worker', 'effect', 'delegation', 'argumentSha256', md5(p_todo || p_worker) || md5(p_worker || p_todo),
		'action', jsonb_build_object('title', 'Dispatch a worker', 'target', p_worker, 'details', '{}'::jsonb),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	v_review := public.qorpera_folder_record_review(v_binding, jsonb_build_object('actionReviewId', v_action, 'tool', 'manage_worker',
		'argumentSha256', md5(p_todo || p_worker) || md5(p_worker || p_todo), 'units', v_units));
	v_result := public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', pg_temp.tw_actor(),
		'tw-dispatch-' || p_todo || '-' || p_worker, v_units,
		jsonb_build_object('action', 'dispatch', 'folder', v_folder, 'title', v_brief ->> 'title', 'goal', v_brief ->> 'goal',
			'doneWhen', v_brief ->> 'doneWhen', 'context', v_brief -> 'context', 'sources', v_brief -> 'sources', 'access', 'read',
			'revival', 'batch'), (v_review ->> 'reviewId')::uuid);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u ->> 'outcome' <> 'saved'),
		'The dispatch saves: ' || v_result::text);
	return v_result;
end $$;

-- 1. Seventy todos: every walk shows each one once, newest first, and the counts are exact.
do $$
declare v_keys text[]; v_expected text[]; v_page jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'tw-seventy-todos', (select jsonb_agg(pg_temp.tw_todo('t-' || lpad(n::text, 2, '0'),
		case when n % 7 = 0 then 'Invoice follow-up ' else 'Market research ' end || n,
		case when n % 5 = 0 then 'blocked' else 'open' end) order by n) from generate_series(1, 70) n));
	perform pg_temp.base_assert((select count(distinct created_at) from public.qorpera_runtime_agent_todos
		where staff_agent_id = '92400000-0000-4000-8000-000000000030' and todo_key ~ '^t-[0-9]{2}$') = 70,
		'Todos saved in one commit each get their own creation time');
	-- The listing is newest first by created_at, which is clock_timestamp() and steps back when the system clock is
	-- adjusted; one distinct second per todo, in key order, keeps the order exact.
	update public.qorpera_runtime_agent_todos set created_at = now() - interval '1 day' + substr(todo_key, 3)::integer * interval '1 second'
	where staff_agent_id = '92400000-0000-4000-8000-000000000030' and todo_key ~ '^t-[0-9]{2}$';
	perform pg_temp.base_commit(pg_temp.base_owner(), 'tw-close-ten', (select jsonb_agg(pg_temp.tw_change('t-' || n, null,
		case when n <= 66 then 'done' else 'cancelled' end) order by n) from generate_series(61, 70) n));

	v_keys := pg_temp.tw_walk('{}');
	select array_agg(todo_key order by created_at desc, id desc) into v_expected from public.qorpera_runtime_agent_todos
	where staff_agent_id = '92400000-0000-4000-8000-000000000030' and state in ('open', 'blocked');
	perform pg_temp.base_assert(cardinality(v_expected) = 60 and v_keys = v_expected,
		'Sixty open and blocked todos: two pages list every one once, newest first');
	v_keys := pg_temp.tw_walk('{"includeClosed":true}');
	perform pg_temp.base_assert(cardinality(v_keys) = 70 and pg_temp.tw_same_once(v_keys, array(select todo_key
		from public.qorpera_runtime_agent_todos where staff_agent_id = '92400000-0000-4000-8000-000000000030')),
		'includeClosed walks all seventy');
	v_keys := pg_temp.tw_walk('{"state":"blocked"}');
	perform pg_temp.base_assert(v_keys = array['t-60','t-55','t-50','t-45','t-40','t-35','t-30','t-25','t-20','t-15','t-10','t-05'],
		'state blocked lists only the blocked ones');
	v_keys := pg_temp.tw_walk('{"state":"done"}');
	perform pg_temp.base_assert(pg_temp.tw_same_once(v_keys, array['t-61','t-62','t-63','t-64','t-65','t-66']),
		'state done lists only the done ones');
	v_keys := pg_temp.tw_walk('{"search":"INVOICE"}');
	perform pg_temp.base_assert(v_keys = array['t-56','t-49','t-42','t-35','t-28','t-21','t-14','t-07'],
		'search matches titles case-insensitively and leaves closed todos out by default');
	v_keys := pg_temp.tw_walk('{"search":"invoice","includeClosed":true}');
	perform pg_temp.base_assert(v_keys = array['t-70','t-63','t-56','t-49','t-42','t-35','t-28','t-21','t-14','t-07'],
		'search combines with includeClosed');
	v_keys := pg_temp.tw_walk('{"search":"t-3"}');
	perform pg_temp.base_assert(pg_temp.tw_same_once(v_keys, array['t-30','t-31','t-32','t-33','t-34','t-35','t-36','t-37','t-38','t-39']),
		'search matches keys too');
	v_page := pg_temp.tw_list('{"search":"nothing like this"}');
	perform pg_temp.base_assert(v_page -> 'todos' = '[]'::jsonb and (v_page ->> 'moreTodos')::int = 0 and v_page -> 'nextCursor' = 'null'::jsonb,
		'An empty listing has no cursor and counts nothing');

	-- Todos created in the same instant are ordered by id, and a page break between them loses none.
	begin
		update public.qorpera_runtime_agent_todos set created_at = '2026-09-25 10:00:00+00'
		where staff_agent_id = '92400000-0000-4000-8000-000000000030';
		v_keys := pg_temp.tw_walk('{"includeClosed":true}');
		perform pg_temp.base_assert(v_keys = array(select todo_key from public.qorpera_runtime_agent_todos
			where staff_agent_id = '92400000-0000-4000-8000-000000000030' order by id desc),
			'Seventy todos created in one instant still page once each, by id');
		raise exception 'rollback-same-instant-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-same-instant-probe' then raise; end if;
	end;
end $$;

-- 2. A change between pages neither skips nor repeats a todo.
do $$
declare v_first jsonb; v_rest text[]; v_before text[] := pg_temp.tw_open(); v_read text; v_unread text; v_page_one text[];
begin
	v_first := pg_temp.tw_list('{}');
	v_page_one := array(select item ->> 'todoKey' from jsonb_array_elements(v_first -> 'todos') item);
	v_read := v_page_one[3];
	select todo_key into strict v_unread from public.qorpera_runtime_agent_todos
	where staff_agent_id = '92400000-0000-4000-8000-000000000030' and state = 'open' and todo_key <> all(v_page_one)
	order by created_at, id limit 1;
	-- Saved after the first page: one already read, one not yet read (an order by the latest change would move both to
	-- the top: one repeated, one skipped), and a new todo.
	perform pg_temp.base_commit(pg_temp.base_owner(), 'tw-between-pages', jsonb_build_array(
		pg_temp.tw_change(v_read, 'Changed after reading'), pg_temp.tw_change(v_unread, 'Changed before reading', 'blocked'),
		pg_temp.tw_todo('new-between', 'Created between pages')));
	v_rest := pg_temp.tw_walk('{}', v_first ->> 'nextCursor');
	perform pg_temp.base_assert(pg_temp.tw_same_once(v_page_one || v_rest, v_before) and v_unread = any(v_rest) and not v_read = any(v_rest),
		'After changes between pages, the walk still lists every todo that was open once: the unread change once, the read one not again');
	perform pg_temp.base_assert(not 'new-between' = any(v_rest) and pg_temp.tw_list('{}') #>> '{todos,0,todoKey}' = 'new-between',
		'A todo created during a walk starts the next walk');
	-- A todo closed before its page is read leaves the open listing; nothing else moves.
	v_first := pg_temp.tw_list('{}');
	v_page_one := array(select item ->> 'todoKey' from jsonb_array_elements(v_first -> 'todos') item);
	select todo_key into strict v_unread from public.qorpera_runtime_agent_todos
	where staff_agent_id = '92400000-0000-4000-8000-000000000030' and state = 'open' and todo_key <> all(v_page_one)
	order by created_at, id limit 1;
	perform pg_temp.base_commit(pg_temp.base_owner(), 'tw-close-unread', jsonb_build_array(pg_temp.tw_change(v_unread, null, 'done')));
	v_rest := pg_temp.tw_walk('{}', v_first ->> 'nextCursor');
	perform pg_temp.base_assert(pg_temp.tw_same_once(v_page_one || v_rest, pg_temp.tw_open()) and not v_unread = any(v_rest),
		'A todo closed mid-walk is simply no longer open');
	-- The cursor's own todo closes before the next page: its place still holds.
	v_first := pg_temp.tw_list('{}');
	v_page_one := array(select item ->> 'todoKey' from jsonb_array_elements(v_first -> 'todos') item);
	perform pg_temp.base_assert(v_first ->> 'nextCursor' = v_first #>> '{todos,31,cursor}', 'The cursor is the last listed todo''s');
	perform pg_temp.base_commit(pg_temp.base_owner(), 'tw-close-cursor', jsonb_build_array(pg_temp.tw_change(v_page_one[32], null, 'done')));
	v_rest := pg_temp.tw_walk('{}', v_first ->> 'nextCursor');
	perform pg_temp.base_assert(pg_temp.tw_same_once(v_page_one[1:31] || v_rest, pg_temp.tw_open()),
		'A cursor whose own todo closed still continues exactly after it');
end $$;

-- 3. The prompt's open-work counts: only open todos, and workers of open todos.
do $$
declare v_index integer; v_counts jsonb;
begin
	perform pg_temp.base_assert((select count(*) from public.qorpera_runtime_agent_todos where staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and todo_key in ('t-11', 't-12', 't-13') and state = 'open') = 3, 'Three open todos take the workers');
	for v_index in 11..13 loop
		perform pg_temp.tw_dispatch('t-' || v_index, 'side-a');
		perform pg_temp.tw_dispatch('t-' || v_index, 'side-b');
	end loop;
	v_counts := public.qorpera_describe_agent_open_work(current_setting('qorpera_test.base_binding')::jsonb);
	perform pg_temp.base_assert(v_counts ->> 'schema' = 'qorpera.agent-open-work/v1'
		and v_counts ->> 'runId' = current_setting('qorpera_test.base_binding')::jsonb ->> 'runId'
		and v_counts -> 'todos' = jsonb_build_object(
			'open', (select count(*) from public.qorpera_runtime_agent_todos where staff_agent_id = '92400000-0000-4000-8000-000000000030' and state = 'open'),
			'blocked', (select count(*) from public.qorpera_runtime_agent_todos where staff_agent_id = '92400000-0000-4000-8000-000000000030' and state = 'blocked'))
		and v_counts -> 'workers' = '{"active":6,"blocked":0}'::jsonb, 'Open work is counted, not listed: ' || v_counts::text);
	-- A blocked worker counts while its todo is open, not after the todo closes.
	begin
		update public.qorpera_runtime_workers set state = 'blocked', reported_at = clock_timestamp(),
			result = jsonb_build_object('outcome', 'blocked', 'outputs', '[]'::jsonb, 'sequence', sequence, 'summary', 'Need a list.', 'needs', 'A list.')
		where worker_key = 'side-a' and staff_agent_id = '92400000-0000-4000-8000-000000000030';
		perform pg_temp.base_assert(public.qorpera_describe_agent_open_work(current_setting('qorpera_test.base_binding')::jsonb) -> 'workers'
			= '{"active":3,"blocked":3}'::jsonb, 'Blocked workers are counted');
		update public.qorpera_runtime_agent_todos set state = 'done' where folder_path = 'agents/alice/todos/t-11.md';
		perform pg_temp.base_assert(public.qorpera_describe_agent_open_work(current_setting('qorpera_test.base_binding')::jsonb) -> 'workers'
			= '{"active":2,"blocked":2}'::jsonb, 'Workers of a closed todo are not open work');
		raise exception 'rollback-open-work-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-open-work-probe' then raise; end if;
	end;
end $$;

-- 4. Invalid requests and foreign cursors are refused.
select pg_temp.base_error($q$select pg_temp.tw_list('{"cursor":"not-a-cursor"}')$q$, '22023', 'Todo request is invalid');
select pg_temp.base_error($q$select pg_temp.tw_list('{"cursor":"00000000-0000-4000-8000-00000000abcd"}')$q$, '22023',
	'Todo cursor is unavailable; list again without it');
select pg_temp.base_error($q$select pg_temp.tw_list('{"state":"closed"}')$q$, '22023', 'Todo request is invalid');
select pg_temp.base_error($q$select pg_temp.tw_list('{"state":["open"]}')$q$, '22023', 'Todo request is invalid');
select pg_temp.base_error($q$select pg_temp.tw_list('{"search":""}')$q$, '22023', 'Todo request is invalid');
select pg_temp.base_error($q$select pg_temp.tw_list('{"search":"a\nb"}')$q$, '22023', 'Todo request is invalid');
select pg_temp.base_error($q$select pg_temp.tw_list('{"workerKey":"side-a"}')$q$, '22023', 'Todo request is invalid');
-- A worker's id is not a todo cursor.
select pg_temp.base_error(format($q$select pg_temp.tw_list('{"cursor":"%s"}')$q$,
	(select id from public.qorpera_runtime_workers where worker_key = 'side-a' limit 1)), '22023', 'Todo cursor is unavailable; list again without it');

-- 5. Control-plane only.
select pg_temp.base_claims('authenticated');
select pg_temp.base_error($q$select public.qorpera_describe_agent_open_work(current_setting('qorpera_test.base_binding')::jsonb)$q$, '42501');
select pg_temp.base_claims('service_role');
select pg_temp.base_assert(
	not has_function_privilege('anon', 'public.qorpera_describe_agent_open_work(jsonb)', 'execute')
	and not has_function_privilege('authenticated', 'public.qorpera_describe_agent_open_work(jsonb)', 'execute')
	and not has_function_privilege('qorpera_secret_broker', 'public.qorpera_describe_agent_open_work(jsonb)', 'execute')
	and has_function_privilege('service_role', 'public.qorpera_describe_agent_open_work(jsonb)', 'execute'),
	'The open-work count is for the runtime only');
rollback;
