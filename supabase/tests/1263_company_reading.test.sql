-- @fixture 596_runtime_agent_thread_cards.test.sql until "-- Only the member the card was raised for answers it"
-- 20260930765000: the company's reading of itself. 596's fixture on the folder runtime base: Owner (…001), Member (…002),
-- Viewer (…003), Admin (…004), the outsider (…005); agents Alice (…030), Bob (…031), Carol (…032) and the seeded
-- Co-Founder (…033); Alice's run holds the base binding; in Bob's thread a question card (9a1) raised for the owner waits,
-- its run ended. Here Alice is made the company's Co-Founder, so her run reads the senses. Covered:
-- 1. The privileges: the senses are a host call of the platform only; the standing is a member's read.
-- 2. The standing of a company with nothing waiting: it runs.
-- 3. The kind: QorperaOS/vision/reading.md is stored with its checked parse, a parse of the wrong shape is refused, and
--    an in-house run's save is plain, a move of attention included.
-- 4. The senses of a small company: a blocked todo, a paused routine, an active one with a wake waiting, an unanswered
--    and an answered card, a hire since the reading; the members' logins; at most 8,192 bytes, cut in order
--    (cards, ended, hired, then agents, never the Co-Founder's), with churn at its bounds.
-- 5. A run that is not the Co-Founder's is refused the senses.
-- 6. The standing's states: a wake waiting under 30 minutes; stopped with every login ready; a busy company (another
--    routine wake got a run 10 minutes ago) not stopped; Brooks (wakes queued for days, a member's turn an hour ago)
--    stopped; stopped on a full login; a non-member and anon are refused.
-- 7. A member deletes the reading: the senses say there is none.

create function pg_temp.rd_standing(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	v := public.qorpera_read_company_standing('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.company-standing/v1', 'the standing''s shape: ' || v::text);
	return v;
end $$;
create function pg_temp.rd_senses() returns jsonb language sql as $$
	select public.qorpera_describe_company_senses(current_setting('qorpera_test.base_binding')::jsonb)
$$;
create function pg_temp.rd_agent(p_senses jsonb, p_handle text) returns jsonb language sql as $$
	select agent from jsonb_array_elements(p_senses -> 'agents') as agent where agent ->> 'handle' = p_handle
$$;
-- A reading's parse as the TS parser returns it; p_extra overrides keys.
create function pg_temp.rd_parse(p_attention text, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind', 'reading', 'sentence', 'We are finding our first ten clinics.', 'line', null,
		'attention', p_attention,
		'things', jsonb_build_array(
			jsonb_build_object('key', 'sales', 'name', 'Sales', 'shape', 'handshake', 'full', 20, 'state', 'Three demos booked',
				'agents', '["bob"]'::jsonb, 'waitsFor', '[]'::jsonb),
			jsonb_build_object('key', 'product', 'name', 'Product', 'shape', 'screen', 'full', 70, 'state', 'Booking works',
				'agents', '["carol"]'::jsonb, 'waitsFor', '["founders"]'::jsonb),
			jsonb_build_object('key', 'money', 'name', 'Money', 'shape', 'coin', 'full', 0, 'state', 'No price yet',
				'agents', '[]'::jsonb, 'waitsFor', '["92400000-0000-4000-8000-000000000001"]'::jsonb)),
		'changes', '[{"agent":"bob","what":"joined","line":"Sales joined to find the first clinics."}]'::jsonb,
		'notes', '["We do not know what a clinic pays."]'::jsonb) || p_extra
$$;
create function pg_temp.rd_write(p_attention text, p_extra jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.base_write('QorperaOS/vision/reading.md', 'reading',
		E'---\nattention: ' || p_attention || E'\n---\n# We are finding our first ten clinics.\n\n' || md5(p_extra::text) || E'\n',
		pg_temp.rd_parse(p_attention, p_extra), pg_temp.base_version('QorperaOS/vision/reading.md'))
$$;
-- A refused save: the platform's commit, whose one unit must be refused for its parse.
create function pg_temp.rd_refused(p_unit jsonb, p_what text) returns void language plpgsql as $$
declare v jsonb := public.qorpera_folder_commit('92400000-0000-4000-8000-000000000020', '{"kind":"platform"}',
	'rd-refused:' || extensions.gen_random_uuid(), jsonb_build_array(p_unit));
begin
	perform pg_temp.base_assert(v #>> '{units,0,outcome}' = 'refused' and v #>> '{units,0,reason}' = 'structured_invalid',
		p_what || ' is refused: ' || v::text);
end $$;
-- A routine's parse as the TS parser returns it (as 377 makes it), every hour.
create function pg_temp.rd_routine(p_id uuid, p_status text) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'routine', 'id', p_id, 'title', 'Watch', 'status', p_status,
		'trigger', jsonb_build_object('when', 'every', 'minutes', 60, 'starts', null), 'timezone', null, 'ends', null,
		'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'optional', 'conclusion', null,
		'instructions', 'Watch the orders.')
$$;

-- Alice is the Co-Founder (foreign keys and triggers off only while the row changes), as 1192 makes her.
set local session_replication_role = replica;
delete from public.qorpera_company_cofounders where profile_id = '92400000-0000-4000-8000-000000000010';
insert into public.qorpera_company_cofounders(profile_id, environment_id, staff_agent_id, created_by_user_id, created_at)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000001', statement_timestamp());
set local session_replication_role = origin;

-- 1. The privileges.
do $$
begin
	perform pg_temp.base_assert(public.qorpera_structured_path_kind('qorperaos/vision/reading.md') = 'reading'
		and public.qorpera_structured_path_kind('vision/reading.md') is null, 'reading.md under QorperaOS/vision is the kind');
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_describe_company_senses(jsonb)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_describe_company_senses(jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_describe_company_senses(jsonb)', 'EXECUTE'),
		'the senses are the platform''s');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_native_host_calls
		where name = 'qorpera_describe_company_senses' and scope = 'binding'), 'the senses are a host call of a run');
	perform pg_temp.base_assert(has_function_privilege('authenticated', 'public.qorpera_read_company_standing(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_read_company_standing(uuid)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_read_company_standing(uuid)', 'EXECUTE'),
		'the standing is a member''s read');
	perform pg_temp.base_assert((select bool_and(prosecdef and proconfig = array['search_path=""'] and prosrc like '%20260930765000%')
		from pg_proc where oid in ('public.qorpera_describe_company_senses(jsonb)'::regprocedure,
			'public.qorpera_read_company_standing(uuid)'::regprocedure)), 'definer reads with the marker');
end $$;

-- 2. Nothing waits: the company runs.
do $$
declare v jsonb := pg_temp.rd_standing('92400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.base_assert(v -> 'stopped' = 'false' and v -> 'waiting' = '0' and v -> 'since' = 'null'
		and v -> 'why' = 'null' and v -> 'member' = 'null' and v -> 'resetsAt' = 'null', 'a running company: ' || v::text);
end $$;

-- 3. The kind.
do $$
declare v_version uuid; v_parse jsonb := pg_temp.rd_parse('sales');
begin
	perform pg_temp.rd_refused(pg_temp.rd_write('sales', jsonb_build_object('things', (v_parse -> 'things') - 2)), 'two things');
	perform pg_temp.rd_refused(pg_temp.rd_write('sales', jsonb_build_object('things',
		jsonb_set(v_parse -> 'things', '{0,shape}', '"star"'))), 'a shape off the list');
	perform pg_temp.rd_refused(pg_temp.rd_write('nobody'), 'attention naming no thing');
	perform pg_temp.rd_refused(pg_temp.rd_write('sales', jsonb_build_object('things',
		jsonb_set(v_parse -> 'things', '{1,key}', '"sales"'))), 'a key twice');
	perform pg_temp.rd_refused(pg_temp.rd_write('sales', jsonb_build_object('things',
		jsonb_set(v_parse -> 'things', '{2,waitsFor}', '["founders","92400000-0000-4000-8000-000000000001"]'))),
		'founders beside a member');
	perform pg_temp.rd_refused(pg_temp.rd_write('sales', '{"notes":["1","2","3","4","5","6"]}'), 'six notes');
	perform pg_temp.rd_refused(pg_temp.rd_write('sales', '{"mood":"good"}'), 'a key of no reading');
	-- The owner saves it: stored with its checked parse.
	perform pg_temp.base_commit(pg_temp.base_owner(), 'rd-save-1', jsonb_build_array(pg_temp.rd_write('sales')));
	v_version := pg_temp.base_version('QorperaOS/vision/reading.md');
	perform pg_temp.base_assert((select v.structured ->> 'kind' = 'reading' and v.structured -> 'parse' = v_parse
		from public.qorpera_folder_path_versions as v where v.version = v_version), 'the reading keeps its checked parse');
	-- An in-house run's save is plain, a move of attention too: the company's bookkeeping.
	perform pg_temp.base_assert(public.qorpera_folder_structured_review_class('92400000-0000-4000-8000-000000000020',
		'{"kind":"run","sessionKind":"in_house"}', pg_temp.rd_write('money'), 'QorperaOS/vision/reading.md', null) = 'plain',
		'a run''s save of the reading is plain');
end $$;

-- 4. The senses of a small company. The fixture's agents were hired two hours ago and the reading saved an hour ago, so
-- a hire now is a hire since the reading.
set local session_replication_role = replica;
update public.qorpera_profile_staff set created_at = created_at - interval '2 hours'
where profile_id = '92400000-0000-4000-8000-000000000010';
update public.qorpera_folder_path_versions set created_at = created_at - interval '1 hour'
where version = pg_temp.base_version('QorperaOS/vision/reading.md');
set local session_replication_role = origin;
do $$
declare v_cursor public.qorpera_cloud_routine_schedule_cursors; v_ran timestamptz := statement_timestamp() - interval '1 hour';
	v jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'rd-team-1', jsonb_build_array(
		pg_temp.base_hire('dora', '12630000-0000-4000-8000-000000000035', 'Dora'),
		-- Bob: a blocked todo and a paused routine.
		pg_temp.base_write('QorperaOS/agents/bob/todos/price-list.md', 'todo', E'---\nprice list\n---\n',
			'{"kind":"todo","id":"12630000-0000-4000-8000-0000000000b1","title":"Draft the price list","status":"blocked","requestedBy":null,"detail":""}'),
		pg_temp.base_write('QorperaOS/agents/bob/routines/digest.md', 'routine', E'---\ndigest\n---\n',
			pg_temp.rd_routine('12630000-0000-4000-8000-0000000000a1', 'paused')),
		-- Carol: an active routine.
		pg_temp.base_write('QorperaOS/agents/carol/routines/watch.md', 'routine', E'---\nwatch\n---\n',
			pg_temp.rd_routine('12630000-0000-4000-8000-0000000000a2', 'active'))));
	-- Carol's routine's slot an hour ago, queued and not yet a run.
	select c.* into strict v_cursor from public.qorpera_cloud_routine_schedule_cursors as c
	join public.qorpera_cloud_routines as r on r.id = c.routine_id and r.current_version = c.routine_version
	where r.id = '12630000-0000-4000-8000-0000000000a2' and c.trigger_id = 'file';
	v := public.qorpera_enqueue_routine_wake(v_cursor.routine_id, v_cursor.routine_version, '12630000-0000-4000-8000-0000000000c1',
		'reading-watch-1', 'file', v_ran, v_cursor.last_scheduled_for, v_ran + interval '1 hour', '{}');
	perform pg_temp.base_assert(v ->> 'status' = 'queued', 'fixture: Carol''s slot waits: ' || v::text);
	-- The owner answers Bob's card (9a1); Alice's run raises a card the owner has not answered.
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.cd_answer(extensions.gen_random_uuid(), '59600000-0000-4000-8000-0000000009a1', 'answered', '{"values":["finance"]}');
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_append_native_interaction_request((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid, (b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid,
		(b ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', '12630000-0000-4000-8000-0000000009c1',
		'{"schema":"qorpera.interaction/v1","surface":"question","title":"Which clinics first?","payload":{"options":[{"label":"Small"},{"label":"Large"}]}}')
	from (select current_setting('qorpera_test.base_binding')::jsonb as b) as binding;
end $$;
do $$
declare v jsonb := pg_temp.rd_senses(); v_bob jsonb := pg_temp.rd_agent(v, 'bob'); v_carol jsonb := pg_temp.rd_agent(v, 'carol');
	v_alice jsonb := pg_temp.rd_agent(v, 'alice'); v_owner jsonb;
begin
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.company-senses/v1' and v ->> 'runId' = current_setting('qorpera_test.base_binding')::jsonb ->> 'runId'
		and v -> 'agentsTruncated' = 'false' and v -> 'membersTruncated' = 'false', 'the senses'' shape: ' || v::text);
	perform pg_temp.base_assert(octet_length(v::text) <= 8192, 'the senses are at most 8,192 bytes: ' || octet_length(v::text));
	-- The agents, the Co-Founder first.
	perform pg_temp.base_assert(v #>> '{agents,0,handle}' = 'alice' and v #> '{agents,0,cofounder}' = 'true'
		and jsonb_array_length(v -> 'agents') = 5 and v_alice ->> 'id' = '92400000-0000-4000-8000-000000000030'
		and v_alice ->> 'name' = 'Alice' and (v_alice ->> 'runsLast7d')::integer >= 1 and v_alice ->> 'lastRunAt' is not null
		and v_alice ->> 'hiredAt' is not null, 'the agents, the Co-Founder first: ' || (v -> 'agents')::text);
	perform pg_temp.base_assert(v_bob -> 'todos' = '{"open":0,"blocked":1,"doneLast7d":0}'
		and v_bob #> '{routines,paused}' = '1' and v_bob #> '{routines,active}' = '0'
		and jsonb_array_length(v_bob #> '{routines,pausedWhy}') = 1 and v_bob #> '{routines,nextAt}' = 'null',
		'Bob''s blocked todo and paused routine: ' || v_bob::text);
	perform pg_temp.base_assert(v_carol #> '{routines,active}' = '1' and v_carol #> '{routines,paused}' = '0'
		and v_carol #> '{routines,concluded}' = '0' and v_carol -> 'waitingWakes' = '1'
		and v_carol ->> 'oldestWaitingWakeAt' is not null and v_carol -> 'todos' = '{"open":0,"blocked":0,"doneLast7d":0}',
		'Carol''s routine and its waiting wake: ' || v_carol::text);
	-- The team: Dora, hired since the reading; nobody's role ended.
	perform pg_temp.base_assert(v #> '{team,hired}' = jsonb_build_array(jsonb_build_object('name', 'Dora', 'handle', 'dora',
			'at', (select created_at from public.qorpera_profile_staff where staff_agent_id = '12630000-0000-4000-8000-000000000035')))
		and v #> '{team,ended}' = '[]' and v #> '{team,truncated}' = 'false'
		and (v #>> '{team,since}')::timestamptz = (v #>> '{reading,savedAt}')::timestamptz,
		'the hire since the reading: ' || (v -> 'team')::text);
	-- The questions: Alice's card waits for the owner; Bob's was answered.
	perform pg_temp.base_assert(v #> '{questions,count}' = '1' and v #>> '{questions,oldest,0,agent}' = 'alice'
		and v #>> '{questions,oldest,0,member}' = '92400000-0000-4000-8000-000000000001'
		and v #>> '{questions,oldest,0,askedAt}' is not null, 'the unanswered card: ' || (v -> 'questions')::text);
	-- The members and their logins.
	select m into v_owner from jsonb_array_elements(v -> 'members') m where m ->> 'userId' = '92400000-0000-4000-8000-000000000001';
	perform pg_temp.base_assert(jsonb_array_length(v -> 'members') = 4 and v_owner #>> '{login,state}' = 'ready'
		and v_owner ->> 'role' = 'owner' and not (v_owner -> 'login') ? 'user_id'
		and (select m #>> '{login,state}' from jsonb_array_elements(v -> 'members') m
			where m ->> 'userId' = '92400000-0000-4000-8000-000000000003') = 'none', 'the members'' logins: ' || (v -> 'members')::text);
	perform pg_temp.base_assert(v #>> '{reading,attention}' = 'sales' and v #>> '{reading,savedAt}' is not null,
		'the reading: ' || coalesce((v -> 'reading')::text, 'none'));
end $$;
-- A larger team with long names: the answer is at most 8,192 bytes. The card and the hires go before any agent, and
-- the agents last in its order go before the Co-Founder's.
savepoint rd_many;
do $$
declare v jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'rd-many-1', (select jsonb_agg(pg_temp.base_hire('long-' || n,
		('12630000-0000-4000-8000-' || lpad(to_hex(256 + n), 12, '0'))::uuid, rpad('Agent ' || n || ' ', 150, 'x')))
		from generate_series(1, 14) as n));
	v := pg_temp.rd_senses();
	perform pg_temp.base_assert(octet_length(v::text) <= 8192 and v -> 'agentsTruncated' = 'true'
		and jsonb_array_length(v -> 'agents') between 5 and 18 and v #>> '{agents,0,handle}' = 'alice'
		and v #> '{questions,oldest}' = '[]' and v #> '{questions,truncated}' = 'true' and v #> '{questions,count}' = '1'
		and v #> '{team,hired}' = '[]' and v #> '{team,truncated}' = 'true' and jsonb_array_length(v -> 'members') = 4,
		'a larger team is cut to 8 KiB, the agents last: ' || octet_length(v::text) || ' bytes, '
			|| jsonb_array_length(v -> 'agents') || ' agents: ' || v::text);
end $$;
rollback to savepoint rd_many;
-- Churn at its bounds: twenty members, ten unanswered cards, twenty hires with long names that are not ASCII and ten of
-- them ended since the reading. The answer is at most 8,192 bytes and still holds the Co-Founder's row.
savepoint rd_churn;
insert into auth.users(id, email)
select ('12630000-0000-4000-8000-' || lpad(to_hex(512 + n), 12, '0'))::uuid, 'reading-member-' || n || '@example.test'
from generate_series(1, 16) as n;
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
select '92400000-0000-4000-8000-000000000010', ('12630000-0000-4000-8000-' || lpad(to_hex(512 + n), 12, '0'))::uuid,
	'reading-member-' || n || '@example.test', 'Medlem ' || n, 'contributor'
from generate_series(1, 16) as n;
do $$
declare b jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_card integer;
begin
	for v_card in 1..9 loop
		perform public.qorpera_append_native_interaction_request((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid,
			(b ->> 'jobId')::uuid, (b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid,
			(b ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', ('12630000-0000-4000-8000-0000000009d' || v_card)::uuid,
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'question', 'title', 'Question ' || v_card,
				'payload', '{"options":[{"label":"Yes"},{"label":"No"}]}'::jsonb));
	end loop;
	perform pg_temp.base_commit(pg_temp.base_owner(), 'rd-churn-1', (select jsonb_agg(pg_temp.base_hire('churn-' || n,
		('12630000-0000-4000-8000-' || lpad(to_hex(768 + n), 12, '0'))::uuid, rpad('Ærøskøbing ' || n || ' ', 150, 'ø')))
		from generate_series(1, 20) as n));
end $$;
set local session_replication_role = replica;
update public.qorpera_profile_staff set employment_status = 'archived', updated_at = clock_timestamp()
where profile_id = '92400000-0000-4000-8000-000000000010'
	and staff_agent_id in (select ('12630000-0000-4000-8000-' || lpad(to_hex(768 + n), 12, '0'))::uuid from generate_series(1, 10) as n);
set local session_replication_role = origin;
do $$
declare v jsonb := pg_temp.rd_senses();
begin
	perform pg_temp.base_assert(octet_length(v::text) <= 8192 and v #>> '{agents,0,handle}' = 'alice'
		and v #> '{agents,0,cofounder}' = 'true' and jsonb_array_length(v -> 'members') = 20
		and v -> 'membersTruncated' = 'false' and v #> '{questions,count}' = '10' and v #> '{questions,truncated}' = 'true'
		and v #> '{team,truncated}' = 'true' and v -> 'agentsTruncated' = 'true'
		and not exists (select 1 from jsonb_array_elements(coalesce(v #> '{team,hired}', '[]') || coalesce(v #> '{team,ended}', '[]')) e
			where char_length(e ->> 'name') > 60),
		'churn at its bounds stays within 8,192 bytes with the Co-Founder''s row: ' || octet_length(v::text) || ' bytes: '
			|| v::text);
end $$;
rollback to savepoint rd_churn;

-- 5. Only the Co-Founder's run reads the senses.
set local session_replication_role = replica;
update public.qorpera_company_cofounders set staff_agent_id = '92400000-0000-4000-8000-000000000031'
where profile_id = '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;
select pg_temp.base_error('select pg_temp.rd_senses()', '42501', 'Only the Co-Founder''s company run reads the company''s senses');
set local session_replication_role = replica;
update public.qorpera_company_cofounders set staff_agent_id = '92400000-0000-4000-8000-000000000030'
where profile_id = '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;

-- 6. The standing. Carol's slot was queued just now: it waits, under 30 minutes.
do $$
declare v jsonb := pg_temp.rd_standing('92400000-0000-4000-8000-000000000002');
begin
	perform pg_temp.base_assert(v -> 'stopped' = 'false' and v -> 'waiting' = '1' and v ->> 'since' is not null
		and v -> 'why' = 'null', 'a wake under 30 minutes: ' || v::text);
end $$;
-- It has waited 40 minutes, and no routine wake was given a run since (none ever was; the company's runs are older).
set local session_replication_role = replica;
update public.qorpera_wake_occurrences set created_at = statement_timestamp() - interval '40 minutes',
	not_before = statement_timestamp() - interval '40 minutes'
where id = '12630000-0000-4000-8000-0000000000c1';
update public.qorpera_execution_runs set created_at = created_at - interval '2 hours'
where profile_id = '92400000-0000-4000-8000-000000000010';
set local session_replication_role = origin;
do $$
declare v jsonb := pg_temp.rd_standing('92400000-0000-4000-8000-000000000003');
begin
	perform pg_temp.base_assert(v -> 'stopped' = 'true' and v -> 'waiting' = '1'
		and abs(extract(epoch from (v ->> 'since')::timestamptz - (statement_timestamp() - interval '40 minutes'))) < 5
		and v -> 'why' = 'null' and v -> 'member' = 'null' and v -> 'resetsAt' = 'null',
		'stopped with every login ready (a viewer reads it too): ' || v::text);
end $$;
-- A busy company: Carol's slot has waited 40 minutes, but another routine wake was given a run 10 minutes ago (Bob's
-- run of the card, made a routine wake of his routine here), so the routines run.
savepoint rd_busy;
set local session_replication_role = replica;
update public.qorpera_wake_occurrences set wake_kind = 'routine', source_kind = 'schedule',
	routine_id = '12630000-0000-4000-8000-0000000000a1',
	routine_version = (select current_version from public.qorpera_cloud_routines where id = '12630000-0000-4000-8000-0000000000a1')
where run_id = current_setting('qorpera_test.card_run')::uuid;
update public.qorpera_execution_runs set created_at = statement_timestamp() - interval '10 minutes'
where id = current_setting('qorpera_test.card_run')::uuid;
set local session_replication_role = origin;
do $$
declare v jsonb := pg_temp.rd_standing('92400000-0000-4000-8000-000000000002');
begin
	perform pg_temp.base_assert((select count(*) from public.qorpera_wake_occurrences
		where run_id = current_setting('qorpera_test.card_run')::uuid and wake_kind = 'routine') = 1, 'fixture: a routine wake''s run');
	perform pg_temp.base_assert(v -> 'stopped' = 'false' and v -> 'waiting' = '1'
		and abs(extract(epoch from (v ->> 'since')::timestamptz - (statement_timestamp() - interval '40 minutes'))) < 5,
		'a routine run 10 minutes ago: the routines run: ' || v::text);
end $$;
rollback to savepoint rd_busy;
-- Brooks (production, 14 November 2026): routine wakes queued for days while members' own turns started runs. Carol's
-- slot has waited three days; Alice's run, a member's post, started an hour ago: the routines stand still all the same.
set local session_replication_role = replica;
update public.qorpera_wake_occurrences set created_at = statement_timestamp() - interval '3 days',
	not_before = statement_timestamp() - interval '3 days'
where id = '12630000-0000-4000-8000-0000000000c1';
update public.qorpera_execution_runs set created_at = statement_timestamp() - interval '1 hour'
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
set local session_replication_role = origin;
do $$
declare v jsonb := pg_temp.rd_standing('92400000-0000-4000-8000-000000000001');
begin
	perform pg_temp.base_assert(v -> 'stopped' = 'true' and v -> 'waiting' = '1'
		and abs(extract(epoch from (v ->> 'since')::timestamptz - (statement_timestamp() - interval '3 days'))) < 5,
		'a member''s turn an hour ago does not make the routines run: ' || v::text);
end $$;
-- The owner's login, which pays Carol's routine (its saver), is at its limit until two days from now.
insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
select version.connection_id, version.version, jsonb_build_object('observedAt', statement_timestamp() - interval '1 minute',
	'windows', jsonb_build_array(jsonb_build_object('id', 'primary', 'label', 'Week', 'usedPercent', 100,
		'resetAt', to_char((statement_timestamp() + interval '2 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))
from public.qorpera_provider_connection_versions as version
where version.connection_id = (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
do $$
declare v jsonb := pg_temp.rd_standing('92400000-0000-4000-8000-000000000002');
begin
	perform pg_temp.base_assert(public.qorpera_works_for_login_state('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001') ->> 'state' = 'full', 'fixture: the owner''s login is full');
	perform pg_temp.base_assert(v -> 'stopped' = 'true' and v ->> 'why' = 'login_full'
		and v ->> 'member' = '92400000-0000-4000-8000-000000000001'
		and abs(extract(epoch from (v ->> 'resetsAt')::timestamptz - (statement_timestamp() + interval '2 days'))) < 120,
		'stopped on the owner''s full login: ' || v::text);
end $$;
-- Someone who is no member, and anon, are refused.
do $$
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error($q$select public.qorpera_read_company_standing('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Standing unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error($q$select public.qorpera_read_company_standing('92400000-0000-4000-8000-000000000010')$q$,
		'42501', 'Standing unavailable');
	perform pg_temp.base_claims('anon');
	set local role anon;
	perform pg_temp.base_error($q$select public.qorpera_read_company_standing('92400000-0000-4000-8000-000000000010')$q$,
		'42501');
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

-- 7. A member deletes the reading: it was never seeded, and the senses then have none.
do $$
declare v jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'rd-delete', jsonb_build_array(jsonb_build_object('op', 'delete',
		'path', 'QorperaOS/vision/reading.md', 'expectedVersion', pg_temp.base_version('QorperaOS/vision/reading.md'))));
	v := pg_temp.rd_senses();
	perform pg_temp.base_assert(v -> 'reading' = 'null'
		and abs(extract(epoch from (v #>> '{team,since}')::timestamptz - (statement_timestamp() - interval '14 days'))) < 5,
		'without a reading the team looks back 14 days: ' || v::text);
end $$;

-- The fixture's rows go with the test.
rollback;
