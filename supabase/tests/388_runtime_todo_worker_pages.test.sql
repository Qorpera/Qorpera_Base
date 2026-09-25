-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- An agent pages through all of its todos and workers: a cursor continues each
-- listing in creation order, so walking to the end shows every item once, and a
-- change between two pages neither skips nor repeats one. Filters narrow a walk;
-- the counts say exactly how much a page left out.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.parent_binding',current_setting('qorpera_test.wake_binding'),true);

create function pg_temp.todo(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_todo(current_setting('qorpera_test.parent_binding')::jsonb,p_request)
$$;
create function pg_temp.worker(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_worker(current_setting('qorpera_test.parent_binding')::jsonb,p_request)
$$;
create function pg_temp.dispatch(p_todo text,p_worker text,p_title text) returns jsonb language sql as $$
	select pg_temp.worker(jsonb_build_object('action','dispatch','operationKey','d-' || p_todo || '-' || p_worker,'todoKey',p_todo,
		'workerKey',p_worker,'title',p_title,'goal','Research ' || p_title,'definitionOfDone','A paragraph.','access','read'))
$$;
-- One listing item's identity: a todo by its key, a worker by its todo and key.
create function pg_temp.item_key(p_kind text,p_item jsonb) returns text language sql immutable as $$
	select case p_kind when 'todos' then p_item ->> 'todoKey' else (p_item ->> 'todoKey') || '/' || (p_item ->> 'workerKey') end
$$;
-- The page after p_cursor (null: the first page).
create function pg_temp.page(p_kind text,p_request jsonb,p_cursor text) returns jsonb language sql as $$
	select case p_kind when 'todos' then pg_temp.todo(p_request || case when p_cursor is null then '{}'::jsonb
			else jsonb_build_object('cursor',p_cursor) end)
		else pg_temp.worker(p_request || case when p_cursor is null then '{}'::jsonb else jsonb_build_object('cursor',p_cursor) end) end
$$;
-- Walks a listing to its end from p_cursor. Every page is full unless it is the
-- last, carries a cursor exactly when more remain, and counts exactly what the
-- pages after it hold. Returns the keys in the order they were listed.
create function pg_temp.walk(p_kind text,p_request jsonb,p_cursor text default null) returns text[] language plpgsql as $$
declare v_size integer := case p_kind when 'todos' then 32 else 16 end; v_page jsonb; v_cursor text := p_cursor;
	v_keys text[] := '{}'; v_mores integer[] := '{}'; v_lengths integer[] := '{}'; v_more integer; v_length integer; v_index integer;
begin
	loop
		v_page := pg_temp.page(p_kind,p_request,v_cursor);
		v_length := jsonb_array_length(v_page -> p_kind);
		v_more := (v_page ->> case p_kind when 'todos' then 'moreTodos' else 'moreWorkers' end)::integer;
		perform pg_temp.wake_assert(v_more >= 0 and (v_more = 0) = (v_page ->> 'nextCursor' is null)
			and (v_more = 0 or v_length = v_size) and v_length <= v_size,'A page is full unless it is the last, and has a cursor exactly when more remain');
		v_keys := v_keys || array(select pg_temp.item_key(p_kind,item) from jsonb_array_elements(v_page -> p_kind) with ordinality listed(item,ordinal)
			order by ordinal);
		v_mores := v_mores || v_more; v_lengths := v_lengths || v_length;
		exit when v_more = 0;
		v_cursor := v_page ->> 'nextCursor';
		perform pg_temp.wake_assert(cardinality(v_lengths) < 100,'A walk ends');
	end loop;
	for v_index in 1..cardinality(v_mores) loop
		perform pg_temp.wake_assert(v_mores[v_index] = coalesce((select sum(length) from unnest(v_lengths[v_index + 1:]) length),0),
			'Each page counts exactly what the pages after it hold');
	end loop;
	return v_keys;
end $$;
-- Whether two key lists hold the same keys, each exactly once.
create function pg_temp.same_once(p_listed text[],p_expected text[]) returns boolean language sql as $$
	select cardinality(p_listed) = (select count(distinct key) from unnest(p_listed) key)
		and (select array_agg(key order by key) from unnest(p_listed) key) is not distinct from
			(select array_agg(key order by key) from unnest(p_expected) key)
$$;

-- A human wake owes its acknowledgement before any work.
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'progress','pages-ack');

-- 1. Seventy todos: every walk shows each one once, newest first, and the counts are exact.
do $$
declare v_index integer; v_keys text[]; v_expected text[]; v_page jsonb;
begin
	for v_index in 1..70 loop
		perform pg_temp.todo(jsonb_build_object('action','upsert','operationKey','t-' || v_index,'todoKey','t-' || lpad(v_index::text,2,'0'),
			'title',case when v_index % 7 = 0 then 'Invoice follow-up ' else 'Market research ' end || v_index,
			'state',case when v_index % 5 = 0 then 'blocked' else 'open' end));
	end loop;
	for v_index in 61..66 loop
		perform pg_temp.todo(jsonb_build_object('action','done','operationKey','done-' || v_index,'todoKey','t-' || v_index));
	end loop;
	for v_index in 67..70 loop
		perform pg_temp.todo(jsonb_build_object('action','cancel','operationKey','cancel-' || v_index,'todoKey','t-' || v_index));
	end loop;

	v_keys := pg_temp.walk('todos','{"action":"list"}');
	select array_agg(todo_key order by created_at desc, id desc) into v_expected from public.qorpera_runtime_agent_todos
	where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state in ('open','blocked');
	perform pg_temp.wake_assert(cardinality(v_expected) = 60 and v_keys = v_expected,
		'Sixty open and blocked todos: two pages list every one once, newest first');
	v_keys := pg_temp.walk('todos','{"action":"list","includeClosed":true}');
	perform pg_temp.wake_assert(cardinality(v_keys) = 70 and pg_temp.same_once(v_keys,array(select todo_key from public.qorpera_runtime_agent_todos
		where staff_agent_id = '30000000-0000-4000-8000-000000000030')),'includeClosed walks all seventy');
	v_keys := pg_temp.walk('todos','{"action":"list","state":"blocked"}');
	perform pg_temp.wake_assert(v_keys = array['t-60','t-55','t-50','t-45','t-40','t-35','t-30','t-25','t-20','t-15','t-10','t-05'],
		'state blocked lists only the blocked ones');
	v_keys := pg_temp.walk('todos','{"action":"list","state":"done"}');
	perform pg_temp.wake_assert(pg_temp.same_once(v_keys,array['t-61','t-62','t-63','t-64','t-65','t-66']),'state done lists only the done ones');
	v_keys := pg_temp.walk('todos','{"action":"list","search":"INVOICE"}');
	perform pg_temp.wake_assert(v_keys = array['t-56','t-49','t-42','t-35','t-28','t-21','t-14','t-07'],
		'search matches titles case-insensitively and leaves closed todos out by default');
	v_keys := pg_temp.walk('todos','{"action":"list","search":"invoice","includeClosed":true}');
	perform pg_temp.wake_assert(v_keys = array['t-70','t-63','t-56','t-49','t-42','t-35','t-28','t-21','t-14','t-07'],
		'search combines with includeClosed');
	v_keys := pg_temp.walk('todos','{"action":"list","search":"t-3"}');
	perform pg_temp.wake_assert(pg_temp.same_once(v_keys,array['t-30','t-31','t-32','t-33','t-34','t-35','t-36','t-37','t-38','t-39']),
		'search matches keys too');
	v_page := pg_temp.todo('{"action":"list","search":"nothing like this"}');
	perform pg_temp.wake_assert(v_page -> 'todos' = '[]'::jsonb and (v_page ->> 'moreTodos')::int = 0 and v_page -> 'nextCursor' = 'null'::jsonb,
		'An empty listing has no cursor and counts nothing');

	-- Items created in the same instant are ordered by id, and a page break between them loses none.
	begin
		update public.qorpera_runtime_agent_todos set created_at = '2026-09-25 10:00:00+00'
		where staff_agent_id = '30000000-0000-4000-8000-000000000030';
		v_keys := pg_temp.walk('todos','{"action":"list","includeClosed":true}');
		perform pg_temp.wake_assert(v_keys = array(select todo_key from public.qorpera_runtime_agent_todos
			where staff_agent_id = '30000000-0000-4000-8000-000000000030' order by id desc),
			'Seventy todos created in one instant still page once each, by id');
		raise exception 'rollback-same-instant-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-same-instant-probe' then raise; end if;
	end;
end $$;

-- 1b. A listed todo shows the start of its detail; named by todoKey, the whole of it, in any state.
do $$
declare v_item jsonb;
begin
	perform pg_temp.todo(jsonb_build_object('action','upsert','operationKey','long-detail','todoKey','long-detail',
		'title','A long plan','detail',repeat('Step. ',500)));
	v_item := pg_temp.todo('{"action":"list","search":"long plan"}') #> '{todos,0}';
	perform pg_temp.wake_assert(char_length(v_item ->> 'detail') = 200 and v_item ->> 'detailTruncated' = 'true' and v_item ? 'cursor'
		and v_item ->> 'todoKey' = 'long-detail','A listed todo carries the start of its detail and its cursor');
	v_item := pg_temp.todo('{"action":"list","todoKey":"long-detail"}') #> '{todos,0}';
	perform pg_temp.wake_assert(char_length(v_item ->> 'detail') = 2999 and not v_item ? 'detailTruncated',
		'A todo named by todoKey is shown with its whole detail');
	perform pg_temp.todo('{"action":"cancel","operationKey":"cancel-long-detail","todoKey":"long-detail"}');
	perform pg_temp.wake_assert(pg_temp.todo('{"action":"list","todoKey":"long-detail"}') #>> '{todos,0,state}' = 'cancelled'
		and pg_temp.todo('{"action":"list","todoKey":"t-61"}') #>> '{todos,0,state}' = 'done'
		and jsonb_array_length(pg_temp.todo('{"action":"list","todoKey":"absent"}') -> 'todos') = 0,
		'A named todo is found in any state');
end $$;

-- 2. A change between pages neither skips nor repeats a todo.
do $$
declare v_first jsonb; v_rest text[]; v_before text[]; v_read text; v_unread text; v_page_one text[];
begin
	select array_agg(todo_key) into v_before from public.qorpera_runtime_agent_todos
	where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state in ('open','blocked');
	v_first := pg_temp.todo('{"action":"list"}');
	v_page_one := array(select item ->> 'todoKey' from jsonb_array_elements(v_first -> 'todos') item);
	v_read := v_page_one[3];
	select todo_key into strict v_unread from public.qorpera_runtime_agent_todos
	where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state = 'open' and todo_key <> all(v_page_one)
	order by created_at, id limit 1;
	-- Changed after the first page: one already read, one not yet read (the old order,
	-- most recently changed first, moved both to the top: one repeated, one skipped).
	perform pg_temp.todo(jsonb_build_object('action','upsert','operationKey','change-read','todoKey',v_read,'title','Changed after reading'));
	perform pg_temp.todo(jsonb_build_object('action','upsert','operationKey','change-unread','todoKey',v_unread,
		'title','Changed before reading','state','blocked'));
	perform pg_temp.todo('{"action":"upsert","operationKey":"new-between","todoKey":"new-between","title":"Created between pages"}');
	v_rest := pg_temp.walk('todos','{"action":"list"}',v_first ->> 'nextCursor');
	perform pg_temp.wake_assert(pg_temp.same_once(v_page_one || v_rest,v_before) and v_unread = any(v_rest) and not v_read = any(v_rest),
		'After changes between pages, the walk still lists every todo that was open once: the unread change once, the read one not again');
	perform pg_temp.wake_assert(not 'new-between' = any(v_rest) and pg_temp.todo('{"action":"list"}') #>> '{todos,0,todoKey}' = 'new-between',
		'A todo created during a walk starts the next walk');
	-- A todo closed before its page is read leaves the open listing; nothing else moves.
	v_first := pg_temp.todo('{"action":"list"}');
	v_page_one := array(select item ->> 'todoKey' from jsonb_array_elements(v_first -> 'todos') item);
	select todo_key into strict v_unread from public.qorpera_runtime_agent_todos
	where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state = 'open' and todo_key <> all(v_page_one)
	order by created_at, id limit 1;
	perform pg_temp.todo(jsonb_build_object('action','done','operationKey','close-unread','todoKey',v_unread));
	v_rest := pg_temp.walk('todos','{"action":"list"}',v_first ->> 'nextCursor');
	perform pg_temp.wake_assert(pg_temp.same_once(v_page_one || v_rest,array(select todo_key from public.qorpera_runtime_agent_todos
			where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state in ('open','blocked'))) and not v_unread = any(v_rest),
		'A todo closed mid-walk is simply no longer open');
	-- The cursor's own todo closes before the next page: its place still holds.
	v_first := pg_temp.todo('{"action":"list"}');
	v_page_one := array(select item ->> 'todoKey' from jsonb_array_elements(v_first -> 'todos') item);
	perform pg_temp.todo(jsonb_build_object('action','done','operationKey','close-cursor','todoKey',v_page_one[32]));
	v_rest := pg_temp.walk('todos','{"action":"list"}',v_first ->> 'nextCursor');
	perform pg_temp.wake_assert(pg_temp.same_once(v_page_one[1:31] || v_rest,array(select todo_key from public.qorpera_runtime_agent_todos
			where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state in ('open','blocked'))),
		'A cursor whose own todo closed still continues exactly after it');
end $$;

-- 3. Twenty workers on one todo and six elsewhere: status walks all of them, a todoKey walk
-- reaches every worker of the large todo, and the todo listing shows the latest sixteen.
do $$
declare v_index integer; v_keys text[]; v_expected text[]; v_todo jsonb;
begin
	perform pg_temp.todo('{"action":"upsert","operationKey":"big","todoKey":"big","title":"A large piece of work"}');
	for v_index in 1..20 loop
		perform pg_temp.dispatch('big','w-' || lpad(v_index::text,2,'0'),case when v_index % 4 = 0 then 'Supplier audit ' else 'Price check ' end || v_index);
	end loop;
	for v_index in 11..13 loop
		perform pg_temp.dispatch('t-' || v_index,'side-a','Side task A');
		perform pg_temp.dispatch('t-' || v_index,'side-b','Side task B');
	end loop;
	select array_agg(todo.todo_key || '/' || worker.worker_key order by worker.created_at desc, worker.id desc) into v_expected
	from public.qorpera_runtime_workers worker join public.qorpera_runtime_agent_todos todo on todo.id = worker.todo_id
	where worker.staff_agent_id = '30000000-0000-4000-8000-000000000030';
	v_keys := pg_temp.walk('workers','{"action":"status"}');
	perform pg_temp.wake_assert(cardinality(v_expected) = 26 and v_keys = v_expected,'Twenty-six workers: status walks every one once, newest first');
	v_keys := pg_temp.walk('workers','{"action":"status","todoKey":"big"}');
	perform pg_temp.wake_assert(v_keys = array(select 'big/w-' || lpad(n::text,2,'0') from generate_series(20,1,-1) n),
		'A todo with twenty workers: its todoKey walk reaches all of them');
	v_keys := pg_temp.walk('workers','{"action":"status","search":"supplier"}');
	perform pg_temp.wake_assert(v_keys = array['big/w-20','big/w-16','big/w-12','big/w-08','big/w-04'],'search matches worker titles');
	v_keys := pg_temp.walk('workers','{"action":"status","search":"side-b"}');
	perform pg_temp.wake_assert(pg_temp.same_once(v_keys,array['t-11/side-b','t-12/side-b','t-13/side-b']),'search matches worker keys');
	perform pg_temp.worker('{"action":"cancel","operationKey":"cancel-w07","todoKey":"big","workerKey":"w-07"}');
	v_keys := pg_temp.walk('workers','{"action":"status","state":"cancelled"}');
	perform pg_temp.wake_assert(v_keys = array['big/w-07'],'state filters workers');
	v_keys := pg_temp.walk('workers','{"action":"status","state":"active","todoKey":"big"}');
	perform pg_temp.wake_assert(cardinality(v_keys) = 19 and not 'big/w-07' = any(v_keys),'state and todoKey combine');
	v_todo := (select item from jsonb_array_elements(pg_temp.todo('{"action":"list","search":"large piece"}') -> 'todos') item);
	perform pg_temp.wake_assert(v_todo -> 'workers' = '[{"workerKey":"w-17","state":"queued"},{"workerKey":"w-18","state":"queued"},
			{"workerKey":"w-19","state":"queued"},{"workerKey":"w-20","state":"queued"}]'::jsonb and (v_todo ->> 'moreWorkers')::int = 16,
		'A listed todo shows its latest four workers by key and state, in dispatch order, and counts the other sixteen');
	perform pg_temp.wake_assert(not (pg_temp.todo('{"action":"list","search":"t-11"}') #> '{todos,0}') ? 'moreWorkers',
		'A todo with few workers shows them all and no count');
	-- A listed worker shows the start of its summary; named, it is shown in full.
	update public.qorpera_runtime_workers set state = 'succeeded', reported_at = clock_timestamp(),
		result = jsonb_build_object('outcome','succeeded','outputs','[]'::jsonb,'sequence',sequence,'summary',repeat('Found it. ',60))
	where worker_key = 'w-20';
	v_todo := pg_temp.worker('{"action":"status","todoKey":"big","search":"supplier audit 20"}') #> '{workers,0}';
	perform pg_temp.wake_assert(v_todo ->> 'workerKey' = 'w-20' and char_length(v_todo ->> 'summary') = 200 and v_todo ? 'cursor',
		'A listed worker carries the start of its summary and its cursor');
	v_todo := pg_temp.worker('{"action":"status","todoKey":"big","workerKey":"w-20"}') #> '{workers,0}';
	perform pg_temp.wake_assert(char_length(v_todo ->> 'summary') = 600,'A named worker is shown in full');
end $$;

-- 4. A change between pages neither skips nor repeats a worker.
do $$
declare v_first jsonb; v_rest text[]; v_page_one text[];
begin
	v_first := pg_temp.worker('{"action":"status","todoKey":"big"}');
	v_page_one := array(select 'big/' || (item ->> 'workerKey') from jsonb_array_elements(v_first -> 'workers') item);
	perform pg_temp.wake_assert(v_page_one[16] = 'big/w-05' and (v_first ->> 'moreWorkers')::int = 4,'The first page ends at w-05 and counts four more');
	-- After the first page: a read worker and an unread one change state, and a new one is dispatched.
	perform pg_temp.worker('{"action":"cancel","operationKey":"cancel-w15","todoKey":"big","workerKey":"w-15"}');
	perform pg_temp.worker('{"action":"cancel","operationKey":"cancel-w02","todoKey":"big","workerKey":"w-02"}');
	perform pg_temp.dispatch('big','w-21','Price check 21');
	v_rest := pg_temp.walk('workers','{"action":"status","todoKey":"big"}',v_first ->> 'nextCursor');
	perform pg_temp.wake_assert(v_rest = array['big/w-04','big/w-03','big/w-02','big/w-01'],
		'The rest of the walk is exactly the four unread workers: the changed one once, the read one not again, the new one not yet');
	perform pg_temp.wake_assert(pg_temp.worker('{"action":"status","todoKey":"big"}') #>> '{workers,0,workerKey}' = 'w-21',
		'A worker dispatched during a walk starts the next walk');
end $$;

-- 5. The prompt's open-work counts: only open todos, and workers of open todos.
do $$
declare v_counts jsonb := public.qorpera_describe_agent_open_work(current_setting('qorpera_test.parent_binding')::jsonb);
begin
	perform pg_temp.wake_assert(v_counts ->> 'schema' = 'qorpera.agent-open-work/v1'
		and v_counts ->> 'runId' = current_setting('qorpera_test.parent_binding')::jsonb ->> 'runId'
		and v_counts -> 'todos' = jsonb_build_object(
			'open',(select count(*) from public.qorpera_runtime_agent_todos where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state = 'open'),
			'blocked',(select count(*) from public.qorpera_runtime_agent_todos where staff_agent_id = '30000000-0000-4000-8000-000000000030' and state = 'blocked'))
		and v_counts -> 'workers' = '{"active":23,"blocked":0}'::jsonb,'Open work is counted, not listed');
	-- A blocked worker counts while its todo is open, not after the todo closes.
	begin
		update public.qorpera_runtime_workers set state = 'blocked', reported_at = clock_timestamp(),
			result = jsonb_build_object('outcome','blocked','outputs','[]'::jsonb,'sequence',sequence,'summary','Need a list.','needs','A list.')
		where worker_key = 'side-a';
		perform pg_temp.wake_assert(public.qorpera_describe_agent_open_work(current_setting('qorpera_test.parent_binding')::jsonb) -> 'workers'
			= '{"active":20,"blocked":3}'::jsonb,'Blocked workers are counted');
		update public.qorpera_runtime_agent_todos set state = 'done' where todo_key = 't-11';
		perform pg_temp.wake_assert(public.qorpera_describe_agent_open_work(current_setting('qorpera_test.parent_binding')::jsonb) -> 'workers'
			= '{"active":19,"blocked":2}'::jsonb,'Workers of a closed todo are not open work');
		raise exception 'rollback-open-work-probe';
	exception when raise_exception then
		if sqlerrm <> 'rollback-open-work-probe' then raise; end if;
	end;
end $$;

-- 6. Invalid requests and foreign cursors are refused.
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","cursor":"not-a-cursor"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","cursor":"00000000-0000-4000-8000-00000000abcd"}')$q$,'22023','Todo cursor is unavailable; list again without it');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","state":"closed"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","state":["open"]}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","search":""}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","search":"a\nb"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","todoKey":"Bad Key"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.todo('{"action":"list","workerKey":"w-01"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"status","state":"running"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"status","workerKey":"w-01"}')$q$,'22023');
select pg_temp.wake_error($q$select pg_temp.worker('{"action":"status","cursor":42}')$q$,'22023');
-- A worker's id is not a todo cursor, and a todo's id is not a worker cursor.
select pg_temp.wake_error(format($q$select pg_temp.todo('{"action":"list","cursor":"%s"}')$q$,
	(select id from public.qorpera_runtime_workers where worker_key = 'w-01')),'22023','Todo cursor is unavailable; list again without it');
select pg_temp.wake_error(format($q$select pg_temp.worker('{"action":"status","cursor":"%s"}')$q$,
	(select id from public.qorpera_runtime_agent_todos where todo_key = 'big')),'22023','Worker cursor is unavailable; ask for status again without it');
-- Another agent's todo is not a cursor into this agent's list.
do $$
declare v_other uuid;
begin
	insert into public.qorpera_runtime_agent_todos(profile_id,environment_id,staff_agent_id,todo_key,title,requested_by_user_id,
		created_by_run_id,updated_by_run_id)
	select profile_id,environment_id,'30000000-0000-4000-8000-000000000031','other','Another agent''s todo',requested_by_user_id,
		created_by_run_id,updated_by_run_id from public.qorpera_runtime_agent_todos where todo_key = 'big'
	returning id into v_other;
	perform pg_temp.wake_error(format($q$select pg_temp.todo('{"action":"list","cursor":"%s"}')$q$,v_other),'22023',
		'Todo cursor is unavailable; list again without it');
	perform pg_temp.wake_assert(not exists (select 1 from jsonb_array_elements(pg_temp.todo('{"action":"list","includeClosed":true,"search":"other"}') -> 'todos') item
		where item ->> 'todoKey' = 'other'),'Another agent''s todo is never listed');
end $$;

-- 7. Control-plane only.
select pg_temp.path_claims('authenticated');
select pg_temp.wake_error($q$select public.qorpera_describe_agent_open_work(current_setting('qorpera_test.parent_binding')::jsonb)$q$,'42501');
select pg_temp.wake_assert(
	not has_function_privilege('anon','public.qorpera_describe_agent_open_work(jsonb)','execute')
	and not has_function_privilege('authenticated','public.qorpera_describe_agent_open_work(jsonb)','execute')
	and not has_function_privilege('qorpera_secret_broker','public.qorpera_describe_agent_open_work(jsonb)','execute')
	and has_function_privilege('service_role','public.qorpera_describe_agent_open_work(jsonb)','execute')
	and not exists (select 1 from unnest(array['anon','authenticated','service_role','qorpera_secret_broker']) role
		cross join unnest(array['public.qorpera_agent_todo_page(public.qorpera_execution_runs,jsonb)',
			'public.qorpera_agent_worker_page(public.qorpera_execution_runs,jsonb)',
			'public.qorpera_agent_todo_listing(public.qorpera_runtime_agent_todos,boolean)',
			'public.qorpera_agent_worker_listing(public.qorpera_runtime_workers,text,boolean)']) helper
		where has_function_privilege(role,helper,'execute')),
	'The open-work count is for the runtime only, and the page helpers for no API role');
select pg_temp.path_claims('service_role');
rollback;
