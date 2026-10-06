-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete, written by the member."
-- Company state files, F2-5b-2 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (F2-5b)"): a worker's brief and
-- results as files on the folder core. Only the worker tools write them, through qorpera_folder_worker_commit, as the run
-- with the tool's request carried in; the worker row is their index; todos with workers keep their files and folders
-- together; rank-5 locks on todos and workers. Runs are 647's with their native rows, reviews 769's recorder. Races are
-- in 841.

create function pg_temp.f2_entry(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_parse ->> 'kind', 'text', p_parse::text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.f2_version(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_path
		and kind is distinct from 'claim'
$$;
-- A structured file's write, staged by the actor that commits it.
create function pg_temp.f2_write(p_actor jsonb, p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_parse::text, p_actor),
		'structured', jsonb_build_array(pg_temp.f2_entry(p_path, p_parse)))
		|| case when pg_temp.f2_version(p_path) is not null then jsonb_build_object('expectedVersion', pg_temp.f2_version(p_path))
			else '{}'::jsonb end
$$;
create function pg_temp.f2_hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(jsonb_build_object('kind','agent','id',p_id,'name',p_name,
				'role','Sales','agentKind',p_kind,'status','active','colour',null,'figure',null,'model',null,'effort',null,
				'instructions','Sell.')::text)),
			jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.f2_entry('agents/' || p_handle || '/agent.md', jsonb_build_object('kind','agent','id',p_id,
			'name',p_name,'role','Sales','agentKind',p_kind,'status','active','colour',null,'figure',null,'model',null,'effort',null,
			'instructions','Sell.'))))
$$;
create function pg_temp.f2_todo(p_actor jsonb, p_path text, p_title text, p_status text default 'open') returns jsonb language sql as $$
	select pg_temp.f2_write(p_actor, p_path, jsonb_build_object('kind','todo','id',
		coalesce((select id from public.qorpera_runtime_agent_todos where folder_path = p_path and folder_retired_at is null),
			md5(p_path)::uuid),
		'title',p_title,'status',p_status,'requestedBy',null,'detail',''))
$$;
-- A brief as the parser gives it, with the platform's standing texts unless told otherwise.
create function pg_temp.brief(p_id uuid, p_title text default 'Compare suppliers', p_access text default 'write',
	p_revival text default 'each', p_follow_ups integer default 0, p_follow_up text default null, p_sources jsonb default '[]',
	p_species text default 'in-house', p_at timestamptz default clock_timestamp()) returns jsonb language sql as $$
	select jsonb_build_object('kind','worker-brief','id',p_id,'title',p_title,'species',p_species,'access',p_access,'revival',p_revival,
		'dispatchedAt',to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'followUps',p_follow_ups,
		'followedUpAt',case when p_follow_ups > 0 then to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
		'goal','Find three suppliers.','doneWhen','Three suppliers with prices.','context',null,'sources',p_sources,'followUp',p_follow_up)
		|| public.qorpera_company_state_worker_standing(p_species, p_access, p_revival)
$$;
create function pg_temp.results(p_outcome text default 'succeeded', p_files jsonb default '[]', p_decision text default null,
	p_note text default null, p_summary text default 'Done.') returns jsonb language sql as $$
	select jsonb_build_object('kind','worker-results','outcome',p_outcome,
		'reportedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'decision',p_decision,'note',p_note,
		'summary',p_summary,'needs',case when p_outcome = 'blocked' then 'A login.' end,'files',p_files)
$$;
-- The request manage_worker sends for a dispatch of this brief.
create function pg_temp.dispatch_request(p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select jsonb_build_object('action','dispatch','folder',p_folder,'title',p_brief ->> 'title','goal',p_brief ->> 'goal',
		'doneWhen',p_brief ->> 'doneWhen','context',p_brief -> 'context','sources',p_brief -> 'sources','access',p_brief ->> 'access',
		'revival',p_brief ->> 'revival')
$$;
-- A dispatch's units: the todo's folder when missing, then the worker's folder with its brief.
create function pg_temp.dispatch_units(p_actor jsonb, p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select case when pg_temp.f2_version(regexp_replace(p_folder, '/[^/]+$', '')) is null
			then jsonb_build_array(jsonb_build_object('op','mkdir','path',regexp_replace(p_folder, '/[^/]+$', ''))) else '[]'::jsonb end
		|| jsonb_build_array(jsonb_build_object('op','new_folder','path',p_folder,
			'contents', jsonb_build_array(jsonb_build_object('path','brief.md','kind','file','file',pg_temp.stage(p_brief::text, p_actor))),
			'structured', jsonb_build_array(pg_temp.f2_entry(p_folder || '/brief.md', p_brief))))
$$;
create function pg_temp.wc(p_actor jsonb, p_key text, p_units jsonb, p_request jsonb, p_review uuid default null) returns jsonb
language sql as $$
	select public.qorpera_folder_worker_commit('63400000-0000-4000-8000-000000000020', p_actor, p_key, p_units, p_request, p_review)
$$;
-- A reviewed manage_worker call: the run's own allow of this call, recorded for exactly these units.
create function pg_temp.reviewed(p_run jsonb, p_call text, p_units jsonb) returns uuid language sql as $$
	select (pg_temp.record(p_run -> 'binding', pg_temp.action(p_run -> 'binding', p_call, 'allow', 'delegation', 'manage_worker'),
		p_units) ->> 'reviewId')::uuid
$$;
create function pg_temp.problem(p_result jsonb, p_unit integer) returns text language sql as $$
	select p_result -> 'units' -> (p_unit - 1) -> 'problems' -> 0 ->> 'message'
$$;
create function pg_temp.refused(p_result jsonb, p_unit integer, p_text text) returns void language plpgsql as $$
begin
	perform pg_temp.expect(p_result, p_unit, 'refused', 'structured_rule');
	if position(p_text in coalesce(pg_temp.problem(p_result, p_unit), '')) = 0 then
		raise exception 'Unit % expected a refusal with "%", got %', p_unit, p_text, p_result using errcode = 'QTF01'; end if;
end $$;
create function pg_temp.worker_row(p_folder text) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where folder_environment_id = '63400000-0000-4000-8000-000000000020'
		and folder_key = p_folder and folder_retired_at is null
$$;
-- A worker's own run, as the drain will start it: a wake of the worker for the parent run, and the row's occurrence.
create function pg_temp.worker_run(p_parent jsonb, p_worker uuid) returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run('84000000-0000-4000-8000-0000000000e1', 'agent', '63400000-0000-4000-8000-000000000002',
	'worker-dispatch', p_parent -> 'actor', p_worker);
begin
	perform pg_temp.fx(format('update public.qorpera_runtime_workers set occurrence_id = (select id from public.qorpera_wake_occurrences
		where run_id = %L) where id = %L', p ->> 'runId', p_worker));
	return jsonb_build_object('actor', p, 'binding', pg_temp.native(p));
end $$;

-- A retired worker's folder made again by a member: its brief, and its results when asked, at the bytes its row records
-- unless told otherwise.
create function pg_temp.restore(p_actor jsonb, p_folder text, p_worker public.qorpera_runtime_workers, p_results boolean,
	p_brief_text text default null) returns jsonb language plpgsql as $$
declare v_brief jsonb := (select structured -> 'parse' from public.qorpera_folder_path_versions where version = p_worker.folder_brief_version);
	v_results jsonb := (select structured -> 'parse' from public.qorpera_folder_path_versions where version = p_worker.folder_results_version);
	v_contents jsonb; v_structured jsonb;
begin
	v_contents := jsonb_build_array(jsonb_build_object('path','brief.md','kind','file','file',
		pg_temp.stage(coalesce(p_brief_text, v_brief::text), p_actor)));
	v_structured := jsonb_build_array(pg_temp.f2_entry(p_folder || '/brief.md', v_brief)
		|| case when p_brief_text is null then '{}'::jsonb else jsonb_build_object('text', p_brief_text) end);
	if p_results then
		v_contents := v_contents || jsonb_build_array(jsonb_build_object('path','results.md','kind','file','file',
			pg_temp.stage(v_results::text, p_actor)));
		v_structured := v_structured || jsonb_build_array(pg_temp.f2_entry(p_folder || '/results.md', v_results));
	end if;
	return jsonb_build_object('op','new_folder','path',p_folder,'contents',v_contents,'structured',v_structured);
end $$;

-- 0. Ada's folder with two todos, and her run for member 2 ----------------------------------------------------------
do $$
declare r jsonb; m jsonb := pg_temp.member(2); i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'f2b-seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.f2_write('{"kind":"platform"}', 'agents/sections.md', '{"kind":"sections","sections":[]}'),
		pg_temp.f2_hire('co-founder', '84000000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		pg_temp.f2_hire('ada', '84000000-0000-4000-8000-0000000000e1', 'Ada'),
		pg_temp.f2_hire('ben', '84000000-0000-4000-8000-0000000000e2', 'Ben')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(m, 'f2b-todos-0001', jsonb_build_array(
		pg_temp.f2_todo(m, 'agents/ada/todos/call-the-bank.md', 'Call the bank'),
		pg_temp.f2_todo(m, 'agents/ada/todos/book-the-room.md', 'Book the room', 'done'),
		pg_temp.f2_todo(m, 'agents/ada/todos/plan-the-trip.md', 'Plan the trip'),
		pg_temp.f2_todo(m, 'agents/ben/todos/ben-only.md', 'Ben''s work')));
	for i in 1..4 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform set_config('qorpera_test.ada', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e1')::text, false);
	perform set_config('qorpera_test.ben', pg_temp.agent_run('84000000-0000-4000-8000-0000000000e2')::text, false);
end $$;

-- 1. A dispatch: the todo's folder and the worker's folder with its brief; the row is the index, the wake waits ---------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; p jsonb := ada -> 'actor'; f text := 'agents/ada/todos/call-the-bank/price-check';
	b jsonb := pg_temp.brief('84000000-0000-4000-8000-000000000101', p_sources => '["agents/ada/todos/call-the-bank.md"]');
	u jsonb := pg_temp.dispatch_units(p, f, b); r jsonb; w public.qorpera_runtime_workers%rowtype; e public.qorpera_runtime_worker_events%rowtype;
begin
	r := pg_temp.wc(p, 'f2b-dispatch-0001', u, pg_temp.dispatch_request(f, b), pg_temp.reviewed(ada, 'f2b-call-0001', u));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	w := pg_temp.worker_row(f);
	if w.id is distinct from '84000000-0000-4000-8000-000000000101'::uuid or w.state is distinct from 'active' or w.sequence is distinct from 1
		or w.occurrence_id is not null or w.species is distinct from 'in-house' or w.access is distinct from 'write' or w.revival is distinct from 'each' or w.worker_key is distinct from 'price-check'
		or w.title is distinct from 'Compare suppliers' or w.staff_agent_id is distinct from '84000000-0000-4000-8000-0000000000e1'
		or w.requested_by_user_id is distinct from '63400000-0000-4000-8000-000000000002' or w.steering_run_id is distinct from (p ->> 'runId')::uuid
		or w.todo_id is distinct from (select id from public.qorpera_runtime_agent_todos where folder_path = 'agents/ada/todos/call-the-bank.md')
		or w.folder_path is distinct from f or w.folder_brief_version is distinct from pg_temp.f2_version(f || '/brief.md')
		or w.folder_results_version is not null or w.folder_commit_id is distinct from (r ->> 'commitId')::uuid
		or w.dispatch is distinct from jsonb_build_object('goal','Find three suppliers.','definitionOfDone','Three suppliers with prices.',
			'context','','sources','["agents/ada/todos/call-the-bank.md"]'::jsonb,'followUp',null)
			|| public.qorpera_company_state_worker_standing('in-house','write','each') then
		raise exception 'The dispatched row: %', to_jsonb(w); end if;
	select * into e from public.qorpera_runtime_worker_events where worker_id = w.id;
	if e.kind is distinct from 'dispatched' or e.sequence is distinct from 1 or e.run_id is distinct from (p ->> 'runId')::uuid or e.body is distinct from w.dispatch then
		raise exception 'The dispatched event: %', to_jsonb(e); end if;
	-- The commit is the run's, under the review of the call.
	if (select actor_kind from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid) is distinct from 'staff_agent'
		or (select run_id from public.qorpera_folder_commits where id = (r ->> 'commitId')::uuid) is distinct from (p ->> 'runId')::uuid then
		raise exception 'The commit is the run''s'; end if;
	-- The setting is cleared after the commit.
	if public.qorpera_folder_worker_request() is not null then raise exception 'The request outlived its commit'; end if;
end $$;

-- 2. Dispatches that refuse ---------------------------------------------------------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; p jsonb := ada -> 'actor'; m jsonb := pg_temp.member(2);
	f text := 'agents/ada/todos/call-the-bank/second'; b jsonb := pg_temp.brief('84000000-0000-4000-8000-000000000102');
	u jsonb; r jsonb; q jsonb;
begin
	-- Without the tool's request: a run's plain commit, and a member's.
	u := pg_temp.dispatch_units(p, f, b);
	r := pg_temp.commit(p, 'f2b-plain-0001', u, pg_temp.reviewed(ada, 'f2b-call-0002', u));
	perform pg_temp.refused(r, 1, 'manage_worker''s dispatch');
	u := pg_temp.dispatch_units(m, f, b);
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-plain-0002', u), 1, 'manage_worker''s dispatch');
	-- A brief written into an existing folder without a request.
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-plain-0003', jsonb_build_array(
		pg_temp.f2_write(m, 'agents/ada/todos/call-the-bank/price-check/brief.md', pg_temp.brief('84000000-0000-4000-8000-000000000101')))),
		1, 'only manage_worker and report_work');
	-- A request that names another operation key (set by hand, as only trusted SQL could).
	u := pg_temp.dispatch_units(p, f, b);
	perform set_config('qorpera.folder_worker', (pg_temp.dispatch_request(f, b) || jsonb_build_object('environmentId',
		'63400000-0000-4000-8000-000000000020','runId',p ->> 'runId','operationKey','another-key-0001'))::text, true);
	r := pg_temp.commit(p, 'f2b-forged-0001', u, pg_temp.reviewed(ada, 'f2b-call-0003', u));
	perform set_config('qorpera.folder_worker', '', true);
	perform pg_temp.refused(r, 1, 'does not belong to this change');
	-- ... or another run, or another company.
	perform set_config('qorpera.folder_worker', (pg_temp.dispatch_request(f, b) || jsonb_build_object('environmentId',
		'63400000-0000-4000-8000-000000000020','runId',current_setting('qorpera_test.ben')::jsonb -> 'actor' ->> 'runId',
		'operationKey','f2b-forged-0002'))::text, true);
	r := pg_temp.commit(p, 'f2b-forged-0002', u, pg_temp.reviewed(ada, 'f2b-call-0003b', u));
	perform set_config('qorpera.folder_worker', '', true);
	perform pg_temp.refused(r, 1, 'does not belong to this change');
	perform set_config('qorpera.folder_worker', (pg_temp.dispatch_request(f, b) || jsonb_build_object('environmentId',
		'63400000-0000-4000-8000-0000000000ff','runId',p ->> 'runId','operationKey','f2b-forged-0003'))::text, true);
	r := pg_temp.commit(p, 'f2b-forged-0003', u, pg_temp.reviewed(ada, 'f2b-call-0003c', u));
	perform set_config('qorpera.folder_worker', '', true);
	perform pg_temp.refused(r, 1, 'does not belong to this change');
	-- A worker change that holds another unit: that unit is refused (a change set is not atomic, so the dispatch lands).
	q := pg_temp.brief('84000000-0000-4000-8000-000000000104');
	u := pg_temp.dispatch_units(p, 'agents/ada/todos/call-the-bank/extra', q)
		|| jsonb_build_array(pg_temp.f2_write(p, 'agents/ada/notes.md', '{"kind":"x"}'::jsonb) - 'structured');
	r := pg_temp.wc(p, 'f2b-extra-0001', u, pg_temp.dispatch_request('agents/ada/todos/call-the-bank/extra', q),
		pg_temp.reviewed(ada, 'f2b-call-0004', u));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.refused(r, 2, 'holds only its own files');
	-- A closed todo.
	f := 'agents/ada/todos/book-the-room/w1'; u := pg_temp.dispatch_units(p, f, b);
	r := pg_temp.wc(p, 'f2b-closed-0001', u, pg_temp.dispatch_request(f, b), pg_temp.reviewed(ada, 'f2b-call-0005', u));
	perform pg_temp.refused(r, 2, 'the todo is closed');
	-- Another agent's todo.
	f := 'agents/ben/todos/ben-only/w1'; u := pg_temp.dispatch_units(p, f, b);
	r := pg_temp.wc(p, 'f2b-other-0001', u, pg_temp.dispatch_request(f, b), pg_temp.reviewed(ada, 'f2b-call-0006', u));
	perform pg_temp.refused(r, 2, 'its own agent''s todos');
	f := 'agents/ada/todos/call-the-bank/second';
	-- The brief and the request disagree; the standing texts are not the platform's; a follow-up in a new brief; coding.
	u := pg_temp.dispatch_units(p, f, b);
	r := pg_temp.wc(p, 'f2b-mismatch-0001', u, pg_temp.dispatch_request(f, b) || '{"title":"Other"}',
		pg_temp.reviewed(ada, 'f2b-call-0007', u));
	perform pg_temp.refused(r, 1, 'does not match the dispatch');
	q := b || '{"authority":"Write anything."}'; u := pg_temp.dispatch_units(p, f, q);
	r := pg_temp.wc(p, 'f2b-standing-0001', u, pg_temp.dispatch_request(f, q), pg_temp.reviewed(ada, 'f2b-call-0008', u));
	perform pg_temp.refused(r, 1, 'standing texts are the platform''s');
	-- A coding brief under an in-house request (coding sessions are 928's, C3a).
	q := pg_temp.brief('84000000-0000-4000-8000-000000000102', p_species => 'coding', p_access => 'read')
		|| '{"harness":"codex","repository":{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}}';
	u := pg_temp.dispatch_units(p, f, q);
	r := pg_temp.wc(p, 'f2b-coding-0001', u, pg_temp.dispatch_request(f, q), pg_temp.reviewed(ada, 'f2b-call-0009', u));
	perform pg_temp.refused(r, 1, 'does not match the dispatch');
	q := pg_temp.brief('84000000-0000-4000-8000-000000000102', p_at => clock_timestamp() - interval '1 hour');
	u := pg_temp.dispatch_units(p, f, q);
	r := pg_temp.wc(p, 'f2b-late-0001', u, pg_temp.dispatch_request(f, q), pg_temp.reviewed(ada, 'f2b-call-0010', u));
	perform pg_temp.refused(r, 1, 'dispatched_at is the time');
	-- An id that is taken, under another worker key.
	q := pg_temp.brief('84000000-0000-4000-8000-000000000101'); u := pg_temp.dispatch_units(p, f, q);
	r := pg_temp.wc(p, 'f2b-taken-0001', u, pg_temp.dispatch_request(f, q), pg_temp.reviewed(ada, 'f2b-call-0011', u));
	perform pg_temp.refused(r, 1, 'already exists');
	-- Without the review of the call: denied.
	u := pg_temp.dispatch_units(p, f, b);
	perform pg_temp.expect(pg_temp.wc(p, 'f2b-unreviewed-0001', u, pg_temp.dispatch_request(f, b)), 1, 'denied', 'review_required');
	if pg_temp.worker_row(f) is not null and (pg_temp.worker_row(f)).id is not null then raise exception 'A refused dispatch left a row'; end if;
	-- The entry: only a run, a well-formed request, no request already set.
	perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L)', m, 'f2b-member-0001', u, pg_temp.dispatch_request(f, b)), '22023');
	perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L)', p, 'f2b-bad-0001', u, '{"action":"dispatch"}'), '22023');
	perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L)', p, 'f2b-bad-0002', u,
		pg_temp.dispatch_request('agents/ada/todos/call-the-bank/Bad_Key', b)), '22023');
	perform set_config('qorpera.folder_worker', '{"action":"dispatch"}', true);
	perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L)', p, 'f2b-nested-0001', u, pg_temp.dispatch_request(f, b)), '55000');
	perform set_config('qorpera.folder_worker', '', true);
end $$;

-- 3. A write worker's report: its files, then results.md; the row waits to revive its parent ------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; f text := 'agents/ada/todos/call-the-bank/price-check';
	w public.qorpera_runtime_workers%rowtype := pg_temp.worker_row(f); x jsonb := pg_temp.worker_run(ada, w.id); p jsonb := x -> 'actor';
	r jsonb; q jsonb := jsonb_build_object('action','report','folder',f);
begin
	perform set_config('qorpera_test.price_check', x::text, false);
	-- The worker writes its output into its folder (an ordinary file).
	perform pg_temp.expect(pg_temp.commit(p, 'f2b-output-0001', jsonb_build_array(jsonb_build_object('op','write',
		'path',f || '/suppliers.md','file',pg_temp.stage('Three suppliers.', p)))), 1, 'saved');
	-- Refusals: a file this run did not write, a decision, a cancelled outcome, the parent reporting.
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-report-0001', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		pg_temp.results(p_files => '["agents/ada/todos/call-the-bank.md"]'))), q), 1, 'this run did not write');
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-report-0002', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		pg_temp.results(p_decision => 'accepted'))), q), 1, 'without a decision');
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-report-0003', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		pg_temp.results('cancelled'))), q), 1, 'without a decision');
	perform pg_temp.refused(pg_temp.wc(ada -> 'actor', 'f2b-report-0004', jsonb_build_array(pg_temp.f2_write(ada -> 'actor',
		f || '/results.md', pg_temp.results())), q), 1, 'only the worker''s own run reports');
	-- The report.
	r := pg_temp.wc(p, 'f2b-report-0005', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		pg_temp.results(p_files => jsonb_build_array(f || '/suppliers.md')))), q);
	perform pg_temp.expect(r, 1, 'saved');
	w := pg_temp.worker_row(f);
	if w.state is distinct from 'succeeded' or w.completion_state is distinct from 'waiting' or w.reported_at is null
		or w.folder_results_version is distinct from pg_temp.f2_version(f || '/results.md')
		or w.result is distinct from jsonb_build_object('outcome','succeeded','summary','Done.','needs',null,
			'outputs',jsonb_build_array(jsonb_build_object('path',f || '/suppliers.md')),'runId',(p ->> 'runId')::uuid,'sequence',1) then
		raise exception 'The reported row: %', to_jsonb(w); end if;
	if (select kind from public.qorpera_runtime_worker_events where worker_id = w.id order by created_at desc, id desc limit 1)
			is distinct from 'reported'
		or (select body from public.qorpera_runtime_worker_events where worker_id = w.id order by created_at desc, id desc limit 1)
			is distinct from w.result then
		raise exception 'The reported event carries the report'; end if;
	-- Once per sequence: the report ended the work.
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-report-0006', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		pg_temp.results())), q), 1, 'only the worker''s own run reports, while it works');
end $$;

-- 4. A read-only worker reports through the exception, and writes nothing else ------------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; f text := 'agents/ada/todos/call-the-bank/reader';
	b jsonb := pg_temp.brief('84000000-0000-4000-8000-000000000103', p_access => 'read', p_revival => 'batch');
	u jsonb := pg_temp.dispatch_units(ada -> 'actor', f, b); x jsonb; p jsonb; r jsonb; q jsonb := jsonb_build_object('action','report','folder',f);
begin
	perform pg_temp.expect(pg_temp.wc(ada -> 'actor', 'f2b-dispatch-0002', u, pg_temp.dispatch_request(f, b),
		pg_temp.reviewed(ada, 'f2b-call-0012', u)), 1, 'saved');
	-- Before its own run starts (no wake yet), nobody else reports for it: not the parent's run, not another worker's.
	perform pg_temp.refused(pg_temp.wc(ada -> 'actor', 'f2b-early-0001', jsonb_build_array(pg_temp.f2_write(ada -> 'actor',
		f || '/results.md', pg_temp.results())), q), 1, 'only the worker''s own run reports');
	r := pg_temp.wc(current_setting('qorpera_test.price_check')::jsonb -> 'actor', 'f2b-early-0002', jsonb_build_array(
		pg_temp.f2_write(current_setting('qorpera_test.price_check')::jsonb -> 'actor', f || '/results.md', pg_temp.results())), q);
	if coalesce(r -> 'units' -> 0 ->> 'outcome', '') not in ('refused','denied') or pg_temp.f2_version(f || '/results.md') is not null then
		raise exception 'Another worker''s run reported for this one: %', r; end if;
	x := pg_temp.worker_run(ada, (pg_temp.worker_row(f)).id); p := x -> 'actor';
	-- A plain write is denied to a read-only worker; so is a report that holds another unit.
	perform pg_temp.expect(pg_temp.commit(p, 'f2b-reader-0001', jsonb_build_array(jsonb_build_object('op','write',
		'path',f || '/notes.md','file',pg_temp.stage('Notes.', p)))), 1, 'denied', 'denied');
	r := pg_temp.wc(p, 'f2b-reader-0002', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md', pg_temp.results('blocked')),
		jsonb_build_object('op','write','path',f || '/notes.md','file',pg_temp.stage('Notes.', p))), q);
	perform pg_temp.refused(r, 2, 'holds only its own files');
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.worker_row(f)).state is distinct from 'blocked' or (pg_temp.worker_row(f)).result ->> 'needs' is distinct from 'A login.' then
		raise exception 'The blocked report'; end if;
end $$;

-- 5. The parent decides: only decision and note change; only a success is accepted ----------------------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; p jsonb := ada -> 'actor'; f text := 'agents/ada/todos/call-the-bank/price-check';
	base jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v where v.version = pg_temp.f2_version(f || '/results.md'));
	r jsonb; w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-decide-0001', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		base || '{"decision":"accepted","summary":"Better."}')), jsonb_build_object('action','decide','folder',f,'decision','accepted',
		'note',null)), 1, 'changes only decision and note');
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-decide-0002', jsonb_build_array(pg_temp.f2_write(p, 'agents/ada/todos/call-the-bank/reader/results.md',
		(select v.structured -> 'parse' from public.qorpera_folder_path_versions v
			where v.version = pg_temp.f2_version('agents/ada/todos/call-the-bank/reader/results.md')) || '{"decision":"accepted"}')),
		jsonb_build_object('action','decide','folder','agents/ada/todos/call-the-bank/reader','decision','accepted','note',null)),
		1, 'only a finished, successful result');
	-- No report, no decision.
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-decide-0004', jsonb_build_array(pg_temp.f2_write(p,
		'agents/ada/todos/call-the-bank/extra/results.md', base || '{"decision":"rejected"}')),
		jsonb_build_object('action','decide','folder','agents/ada/todos/call-the-bank/extra','decision','rejected','note',null)),
		1, 'without a report there is none');
	r := pg_temp.wc(p, 'f2b-decide-0003', jsonb_build_array(pg_temp.f2_write(p, f || '/results.md',
		base || '{"decision":"accepted","note":"Good sources."}')), jsonb_build_object('action','decide','folder',f,'decision','accepted',
		'note','Good sources.'));
	perform pg_temp.expect(r, 1, 'saved');
	w := pg_temp.worker_row(f);
	if w.acceptance is distinct from 'accepted' or w.acceptance_note is distinct from 'Good sources.' or w.accepted_by_run_id is distinct from (p ->> 'runId')::uuid
		or w.completion_state is distinct from 'suppressed' or w.folder_results_version is distinct from pg_temp.f2_version(f || '/results.md') then
		raise exception 'The decided row: %', to_jsonb(w); end if;
end $$;

-- 6. A follow-up: one more follow-up in the brief, results.md removed, the worker at work again ---------------------------
do $$
declare
	ada jsonb := current_setting('qorpera_test.ada')::jsonb; p jsonb := ada -> 'actor'; f text := 'agents/ada/todos/call-the-bank/price-check';
	base jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v where v.version = pg_temp.f2_version(f || '/brief.md'));
	next jsonb := base || jsonb_build_object('followUps', 1, 'followedUpAt', to_char(clock_timestamp() at time zone 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Add a fourth.');
	u jsonb; r jsonb; w public.qorpera_runtime_workers%rowtype; q jsonb := jsonb_build_object('action','followup','folder',f,'text','Add a fourth.','resultsVersion',pg_temp.f2_version(f || '/results.md'));
begin
	u := jsonb_build_array(pg_temp.f2_write(p, f || '/brief.md', next),
		jsonb_build_object('op','delete','path',f || '/results.md','expectedVersion',pg_temp.f2_version(f || '/results.md')));
	-- Another change than one follow-up.
	r := pg_temp.wc(p, 'f2b-followup-0001', jsonb_build_array(pg_temp.f2_write(p, f || '/brief.md', next || '{"title":"New"}'),
		u -> 1), q, pg_temp.reviewed(ada, 'f2b-call-0013', jsonb_build_array(pg_temp.f2_write(p, f || '/brief.md', next || '{"title":"New"}'),
		u -> 1)));
	perform pg_temp.refused(r, 1, 'adds one follow-up');
	-- Its results stay: they go only after this commit's brief landed.
	perform pg_temp.refused(r, 2, 'holds only its own files');
	if pg_temp.f2_version(f || '/results.md') is null then raise exception 'A refused follow-up removed the results'; end if;
	-- 20260930075000: results other than those the tool read (a decision landed since) make the follow-up a conflict, and
	-- nothing of it is saved, where the brief alone used to save and the verify step refused the change set.
	r := pg_temp.wc(p, 'f2b-followup-0001b', u, q || jsonb_build_object('resultsVersion', extensions.gen_random_uuid()),
		pg_temp.reviewed(ada, 'f2b-call-0013b', u));
	perform pg_temp.expect(r, 1, 'conflict', 'version_changed');
	if (r -> 'units' -> 1 ->> 'outcome') = 'saved' or pg_temp.f2_version(f || '/results.md') is null
		or (pg_temp.worker_row(f)).sequence is distinct from 1 then
		raise exception 'A follow-up behind a decision saves nothing: %', r; end if;
	r := pg_temp.wc(p, 'f2b-followup-0002', u, q, pg_temp.reviewed(ada, 'f2b-call-0014', u));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	w := pg_temp.worker_row(f);
	if w.sequence is distinct from 2 or w.state is distinct from 'active' or w.result is not null or w.acceptance is not null or w.completion_state is distinct from 'none'
		or w.occurrence_id is not null or w.steering_run_id is distinct from (p ->> 'runId')::uuid or w.dispatch ->> 'followUp' is distinct from 'Add a fourth.'
		or w.folder_results_version is not null or w.folder_brief_version is distinct from pg_temp.f2_version(f || '/brief.md') then
		raise exception 'The followed-up row: %', to_jsonb(w); end if;
	-- At work again: a second follow-up waits for its report.
	perform pg_temp.refused(pg_temp.wc(p, 'f2b-followup-0003', jsonb_build_array(pg_temp.f2_write(p, f || '/brief.md',
		next || jsonb_build_object('followUps', 2, 'followUp', 'More.'))), jsonb_build_object('action','followup','folder',f,'text','More.',
		'resultsVersion',null),
		pg_temp.reviewed(ada, 'f2b-call-0015', jsonb_build_array(pg_temp.f2_write(p, f || '/brief.md',
			next || jsonb_build_object('followUps', 2, 'followUp', 'More.'))))), 1, 'still working');
	-- A follow-up that keeps the old results.md: the row no longer points at it, so verify refuses the whole change set.
	declare rb jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
			where v.version = pg_temp.f2_version('agents/ada/todos/call-the-bank/reader/brief.md'));
		ru jsonb;
	begin
		ru := jsonb_build_array(pg_temp.f2_write(p, 'agents/ada/todos/call-the-bank/reader/brief.md', rb || jsonb_build_object('followUps', 1,
			'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Try again.')));
		perform pg_temp.raises(format('select pg_temp.wc(%L, %L, %L, %L, %L)', p, 'f2b-followup-0004', ru,
			jsonb_build_object('action','followup','folder','agents/ada/todos/call-the-bank/reader','text','Try again.',
				'resultsVersion',pg_temp.f2_version('agents/ada/todos/call-the-bank/reader/results.md')),
			pg_temp.reviewed(ada, 'f2b-call-0016', ru)), 'XX000');
		if (pg_temp.worker_row('agents/ada/todos/call-the-bank/reader')).state is distinct from 'blocked' then
			raise exception 'A refused follow-up changed the reader'; end if;
	end;
	-- A todo with a worker at work is not done.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'f2b-done-0001', jsonb_build_array(pg_temp.f2_todo(pg_temp.member(2),
		'agents/ada/todos/call-the-bank.md', 'Call the bank', 'done'))), 1, 'refused', 'structured_rule');
end $$;

-- 7. Status: the run's own workers on one todo, from the index -------------------------------------------------------------
do $$
declare ada jsonb := current_setting('qorpera_test.ada')::jsonb; r jsonb;
begin
	r := public.qorpera_folder_agent_workers('63400000-0000-4000-8000-000000000020', ada -> 'actor', '{"todoKey":"call-the-bank"}');
	if r ->> 'schema' is distinct from 'qorpera.folder-agent-workers/v1' or jsonb_array_length(r -> 'workers') is distinct from 3
		or (select jsonb_agg(w ->> 'folder' order by w ->> 'folder') from jsonb_array_elements(r -> 'workers') w)
			is distinct from '["agents/ada/todos/call-the-bank/extra","agents/ada/todos/call-the-bank/price-check","agents/ada/todos/call-the-bank/reader"]' then
		raise exception 'Status: %', r; end if;
	perform pg_temp.raises(format('select public.qorpera_folder_agent_workers(%L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		pg_temp.member(2), '{"todoKey":"call-the-bank"}'), '42501');
	perform pg_temp.raises(format('select public.qorpera_folder_agent_workers(%L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		ada -> 'actor', '{"todoKey":"ben-only"}'), 'P0002');
	-- 20260930075000: filtered in SQL, and a page continues after a cursor (newest first; at most 16 a page).
	if r ->> 'moreWorkers' is distinct from '0' or r -> 'nextCursor' is distinct from 'null'
		or exists (select 1 from jsonb_array_elements(r -> 'workers') w where w ->> 'cursor' is null) then
		raise exception 'A whole page: %', r; end if;
	declare one jsonb := public.qorpera_folder_agent_workers('63400000-0000-4000-8000-000000000020', ada -> 'actor',
			'{"todoKey":"call-the-bank","workerKey":"reader"}');
		later jsonb := public.qorpera_folder_agent_workers('63400000-0000-4000-8000-000000000020', ada -> 'actor',
			jsonb_build_object('todoKey', 'call-the-bank', 'cursor', r -> 'workers' -> 0 ->> 'cursor'));
	begin
		if jsonb_array_length(one -> 'workers') <> 1 or one -> 'workers' -> 0 ->> 'workerKey' <> 'reader'
			or jsonb_array_length(later -> 'workers') <> 2 or later -> 'workers' -> 0 = r -> 'workers' -> 0
			or jsonb_array_length(public.qorpera_folder_agent_workers('63400000-0000-4000-8000-000000000020', ada -> 'actor',
				'{"todoKey":"call-the-bank","search":"PRICE"}') -> 'workers') <> 1
			or jsonb_array_length(public.qorpera_folder_agent_workers('63400000-0000-4000-8000-000000000020', ada -> 'actor',
				'{"todoKey":"call-the-bank","state":"cancelled"}') -> 'workers') <> 0 then
			raise exception 'Filters and pages: %, %', one, later; end if;
	end;
	perform pg_temp.raises(format('select public.qorpera_folder_agent_workers(%L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		ada -> 'actor', jsonb_build_object('todoKey', 'call-the-bank', 'cursor', extensions.gen_random_uuid())), 'P0002');
	perform pg_temp.raises(format('select public.qorpera_folder_agent_workers(%L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		ada -> 'actor', '{"todoKey":"call-the-bank","state":"queued"}'), '22023');
end $$;

-- 8. Cancel: the row only, its queued wake cancelled; no file ------------------------------------------------------------
do $$
declare ada jsonb := current_setting('qorpera_test.ada')::jsonb; f text := 'agents/ada/todos/call-the-bank/price-check'; r jsonb;
	w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.raises(format('select public.qorpera_folder_cancel_agent_worker(%L, %L)', ada -> 'binding', '{"folder":"x"}'), '22023');
	-- A cancel is work: each run acknowledges its wake first (qorpera_assert_wake_work_allowed), as before any effect.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform public.qorpera_folder_send_agent_message(ada -> 'binding', 'f2b-ack-ada', 'Stopping the price check.', 'progress');
	perform public.qorpera_folder_send_agent_message(current_setting('qorpera_test.ben')::jsonb -> 'binding', 'f2b-ack-ben',
		'Looking at the todos.', 'progress');
	r := public.qorpera_folder_cancel_agent_worker(ada -> 'binding', jsonb_build_object('folder', f, 'operationKey', 'f2b-cancel-0001'));
	w := pg_temp.worker_row(f);
	if r ->> 'action' is distinct from 'cancel' or w.state is distinct from 'cancelled' or w.completion_state is distinct from 'suppressed' or w.result ->> 'reason' is distinct from 'parent_cancelled'
		or w.folder_results_version is not null or pg_temp.f2_version(f || '/results.md') is not null then
		raise exception 'The cancelled row: %', to_jsonb(w); end if;
	-- A replay answers the same; a cancelled in-house worker cannot continue.
	if public.qorpera_folder_cancel_agent_worker(ada -> 'binding', jsonb_build_object('folder', f, 'operationKey', 'f2b-cancel-0001'))
		is distinct from r then
		raise exception 'The cancel replay'; end if;
	declare cb jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v where v.version = pg_temp.f2_version(f || '/brief.md'));
		cu jsonb;
	begin
		cu := jsonb_build_array(pg_temp.f2_write(ada -> 'actor', f || '/brief.md', cb || jsonb_build_object('followUps', 2,
			'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', 'Again.')));
		perform pg_temp.refused(pg_temp.wc(ada -> 'actor', 'f2b-followup-0005', cu,
			jsonb_build_object('action','followup','folder',f,'text','Again.','resultsVersion',null), pg_temp.reviewed(ada, 'f2b-call-0017', cu)),
			1, 'cannot continue');
	end;
	-- A folder with no worker: nothing to cancel (never a retry).
	perform pg_temp.raises(format('select public.qorpera_folder_cancel_agent_worker(%L, %L)', ada -> 'binding',
		jsonb_build_object('folder', 'agents/ada/todos/call-the-bank/nobody', 'operationKey', 'f2b-cancel-0004')), 'P0002');
	-- Ben's run cannot cancel Ada's worker.
	perform pg_temp.raises(format('select public.qorpera_folder_cancel_agent_worker(%L, %L)', current_setting('qorpera_test.ben')::jsonb -> 'binding',
		jsonb_build_object('folder', f, 'operationKey', 'f2b-cancel-0002')), '42501');
end $$;

-- 9. The guard: worker files go with their folder; a todo with workers keeps its file; a restore brings them back --------
do $$
declare m jsonb := pg_temp.member(2); f text := 'agents/ada/todos/call-the-bank/reader'; r jsonb; w public.qorpera_runtime_workers%rowtype;
	brief_sha text;
begin
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0001', jsonb_build_array(jsonb_build_object('op','delete',
		'path',f || '/brief.md','expectedVersion',pg_temp.f2_version(f || '/brief.md')))), 1, 'go with its folder');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0002', jsonb_build_array(jsonb_build_object('op','move',
		'from',f,'to','agents/ada/todos/call-the-bank/renamed','expectedVersion',pg_temp.f2_version(f),'asOfSeq',(select last_seq from public.qorpera_folder_clocks
			where environment_id = '63400000-0000-4000-8000-000000000020')))), 1, 'moves only with its agent''s folder');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0003', jsonb_build_array(jsonb_build_object('op','mkdir',
		'path','agents/ada/todos/plan-the-trip'), jsonb_build_object('op','mkdir','path','agents/ada/todos/plan-the-trip/sneaky'))),
		2, 'made by manage_worker''s dispatch');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0004', jsonb_build_array(jsonb_build_object('op','delete',
		'path','agents/ada/todos/call-the-bank.md','expectedVersion',pg_temp.f2_version('agents/ada/todos/call-the-bank.md')))),
		1, 'this todo has workers');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0005', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/ada/todos/call-the-bank.md','to','agents/ada/todos/call-the-banks.md','expectedVersion',
		pg_temp.f2_version('agents/ada/todos/call-the-bank.md')))), 1, 'this todo has workers');
	-- Nothing arrives at a worker's place by a move or a copy, nor in a subtree that would put a folder there.
	perform pg_temp.expect(pg_temp.commit(m, 'f2b-guard-0013', jsonb_build_array(jsonb_build_object('op','mkdir','path','agents/ada/drafts'),
		jsonb_build_object('op','mkdir','path','stuff'), jsonb_build_object('op','mkdir','path','stuff/inside'))), 3, 'saved');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0014', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/ada/drafts','to','agents/ada/todos/call-the-bank/fake','expectedVersion',pg_temp.f2_version('agents/ada/drafts'),
		'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020')))),
		1, 'made by manage_worker''s dispatch');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0015', jsonb_build_array(jsonb_build_object('op','copy',
		'from','agents/ada/drafts','to','agents/ada/todos/call-the-bank/fake'))), 1, 'made by manage_worker''s dispatch');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0016', jsonb_build_array(jsonb_build_object('op','move',
		'from','stuff','to','agents/ada/todos/fresh-todo','expectedVersion',pg_temp.f2_version('stuff'),
		'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020')))),
		1, 'made by manage_worker''s dispatch');
	-- A finished worker's folder goes, and retires its row; a restore brings it back whole, finished, with the same bytes.
	w := pg_temp.worker_row(f);
	r := pg_temp.commit(m, 'f2b-guard-0006', jsonb_build_array(jsonb_build_object('op','delete','path',f,
		'expectedVersion',pg_temp.f2_version(f),'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020'))));
	perform pg_temp.expect(r, 1, 'saved');
	if (select folder_retired_at from public.qorpera_runtime_workers where id = w.id) is null then raise exception 'Not retired'; end if;
	-- A retired worker's folder: nothing to cancel, never a retry.
	perform pg_temp.raises(format('select public.qorpera_folder_cancel_agent_worker(%L, %L)',
		current_setting('qorpera_test.ada')::jsonb -> 'binding', jsonb_build_object('folder', f, 'operationKey', 'f2b-cancel-0005')), 'P0002');
	-- A folder alone, the brief alone, or other bytes: refused.
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0007', jsonb_build_array(jsonb_build_object('op','mkdir','path',f))),
		1, 'comes back whole');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0008', jsonb_build_array(pg_temp.restore(m, f, w, false))), 1, 'comes back whole');
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0009', jsonb_build_array(pg_temp.restore(m, f, w, true, 'Other bytes.'))),
		1, 'only manage_worker and report_work');
	r := pg_temp.commit(m, 'f2b-guard-0010', jsonb_build_array(pg_temp.restore(m, f, w, true)));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.worker_row(f)).id is distinct from w.id or (pg_temp.worker_row(f)).state is distinct from 'blocked'
		or (pg_temp.worker_row(f)).folder_brief_version is distinct from pg_temp.f2_version(f || '/brief.md')
		or (pg_temp.worker_row(f)).folder_results_version is distinct from pg_temp.f2_version(f || '/results.md') then
		raise exception 'The restored row: %', to_jsonb(pg_temp.worker_row(f)); end if;
	-- An agent's folder with a worker at work does not move; once none is, its workers follow it.
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0011', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/ada','to','agents/adele','expectedVersion',pg_temp.f2_version('agents/ada'),'asOfSeq',(select last_seq from public.qorpera_folder_clocks
			where environment_id = '63400000-0000-4000-8000-000000000020')))), 1, 'still at work');
	perform public.qorpera_folder_cancel_agent_worker(current_setting('qorpera_test.ada')::jsonb -> 'binding',
		jsonb_build_object('folder', 'agents/ada/todos/call-the-bank/extra', 'operationKey', 'f2b-cancel-0003'));
	-- Workers move only with their agent's whole folder: not with its todos folder, even when none is at work.
	perform pg_temp.refused(pg_temp.commit(m, 'f2b-guard-0017', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/ada/todos','to','stuff/todos','expectedVersion',pg_temp.f2_version('agents/ada/todos'),
		'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63400000-0000-4000-8000-000000000020')))),
		1, 'workers move only with their agent''s folder');
	r := pg_temp.commit(m, 'f2b-guard-0012', jsonb_build_array(jsonb_build_object('op','move',
		'from','agents/ada','to','agents/adele','expectedVersion',pg_temp.f2_version('agents/ada'),'asOfSeq',(select last_seq from public.qorpera_folder_clocks
			where environment_id = '63400000-0000-4000-8000-000000000020'))));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.worker_row('agents/adele/todos/call-the-bank/reader')).id is distinct from w.id
		or (pg_temp.worker_row('agents/adele/todos/call-the-bank/reader')).folder_brief_version
			is distinct from pg_temp.f2_version('agents/adele/todos/call-the-bank/reader/brief.md')
		or (pg_temp.worker_row('agents/adele/todos/call-the-bank/price-check')).folder_path is distinct from 'agents/adele/todos/call-the-bank/price-check'
		or exists (select 1 from public.qorpera_runtime_workers where folder_key like 'agents/ada/%' and folder_retired_at is null) then
		raise exception 'The moved workers'; end if;
end $$;

-- 10. The parse's shape, the locks, and the deploy guard's markers --------------------------------------------------------
do $$
declare b jsonb := pg_temp.brief('84000000-0000-4000-8000-000000000109'); v_n integer;
begin
	if jsonb_array_length(public.qorpera_company_state_parse_problems('worker-brief', b)) is distinct from 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-results', pg_temp.results('blocked'))) is distinct from 0 then
		raise exception 'Good parses refused'; end if;
	if jsonb_array_length(public.qorpera_company_state_parse_problems('worker-brief', b - 'goal')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-brief', b || '{"followUps":1}')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-brief', b || '{"followUps":"x"}')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-brief', b || '{"goal":" padded"}')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-brief',
			b || jsonb_build_object('sources', (select jsonb_agg('s' || n || '.md') from generate_series(1, 9) n)))) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-results', pg_temp.results('succeeded') || '{"needs":"x"}')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-results', pg_temp.results('blocked') || '{"needs":null}')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-results', pg_temp.results() || '{"note":"x"}')) = 0
		or jsonb_array_length(public.qorpera_company_state_parse_problems('worker-results',
			pg_temp.results(p_files => '["a.md","A.md"]'))) = 0 then
		raise exception 'Bad parses passed'; end if;
	-- The lock takes the two tables by id.
	perform public.qorpera_folder_structured_lock('63400000-0000-4000-8000-000000000020', jsonb_build_array(
		jsonb_build_object('rank',5,'tbl','qorpera_runtime_workers','key','84000000-0000-4000-8000-000000000101','mode','nokeyupdate'),
		jsonb_build_object('rank',5,'tbl','qorpera_runtime_agent_todos','key',(select id from public.qorpera_runtime_agent_todos
			where folder_path = 'agents/ada/todos/call-the-bank.md'),'mode','share')), 5::smallint, 5::smallint);
	select count(*) into v_n from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
	where n.nspname = 'public' and p.prosrc like '%20260930003000%' and p.proname in ('qorpera_company_state_parse_problems',
		'qorpera_company_state_checked','qorpera_folder_structured_targets','qorpera_folder_structured_lock',
		'qorpera_folder_structured_decide','qorpera_folder_structured_apply','qorpera_folder_structured_verify',
		'qorpera_folder_structured_review_class','qorpera_folder_record_review','qorpera_folder_actor_resource_allowed');
	if v_n is distinct from 10 then raise exception 'The deploy guard''s markers: % of 10', v_n; end if;
	if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_folder_worker_commit' and scope = 'folder')
		or not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_folder_cancel_agent_worker' and scope = 'binding') then
		raise exception 'The native host''s calls'; end if;
end $$;

rollback;
