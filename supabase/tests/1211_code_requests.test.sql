-- @fixture 1210_code_change_record.test.sql until "-- The checks start here"
-- Undo, download and restore of the repositories kept in Qorpera (migration 20260930720000): the requests, the calls
-- that add them (an agent's, a member's, an operator's), the executor's claim, step and finish, and what a finish does
-- to the change record. 1210's helpers: company/shop, session copies that hand commits in, and the record call.
--   1. An agent asks for an undo: the request's shape, each refusal, a replay, one open at a time.
--   2. The executor's claim, step and finish of an undo: refused, undone, already; a filler first; an undo of an undo;
--      andLater across undo rows, and its own undo; a finish that comes late; too many starts; put off; nothing.
--      (company/eight, before section 6: a late finish against a row a turn took for its own.)
--   3. Downloads: the member's three calls per role, made and ready, the same main again, too large, put off, the
--      rate, no executor, the file's removal, and a made download that is over from the step of the job that replaces
--      its file, whatever becomes of that job's finish.
--   4. Restore: the operator's call, verify, the wait for quiet sessions, progress, the record a restore makes before
--      its place opens and the finish after it, what the record does to the rows (lost rows, files and care due
--      again), a restored main the record does not know, the wall for undo, and discard.
--   5. A restore against the downloads made in its place (over from each step that lets a job go to move the place,
--      also when the restore then fails, and on a later claim of the same request; not from a step that moves nothing
--      out; a finish that comes after it); its record against landings and in every order of
--      failure; record files acknowledged after a restore; restores back, forward and back again with undos among the
--      rows; a history of more than 200 changes.
--   6. More than 500 changes are not taken out at once.
--   7. An agent describes a change: the notice, and each thing wrong with a picture.
--   8. A worker's run asks for nothing.

-- exec-1170 runs on machine 5…5 and holds this company's code alone.
update public.qorpera_coding_executors set nas_machine_id_sha256 = repeat('5', 64) where owner = 'exec-1170';

-- The executor's three calls: the service role, with its claims. The claim answers its requests.
create function pg_temp.req_claim(p_limit integer default 20, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_requests_claim(p_owner, p_machine, p_limit);
	reset role;
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.code-requests/v1' and jsonb_typeof(v -> 'requests') = 'array',
		'a claim: ' || v::text);
	return v -> 'requests';
end $$;
create function pg_temp.req_step(p_id uuid, p_token uuid, p_progress jsonb default null, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_request_step(p_owner, p_machine, p_id, p_token, p_progress);
	reset role;
	return v;
end $$;
create function pg_temp.req_finish(p_id uuid, p_token uuid, p_outcome jsonb, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_request_finish(p_owner, p_machine, p_id, p_token, p_outcome);
	reset role;
	return v;
end $$;
-- How a request ended, and what the finish answers.
create function pg_temp.req_outcome(p_keys jsonb) returns jsonb language sql immutable as $$
	select '{"schema":"qorpera.code-request-outcome/v1"}'::jsonb || p_keys
$$;
create function pg_temp.req_recorded(p_change integer) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-request-finish/v1', 'state', 'recorded', 'change', p_change)
$$;
create function pg_temp.req_row(p_id uuid) returns public.qorpera_code_requests language sql as $$
	select * from public.qorpera_code_requests where id = p_id
$$;
-- A request's lease ended a second ago; and it is no longer put off.
create function pg_temp.req_lapse(p_id uuid) returns void language sql as $$
	update public.qorpera_code_requests set lease_until = clock_timestamp() - interval '1 second' where id = p_id
$$;
create function pg_temp.req_now(p_id uuid) returns void language sql as $$
	update public.qorpera_code_requests set not_before = null where id = p_id
$$;
-- The agent's calls, with Alice's own company run.
create function pg_temp.req_undo(p_key text, p_change integer, p_later boolean default false, p_keys jsonb default '{}',
	p_name text default 'shop') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_request_code_undo(pg_temp.c3_alice(), jsonb_build_object('operationKey', p_key,
		'owner', 'company', 'name', p_name, 'change', p_change, 'andLater', p_later, 'reason', 'It broke the checkout.',
		'notice', null) || p_keys);
end $$;
create function pg_temp.req_read(p_id uuid) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_code_request(pg_temp.c3_alice(), p_id);
end $$;
create function pg_temp.req_describe(p_key text, p_change integer, p_keys jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_describe_code_change(pg_temp.c3_alice(), jsonb_build_object('operationKey', p_key,
		'owner', 'company', 'name', 'shop', 'change', p_change) || p_keys);
end $$;
-- What the agent is told of a refusal.
create function pg_temp.req_refused(p_reason text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'refused', 'reason', p_reason)
$$;
-- An undo that moved main from one commit to the other, as its job reports it.
create function pg_temp.req_moved(p_before text, p_after text) returns jsonb language sql immutable as $$
	select pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'undone', 'mainBefore', pg_temp.rec_sha(p_before),
		'mainAfter', pg_temp.rec_sha(p_after), 'filesChanged', 1, 'paths', '[{"path":"src/a.ts","change":"changed"}]'::jsonb,
		'pathsMore', 0))
$$;
-- An undo from the agent's call to the executor's finish: asked for, claimed (the claim is kept for a look), done.
create function pg_temp.req_undone(p_key text, p_change integer, p_later boolean, p_before text, p_after text,
	p_keys jsonb default '{}', p_name text default 'shop') returns jsonb language plpgsql as $$
declare v_asked jsonb := pg_temp.req_undo(p_key, p_change, p_later, p_keys, p_name); v_item jsonb;
begin
	perform pg_temp.base_assert(v_asked ->> 'state' = 'queued', 'the undo is asked for: ' || v_asked::text);
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_asked ->> 'requestId', 'the undo is claimed: ' || coalesce(v_item::text, 'none'));
	perform set_config('qorpera_test.req_item', v_item::text, true);
	return pg_temp.req_finish((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid, pg_temp.req_moved(p_before, p_after));
end $$;
-- A repository's rows in a line: L in main, R and the row that took it out, C a conflict, X refused, - lost.
create function pg_temp.req_rows(p_name text default 'shop') returns text language sql as $$
	select string_agg(c.n || ':' || case c.state when 'landed' then 'L' when 'reverted' then 'R' || c.reverted_by
		when 'conflict' then 'C' when 'refused' then 'X' else '-' end, ' ' order by c.n)
	from public.qorpera_code_changes c where c.environment_id = pg_temp.rec_here() and c.owner = 'company' and c.name = p_name
$$;
-- A member's call, as the web makes it: role authenticated, with that user's claims.
create function pg_temp.req_as(p_user uuid, p_call text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute 'select ' || p_call into v;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.req_owner() returns uuid language sql immutable as $$ select '92400000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.req_ask(p_file text, p_user uuid default pg_temp.req_owner(), p_name text default 'shop')
returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_request_code_download(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', 'company', p_name, p_file))
$$;
create function pg_temp.req_download(p_id uuid, p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_code_download(%L, %L)', '92400000-0000-4000-8000-000000000010', p_id))
$$;
create function pg_temp.req_list(p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_list_code_repositories(%L)', '92400000-0000-4000-8000-000000000010'))
$$;
-- The operator's call, as the database owner makes it.
create function pg_temp.req_restore(p_mode text, p_bundle text, p_damaged text, p_note text, p_name text default 'shop')
returns uuid language sql as $$
	select public.qorpera_request_code_restore(pg_temp.rec_here(), 'company', p_name, p_mode, p_bundle, p_damaged, p_note)
$$;

-- A restore's record, as the executor makes it inside the job that opens the place again: the bundle, main as restored,
-- and main when the place was closed (no word: it could not be read).
create function pg_temp.req_record_raw(p_id uuid, p_token uuid, p_restored jsonb, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_restore_record(p_owner, p_machine, p_id, p_token, p_restored);
	reset role;
	return v;
end $$;
create function pg_temp.req_restoring(p_bundle text, p_main text, p_previous text default null) returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.code-restore-record/v1', 'bundle', p_bundle, 'mainSha', pg_temp.rec_sha(p_main),
		'previousMainSha', pg_temp.rec_sha(p_previous))
$$;
create function pg_temp.req_record(p_id uuid, p_token uuid, p_bundle text, p_main text, p_previous text default null)
returns jsonb language sql as $$
	select pg_temp.req_record_raw(p_id, p_token, pg_temp.req_restoring(p_bundle, p_main, p_previous))
$$;
-- What the record answers: the restore's row, whether the restored main was found in the record, the newest row it
-- holds, and how many rows went and came back.
create function pg_temp.req_restored(p_change integer, p_kept integer, p_lost integer, p_back integer,
	p_boundary text default 'found') returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-restore-recorded/v1', 'state', 'recorded', 'change', p_change,
		'boundary', p_boundary, 'keptThrough', p_kept, 'lost', p_lost, 'back', p_back)
$$;
-- How a restore ended, as its executor says it after the job that opened the place has saved.
create function pg_temp.req_restore_outcome(p_bundle text, p_main text, p_keys jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'restored', 'bundle', p_bundle,
		'mainSha', pg_temp.rec_sha(p_main), 'previousMainSha', null, 'refsSha256', repeat('a', 64), 'refs', 9,
		'stranded', '[]'::jsonb, 'movedTo', null) || p_keys)
$$;
-- A download made, as its job goes: the step first (the job's place in the line is held, nothing is written yet), then
-- the finish once the job has saved.
create function pg_temp.req_made(p_id uuid, p_token uuid, p_outcome jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_assert(pg_temp.req_step(p_id, p_token) ->> 'state' = 'go', 'the download''s job is let go');
	return pg_temp.req_finish(p_id, p_token, p_outcome);
end $$;
-- A repository's downloads that read ready in the member's list: their requests, by file.
create function pg_temp.req_ready(p_name text default 'shop') returns jsonb language sql as $$
	select coalesce(jsonb_agg(d -> 'requestId' order by d ->> 'file') filter (where d ->> 'state' = 'ready'), '[]'::jsonb)
	from jsonb_array_elements((select r -> 'downloads' from jsonb_array_elements(pg_temp.req_list() -> 'repositories') r
		where r ->> 'name' = p_name)) d
$$;
-- The company's sessions are quiet: none is in a turn, none waits for an executor.
create function pg_temp.req_quiet() returns void language sql as $$
	update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null
	where environment_id = pg_temp.rec_here() and phase <> 'completed'
$$;
-- A restore from the operator's call to the executor's record: asked for, claimed (the claim is kept for a look and
-- for the finish), let go to move the place, and recorded. Answers what the record answered.
create function pg_temp.req_restore_to(p_bundle text, p_main text, p_name text, p_previous text default null)
returns jsonb language plpgsql as $$
declare v_id uuid; v_item jsonb;
begin
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', p_bundle, 'keep', 'A drill.', p_name);
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and not v_item ? 'tips',
		'the restore is claimed: ' || coalesce(v_item::text, 'none'));
	perform set_config('qorpera_test.req_item', v_item::text, true);
	-- The job that sets the place aside asks its step before it moves anything.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, jsonb_build_object('bundle', p_bundle,
		'step', 'set-aside')) ->> 'state' = 'go', 'the restore is let go to move the place');
	return pg_temp.req_record(v_id, (v_item ->> 'token')::uuid, p_bundle, p_main, p_previous);
end $$;
-- The finish of the restore req_restore_to recorded.
create function pg_temp.req_restore_end(p_bundle text, p_main text) returns jsonb language sql as $$
	select pg_temp.req_finish((current_setting('qorpera_test.req_item')::jsonb ->> 'requestId')::uuid,
		(current_setting('qorpera_test.req_item')::jsonb ->> 'token')::uuid, pg_temp.req_restore_outcome(p_bundle, p_main))
$$;

-- company/shop has six rows: five landings and a conflict. Main is at c5.
do $$
begin
	perform pg_temp.rec_land(1, 'c0', 'c1');
	perform pg_temp.rec_land(2, 'c1', 'c2');
	perform pg_temp.rec_record(pg_temp.rec_turn(3, 1, pg_temp.rec_sha('h3')), pg_temp.rec_report('conflict', pg_temp.rec_sha('h3'), null, null));
	perform pg_temp.rec_land(4, 'c2', 'c3');
	perform pg_temp.rec_land(5, 'c3', 'c4');
	perform pg_temp.rec_land(6, 'c4', 'c5');
	perform pg_temp.base_assert(pg_temp.req_rows() = '1:L 2:L 3:C 4:L 5:L 6:L' and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('c5'),
		'six rows: ' || pg_temp.req_rows());
end $$;

-- 1. An agent asks for an undo ----------------------------------------------------------------------------------------
do $$
declare v jsonb; v_bad jsonb; v_id uuid; q public.qorpera_code_requests%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_request jsonb := jsonb_build_object('operationKey', 'undo-shape', 'owner', 'company', 'name', 'shop', 'change', 6,
		'andLater', false, 'reason', 'It broke the checkout.', 'notice', null);
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (pg_temp.c3_alice() ->> 'runId')::uuid;
	-- The request has exactly its keys, each of its kind; only the notice may be left out.
	foreach v_bad in array array['null'::jsonb, '[]', v_request - 'reason', v_request - 'andLater', v_request - 'operationKey',
		v_request || '{"force":true}', v_request || '{"change":0}', v_request || '{"change":"6"}', v_request || '{"change":1.5}',
		v_request || '{"change":null}', v_request || '{"andLater":"yes"}', v_request || '{"andLater":null}',
		v_request || '{"reason":""}', v_request || '{"reason":"   "}', v_request || '{"reason":7}',
		v_request || jsonb_build_object('reason', repeat('r', 501)), v_request || jsonb_build_object('notice', E'One.\nTwo.'),
		v_request || '{"notice":7}', v_request || '{"notice":""}', v_request || jsonb_build_object('notice', repeat('n', 201)),
		v_request || '{"owner":"Company"}', v_request || '{"name":"shop."}', v_request || '{"owner":null}',
		v_request || '{"operationKey":"undo shape"}'] loop
		perform pg_temp.base_error(format('select public.qorpera_folder_request_code_undo(pg_temp.c3_alice(), %L)', v_bad),
			'22023', 'Code request is invalid');
	end loop;
	-- No such repository, no such number: P0002, and nothing is kept of the call (its key is free again).
	perform pg_temp.base_error($q$select pg_temp.req_undo('undo-none', 6, p_name => 'nowhere')$q$, 'P0002', 'No such change');
	perform pg_temp.base_error($q$select pg_temp.req_undo('undo-none', 99)$q$, 'P0002', 'No such change');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_requests)
		and not exists (select 1 from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_run.id
			and receipt.logical_operation_key like 'code:%'), 'nothing was kept');
	-- A change that never went into main has nothing to undo. The answer is the call's, also when it is asked again.
	v := pg_temp.req_undo('undo-none', 3);
	perform pg_temp.base_assert(v = pg_temp.req_refused('never_landed') and pg_temp.req_undo('undo-none', 3) = v
		and not exists (select 1 from public.qorpera_code_requests), 'never landed: ' || v::text);
	-- No executor holds the company: switched off, or two of them.
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.rec_here();
	perform pg_temp.base_assert(pg_temp.req_undo('undo-off', 6) = pg_temp.req_refused('no_executor'), 'the executor is off');
	update public.qorpera_coding_executors set enabled = true where environment_id = pg_temp.rec_here();
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
	values (pg_temp.rec_here(), 'exec-two', true, array['codex'], repeat('6', 64));
	perform pg_temp.base_assert(pg_temp.req_undo('undo-two', 6) = pg_temp.req_refused('no_executor'), 'two executors');
	delete from public.qorpera_coding_executors where owner = 'exec-two';
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_requests), 'a refusal adds no request');

	-- Asked: a request row, the agent's, with what it asked.
	v := pg_temp.req_undo('undo-1', 6, p_keys => '{"notice":"The old checkout is back."}');
	v_id := (v ->> 'requestId')::uuid;
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'queued', 'requestId', v_id)
		and q.environment_id = pg_temp.rec_here() and q.owner = 'company' and q.name = 'shop'
		and q.profile_id = '92400000-0000-4000-8000-000000000010' and q.kind = 'undo' and q.state = 'queued'
		and q.input = jsonb_build_object('change', 6, 'andLater', false, 'reason', 'It broke the checkout.',
			'notice', 'The old checkout is back.')
		and q.by_kind = 'agent' and q.by_agent_id = '92400000-0000-4000-8000-000000000030'
		and q.by_user_id is not distinct from v_run.requested_by_user_id and q.run_id = v_run.id and q.lease_token is null
		and q.attempts = 0 and q.not_before is null and q.progress is null and q.outcome is null and q.finished_at is null
		and q.expires_at is null, 'an undo is asked for: ' || to_jsonb(q)::text);
	-- The same call again answers the same; the same key for another request is another operation's. A notice left out
	-- is a null one: the same request.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-1', 6, p_keys => '{"notice":"The old checkout is back."}') = v
		and (select count(*) from public.qorpera_code_requests) = 1, 'a replay');
	perform pg_temp.base_assert(public.qorpera_folder_request_code_undo(pg_temp.c3_alice(), v_request - 'notice'
			|| '{"operationKey":"undo-none","change":3}') = pg_temp.req_refused('never_landed'), 'a notice left out');
	perform pg_temp.base_error($q$select pg_temp.req_undo('undo-1', 5)$q$, '23505', 'logical operation key is already bound to other work');
	-- Another call for the same undo (that change, alone) finds the open request, whatever reason or notice it gives.
	-- One for that change and every later one asks for something else: it is told the repository is busy, as is one
	-- for another change. It is never handed the open request, which would not do what it asked.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-1b', 6) = v
		and pg_temp.req_undo('undo-1b2', 6, p_keys => '{"reason":"Another reason.","notice":"Other words."}') = v
		and pg_temp.req_undo('undo-1c', 6, true) = pg_temp.req_refused('busy')
		and pg_temp.req_undo('undo-1d', 5) = pg_temp.req_refused('busy')
		and (select count(*) from public.qorpera_code_requests) = 1
		and (pg_temp.req_row(v_id)).input -> 'andLater' = 'false', 'one open undo, of one scope');
	-- The agent reads how it stands; another company's request, or none, is no request.
	perform pg_temp.base_assert(pg_temp.req_read(v_id) = jsonb_build_object('schema', 'qorpera.code-request/v1', 'requestId', v_id,
		'kind', 'undo', 'state', 'queued', 'result', null, 'change', null, 'code', null, 'paths', null), 'queued: ' || pg_temp.req_read(v_id)::text);
	perform pg_temp.base_error(format('select pg_temp.req_read(%L)', pg_temp.rec_copy(1)), 'P0002', 'No such code request');
	perform pg_temp.base_error('select pg_temp.req_read(null)', 'P0002', 'No such code request');
	perform set_config('qorpera_test.req_first', v_id::text, true);
end $$;

-- 2. Claim, step and finish of an undo --------------------------------------------------------------------------------
do $$
declare v jsonb; v_item jsonb; v_bad jsonb; v_id uuid := current_setting('qorpera_test.req_first')::uuid; v_token uuid;
	q public.qorpera_code_requests%rowtype; r public.qorpera_code_changes%rowtype; s public.qorpera_code_repositories%rowtype;
	v_lost jsonb := '{"schema":"qorpera.code-request-finish/v1","state":"lost"}';
	v_step_lost jsonb := '{"schema":"qorpera.code-request-step/v1","state":"lost"}';
	v_conflict jsonb := pg_temp.req_outcome('{"state":"refused","code":"CODE_HOST_UNDO_CONFLICT","paths":["src/a.ts","src/b.ts"]}');
	i integer;
begin
	-- Only the executor that holds the company claims its requests, at most 20 at a time.
	perform pg_temp.base_assert(pg_temp.req_claim(p_machine => repeat('6', 64)) = '[]'::jsonb
		and pg_temp.req_claim(p_owner => 'exec-none') = '[]'::jsonb and (pg_temp.req_row(v_id)).state = 'queued',
		'another machine, or no executor of it');
	perform pg_temp.base_error($q$select pg_temp.req_claim(0)$q$, '22023', 'Code request limit invalid');
	perform pg_temp.base_error($q$select pg_temp.req_claim(21)$q$, '22023', 'Code request limit invalid');
	perform pg_temp.base_error($q$select pg_temp.req_claim(null)$q$, '22023', 'Code request limit invalid');
	perform pg_temp.base_error($q$select pg_temp.req_claim(5, 'exec 1170')$q$, '42501', 'Coding machine custody required');
	perform pg_temp.base_error($q$select pg_temp.req_claim(5, 'exec-1170', repeat('5', 63))$q$, '42501', 'Coding machine custody required');
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', null);
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb, 'the company is being deleted');
	delete from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010';
	-- The claim: the request with its lease of five minutes, the target's two ends of main and the commit's message.
	v := pg_temp.req_claim();
	v_item := v -> 0;
	q := pg_temp.req_row(v_id);
	v_token := q.lease_token;
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v_item = jsonb_build_object('requestId', v_id, 'token', v_token,
			'leaseUntil', q.lease_until, 'companyId', '92400000-0000-4000-8000-000000000010', 'environmentId', pg_temp.rec_here(),
			'owner', 'company', 'name', 'shop', 'kind', 'undo', 'change', jsonb_build_object('n', 6,
				'mainBefore', pg_temp.rec_sha('c4'), 'mainAfter', pg_temp.rec_sha('c5')), 'andLater', false,
			'message', 'Undo change 6: Session 6')
		and v_token is not null and q.state = 'running' and q.lease_owner = 'exec-1170' and q.attempts = 1
		and q.lease_until between clock_timestamp() + interval '299 seconds' and clock_timestamp() + interval '5 minutes',
		'the claim: ' || v::text);
	-- While its lease lives nobody claims it again; the agent reads that it is being made.
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and pg_temp.req_read(v_id) ->> 'state' = 'running', 'leased');

	-- A step renews the lease of the caller that holds it.
	perform pg_temp.base_error(format('select pg_temp.req_step(%L, %L, %L)', v_id, v_token, '[]'), '22023', 'Code request progress invalid');
	perform pg_temp.base_assert(pg_temp.req_step(v_id, pg_temp.rec_copy(1)) = v_step_lost and pg_temp.req_step(v_id, null) = v_step_lost
		and pg_temp.req_step(pg_temp.rec_copy(1), v_token) = v_step_lost and pg_temp.req_step(null, v_token) = v_step_lost
		and pg_temp.req_step(v_id, v_token, p_owner => 'exec-none') = v_step_lost
		and pg_temp.req_step(v_id, v_token, p_machine => repeat('6', 64)) = v_step_lost, 'a step that is lost');
	update public.qorpera_code_requests set lease_until = clock_timestamp() + interval '10 seconds' where id = v_id;
	v := pg_temp.req_step(v_id, v_token);
	perform pg_temp.base_assert(v - 'leaseUntil' = '{"schema":"qorpera.code-request-step/v1","state":"go"}'
		and (v ->> 'leaseUntil')::timestamptz = (pg_temp.req_row(v_id)).lease_until
		and (pg_temp.req_row(v_id)).lease_until > clock_timestamp() + interval '299 seconds'
		and (pg_temp.req_row(v_id)).progress is null and (pg_temp.req_row(v_id)).attempts = 1, 'a step: ' || v::text);

	-- The finish: an outcome of one of the request's kind's shapes, from the caller that holds the lease.
	foreach v_bad in array array['null'::jsonb, '[]', '{"state":"done","result":"undone"}',
		pg_temp.req_outcome('{"state":"done"}'), pg_temp.req_outcome('{"state":"done","result":"done"}'),
		pg_temp.req_outcome('{"state":"queued"}'), pg_temp.req_moved('c5', 'u1') - 'mainAfter',
		pg_temp.req_moved('c5', 'u1') - 'paths', pg_temp.req_moved('c5', 'u1') || '{"paths":null}',
		pg_temp.req_moved('c5', 'u1') || '{"filesChanged":null}', pg_temp.req_moved('c5', 'u1') || '{"replayed":true}',
		pg_temp.req_moved('c5', 'u1') || '{"mainBefore":"c5"}', pg_temp.req_moved('c5', 'u1') || '{"schema":"qorpera.code-request-outcome/v2"}',
		pg_temp.req_outcome('{"state":"done","result":"nothing"}'), pg_temp.req_outcome('{"state":"done","result":"nothing","mainSha":"c5"}'),
		v_conflict - 'paths', v_conflict || '{"code":"a conflict"}', v_conflict || '{"code":"UNDO_CONFLICT"}',
		v_conflict || '{"paths":[7]}', v_conflict || '{"paths":"src/a.ts"}', v_conflict || '{"mainSha":null}',
		pg_temp.req_outcome('{"state":"busy","code":"BUSY"}'), pg_temp.req_outcome('{"state":"failed"}'),
		pg_temp.req_outcome('{"state":"failed","code":"it failed"}'), pg_temp.req_outcome('{"state":"failed","code":"X","detail":"y"}'),
		-- Another kind's outcome is not an undo's.
		pg_temp.req_outcome('{"state":"done","result":"removed"}'), pg_temp.req_outcome('{"state":"done","result":"discarded"}'),
		pg_temp.req_outcome('{"state":"refused","code":"CODE_HOST_DOWNLOAD_TOO_LARGE"}')] loop
		perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token, v_bad),
			'22023', 'Code request outcome invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, null)', v_id, v_token), '22023', 'Code request outcome invalid');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, pg_temp.rec_copy(1), v_conflict) = v_lost
		and pg_temp.req_finish(v_id, null, v_conflict) = v_lost and pg_temp.req_finish(pg_temp.rec_copy(1), v_token, v_conflict) = v_lost
		and pg_temp.req_finish(v_id, v_token, v_conflict, 'exec-none') = v_lost
		and pg_temp.req_finish(v_id, v_token, v_conflict, p_machine => repeat('6', 64)) = v_lost
		and to_jsonb(pg_temp.req_row(v_id)) = to_jsonb(q), 'a finish that is lost');
	-- Refused: later changes built on it. Nothing moved; the agent reads the files.
	v := pg_temp.req_finish(v_id, v_token, v_conflict);
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = pg_temp.req_recorded(null) and q.state = 'refused' and q.outcome = v_conflict
		and q.lease_token is null and q.lease_owner is null and q.lease_until is null
		and q.finished_at between clock_timestamp() - interval '1 minute' and clock_timestamp()
		and pg_temp.req_rows() = '1:L 2:L 3:C 4:L 5:L 6:L' and (pg_temp.rec_shop()).last_change = 6
		and pg_temp.req_read(v_id) = jsonb_build_object('schema', 'qorpera.code-request/v1', 'requestId', v_id, 'kind', 'undo',
			'state', 'refused', 'result', null, 'change', null, 'code', 'CODE_HOST_UNDO_CONFLICT',
			'paths', '["src/a.ts","src/b.ts"]'::jsonb), 'refused: ' || pg_temp.req_read(v_id)::text);
	-- Its lease is over: the token finishes nothing more, and nobody claims it.
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, v_conflict) = v_lost and pg_temp.req_step(v_id, v_token) = v_step_lost
		and pg_temp.req_claim() = '[]'::jsonb, 'a finished request');
	-- A commit of the row that the repository no longer holds is a refusal too.
	v_id := (pg_temp.req_undo('undo-2', 6) ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid,
			pg_temp.req_outcome('{"state":"refused","code":"CODE_HOST_UNDO_UNKNOWN_COMMIT","paths":[]}')) = pg_temp.req_recorded(null)
		and pg_temp.req_read(v_id) ->> 'code' = 'CODE_HOST_UNDO_UNKNOWN_COMMIT' and pg_temp.req_read(v_id) -> 'paths' = '[]'::jsonb,
		'an unknown commit');

	-- Undone: the undo's row, which says whose effect it took out; that row is reverted by it and its file says so.
	v := pg_temp.req_undone('undo-3', 6, false, 'c5', 'u1', '{"notice":"The old checkout is back."}');
	v_id := (current_setting('qorpera_test.req_item')::jsonb ->> 'requestId')::uuid;
	r := pg_temp.rec_row(7); s := pg_temp.rec_shop(); q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = pg_temp.req_recorded(7) and pg_temp.rec_is(7, 'undo', 'landed', 'c5', 'u1')
		and r.undoes = array[6] and r.title = 'Undo change 6: Session 6' and r.summary = 'It broke the checkout.'
		and r.notice = 'The old checkout is back.' and r.staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and r.owner_user_id is not distinct from q.by_user_id and r.request_id = v_id and r.worker_id is null and r.sequence is null
		and r.head_sha is null and r.how is null and r.files_changed = 1 and r.paths = '[{"path":"src/a.ts","change":"changed"}]'
		and r.paths_more = 0 and r.file_version = 1 and r.file_written = 0
		and pg_temp.req_rows() = '1:L 2:L 3:C 4:L 5:L 6:R7 7:L' and (pg_temp.rec_row(6)).file_version = 2
		and s.last_change = 7 and s.last_main = pg_temp.rec_sha('u1'), 'undone: ' || to_jsonb(r)::text);
	-- The request keeps the outcome, without the paths the row holds, and the row's number.
	perform pg_temp.base_assert(q.state = 'done' and q.outcome = (pg_temp.req_moved('c5', 'u1') - 'paths') || '{"change":7}'
		and pg_temp.req_read(v_id) = jsonb_build_object('schema', 'qorpera.code-request/v1', 'requestId', v_id, 'kind', 'undo',
			'state', 'done', 'result', 'undone', 'change', 7, 'code', null, 'paths', null), 'the undone request: ' || to_jsonb(q)::text);
	-- Already: the row is reverted, and nothing is asked for.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-4', 6) = jsonb_build_object('schema', 'qorpera.code-request/v1',
		'state', 'already', 'change', 6, 'undoneBy', 7) and (select count(*) from public.qorpera_code_requests) = 3, 'already');

	-- Main was not where the record had it when the undo's job ran: a filler for the gap first, then the undo's row.
	v := pg_temp.req_undone('undo-5', 2, false, 'x9', 'u2');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(9) and pg_temp.rec_is(8, 'found', 'landed', 'u1', 'x9')
		and pg_temp.rec_is(9, 'undo', 'landed', 'x9', 'u2') and (pg_temp.rec_row(9)).undoes = array[2]
		and (pg_temp.rec_row(9)).notice is null and pg_temp.req_rows() = '1:L 2:R9 3:C 4:L 5:L 6:R7 7:L 8:L 9:L'
		and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('u2'), 'a filler first: ' || pg_temp.req_rows());
	-- An undo of an undo puts its target back in main.
	v := pg_temp.req_undone('undo-6', 7, false, 'u2', 'u3');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(10) and (pg_temp.rec_row(10)).undoes = array[7]
		and (pg_temp.rec_row(10)).title = 'Undo change 7: Undo change 6: Session 6'
		and pg_temp.req_rows() = '1:L 2:R9 3:C 4:L 5:L 6:L 7:R10 8:L 9:L 10:L' and (pg_temp.rec_row(6)).reverted_by is null
		and (pg_temp.rec_row(6)).file_version = 3 and (pg_temp.rec_row(7)).file_version = 2, 'an undo of an undo: ' || pg_temp.req_rows());
	-- andLater: that change and every later one that is in main, newest first, each as it stands when its turn comes.
	-- The undo rows among them put their own targets back before those go too: change 2, undone by 9, is in main again,
	-- as it was before change 4.
	v := pg_temp.req_undone('undo-7', 4, true, 'u3', 'u4');
	v_item := current_setting('qorpera_test.req_item')::jsonb;
	perform pg_temp.base_assert(v = pg_temp.req_recorded(11) and v_item ->> 'message' = 'Go back to before change 4'
		and (v_item ->> 'andLater')::boolean and v_item -> 'change' = jsonb_build_object('n', 4, 'mainBefore', pg_temp.rec_sha('c2'),
			'mainAfter', pg_temp.rec_sha('c3'))
		and (pg_temp.rec_row(11)).undoes = array[4, 5, 6, 7, 8, 9, 10] and (pg_temp.rec_row(11)).title = 'Go back to before change 4'
		and pg_temp.req_rows() = '1:L 2:L 3:C 4:R11 5:R11 6:R11 7:R11 8:R11 9:R11 10:R11 11:L'
		and (pg_temp.rec_shop()).last_main = pg_temp.rec_sha('u4'), 'andLater: ' || pg_temp.req_rows());
	-- Its own undo puts every one of them back as it was: 2 undone by 9 again, 7 by 10, and 6 in main.
	v := pg_temp.req_undone('undo-8', 11, false, 'u4', 'u5');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(12) and (pg_temp.rec_row(12)).undoes = array[11]
		and pg_temp.req_rows() = '1:L 2:R9 3:C 4:L 5:L 6:L 7:R10 8:L 9:L 10:L 11:R12 12:L', 'an andLater undone: ' || pg_temp.req_rows());

	-- A finish that comes late. The undo of change 5 moved main from u5 to u6, and its finish was not heard. A landing
	-- after it was recorded: main was not where the record had it, so it left a filler that ends at the undo's commit.
	-- The undo takes the filler over, and the record's main stays where the landing left it.
	v_id := (pg_temp.req_undo('undo-9', 5) ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.rec_land(30, 'u6', 'c20') = pg_temp.rec_answer('recorded', 14)
		and pg_temp.rec_is(13, 'found', 'landed', 'u5', 'u6'), 'a landing after the undo');
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('u5', 'u6'));
	r := pg_temp.rec_row(13); s := pg_temp.rec_shop();
	perform pg_temp.base_assert(v = pg_temp.req_recorded(13) and pg_temp.rec_is(13, 'undo', 'landed', 'u5', 'u6')
		and r.undoes = array[5] and r.title = 'Undo change 5: Session 5' and r.request_id = v_id and r.files_changed = 1
		and r.paths = '[{"path":"src/a.ts","change":"changed"}]' and r.file_version = 2
		and r.own_before is null and r.own_after is null
		and pg_temp.req_rows() = '1:L 2:R9 3:C 4:L 5:R13 6:L 7:R10 8:L 9:L 10:L 11:R12 12:L 13:L 14:L'
		and s.last_change = 14 and s.last_main = pg_temp.rec_sha('c20'), 'a late finish: ' || pg_temp.req_rows());
	-- More was lost with it: the undo of change 4 moved main from c20 to u7, a landing after it was never recorded,
	-- and the next one left a filler from c20 to where it began. The undo is that filler's first step: it takes it
	-- over, and what the job counted for the undo alone is not the filler's.
	v_id := (pg_temp.req_undo('undo-10', 4) ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.rec_land(31, 'c21', 'c22') = pg_temp.rec_answer('recorded', 16)
		and pg_temp.rec_is(15, 'found', 'landed', 'c20', 'c21'), 'two landings after the undo');
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('c20', 'u7'));
	r := pg_temp.rec_row(15); s := pg_temp.rec_shop();
	perform pg_temp.base_assert(v = pg_temp.req_recorded(15) and pg_temp.rec_is(15, 'undo', 'landed', 'c20', 'c21')
		and r.undoes = array[4] and r.files_changed is null and r.paths is null
		-- The row keeps the filler's span, and the undo's own two ends beside it.
		and r.own_before = pg_temp.rec_sha('c20') and r.own_after = pg_temp.rec_sha('u7')
		and pg_temp.req_rows() = '1:L 2:R9 3:C 4:R15 5:R13 6:L 7:R10 8:L 9:L 10:L 11:R12 12:L 13:L 14:L 15:L 16:L'
		and s.last_change = 16 and s.last_main = pg_temp.rec_sha('c22'), 'a late finish, and more lost: ' || pg_temp.req_rows());

	-- Three starts and no finish: a fourth claim ends the request, and the agent reads that it did not finish.
	v_id := (pg_temp.req_undo('undo-11', 1) ->> 'requestId')::uuid;
	for i in 1..3 loop
		v_item := pg_temp.req_claim() -> 0;
		perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and (pg_temp.req_row(v_id)).attempts = i, 'start ' || i);
		perform pg_temp.req_lapse(v_id);
	end loop;
	-- A lease that ran out and was not claimed again is still its holder's: a step and a finish go by the token.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, (v_item ->> 'token')::uuid) ->> 'state' = 'go', 'the token is the lease');
	perform pg_temp.req_lapse(v_id);
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb, 'no fourth start');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.state = 'failed' and q.outcome = pg_temp.req_outcome('{"state":"failed","code":"DID_NOT_FINISH"}')
		and q.lease_token is null and q.finished_at is not null and pg_temp.req_read(v_id) ->> 'state' = 'failed'
		and pg_temp.req_read(v_id) ->> 'code' = 'DID_NOT_FINISH'
		and pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('c22', 'u8')) = v_lost
		and (pg_temp.rec_shop()).last_change = 16, 'it did not finish: ' || to_jsonb(q)::text);
	-- Put off: back in the queue for two minutes. Then main no longer holds what the change did: nothing is undone.
	v_id := (pg_temp.req_undo('undo-12', 1) ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_outcome('{"state":"busy"}'))
		= pg_temp.req_recorded(null), 'put off');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.state = 'queued' and q.lease_token is null and q.attempts = 1 and q.progress is null
		and q.not_before between clock_timestamp() + interval '119 seconds' and clock_timestamp() + interval '2 minutes'
		and q.finished_at is null and pg_temp.req_claim() = '[]'::jsonb and pg_temp.req_read(v_id) ->> 'state' = 'queued',
		'back in the queue: ' || to_jsonb(q)::text);
	perform pg_temp.req_now(v_id);
	v_item := pg_temp.req_claim() -> 0;
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'nothing', 'mainSha', pg_temp.rec_sha('c22'))));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(null) and (pg_temp.req_row(v_id)).state = 'done'
		and (pg_temp.req_row(v_id)).attempts = 2 and pg_temp.req_read(v_id) ->> 'result' = 'nothing'
		and pg_temp.req_read(v_id) -> 'change' = 'null' and (pg_temp.rec_shop()).last_change = 16
		and (pg_temp.rec_row(1)).state = 'landed', 'nothing: ' || pg_temp.req_read(v_id)::text);
	-- A request whose target is not there is not handed out: it ends, and says why.
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind)
	values (pg_temp.rec_here(), 'company', 'shop', '92400000-0000-4000-8000-000000000010', 'undo',
		'{"change":999,"andLater":false,"reason":"By hand.","notice":null}', 'operator') returning id into v_id;
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_id)).state = 'failed'
		and (pg_temp.req_row(v_id)).outcome ->> 'code' = 'CHANGE_UNAVAILABLE', 'a target that is not there');
	-- One movement of main is asked for at a time in a repository.
	perform pg_temp.base_error($q$insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind)
		select pg_temp.rec_here(), 'company', 'shop', '92400000-0000-4000-8000-000000000010', k, '{}', 'operator'
		from unnest(array['undo', 'restore']) k$q$, '23505');
end $$;

-- 3. Downloads --------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_item jsonb; v_files uuid; v_history uuid; v_id uuid; v_next uuid; q public.qorpera_code_requests%rowtype;
	v_company text := '92400000-0000-4000-8000-000000000010'; v_user uuid; i integer;
	v_owner uuid := pg_temp.req_owner(); v_member uuid := '92400000-0000-4000-8000-000000000002';
	v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_admin uuid := '92400000-0000-4000-8000-000000000004';
	v_outsider uuid := '92400000-0000-4000-8000-000000000005';
	v_day text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD');
	v_zip text := 'code/company/shop/downloads/shop-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') || '.zip';
	v_made jsonb;
begin
	v_made := pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'made', 'path', v_zip, 'bytes', 123456,
		'sha256', repeat('d', 64), 'mainSha', pg_temp.rec_sha('c22')));
	-- The list: every member reads it, viewers too; only owners and admins may ask for a download.
	v := pg_temp.req_list();
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-repositories/v1', 'canDownload', true,
		'repositories', jsonb_build_array(jsonb_build_object('owner', 'company', 'name', 'shop', 'changes', 16,
			'downloads', '[]'::jsonb))), 'the owner''s list: ' || v::text);
	perform pg_temp.base_assert((pg_temp.req_list(v_admin) ->> 'canDownload')::boolean
		and not (pg_temp.req_list(v_member) ->> 'canDownload')::boolean and not (pg_temp.req_list(v_viewer) ->> 'canDownload')::boolean
		and pg_temp.req_list(v_viewer) -> 'repositories' = v -> 'repositories', 'who may ask');
	-- Somebody who is no member, nobody at all, another company, and a call without a member's role: refused.
	perform pg_temp.base_error(format('select pg_temp.req_list(%L)', v_outsider), '42501', 'Code unavailable');
	perform pg_temp.base_error(format('select pg_temp.req_as(null, %L)', format('public.qorpera_list_code_repositories(%L)', v_company)),
		'42501', 'Code unavailable');
	perform pg_temp.base_error(format('select pg_temp.req_as(%L, %L)', v_owner,
		$q$public.qorpera_list_code_repositories('91170000-0000-4000-8000-000000000010')$q$), '42501', 'Code unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select public.qorpera_list_code_repositories(%L)', v_company), '42501', 'Code unavailable');
	perform pg_temp.base_error(format('select public.qorpera_request_code_download(%L, %L, %L, %L)', v_company, 'company', 'shop', 'files'),
		'42501', 'Code unavailable');
	perform pg_temp.base_error(format('select public.qorpera_code_download(%L, %L)', v_company, pg_temp.rec_copy(1)), '42501', 'Code unavailable');
	foreach v_user in array array[v_member, v_viewer, v_outsider] loop
		perform pg_temp.base_error(format('select pg_temp.req_ask(%L, %L)', 'files', v_user), '42501', 'Code unavailable');
		perform pg_temp.base_error(format('select pg_temp.req_download(%L, %L)', pg_temp.rec_copy(1), v_user), '42501', 'Code unavailable');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.req_as(%L, %L)', v_owner,
		$q$public.qorpera_request_code_download('91170000-0000-4000-8000-000000000010', 'company', 'shop', 'files')$q$),
		'42501', 'Code unavailable');
	-- What may be asked for: the files or the history of one of the company's repositories.
	perform pg_temp.base_error($q$select pg_temp.req_ask('everything')$q$, '22023', 'Code download request is invalid');
	perform pg_temp.base_error($q$select pg_temp.req_ask(null)$q$, '22023', 'Code download request is invalid');
	perform pg_temp.base_error($q$select pg_temp.req_ask('files', p_name => 'nowhere')$q$, 'P0002', 'No such repository');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_requests where kind = 'download'), 'nothing was asked');

	-- Asked: a request with the file's name of today. Asked again, by the admin: the same request.
	v := pg_temp.req_ask('files');
	v_files := (v ->> 'requestId')::uuid;
	q := pg_temp.req_row(v_files);
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', v_files, 'file', 'files',
			'state', 'queued', 'reason', null, 'path', null, 'bytes', null)
		and q.kind = 'download' and q.state = 'queued' and q.by_kind = 'member' and q.by_user_id = v_owner and q.by_agent_id is null
		and q.input = jsonb_build_object('file', 'files', 'fileName', 'shop-' || v_day || '.zip')
		and q.profile_id = v_company::uuid and q.name = 'shop', 'a download is asked for: ' || to_jsonb(q)::text);
	perform pg_temp.base_assert(pg_temp.req_ask('files', v_admin) = v and pg_temp.req_ask('files') = v
		and (select count(*) from public.qorpera_code_requests where kind = 'download') = 1, 'the same request');
	-- The history is another file, and another request.
	v_history := (pg_temp.req_ask('history', v_admin) ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_history <> v_files and (pg_temp.req_row(v_history)).input = jsonb_build_object('file', 'history',
		'fileName', 'shop-' || v_day || '.bundle') and (pg_temp.req_row(v_history)).by_user_id = v_admin, 'the history');
	-- An owner or admin reads how one stands; the list shows both to every member.
	perform pg_temp.base_assert(pg_temp.req_download(v_files, v_admin) = v
		and pg_temp.req_list(v_viewer) #> '{repositories,0,downloads}' = jsonb_build_array(
			jsonb_build_object('requestId', v_files, 'file', 'files', 'state', 'queued', 'path', null, 'bytes', null,
				'madeAt', null, 'expiresAt', null),
			jsonb_build_object('requestId', v_history, 'file', 'history', 'state', 'queued', 'path', null, 'bytes', null,
				'madeAt', null, 'expiresAt', null)), 'the list with two downloads: ' || pg_temp.req_list(v_viewer)::text);
	perform pg_temp.base_error(format('select pg_temp.req_download(%L)', pg_temp.rec_copy(1)), 'P0002', 'No such download');
	perform pg_temp.base_error(format('select pg_temp.req_download(%L)', current_setting('qorpera_test.req_first')), 'P0002', 'No such download');
	-- An agent's undo is not held up by a download, nor a download by an undo.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-beside', 1) ->> 'state' = 'queued', 'an undo beside the downloads');

	-- The claim: the oldest first; each download with its work, its file's name and where the file goes, for 30 minutes.
	v := pg_temp.req_claim();
	q := pg_temp.req_row(v_files);
	perform pg_temp.base_assert(jsonb_array_length(v) = 3 and v -> 0 = jsonb_build_object('requestId', v_files, 'token', q.lease_token,
			'leaseUntil', q.lease_until, 'companyId', v_company, 'environmentId', pg_temp.rec_here(), 'owner', 'company', 'name', 'shop',
			'kind', 'download', 'work', 'make', 'file', 'files', 'fileName', 'shop-' || v_day || '.zip', 'path', v_zip)
		and v -> 1 ->> 'requestId' = v_history::text and v -> 1 ->> 'file' = 'history' and v -> 1 ->> 'work' = 'make'
		and v -> 1 ->> 'path' = 'code/company/shop/downloads/shop-' || v_day || '.bundle' and v -> 2 ->> 'kind' = 'undo'
		and q.lease_until between clock_timestamp() + interval '29 minutes' and clock_timestamp() + interval '30 minutes',
		'the downloads are claimed: ' || v::text);
	perform pg_temp.base_assert(pg_temp.req_finish((v -> 2 ->> 'requestId')::uuid, (v -> 2 ->> 'token')::uuid, pg_temp.req_outcome(
		jsonb_build_object('state', 'done', 'result', 'nothing', 'mainSha', pg_temp.rec_sha('c22')))) = pg_temp.req_recorded(null), 'the undo beside');
	-- A made file counts only for a request whose job asked its step first: the step is where it gets the generation
	-- its file is made in.
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_files, q.lease_token, v_made),
		'55000', 'Code download was not begun');
	perform pg_temp.base_assert((pg_temp.req_row(v_files)).state = 'running' and (pg_temp.req_row(v_files)).artifact_generation is null,
		'no generation before its step');
	-- A download is never busy at a step, whatever the company's sessions do: a turn's job cancels its job instead.
	perform pg_temp.base_assert(public.qorpera_code_care_busy(pg_temp.rec_here(), clock_timestamp())
		and pg_temp.req_step(v_files, q.lease_token) ->> 'state' = 'go'
		and (pg_temp.req_row(v_files)).lease_until > clock_timestamp() + interval '29 minutes'
		and (pg_temp.req_row(v_files)).artifact_generation = 0 and (pg_temp.rec_shop()).artifact_generation = 0
		and (pg_temp.req_row(v_files)).progress is null
		and pg_temp.req_download(v_files) ->> 'state' = 'running', 'a download''s step');
	-- Made: the file is where the claim said, and lasts 7 days.
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_files, q.lease_token,
		v_made || '{"path":"code/company/shop/downloads/other.zip"}'), '22023', 'Code request outcome invalid');
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_files, q.lease_token,
		pg_temp.req_outcome('{"state":"done","result":"removed"}')), '22023', 'Code request outcome invalid');
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_files, q.lease_token, v_made - 'sha256'),
		'22023', 'Code request outcome invalid');
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_files, q.lease_token, pg_temp.req_moved('c22', 'u9')),
		'22023', 'Code request outcome invalid');
	perform pg_temp.base_assert(pg_temp.req_finish(v_files, q.lease_token, v_made) = pg_temp.req_recorded(null), 'made');
	q := pg_temp.req_row(v_files);
	perform pg_temp.base_assert(q.state = 'done' and q.outcome = v_made and q.lease_token is null and q.attempts = 0
		and q.expires_at between clock_timestamp() + interval '7 days' - interval '1 minute' and clock_timestamp() + interval '7 days'
		and q.finished_at is not null, 'the made download: ' || to_jsonb(q)::text);
	v := pg_temp.req_download(v_files);
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', v_files, 'file', 'files',
			'state', 'ready', 'reason', null, 'path', v_zip, 'bytes', 123456)
		and pg_temp.req_list(v_member) #> '{repositories,0,downloads,0}' = jsonb_build_object('requestId', v_files, 'file', 'files',
			'state', 'ready', 'path', v_zip, 'bytes', 123456, 'madeAt', q.finished_at, 'expiresAt', q.expires_at), 'ready: ' || v::text);
	-- Asked again while main is where the file was made: the file that is there.
	perform pg_temp.base_assert(pg_temp.req_ask('files', v_admin) = v
		and (select count(*) from public.qorpera_code_requests where kind = 'download') = 2, 'the same main again');
	-- Too large to make: the member is told so.
	perform pg_temp.base_assert(pg_temp.req_finish(v_history, (pg_temp.req_row(v_history)).lease_token,
			pg_temp.req_outcome('{"state":"refused","code":"CODE_HOST_DOWNLOAD_TOO_LARGE"}')) = pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_history)).state = 'refused'
		and pg_temp.req_download(v_history) = jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', v_history,
			'file', 'history', 'state', 'failed', 'reason', 'too_large', 'path', null, 'bytes', null), 'too large');

	-- Main moves: the file that is there is of an older main, so a new one is asked for.
	perform pg_temp.base_assert(pg_temp.rec_land(32, 'c22', 'c23') = pg_temp.rec_answer('recorded', 17), 'main moves');
	v := pg_temp.req_ask('files');
	v_next := (v ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_next <> v_files and v ->> 'state' = 'queued'
		and jsonb_array_length(pg_temp.req_list() #> '{repositories,0,downloads}') = 2, 'a new main, a new file: ' || v::text);
	-- Put off behind coding turns every time: five starts, and it ends. The member is told it was busy.
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.req_finish(v_next, (v_item ->> 'token')::uuid, pg_temp.req_outcome('{"state":"busy"}'))
		= pg_temp.req_recorded(null) and (pg_temp.req_row(v_next)).progress = '{"busy":true}'
		and (pg_temp.req_row(v_next)).state = 'queued' and pg_temp.req_download(v_next) ->> 'state' = 'queued', 'a download put off');
	for i in 2..5 loop
		perform pg_temp.req_now(v_next);
		v_item := pg_temp.req_claim() -> 0;
		perform pg_temp.base_assert(v_item ->> 'requestId' = v_next::text and (pg_temp.req_row(v_next)).attempts = i, 'start ' || i);
		perform pg_temp.req_finish(v_next, (v_item ->> 'token')::uuid, pg_temp.req_outcome('{"state":"busy"}'));
	end loop;
	perform pg_temp.req_now(v_next);
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_next)).state = 'failed'
		and (pg_temp.req_row(v_next)).outcome ->> 'code' = 'DID_NOT_FINISH'
		and pg_temp.req_download(v_next) = jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', v_next,
			'file', 'files', 'state', 'failed', 'reason', 'busy', 'path', null, 'bytes', null), 'busy to the end');
	-- Any other failure is told as one.
	v_id := (pg_temp.req_ask('history') ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid,
			pg_temp.req_outcome('{"state":"failed","code":"CODE_HOST_DOWNLOAD_FAILED"}')) = pg_temp.req_recorded(null)
		and pg_temp.req_download(v_id) ->> 'state' = 'failed' and pg_temp.req_download(v_id) ->> 'reason' = 'failed', 'failed');

	-- The rate: 20 download requests of the company in 24 hours. Four were asked for; sixteen more, by hand.
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind)
	select pg_temp.rec_here(), 'company', 'shop', v_company::uuid, 'download', '{"file":"history","fileName":"x.bundle"}', 'failed', 'member'
	from generate_series(1, 16);
	perform pg_temp.base_assert(pg_temp.req_ask('history') = jsonb_build_object('schema', 'qorpera.code-download/v1',
		'requestId', null, 'file', 'history', 'state', 'refused', 'reason', 'too_many', 'path', null, 'bytes', null), 'too many');
	-- One of the twenty is older than a day: one more may be asked for.
	update public.qorpera_code_requests set created_at = clock_timestamp() - interval '25 hours'
	where id = (select id from public.qorpera_code_requests where kind = 'download' and state = 'failed' and input ->> 'fileName' = 'x.bundle' limit 1);
	-- No executor holds the company: refused, and nothing is asked for.
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.rec_here();
	perform pg_temp.base_assert(pg_temp.req_ask('history') ->> 'reason' = 'no_executor' and pg_temp.req_ask('history') ->> 'state' = 'refused',
		'no executor');
	update public.qorpera_coding_executors set enabled = true where environment_id = pg_temp.rec_here();
	v_history := (pg_temp.req_ask('history') ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_history is not null and (pg_temp.req_row(v_history)).state = 'queued', 'one more');
	perform pg_temp.base_assert(pg_temp.req_ask('files') ->> 'reason' = 'too_many', 'and then too many again');

	-- The made file's time is over: no member is shown it, and the executor is asked to remove it.
	update public.qorpera_code_requests set expires_at = clock_timestamp() - interval '1 second' where id = v_files;
	perform pg_temp.base_assert(pg_temp.req_download(v_files) ->> 'state' = 'failed' and pg_temp.req_download(v_files) ->> 'reason' = 'failed'
		and not exists (select 1 from jsonb_array_elements(pg_temp.req_list() #> '{repositories,0,downloads}') d
			where d ->> 'requestId' = v_files::text), 'its time is over');
	v := pg_temp.req_claim();
	q := pg_temp.req_row(v_files);
	perform pg_temp.base_assert(jsonb_array_length(v) = 2 and v -> 0 ->> 'requestId' = v_history::text and v -> 0 ->> 'work' = 'make'
		and v -> 1 = jsonb_build_object('requestId', v_files, 'token', q.lease_token, 'leaseUntil', q.lease_until,
			'companyId', v_company, 'environmentId', pg_temp.rec_here(), 'owner', 'company', 'name', 'shop', 'kind', 'download',
			'work', 'remove', 'file', 'files', 'fileName', 'shop-' || v_day || '.zip', 'path', v_zip)
		and q.state = 'done' and q.attempts = 1 and pg_temp.req_claim() = '[]'::jsonb, 'the removal is claimed: ' || v::text);
	-- A removal ends removed, put off or failed, and nothing else. Failed: it is tried again in ten minutes.
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_files, q.lease_token, v_made), '22023', 'Code request outcome invalid');
	perform pg_temp.base_assert(pg_temp.req_finish(v_files, q.lease_token, pg_temp.req_outcome('{"state":"failed","code":"CODE_HOST_JOB_FAILED"}'))
		= pg_temp.req_recorded(null), 'a removal that failed');
	q := pg_temp.req_row(v_files);
	perform pg_temp.base_assert(q.state = 'done' and q.outcome = v_made and q.lease_token is null
		and q.not_before between clock_timestamp() + interval '9 minutes' and clock_timestamp() + interval '10 minutes'
		and pg_temp.req_claim() = '[]'::jsonb, 'tried again later: ' || to_jsonb(q)::text);
	perform pg_temp.req_now(v_files);
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'work' = 'remove' and pg_temp.req_finish(v_files, (v_item ->> 'token')::uuid,
			pg_temp.req_outcome('{"state":"done","result":"removed"}')) = pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_files)).state = 'expired' and (pg_temp.req_row(v_files)).lease_token is null
		and pg_temp.req_claim() = '[]'::jsonb and pg_temp.req_download(v_files) ->> 'state' = 'failed', 'removed');

	-- A file is removed by its name, and two downloads of one kind on one day have the same name. The history is made;
	-- main moves and a newer one is asked for. The older one's time ends while the newer one is on its way: it waits.
	-- Once the newer one's job is let go, it replaces the older one's file: the older one is over, nothing is left to
	-- remove, and no job is asked for.
	perform pg_temp.req_made(v_history, (pg_temp.req_row(v_history)).lease_token, pg_temp.req_outcome(jsonb_build_object(
		'state', 'done', 'result', 'made', 'path', 'code/company/shop/downloads/shop-' || v_day || '.bundle', 'bytes', 99,
		'sha256', repeat('e', 64), 'mainSha', pg_temp.rec_sha('c23'))));
	update public.qorpera_code_requests set created_at = clock_timestamp() - interval '25 hours' where kind = 'download' and state = 'failed';
	perform pg_temp.base_assert(pg_temp.rec_land(33, 'c23', 'c24') = pg_temp.rec_answer('recorded', 18), 'main moves again');
	v_next := (pg_temp.req_ask('history') ->> 'requestId')::uuid;
	update public.qorpera_code_requests set expires_at = clock_timestamp() - interval '1 second' where id = v_history;
	v := pg_temp.req_claim();
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v -> 0 ->> 'requestId' = v_next::text
		and (pg_temp.req_row(v_history)).state = 'done' and (pg_temp.req_row(v_history)).lease_token is null, 'the older one waits: ' || v::text);
	perform pg_temp.base_assert(pg_temp.req_step(v_next, (v -> 0 ->> 'token')::uuid) ->> 'state' = 'go'
		and (pg_temp.req_row(v_history)).state = 'expired', 'the newer one''s job ends the older one');
	perform pg_temp.req_finish(v_next, (v -> 0 ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object(
		'state', 'done', 'result', 'made', 'path', 'code/company/shop/downloads/shop-' || v_day || '.bundle', 'bytes', 101,
		'sha256', repeat('f', 64), 'mainSha', pg_temp.rec_sha('c24'))));
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_history)).state = 'expired'
		and (pg_temp.req_row(v_next)).state = 'done' and pg_temp.req_ask('history') ->> 'requestId' = v_next::text
		and pg_temp.req_ask('history') ->> 'state' = 'ready', 'the newer one has the file');
	-- Six claims of a removal and no finish: the request ends, and the file stays until the next one replaces it.
	update public.qorpera_code_requests set expires_at = clock_timestamp() - interval '1 second' where id = v_next;
	for i in 1..5 loop
		v_item := pg_temp.req_claim() -> 0;
		perform pg_temp.base_assert(v_item ->> 'work' = 'remove' and (pg_temp.req_row(v_next)).attempts = i, 'removal start ' || i);
		perform pg_temp.req_lapse(v_next);
	end loop;
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_next)).state = 'expired'
		and (pg_temp.req_row(v_next)).lease_token is null, 'a removal that never finished');
	-- One download of each file is open at a time in a repository.
	perform pg_temp.base_error(format($q$insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind)
		select pg_temp.rec_here(), 'company', 'shop', %L, 'download', '{"file":"files","fileName":"a.zip"}', 'member'
		from generate_series(1, 2)$q$, v_company), '23505');
end $$;
-- A made download is ready only while its file is the one it made. The job that makes a download replaces what
-- downloads/ holds of its kind, and asks its step before its first command: from that step on the older made download
-- of that file is over, whatever becomes of the job and of its finish. The other kind's file is not touched.
do $$
declare v jsonb; v_item jsonb; v_old uuid; v_new uuid; v_third uuid; v_other uuid; v_first uuid; v_second uuid;
	q public.qorpera_code_requests%rowtype;
	v_zip text := 'code/company/shop/downloads/shop-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') || '.zip';
	v_bundle text := 'code/company/shop/downloads/shop-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') || '.bundle';
	v_made jsonb; v_lost jsonb := '{"schema":"qorpera.code-request-finish/v1","state":"lost"}';
	v_failed jsonb;
begin
	v_made := pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'made', 'path', v_zip, 'bytes', 201,
		'sha256', repeat('3', 64), 'mainSha', pg_temp.rec_sha('c25')));
	-- (The day's rate starts again.)
	update public.qorpera_code_requests set created_at = created_at - interval '25 hours' where kind = 'download';
	v_old := (pg_temp.req_ask('files') ->> 'requestId')::uuid;
	v_other := (pg_temp.req_ask('history') ->> 'requestId')::uuid;
	v := pg_temp.req_claim();
	perform pg_temp.base_assert(jsonb_array_length(v) = 2 and v -> 0 ->> 'requestId' = v_old::text and v -> 1 ->> 'requestId' = v_other::text,
		'two downloads are claimed: ' || v::text);
	perform pg_temp.req_made(v_old, (v -> 0 ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'made', 'path', v_zip, 'bytes', 200, 'sha256', repeat('1', 64), 'mainSha', pg_temp.rec_sha('c24'))));
	perform pg_temp.req_made(v_other, (v -> 1 ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'made', 'path', v_bundle, 'bytes', 300, 'sha256', repeat('2', 64), 'mainSha', pg_temp.rec_sha('c24'))));
	perform pg_temp.base_assert(pg_temp.req_download(v_old) ->> 'state' = 'ready' and pg_temp.req_download(v_other) ->> 'state' = 'ready'
		and pg_temp.req_ask('files') ->> 'requestId' = v_old::text and pg_temp.req_ready() = jsonb_build_array(v_old, v_other), 'both are ready');
	v_failed := jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', v_old, 'file', 'files', 'state', 'failed',
		'reason', 'failed', 'path', null, 'bytes', null);
	-- Main moves, and the files are asked for again: a new request. Claimed, its job has not begun: the older file is
	-- still there.
	perform pg_temp.base_assert(pg_temp.rec_land(34, 'c24', 'c25') = pg_temp.rec_answer('recorded', 19), 'main moves once more');
	v_new := (pg_temp.req_ask('files') ->> 'requestId')::uuid;
	v_first := (pg_temp.req_claim() -> 0 ->> 'token')::uuid;
	perform pg_temp.base_assert(v_new <> v_old and pg_temp.req_download(v_old) ->> 'state' = 'ready'
		and pg_temp.req_download(v_new) ->> 'state' = 'running', 'a newer one is on its way');
	-- Its job is let go, and replaces the file. The older download is over from this step: to the member who reads it,
	-- in the list, and for one who asks again (who gets the one on its way).
	perform pg_temp.base_assert(pg_temp.req_step(v_new, v_first) ->> 'state' = 'go', 'the newer one''s job is let go');
	q := pg_temp.req_row(v_old);
	perform pg_temp.base_assert(q.state = 'expired' and q.lease_token is null and pg_temp.req_download(v_old) = v_failed
		and pg_temp.req_ready() = jsonb_build_array(v_other) and pg_temp.req_download(v_other) ->> 'state' = 'ready'
		and (pg_temp.req_row(v_other)).state = 'done' and pg_temp.req_ask('files') ->> 'requestId' = v_new::text
		and pg_temp.req_ask('files') ->> 'state' = 'running',
		'the older download of that file is over at the newer one''s step: ' || to_jsonb(q)::text || ' ' || pg_temp.req_list()::text);
	-- The newer one's finish never comes. Its lease ends and it is claimed again; the older one stays over.
	perform pg_temp.req_lapse(v_new);
	v_item := pg_temp.req_claim() -> 0;
	v_second := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_new::text and (pg_temp.req_row(v_new)).attempts = 2 and v_second <> v_first
		and pg_temp.req_download(v_old) = v_failed and pg_temp.req_ready() = jsonb_build_array(v_other), 'a finish that never came');
	-- The second job is let go. Now the first job's finish arrives: it is not the request's lease any more, and makes
	-- nothing ready.
	perform pg_temp.base_assert(pg_temp.req_step(v_new, v_second) ->> 'state' = 'go'
		and pg_temp.req_finish(v_new, v_first, v_made) = v_lost and (pg_temp.req_row(v_new)).state = 'running'
		and pg_temp.req_ready() = jsonb_build_array(v_other), 'the first job''s finish after the second job began');
	-- The second job fails. Nothing of that file is ready, and the older one is not ready again: asking makes a new
	-- request.
	perform pg_temp.base_assert(pg_temp.req_finish(v_new, v_second, pg_temp.req_outcome('{"state":"failed","code":"CODE_HOST_DOWNLOAD_FAILED"}'))
		= pg_temp.req_recorded(null) and pg_temp.req_download(v_new) ->> 'state' = 'failed'
		and pg_temp.req_download(v_old) = v_failed and pg_temp.req_ready() = jsonb_build_array(v_other), 'a replacement that failed');
	v_third := (pg_temp.req_ask('files') ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_third not in (v_old, v_new) and v_item ->> 'requestId' = v_third::text
		and pg_temp.req_made(v_third, (v_item ->> 'token')::uuid, v_made) = pg_temp.req_recorded(null)
		and pg_temp.req_download(v_third) ->> 'state' = 'ready' and pg_temp.req_ready() = jsonb_build_array(v_third, v_other),
		'the next one is made: ' || pg_temp.req_list()::text);
	-- A finish of the older request that arrives after the newer one was made ends nothing and makes nothing ready: the
	-- older request holds no lease.
	perform pg_temp.base_assert(pg_temp.req_finish(v_new, v_second, v_made) = v_lost and pg_temp.req_finish(v_new, v_first, v_made) = v_lost
		and (pg_temp.req_row(v_new)).state = 'failed' and (pg_temp.req_row(v_third)).state = 'done'
		and pg_temp.req_ask('files') ->> 'requestId' = v_third::text and pg_temp.req_ask('files') ->> 'state' = 'ready'
		and pg_temp.req_ready() = jsonb_build_array(v_third, v_other), 'the older request''s finish after the newer one was made');
	-- And nothing is asked to be removed for the one that was replaced, when its 7 days would have been over.
	update public.qorpera_code_requests set expires_at = clock_timestamp() - interval '1 second' where id = v_old;
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_old)).state = 'expired', 'no removal for it');
end $$;

-- 4. Restore ----------------------------------------------------------------------------------------------------------
-- company/site: three landings, an undo of the second, a conflict, and a landing after a movement nobody recorded.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'site');
-- The owner's coding machine, for a session to be on.
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values (pg_temp.rec_copy(901), 'member', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'92400000-0000-4000-8000-000000000001', 'exec-1170', repeat('7', 64), '{}');
set local session_replication_role = origin;
do $$
begin
	perform pg_temp.rec_land(40, 's0', 's1', p_name => 'site');
	perform pg_temp.rec_land(41, 's1', 's2', p_name => 'site');
	perform pg_temp.rec_land(42, 's2', 's3', p_name => 'site');
	perform pg_temp.base_assert(pg_temp.req_undone('undo-site', 2, false, 's3', 's4', p_name => 'site') = pg_temp.req_recorded(4), 'site''s undo');
	perform pg_temp.rec_record(pg_temp.rec_turn(43, 1, pg_temp.rec_sha('h43'), '{}', pg_temp.own_repo('company', 'site')),
		pg_temp.rec_report('conflict', pg_temp.rec_sha('h43'), null, null));
	perform pg_temp.rec_land(44, 's5', 's6', p_name => 'site');
	perform pg_temp.base_assert(pg_temp.req_rows('site') = '1:L 2:R4 3:L 4:L 5:C 6:L 7:L' and pg_temp.rec_is(6, 'found', 'landed', 's4', 's5', 'site'),
		'site''s rows: ' || pg_temp.req_rows('site'));
	-- Its files are written, and care has looked at it.
	perform pg_temp.rec_written(pg_temp.rec_wrote((select jsonb_agg(jsonb_build_object('n', c.n, 'version', c.file_version))
		from public.qorpera_code_changes c where c.environment_id = pg_temp.rec_here() and c.name = 'site'),
		(pg_temp.rec_shop('site')).index_version), 'site');
	update public.qorpera_code_repositories set refs_sha256 = repeat('b', 64), main_sha = pg_temp.rec_sha('s6'),
		next_care_at = clock_timestamp() + interval '1 day' where name = 'site';
	perform pg_temp.base_assert(pg_temp.rec_files(p_name => 'site') -> 'changes' = '[]'::jsonb
		and pg_temp.rec_files(p_name => 'site') -> 'index' = 'null', 'site''s files are written');
end $$;
do $$
declare v jsonb; v_item jsonb; v_id uuid; v_undo uuid; v_token uuid; q public.qorpera_code_requests%rowtype;
	r public.qorpera_code_changes%rowtype; s public.qorpera_code_repositories%rowtype; v_role text; i integer;
	v_call text; v_bad jsonb;
	v_bundle text := '20261109T021455Z-0123456789ab'; v_aside text := 'code/_set-aside/company/at-20261110T120000Z/site';
	v_progress jsonb; v_restored jsonb; b1 uuid := '91170000-0000-4000-8000-0000000000b1'; v_recorded jsonb;
	v_held jsonb := '{"held":true}';
	v_record_lost jsonb := '{"schema":"qorpera.code-restore-recorded/v1","state":"lost"}';
	v_fresh text := '20261110T160000Z-ba9876543210';
begin
	v_progress := jsonb_build_object('bundle', v_bundle, 'setAside', v_aside);
	v_restored := pg_temp.req_restore_outcome(v_bundle, 's3', jsonb_build_object('previousMainSha', pg_temp.rec_sha('s6'),
		'stranded', jsonb_build_array(pg_temp.rec_copy(44)), 'movedTo', v_aside));
	-- Only the database owner asks for a restore.
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_claims(v_role);
		execute format('set local role %I', v_role);
		perform pg_temp.base_error(format($q$select public.qorpera_request_code_restore(%L, 'company', 'site', 'verify', %L, null, 'A drill.')$q$,
			pg_temp.rec_here(), v_bundle), '42501', 'permission denied for function qorpera_request_code_restore');
		reset role;
	end loop;
	perform pg_temp.base_claims('service_role');
	-- What may be asked for: verify a stored bundle; restore from one, or from a fresh one, and keep or remove the place;
	-- discard one set-aside copy of the repository.
	foreach v_call in array array[$q$'repair', '20261109T021455Z-0123456789ab', 'keep', 'x'$q$,
		$q$null, '20261109T021455Z-0123456789ab', 'keep', 'x'$q$, $q$'verify', 'fresh', null, 'x'$q$, $q$'verify', null, null, 'x'$q$,
		$q$'restore', '20261109T021455Z-0123456789ab.bundle', 'keep', 'x'$q$, $q$'restore', '20261109T021455Z-0123456789ab', null, 'x'$q$,
		$q$'restore', 'fresh', 'archive', 'x'$q$, $q$'restore', 'fresh', 'keep', repeat('n', 1001)$q$,
		$q$'discard', 'fresh', null, 'code/_set-aside/company/at-20261110T120000Z/site', 'site'$q$,
		$q$'discard', null, null, 'code/company/site', 'site'$q$,
		$q$'discard', null, null, 'code/_set-aside/company/at-20261110T120000Z/shop', 'site'$q$,
		$q$'discard', null, null, 'code/_set-aside/other/at-20261110T120000Z/site', 'site'$q$,
		$q$'discard', null, null, 'code/_set-aside/company/at-20261110T120000Z/site/main', 'site'$q$,
		$q$'discard', null, 'archive', 'code/_set-aside/company/at-20261110T120000Z/site', 'site'$q$,
		$q$'discard', null, null, null, 'site'$q$] loop
		perform pg_temp.base_error(format('select pg_temp.req_restore(%s)', v_call), '22023', 'Code restore request is invalid');
	end loop;
	perform pg_temp.base_error($q$select pg_temp.req_restore('verify', '20261109T021455Z-0123456789ab', null, 'x', 'nowhere')$q$,
		'P0002', 'No such repository');
	-- One movement of main is asked for at a time: not while an undo is open, and no undo while a restore is.
	v_undo := (pg_temp.req_undo('undo-open', 3, p_name => 'site') ->> 'requestId')::uuid;
	perform pg_temp.base_error(format($q$select pg_temp.req_restore('verify', %L, null, 'x', 'site')$q$, v_bundle),
		'55000', 'An undo or a restore is already asked for in this repository');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.req_finish(v_undo, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'nothing', 'mainSha', pg_temp.rec_sha('s6'))));

	-- Verify: the request is the operator's. It is claimed whatever the company's sessions do (it writes nothing in the
	-- folder), for two hours, with the repository's open sessions. (The rows are not handed out: which of them the
	-- restored main holds is the kernel's own to find.)
	v_id := pg_temp.req_restore('verify', v_bundle, null, 'The monthly drill.', 'site');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.kind = 'restore' and q.state = 'queued' and q.by_kind = 'operator' and q.by_user_id is null
		and q.by_agent_id is null and q.run_id is null and q.profile_id = '92400000-0000-4000-8000-000000000010' and q.name = 'site'
		and q.input = jsonb_build_object('mode', 'verify', 'bundle', v_bundle, 'damaged', 'keep', 'note', 'The monthly drill.',
			'path', null), 'a verify is asked for: ' || to_jsonb(q)::text);
	perform pg_temp.base_assert(pg_temp.req_undo('undo-walled', 3, p_name => 'site') = pg_temp.req_refused('busy')
		and pg_temp.req_undo('undo-shop', 1) ->> 'state' = 'queued', 'no undo while a restore is open, in that repository');
	perform pg_temp.base_assert(public.qorpera_code_care_busy(pg_temp.rec_here(), clock_timestamp()), 'fixture: sessions are at work');
	v := pg_temp.req_claim();
	v_item := v -> 0;
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(jsonb_array_length(v) = 2 and v_item - 'sessions' = jsonb_build_object('requestId', v_id,
			'token', q.lease_token, 'leaseUntil', q.lease_until, 'companyId', '92400000-0000-4000-8000-000000000010',
			'environmentId', pg_temp.rec_here(), 'owner', 'company', 'name', 'site', 'kind', 'restore', 'mode', 'verify',
			'bundle', v_bundle, 'damaged', 'keep', 'progress', null, 'path', null)
		and v_item -> 'sessions' = (select jsonb_agg(jsonb_build_object('workerId', pg_temp.rec_copy(n), 'baseSha', pg_temp.rec_sha('base'))
			order by pg_temp.rec_copy(n)) from generate_series(40, 44) n)
		and q.lease_until between clock_timestamp() + interval '119 minutes' and clock_timestamp() + interval '2 hours'
		and v -> 1 ->> 'kind' = 'undo', 'the verify is claimed: ' || v::text);
	perform pg_temp.req_finish((v -> 1 ->> 'requestId')::uuid, (v -> 1 ->> 'token')::uuid, pg_temp.req_outcome(
		jsonb_build_object('state', 'done', 'result', 'nothing', 'mainSha', pg_temp.rec_sha('c24'))));
	-- A request ends as its mode does, and a verify writes no row and records no restore.
	foreach v_bad in array array[v_restored, pg_temp.req_outcome('{"state":"done","result":"discarded"}')] loop
		perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, q.lease_token, v_bad),
			'22023', 'Code request outcome invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.req_record(%L, %L, %L, %L)', v_id, q.lease_token, v_bundle, 's3'),
		'22023', 'Code restore record invalid');
	v := pg_temp.req_finish(v_id, q.lease_token, pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'verified',
		'mainSha', pg_temp.rec_sha('s6'), 'refsSha256', repeat('a', 64), 'refs', 9)));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(null) and (pg_temp.req_row(v_id)).state = 'done'
		and (pg_temp.req_row(v_id)).outcome ->> 'result' = 'verified' and pg_temp.req_rows('site') = '1:L 2:R4 3:L 4:L 5:C 6:L 7:L'
		and (pg_temp.rec_shop('site')).last_change = 7, 'verified: ' || v::text);

	-- Restore: it waits while a session of the company is at work, and says so.
	v_id := pg_temp.req_restore('restore', v_bundle, 'keep', 'The folder lost objects.', 'site');
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb, 'a restore waits');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.state = 'queued' and q.progress = '{"waiting":"SESSIONS_BUSY"}' and q.attempts = 0
		and q.lease_token is null and q.input = jsonb_build_object('mode', 'restore', 'bundle', v_bundle, 'damaged', 'keep',
			'note', 'The folder lost objects.', 'path', null), 'it waits for the sessions: ' || to_jsonb(q)::text);
	-- The sessions are quiet, but one of the repository's is on a machine.
	update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null
	where environment_id = pg_temp.rec_here();
	update public.qorpera_coding_sessions set attached_machine_id = pg_temp.rec_copy(901), attachment_token = pg_temp.rec_copy(902),
		attachment_until = clock_timestamp(), attachment_turn = 1, attached_at = clock_timestamp()
	where worker_id in (pg_temp.rec_copy(40), pg_temp.rec_copy(1));
	perform pg_temp.base_assert(not public.qorpera_code_care_busy(pg_temp.rec_here(), clock_timestamp())
		and pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_id)).progress = '{"waiting":"SESSIONS_ATTACHED"}'
		and (pg_temp.req_row(v_id)).attempts = 0, 'it waits for the machine');
	-- Off the machine. A session of another repository on a machine holds nothing back. The claim says nothing of the wait.
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = pg_temp.rec_copy(40);
	v_item := pg_temp.req_claim() -> 0;
	q := pg_temp.req_row(v_id);
	v_token := q.lease_token;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item ->> 'mode' = 'restore' and v_item ->> 'damaged' = 'keep'
		and v_item -> 'progress' = 'null' and q.progress is null and q.state = 'running' and q.attempts = 1
		and not v_item ? 'tips' and jsonb_array_length(v_item -> 'sessions') = 5, 'the restore is claimed: ' || v_item::text);
	-- Until the restore is let go to close the place, a session that starts stops its job: the close is put off, and
	-- nothing is saved.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'close'))
			= '{"schema":"qorpera.code-request-step/v1","state":"busy"}'
		and pg_temp.req_step(v_id, v_token, '{"bundle":"other"}') ->> 'state' = 'busy'
		and pg_temp.req_step(v_id, v_token) ->> 'state' = 'busy' and (pg_temp.req_row(v_id)).progress is null, 'busy at a step');
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	update public.qorpera_coding_sessions set attached_machine_id = pg_temp.rec_copy(901), attachment_token = pg_temp.rec_copy(902),
		attachment_until = clock_timestamp(), attachment_turn = 1, attached_at = clock_timestamp() where worker_id = pg_temp.rec_copy(41);
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'close')) ->> 'state' = 'busy'
		and (pg_temp.req_row(v_id)).progress is null, 'a session went on a machine');
	-- The sessions are quiet. Before each job the lease is renewed and what was done so far is kept; and the close
	-- that is let go is where the kernel writes its own word that the request holds the place.
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = pg_temp.rec_copy(41);
	v := pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'close'));
	perform pg_temp.base_assert(v ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_bundle, 'step', 'close', 'held', true)
		and pg_temp.req_step(v_id, v_token) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_bundle, 'step', 'close', 'held', true),
		'a restore''s step: ' || v::text);
	-- From there the restore is not put off: the place is closed or about to be, and waiting for the company's other
	-- work would only keep it closed. Only the kernel's own word in the progress says so (`held`): not the name of a
	-- step (a later claim begins with another), and nothing else a caller writes there.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	update public.qorpera_coding_sessions set attached_machine_id = pg_temp.rec_copy(901), attachment_token = pg_temp.rec_copy(902),
		attachment_until = clock_timestamp(), attachment_turn = 1, attached_at = clock_timestamp() where worker_id = pg_temp.rec_copy(41);
	perform pg_temp.base_assert(not public.qorpera_code_restore_holds(null) and not public.qorpera_code_restore_holds('{}')
		and not public.qorpera_code_restore_holds('{"step":"close","bundle":"x"}')
		and not public.qorpera_code_restore_holds('{"step":"fresh"}') and not public.qorpera_code_restore_holds('{"step":"discard"}')
		and not public.qorpera_code_restore_holds('{"step":"set-aside"}') and not public.qorpera_code_restore_holds('{"step":"build"}')
		and not public.qorpera_code_restore_holds('{"step":"open"}') and not public.qorpera_code_restore_holds('{"setAside":null}')
		and not public.qorpera_code_restore_holds('{"built":true}') and not public.qorpera_code_restore_holds('{"moving":true}')
		and not public.qorpera_code_restore_holds('{"held":false}') and not public.qorpera_code_restore_holds('{"held":"true"}')
		and public.qorpera_code_restore_holds('{"held":true}') and public.qorpera_code_restore_holds('{"held":true,"step":"fresh"}'),
		'when a restore holds the place');
	-- Nothing has moved yet, and the steps before this one, the ones put off too, left the repository's artifact
	-- generation alone. This step lets the job go that moves the place aside: the generation goes up, and the
	-- kernel's word stands. Asked again (the job that looks at what the folder kept of the move asks the same step),
	-- the generation goes up again: each such step counts, not the first of a request.
	perform pg_temp.base_assert((pg_temp.rec_shop('site')).artifact_generation = 0, 'nothing has moved yet');
	v := pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'set-aside'));
	perform pg_temp.base_assert(v ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_bundle, 'step', 'set-aside', 'held', true)
		and (pg_temp.rec_shop('site')).artifact_generation = 1
		and pg_temp.req_step(v_id, v_token) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_bundle, 'step', 'set-aside', 'held', true)
		and (pg_temp.rec_shop('site')).artifact_generation = 2,
		'a restore that moves the place goes on beside a turn: ' || v::text);
	-- (A step that does not name the set-aside moves the generation no further, and keeps the kernel's word.)
	v := pg_temp.req_step(v_id, v_token, v_progress);
	perform pg_temp.base_assert(v ->> 'state' = 'go' and (pg_temp.req_row(v_id)).progress = v_progress || v_held
		and pg_temp.req_step(v_id, v_token) ->> 'state' = 'go' and (pg_temp.rec_shop('site')).artifact_generation = 2,
		'and beside a session on a machine: ' || v::text);
	-- The executor stopped while the sessions work: the next claim hands the request out all the same, with the
	-- kernel's word for its executor to read.
	perform pg_temp.req_lapse(v_id);
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item -> 'progress' = v_progress || v_held
		and (pg_temp.req_row(v_id)).attempts = 2, 'a restore that holds the place is claimed beside a turn: ' || coalesce(v_item::text, 'nothing'));
	v_token := (v_item ->> 'token')::uuid;
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = pg_temp.rec_copy(41);
	-- The executor stopped: the next claim hands the request out with what it had done.
	perform pg_temp.req_lapse(v_id);
	v_item := pg_temp.req_claim() -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item -> 'progress' = v_progress || v_held
		and (pg_temp.req_row(v_id)).attempts = 3 and v_token <> q.lease_token, 'it goes on where it was: ' || v_item::text);

	-- The finish takes `restored` in its shape only, and only for a restore that was recorded: nothing is recorded once
	-- the place is open.
	foreach v_bad in array array[pg_temp.req_outcome('{"state":"done","result":"verified"}') || jsonb_build_object(
			'mainSha', pg_temp.rec_sha('s3'), 'refsSha256', repeat('a', 64), 'refs', 9),
		v_restored - 'stranded', v_restored - 'previousMainSha', v_restored || '{"keptThrough":3}', v_restored || '{"boundary":"found"}',
		v_restored || '{"bundle":"fresh"}', v_restored || '{"movedTo":"code/company/site"}', v_restored || '{"stranded":[7]}',
		v_restored || '{"refs":-1}', v_restored || '{"extra":true}'] loop
		perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token, v_bad),
			'22023', 'Code request outcome invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token, v_restored),
		'55000', 'Code restore is not recorded');
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).state = 'running' and (pg_temp.rec_shop('site')).last_change = 7, 'nothing was recorded');

	-- The record, which the executor makes inside the job that opens the place: exactly its keys, each of its kind, for
	-- the bundle that was asked for, from the caller that holds the request.
	foreach v_bad in array array['null'::jsonb, '[]', '{}', pg_temp.req_restoring(v_bundle, 's3') - 'previousMainSha',
		pg_temp.req_restoring(v_bundle, 's3') - 'schema', pg_temp.req_restoring(v_bundle, 's3') || '{"keptThrough":3}',
		pg_temp.req_restoring(v_bundle, 's3') || '{"schema":"qorpera.code-restore-record/v2"}',
		pg_temp.req_restoring(v_bundle, 's3') || '{"bundle":"fresh"}', pg_temp.req_restoring(v_bundle, 's3') || '{"bundle":null}',
		pg_temp.req_restoring(v_bundle, 's3') || '{"mainSha":"s3"}', pg_temp.req_restoring(v_bundle, 's3') || '{"mainSha":null}',
		pg_temp.req_restoring(v_bundle, 's3') || '{"previousMainSha":"s6"}', pg_temp.req_restoring(v_bundle, 's3') || '{"previousMainSha":7}',
		-- Another bundle than the one the operator asked for.
		pg_temp.req_restoring(v_fresh, 's3')] loop
		perform pg_temp.base_error(format('select pg_temp.req_record_raw(%L, %L, %L)', v_id, v_token, v_bad),
			'22023', 'Code restore record invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.req_record_raw(%L, %L, null)', v_id, v_token), '22023', 'Code restore record invalid');
	perform pg_temp.base_error(format('select pg_temp.req_record_raw(%L, %L, %L, %L)', v_id, v_token, pg_temp.req_restoring(v_bundle, 's3'),
		'exec 1170'), '42501', 'Coding machine custody required');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(pg_temp.req_record(v_id, pg_temp.rec_copy(1), v_bundle, 's3') = v_record_lost
		and pg_temp.req_record(v_id, null, v_bundle, 's3') = v_record_lost
		and pg_temp.req_record(pg_temp.rec_copy(1), v_token, v_bundle, 's3') = v_record_lost
		and pg_temp.req_record(null, v_token, v_bundle, 's3') = v_record_lost
		and pg_temp.req_record_raw(v_id, v_token, pg_temp.req_restoring(v_bundle, 's3'), 'exec-none') = v_record_lost
		and pg_temp.req_record_raw(v_id, v_token, pg_temp.req_restoring(v_bundle, 's3'), p_machine => repeat('6', 64)) = v_record_lost
		and to_jsonb(pg_temp.req_row(v_id)) = to_jsonb(q) and (pg_temp.rec_shop('site')).last_change = 7
		and pg_temp.req_rows('site') = '1:L 2:R4 3:L 4:L 5:C 6:L 7:L', 'a record that is lost writes nothing');

	-- Recorded, from a bundle older than main: the restored main is where the third row left it. The kernel finds that
	-- from the rows. The rows after it that moved main are lost; the undo among them is no longer in main's history, so
	-- change 2 is in main again, as it was when the bundle was taken. A conflict stays what it was.
	v := pg_temp.req_record(v_id, v_token, v_bundle, 's3', 's6');
	r := pg_temp.rec_row(8, 'site'); s := pg_temp.rec_shop('site'); q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = pg_temp.req_restored(8, 3, 3, 0) and pg_temp.req_rows('site') = '1:L 2:L 3:L 4:- 5:C 6:- 7:- 8:L'
		and (pg_temp.rec_row(4, 'site')).reverted_by is null and (pg_temp.rec_row(2, 'site')).reverted_by is null
		and pg_temp.rec_is(8, 'restore', 'landed', 's6', 's3', 'site') and r.title = 'Restored from the copy of 2026-11-09 02:14 UTC'
		and r.summary = 'The folder lost objects.' and r.restored_from = v_bundle and r.request_id = v_id and r.undoes is null
		and r.worker_id is null and r.files_changed is null, 'recorded: ' || v::text || ' ' || pg_temp.req_rows('site') || ' ' || to_jsonb(r)::text);
	-- The registry: main as restored, when and from what; care is due at once and trusts no refs it knew.
	perform pg_temp.base_assert(s.last_change = 8 and s.last_main = pg_temp.rec_sha('s3') and s.main_sha = pg_temp.rec_sha('s3')
		and s.restored_at between clock_timestamp() - interval '1 minute' and clock_timestamp() and s.restored_from = v_bundle
		and s.refs_sha256 is null and s.next_care_at <= clock_timestamp() and s.index_written = 0 and s.index_version > 0,
		'the registry after a restore: ' || to_jsonb(s)::text);
	-- The request is still its executor's: the place opens, and the job saves, before it ends. It keeps what was
	-- recorded.
	v_recorded := jsonb_build_object('change', 8, 'boundary', 'found', 'keptThrough', 3, 'lost', 3, 'back', 0, 'bundle', v_bundle,
		'mainSha', pg_temp.rec_sha('s3'));
	perform pg_temp.base_assert(q.state = 'running' and q.lease_token = v_token and q.outcome is null and q.finished_at is null
		and q.progress = v_progress || v_held || jsonb_build_object('recorded', v_recorded),
		'the request after the record: ' || to_jsonb(q)::text);
	-- Made again by the same request (the answer was not heard): the same answer, and nothing is written.
	s := pg_temp.rec_shop('site');
	perform pg_temp.base_assert(pg_temp.req_record(v_id, v_token, v_bundle, 's3', 's6') = v
		and pg_temp.req_record(v_id, v_token, v_bundle, 's3') = v and to_jsonb(pg_temp.rec_shop('site')) = to_jsonb(s)
		and pg_temp.req_rows('site') = '1:L 2:L 3:L 4:- 5:C 6:- 7:- 8:L' and to_jsonb(pg_temp.req_row(v_id)) = to_jsonb(q),
		'the same record again');
	perform pg_temp.base_error(format('select pg_temp.req_record(%L, %L, %L, %L)', v_id, v_token, v_bundle, 's2'),
		'22023', 'Code restore record invalid');
	-- A step keeps what was recorded, and takes none from its caller. This one is of the job that removes a set-aside
	-- copy: it moves nothing out of the place, and the generation stays.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, v_progress || '{"step":"discard","recorded":{"change":1}}') ->> 'state' = 'go'
		and (pg_temp.rec_shop('site')).artifact_generation = 2
		and (pg_temp.req_row(v_id)).progress = v_progress || v_held || jsonb_build_object('step', 'discard', 'recorded', v_recorded)
		and pg_temp.req_step(v_id, v_token) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress -> 'recorded' = v_recorded, 'a step keeps the record');
	-- The finish, once the job that opened the place has saved: it writes no row, and only for the bundle and the main
	-- that were recorded. The request keeps the outcome with what the record found.
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		v_restored || jsonb_build_object('mainSha', pg_temp.rec_sha('s2'))), '55000', 'Code restore is not recorded');
	v := pg_temp.req_finish(v_id, v_token, v_restored);
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = pg_temp.req_recorded(8) and q.state = 'done' and q.lease_token is null
		and q.outcome = v_restored || '{"change":8,"boundary":"found","keptThrough":3,"lost":3,"back":0}'
		and q.progress -> 'recorded' = v_recorded and (pg_temp.rec_shop('site')).last_change = 8
		and pg_temp.req_rows('site') = '1:L 2:L 3:L 4:- 5:C 6:- 7:- 8:L', 'the restore''s request: ' || to_jsonb(q)::text);
	-- Its lease is over: the token records and finishes nothing more.
	perform pg_temp.base_assert(pg_temp.req_record(v_id, v_token, v_bundle, 's3') = v_record_lost
		and pg_temp.req_finish(v_id, v_token, v_restored) ->> 'state' = 'lost', 'a finished restore');
	-- Every file is written again: all eight rows and the list. A row a restore went back past, and the restore's own,
	-- are handed out without a diff to ask for, whatever is known of their files.
	v := pg_temp.rec_files(p_name => 'site');
	perform pg_temp.base_assert(pg_temp.rec_due_names() like '%site%' and jsonb_array_length(v -> 'changes') = 8
		and jsonb_array_length(v -> 'index' -> 'lines') = 8
		and v -> 'changes' -> 5 ->> 'kind' = 'found' and v -> 'changes' -> 5 ->> 'state' = 'lost'
		and v -> 'changes' -> 5 -> 'filesChanged' = 'null' and not (v -> 'changes' -> 5 ->> 'needsDiff')::boolean
		and v -> 'changes' -> 7 ->> 'kind' = 'restore' and v -> 'changes' -> 7 -> 'filesChanged' = 'null'
		and not (v -> 'changes' -> 7 ->> 'needsDiff')::boolean and v -> 'changes' -> 7 ->> 'restoredFrom' = v_bundle
		and v -> 'changes' -> 3 ->> 'state' = 'lost' and v -> 'changes' -> 3 -> 'undoes' = '[2]'::jsonb
		and v -> 'changes' -> 3 -> 'revertedBy' = 'null', 'the files after a restore: ' || (v -> 'changes' -> 5)::text);

	-- A filler a restore went back past is nobody's to take over, and says nothing of main: a turn that hands in the
	-- commit it ended at gets no row from it, and a landing on that commit is a row of its own. (Then as before.)
	begin
		v := pg_temp.rec_record(pg_temp.rec_turn(45, 1, pg_temp.rec_sha('s5'), '{}', pg_temp.own_repo('company', 'site')),
			pg_temp.rec_report('unchanged', pg_temp.rec_sha('s5'), pg_temp.rec_sha('s3'), pg_temp.rec_sha('s5')));
		perform pg_temp.base_assert(v = pg_temp.rec_answer('nothing', null) and pg_temp.rec_is(6, 'found', 'lost', 's4', 's5', 'site'),
			'a lost filler is not taken over: ' || v::text);
		v := pg_temp.rec_land(46, 's3', 's5', false, p_name => 'site');
		perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 9) and pg_temp.rec_is(6, 'found', 'lost', 's4', 's5', 'site')
			and pg_temp.rec_is(9, 'landing', 'landed', 's3', 's5', 'site'), 'a landing on a lost filler''s commit: ' || v::text);
		raise exception 'as before' using errcode = 'P0001';
	exception when raise_exception then
		perform pg_temp.base_assert(sqlerrm = 'as before' and (pg_temp.rec_shop('site')).last_change = 8, 'as before: ' || sqlerrm);
	end;
	-- Undo after a restore: a lost row has nothing to undo, a restore is not undone, and andLater does not reach across
	-- one. A change before it that main still holds is undone like any other.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-lost', 4, p_name => 'site') = pg_temp.req_refused('lost')
		and pg_temp.req_undo('undo-lost-7', 7, true, p_name => 'site') = pg_temp.req_refused('lost')
		and pg_temp.req_undo('undo-restore', 8, p_name => 'site') = pg_temp.req_refused('restore')
		and pg_temp.req_undo('undo-wall', 1, true, p_name => 'site') = pg_temp.req_refused('wall')
		and pg_temp.req_undo('undo-wall-3', 3, true, p_name => 'site') = pg_temp.req_refused('wall')
		and pg_temp.req_undo('undo-never', 5, p_name => 'site') = pg_temp.req_refused('never_landed'), 'undo after a restore');
	perform pg_temp.base_assert(pg_temp.req_undone('undo-before', 3, false, 's3', 's3u', p_name => 'site') = pg_temp.req_recorded(9)
		and pg_temp.req_rows('site') = '1:L 2:L 3:R9 4:- 5:C 6:- 7:- 8:L 9:L', 'an undo before the wall: ' || pg_temp.req_rows('site'));
	-- andLater from the restore's row on is not across it; from a row after it, neither.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-after', 9, true, p_name => 'site') ->> 'state' = 'queued', 'andLater after the wall');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.req_finish((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid, pg_temp.req_outcome(
		jsonb_build_object('state', 'done', 'result', 'nothing', 'mainSha', pg_temp.rec_sha('s3u'))));

	-- A restore to a commit no row names, with nothing known of main before it: where the restored main stands in the
	-- record is not known. That is not read as nothing kept: no row is touched, and the answer, the request's progress
	-- and its outcome say so, for an operator to look. The place it replaced was removed, so nothing was moved.
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', 'fresh', 'remove', null, 'site');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'bundle' = 'fresh' and v_item ->> 'damaged' = 'remove' and not v_item ? 'tips',
		'a fresh restore is claimed: ' || v_item::text);
	v := pg_temp.req_record(v_id, (v_item ->> 'token')::uuid, v_fresh, 'r2');
	perform pg_temp.base_assert(v = pg_temp.req_restored(10, null, 0, 0, 'unknown')
		and pg_temp.req_rows('site') = '1:L 2:L 3:R9 4:- 5:C 6:- 7:- 8:L 9:L 10:L'
		and pg_temp.rec_is(10, 'restore', 'landed', 's3u', 'r2', 'site') and (pg_temp.rec_row(10, 'site')).summary is null
		and (pg_temp.rec_row(10, 'site')).title = 'Restored from the copy of 2026-11-10 16:00 UTC'
		and (pg_temp.rec_shop('site')).restored_from = v_fresh and (pg_temp.rec_shop('site')).last_main = pg_temp.rec_sha('r2')
		and (pg_temp.req_row(v_id)).progress #>> '{recorded,boundary}' = 'unknown', 'not known, nothing lost: ' || v::text || ' ' || pg_temp.req_rows('site'));
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_restore_outcome(v_fresh, 'r2'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(10) and (pg_temp.req_row(v_id)).outcome ->> 'boundary' = 'unknown'
		and (pg_temp.req_row(v_id)).outcome -> 'keptThrough' = 'null' and (pg_temp.req_row(v_id)).outcome -> 'lost' = '0',
		'the outcome says the boundary is not known: ' || (pg_temp.req_row(v_id)).outcome::text);
	-- Main had moved before the place was closed and nobody recorded how (the executor read main there): a filler for
	-- that gap first, as before any other movement. A fresh bundle is of that very main, so the filler is the newest row
	-- the restored main holds. Its history ends at the restore before, whose own place was not known: the rows before
	-- that one are left as they were, and the boundary is still not known.
	v := pg_temp.req_restore_to('20261110T170000Z-ba9876543210', 'r3', 'site', 'r3');
	perform pg_temp.base_assert(v = pg_temp.req_restored(12, 11, 0, 0, 'unknown') and pg_temp.rec_is(11, 'found', 'landed', 'r2', 'r3', 'site')
		and pg_temp.rec_is(12, 'restore', 'landed', 'r3', 'r3', 'site')
		and pg_temp.req_rows('site') = '1:L 2:L 3:R9 4:- 5:C 6:- 7:- 8:L 9:L 10:L 11:L 12:L', 'a filler first: ' || v::text || ' ' || pg_temp.req_rows('site'));
	perform pg_temp.base_assert(pg_temp.req_restore_end('20261110T170000Z-ba9876543210', 'r3') = pg_temp.req_recorded(12), 'and its finish');
	-- A restore to where the record's first row began: main holds none of the rows, and that is known. Every row that
	-- moved main is lost, the earlier restores' too; the undo among them gives its target nothing back, since that is
	-- lost as well.
	v := pg_temp.req_restore_to('20261101T020000Z-0123456789ab', 's0', 'site');
	perform pg_temp.base_assert(v = pg_temp.req_restored(13, 0, 8, 0)
		and pg_temp.req_rows('site') = '1:- 2:- 3:- 4:- 5:C 6:- 7:- 8:- 9:- 10:- 11:- 12:- 13:L'
		and pg_temp.rec_is(13, 'restore', 'landed', 'r3', 's0', 'site') and (pg_temp.rec_row(3, 'site')).reverted_by is null,
		'nothing kept, and known: ' || v::text || ' ' || pg_temp.req_rows('site'));
	perform pg_temp.base_assert(pg_temp.req_restore_end('20261101T020000Z-0123456789ab', 's0') = pg_temp.req_recorded(13), 'and its finish');

	-- Three starts of a restore and no finish: it ends, and keeps what it had done for the request that goes on.
	v_id := pg_temp.req_restore('restore', v_bundle, 'keep', 'Once more.', 'site');
	for i in 1..3 loop
		v_item := pg_temp.req_claim() -> 0;
		perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text, 'restore start ' || i);
		perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, v_progress);
		perform pg_temp.req_lapse(v_id);
	end loop;
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_id)).state = 'failed'
		and (pg_temp.req_row(v_id)).outcome ->> 'code' = 'DID_NOT_FINISH' and (pg_temp.req_row(v_id)).progress = v_progress,
		'a restore that did not finish keeps its progress: ' || (pg_temp.req_row(v_id)).progress::text);

	-- Discard: one set-aside copy of the repository, by its path.
	v_id := pg_temp.req_restore('discard', null, null, v_aside, 'site');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).input = jsonb_build_object('mode', 'discard', 'bundle', null, 'damaged', 'keep',
			'note', null, 'path', v_aside)
		and v_item ->> 'mode' = 'discard' and v_item ->> 'path' = v_aside and v_item -> 'bundle' = 'null', 'a discard is claimed: ' || v_item::text);
	perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, (v_item ->> 'token')::uuid,
		pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'verified', 'mainSha', pg_temp.rec_sha('r2'),
			'refsSha256', repeat('a', 64), 'refs', 9))), '22023', 'Code request outcome invalid');
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_outcome('{"state":"done","result":"discarded"}'))
		= pg_temp.req_recorded(null) and (pg_temp.req_row(v_id)).state = 'done' and (pg_temp.rec_shop('site')).last_change = 13, 'discarded');
end $$;

-- 5. A restore's record -----------------------------------------------------------------------------------------------
-- company/one: two landings and the code made as a file. A restore ends the downloads made in its place from the step
-- that lets it move the place, also when it then fails. Its record is made while the place is closed, so a landing
-- after it stands.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'one');
do $$
declare v jsonb; v_item jsonb; v_id uuid; v_first uuid; v_token uuid; q public.qorpera_code_requests%rowtype;
	s public.qorpera_code_repositories%rowtype; i integer; v_download uuid;
	v_zip text := 'code/company/one/downloads/one-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') || '.zip';
	v_bundle text := '20261110T160000Z-ba9876543210'; v_other text := '20261110T180000Z-ba9876543210';
	v_record_lost jsonb := '{"schema":"qorpera.code-restore-recorded/v1","state":"lost"}';
begin
	perform pg_temp.rec_land(70, 'a0', 'a1', p_name => 'one');
	perform pg_temp.rec_land(71, 'a1', 'a2', p_name => 'one');
	-- The code as a file, made while main is at the second change.
	v_download := (pg_temp.req_ask('files', p_name => 'one') ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.req_made(v_download, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'made', 'path', v_zip, 'bytes', 77, 'sha256', repeat('7', 64), 'mainSha', pg_temp.rec_sha('a2'))));
	perform pg_temp.base_assert(pg_temp.req_ask('files', p_name => 'one') ->> 'state' = 'ready'
		and pg_temp.req_ask('files', p_name => 'one') ->> 'requestId' = v_download::text
		and pg_temp.req_ready('one') = jsonb_build_array(v_download), 'one''s download is ready');

	-- A restore of the place, from a bundle of main as it stands. While it proves its bundle and closes the place,
	-- nothing has moved: the download is ready.
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', v_bundle, 'keep', 'The folder lost objects.', 'one');
	v_token := (pg_temp.req_claim() -> 0 ->> 'token')::uuid;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'close')) ->> 'state' = 'go'
		and pg_temp.req_download(v_download) ->> 'state' = 'ready' and (pg_temp.rec_shop('one')).artifact_generation = 0,
		'closed, and nothing moved');
	-- The job that sets the place aside asks its step, and then moves everything aside, downloads/ too. From that step
	-- on the made download is over, though main is where it was made: the member who reads it is told so, the list no
	-- longer shows it, and asking again makes a new request.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'set-aside')) ->> 'state' = 'go',
		'the restore is let go to move the place');
	q := pg_temp.req_row(v_download);
	v := pg_temp.req_ask('files', p_name => 'one');
	perform pg_temp.base_assert(q.state = 'expired' and q.lease_token is null and (pg_temp.rec_shop('one')).last_main = q.outcome ->> 'mainSha'
		and (pg_temp.rec_shop('one')).artifact_generation = 1
		and pg_temp.req_download(v_download) ->> 'state' = 'failed' and pg_temp.req_download(v_download) ->> 'reason' = 'failed'
		and v ->> 'state' = 'queued' and v ->> 'requestId' <> v_download::text and v -> 'path' = 'null'
		and (select r -> 'downloads' from jsonb_array_elements(pg_temp.req_list() -> 'repositories') r where r ->> 'name' = 'one')
			= jsonb_build_array(jsonb_build_object('requestId', v ->> 'requestId', 'file', 'files', 'state', 'queued', 'path', null,
				'bytes', null, 'madeAt', null, 'expiresAt', null)),
		'a restore that moves the place ends the made downloads: ' || to_jsonb(q)::text || ' ' || v::text);
	-- The move is saved, and the restore then fails in the build: it ends failed, with the place closed. Its later
	-- steps moved the generation no further, and its failed finish made nothing ready again.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'build',
			'setAside', 'code/_set-aside/company/at-20261110T120000Z/one')) ->> 'state' = 'go'
		and (pg_temp.rec_shop('one')).artifact_generation = 1
		and pg_temp.req_finish(v_id, v_token, pg_temp.req_outcome('{"state":"failed","code":"BUILD_FAILED:CODE_HOST_RESTORE_FAILED:PLACE_CLOSED"}'))
			= pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_id)).state = 'failed' and pg_temp.req_rows('one') = '1:L 2:L'
		and pg_temp.req_download(v_download) ->> 'state' = 'failed' and pg_temp.req_ready('one') = '[]'::jsonb
		and pg_temp.req_ask('files', p_name => 'one') ->> 'requestId' = v ->> 'requestId',
		'a restore that failed in the build: ' || pg_temp.req_list()::text);
	-- The download asked for meanwhile: its job is let go and refused in the closed place.
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v ->> 'requestId' and v_item ->> 'work' = 'make'
		and pg_temp.req_step((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid) ->> 'state' = 'go'
		and (pg_temp.req_row((v_item ->> 'requestId')::uuid)).artifact_generation = 1
		and pg_temp.req_finish((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid,
			pg_temp.req_outcome('{"state":"failed","code":"CODE_HOST_RESTORE_IN_PROGRESS"}')) = pg_temp.req_recorded(null)
		and pg_temp.req_download((v_item ->> 'requestId')::uuid) ->> 'state' = 'failed', 'no download from a closed place');

	-- The operator asks again with the same bundle. The new request goes on from the emptied place: recorded inside the
	-- job that opens it. (The step this test's helper asks before the record names the set-aside, as a job that moves
	-- the place would: it takes the generation up once more. Nothing was made in between, so nothing ends by it.)
	v := pg_temp.req_restore_to(v_bundle, 'a2', 'one', 'a2');
	perform pg_temp.base_assert(v = pg_temp.req_restored(3, 2, 0, 0) and pg_temp.rec_is(3, 'restore', 'landed', 'a2', 'a2', 'one')
		and (pg_temp.rec_shop('one')).artifact_generation = 2, 'recorded in the job: ' || v::text);
	-- The place is new, and the code is made again as a file, in the generation the repository's artifacts have now.
	v := pg_temp.req_ask('files', p_name => 'one');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v_item ->> 'requestId' = v ->> 'requestId' and v_item ->> 'work' = 'make'
		and pg_temp.req_made((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object(
			'state', 'done', 'result', 'made', 'path', v_zip, 'bytes', 78, 'sha256', repeat('8', 64), 'mainSha', pg_temp.rec_sha('a2'))))
			= pg_temp.req_recorded(null) and pg_temp.req_ask('files', p_name => 'one') ->> 'state' = 'ready'
		and (pg_temp.req_row((v_item ->> 'requestId')::uuid)).artifact_generation = 2, 'and the new file is made');
	-- Then the place is open, the company's line is free, and a landing goes in and is recorded before the restore's
	-- finish arrives. The finish records nothing: the landing is in main, and the record's main is where the landing
	-- left it.
	perform pg_temp.base_assert(pg_temp.rec_land(72, 'a2', 'a3', p_name => 'one') = pg_temp.rec_answer('recorded', 4), 'a landing after the open');
	perform pg_temp.base_assert(pg_temp.req_restore_end(v_bundle, 'a2') = pg_temp.req_recorded(3)
		and pg_temp.req_rows('one') = '1:L 2:L 3:L 4:L' and pg_temp.rec_is(4, 'landing', 'landed', 'a2', 'a3', 'one')
		and (pg_temp.rec_shop('one')).last_main = pg_temp.rec_sha('a3') and (pg_temp.rec_shop('one')).last_change = 4,
		'the landing stands after the finish: ' || pg_temp.req_rows('one'));

	-- The record was made and the job that opens the place did not save (or the executor stopped): the request is still
	-- running, and the next claim opens the place and records again. That is the same record: the same answer, no
	-- second row. The token of the claim before it records nothing.
	v := pg_temp.req_restore_to(v_bundle, 'a2', 'one', 'a3');
	v_item := current_setting('qorpera_test.req_item')::jsonb;
	v_id := (v_item ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v = pg_temp.req_restored(5, 2, 1, 0) and pg_temp.req_rows('one') = '1:L 2:L 3:L 4:- 5:L'
		and pg_temp.rec_is(5, 'restore', 'landed', 'a3', 'a2', 'one'), 'back to the bundle: ' || v::text || ' ' || pg_temp.req_rows('one'));
	perform pg_temp.req_lapse(v_id);
	v_token := (pg_temp.req_claim() -> 0 ->> 'token')::uuid;
	q := pg_temp.req_row(v_id); s := pg_temp.rec_shop('one');
	perform pg_temp.base_assert(q.attempts = 2 and q.state = 'running' and q.progress #>> '{recorded,change}' = '5'
		and pg_temp.req_record(v_id, (v_item ->> 'token')::uuid, v_bundle, 'a2', 'a3') = v_record_lost
		and pg_temp.req_record(v_id, v_token, v_bundle, 'a2', 'a3') = v
		and to_jsonb(pg_temp.rec_shop('one')) = to_jsonb(s) and pg_temp.req_rows('one') = '1:L 2:L 3:L 4:- 5:L',
		'the next claim records the same: ' || to_jsonb(q)::text);
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_restore_outcome(v_bundle, 'a2')) = pg_temp.req_recorded(5)
		and (pg_temp.req_row(v_id)).state = 'done' and (pg_temp.req_row(v_id)).outcome -> 'lost' = '1', 'and ends it');

	-- The record was made and the request never came to its end: three claims, and it ends as one that did not finish.
	-- The place may still be closed. Its progress keeps what was recorded, for the operator. (Further back: the two
	-- restores of the newer bundle are lost with what they restored.)
	v := pg_temp.req_restore_to(v_other, 'a1', 'one');
	v_first := (current_setting('qorpera_test.req_item')::jsonb ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v = pg_temp.req_restored(6, 1, 3, 0) and pg_temp.req_rows('one') = '1:L 2:- 3:- 4:- 5:- 6:L'
		and pg_temp.rec_is(6, 'restore', 'landed', 'a2', 'a1', 'one'), 'further back: ' || v::text || ' ' || pg_temp.req_rows('one'));
	for i in 2..3 loop
		perform pg_temp.req_lapse(v_first);
		perform pg_temp.base_assert(pg_temp.req_claim() -> 0 ->> 'requestId' = v_first::text, 'start ' || i);
	end loop;
	perform pg_temp.req_lapse(v_first);
	q := pg_temp.req_row(v_first);
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb and (pg_temp.req_row(v_first)).state = 'failed'
		and (pg_temp.req_row(v_first)).outcome ->> 'code' = 'DID_NOT_FINISH'
		and (pg_temp.req_row(v_first)).progress -> 'recorded' = q.progress -> 'recorded'
		and q.progress #>> '{recorded,change}' = '6', 'it did not finish, and keeps its record');
	-- A turn that meets the closed place is refused, and that is a row too: it moved nothing.
	perform pg_temp.rec_record(pg_temp.rec_turn(73, 1, pg_temp.rec_sha('h73'), '{}', pg_temp.own_repo('company', 'one')),
		pg_temp.rec_report('refused', pg_temp.rec_sha('h73'), null, null, '{"refusal":{"code":"CODE_HOST_RESTORE_IN_PROGRESS","paths":[]}}'));
	-- The operator asks again with the same bundle, and the new request opens the place. The record's newest movement
	-- of main is already this restore: its row is answered, no second one is written, and no row's state changes.
	s := pg_temp.rec_shop('one');
	v := pg_temp.req_restore_to(v_other, 'a1', 'one', 'a2');
	v_id := (current_setting('qorpera_test.req_item')::jsonb ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_id <> v_first and v = pg_temp.req_restored(6, 1, 0, 0)
		and pg_temp.req_rows('one') = '1:L 2:- 3:- 4:- 5:- 6:L 7:X' and (pg_temp.rec_shop('one')).last_change = 7
		and (pg_temp.rec_shop('one')).last_main = pg_temp.rec_sha('a1') and (pg_temp.rec_row(6, 'one')).request_id = v_first
		and (pg_temp.rec_shop('one')).restored_at >= s.restored_at, 'the same restore by a later request: ' || v::text || ' ' || pg_temp.req_rows('one'));
	perform pg_temp.base_assert(pg_temp.req_restore_end(v_other, 'a1') = pg_temp.req_recorded(6)
		and (pg_temp.req_row(v_id)).outcome -> 'change' = '6', 'which ends with that row');
	-- Once main has moved on, a restore from the same bundle is a restore of its own: a new row, and the landing since
	-- is lost.
	perform pg_temp.base_assert(pg_temp.rec_land(74, 'a1', 'a4', p_name => 'one') = pg_temp.rec_answer('recorded', 8), 'main moves on');
	v := pg_temp.req_restore_to(v_other, 'a1', 'one', 'a4');
	perform pg_temp.base_assert(v = pg_temp.req_restored(9, 1, 1, 0) and pg_temp.req_rows('one') = '1:L 2:- 3:- 4:- 5:- 6:L 7:X 8:- 9:L'
		and pg_temp.rec_is(9, 'restore', 'landed', 'a4', 'a1', 'one'), 'a restore of its own: ' || v::text || ' ' || pg_temp.req_rows('one'));
	perform pg_temp.base_assert(pg_temp.req_restore_end(v_other, 'a1') = pg_temp.req_recorded(9), 'and its finish');
	-- Main had moved before the place was closed and nobody recorded how: a filler for that gap first. The bundle is of
	-- that main, so the filler is the newest row main holds, and everything before it is in main still.
	v := pg_temp.req_restore_to('20261110T190000Z-ba9876543210', 'a9', 'one', 'a9');
	perform pg_temp.base_assert(v = pg_temp.req_restored(11, 10, 0, 0) and pg_temp.rec_is(10, 'found', 'landed', 'a1', 'a9', 'one')
		and pg_temp.rec_is(11, 'restore', 'landed', 'a9', 'a9', 'one')
		and pg_temp.req_rows('one') = '1:L 2:- 3:- 4:- 5:- 6:L 7:X 8:- 9:L 10:L 11:L', 'a filler first: ' || v::text || ' ' || pg_temp.req_rows('one'));
	perform pg_temp.base_assert(pg_temp.req_restore_end('20261110T190000Z-ba9876543210', 'a9') = pg_temp.req_recorded(11), 'and its finish');

	-- A download whose job made its file, and whose finish comes after a restore began to move the place. The finish is
	-- taken, since it holds the request's lease, but the file it speaks of went aside with the old place: the download
	-- is over at once, and was never ready.
	v := pg_temp.req_ask('files', p_name => 'one');
	v_download := (v ->> 'requestId')::uuid;
	v_token := (pg_temp.req_claim() -> 0 ->> 'token')::uuid;
	s := pg_temp.rec_shop('one');
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and pg_temp.req_step(v_download, v_token) ->> 'state' = 'go'
		and (pg_temp.req_row(v_download)).artifact_generation = s.artifact_generation, 'a download''s job is let go');
	v := pg_temp.req_restore_to('20261110T200000Z-ba9876543210', 'a9', 'one', 'a9');
	perform pg_temp.base_assert(v = pg_temp.req_restored(12, 10, 0, 0) and (pg_temp.rec_shop('one')).artifact_generation = s.artifact_generation + 1
		and pg_temp.req_restore_end('20261110T200000Z-ba9876543210', 'a9') = pg_temp.req_recorded(12)
		and (pg_temp.req_row(v_download)).state = 'running', 'a restore while the download''s finish is on its way: ' || v::text);
	v := pg_temp.req_finish(v_download, v_token, pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'made',
		'path', v_zip, 'bytes', 79, 'sha256', repeat('9', 64), 'mainSha', pg_temp.rec_sha('a9'))));
	q := pg_temp.req_row(v_download);
	perform pg_temp.base_assert(v = pg_temp.req_recorded(null) and q.state = 'expired' and q.expires_at is null and q.lease_token is null
		and q.outcome ->> 'result' = 'made' and q.artifact_generation = s.artifact_generation
		and pg_temp.req_download(v_download) ->> 'state' = 'failed' and pg_temp.req_download(v_download) ->> 'reason' = 'failed'
		and pg_temp.req_ready('one') = '[]'::jsonb, 'a finish that comes after the place was moved: ' || to_jsonb(q)::text);
	-- Asked again, the code is made in the new place.
	v := pg_temp.req_ask('files', p_name => 'one');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v ->> 'requestId' <> v_download::text and v_item ->> 'requestId' = v ->> 'requestId'
		and pg_temp.req_made((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object(
			'state', 'done', 'result', 'made', 'path', v_zip, 'bytes', 80, 'sha256', repeat('a', 64), 'mainSha', pg_temp.rec_sha('a9'))))
			= pg_temp.req_recorded(null)
		and pg_temp.req_ready('one') = jsonb_build_array(v -> 'requestId'), 'and made again: ' || pg_temp.req_list()::text);
end $$;

-- company/four: two landings whose record files a job has written. The job's word that it wrote them comes after a
-- restore moved those files aside and was recorded: it counts for nothing, and every file is written again.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'four');
do $$
declare v jsonb; v_old jsonb; v_new jsonb; s public.qorpera_code_repositories%rowtype;
	v_bundle text := '20261110T160000Z-ba9876543210';
begin
	perform pg_temp.rec_land(95, 'f0', 'f1', p_name => 'four');
	perform pg_temp.rec_land(96, 'f1', 'f2', p_name => 'four');
	-- A job wrote both rows' files and the list, at the versions they have.
	v := pg_temp.rec_files(p_name => 'four');
	s := pg_temp.rec_shop('four');
	v_old := pg_temp.rec_wrote((select jsonb_agg(jsonb_build_object('n', c -> 'n', 'version', c -> 'version') order by c -> 'n')
		from jsonb_array_elements(v -> 'changes') c), (v -> 'index' ->> 'version')::bigint);
	perform pg_temp.base_assert(v_old = pg_temp.rec_wrote('[{"n":1,"version":1},{"n":2,"version":1}]', s.index_version)
		and s.index_version = 2 and s.index_written = 0, 'what the job wrote: ' || v_old::text);
	-- Before the job says so, a restore from a bundle of main as it stands moves the place aside, those files with it,
	-- and is recorded. Every file has a new version, and so has the list.
	v := pg_temp.req_restore_to(v_bundle, 'f2', 'four', 'f2');
	perform pg_temp.base_assert(v = pg_temp.req_restored(3, 2, 0, 0) and pg_temp.req_restore_end(v_bundle, 'f2') = pg_temp.req_recorded(3),
		'four is restored: ' || v::text);
	s := pg_temp.rec_shop('four');
	perform pg_temp.base_assert((select array_agg(c.file_version order by c.n) from public.qorpera_code_changes c where c.name = 'four') = array[2, 2, 2]
		and (select array_agg(c.file_written order by c.n) from public.qorpera_code_changes c where c.name = 'four') = array[0, 0, 0]
		and s.index_version = 4 and s.index_written = 0, 'new versions: ' || to_jsonb(s)::text);
	-- The job's word arrives now. It is of files that went aside: every row is still due, and the list.
	perform pg_temp.base_assert(pg_temp.rec_written(v_old, 'four') ->> 'state' = 'recorded', 'the old acknowledgment is heard');
	v := pg_temp.rec_files(p_name => 'four');
	perform pg_temp.base_assert(pg_temp.rec_due_names() like '%four%' and jsonb_array_length(v -> 'changes') = 3
		and (select jsonb_agg(c -> 'version' order by c -> 'n') from jsonb_array_elements(v -> 'changes') c) = '[2, 2, 2]'::jsonb
		and v -> 'index' ->> 'version' = '4' and jsonb_array_length(v -> 'index' -> 'lines') = 3,
		'still due after an acknowledgment from before the restore: ' || v::text);
	-- A job that writes them now, in the new place, says so with the versions it wrote: nothing is due.
	v_new := pg_temp.rec_wrote((select jsonb_agg(jsonb_build_object('n', c -> 'n', 'version', c -> 'version') order by c -> 'n')
		from jsonb_array_elements(v -> 'changes') c), (v -> 'index' ->> 'version')::bigint);
	perform pg_temp.rec_written(v_new, 'four');
	v := pg_temp.rec_files(p_name => 'four');
	perform pg_temp.base_assert(v -> 'changes' = '[]'::jsonb and v -> 'index' = 'null'::jsonb and pg_temp.rec_due_names() not like '%four%',
		'written in the new place: ' || v::text);
	-- The same restore recorded again by a later request (no new row): the versions go up again, the list's too, so
	-- the word of files written before it counts for nothing either.
	v := pg_temp.req_restore_to(v_bundle, 'f2', 'four', 'f2');
	perform pg_temp.base_assert(v = pg_temp.req_restored(3, 2, 0, 0) and pg_temp.req_restore_end(v_bundle, 'f2') = pg_temp.req_recorded(3)
		and (pg_temp.rec_shop('four')).last_change = 3 and (pg_temp.rec_shop('four')).index_version = 5,
		'the same restore again: ' || v::text);
	perform pg_temp.rec_written(v_new, 'four');
	v := pg_temp.rec_files(p_name => 'four');
	perform pg_temp.base_assert(jsonb_array_length(v -> 'changes') = 3
		and (select jsonb_agg(c -> 'version' order by c -> 'n') from jsonb_array_elements(v -> 'changes') c) = '[3, 3, 3]'::jsonb
		and v -> 'index' ->> 'version' = '5', 'still due when the same restore is recorded again: ' || v::text);
end $$;

-- company/five: the downloads are ended by each attempt to move the place, not once for a request. A restore's job
-- that sets the place aside is let go, fails before it moves anything, and the place is opened again as it was. The
-- word that the request failed never reaches the kernel, so the same request is claimed again later. A download made
-- while the place was open is over when that claim's job is let go to move the place. And a step that moves nothing
-- out of the place ends nothing: a download made after the restore's open outlives the discard of the set-aside copy.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'five');
do $$
declare v jsonb; v_item jsonb; v_id uuid; v_first uuid; v_second uuid; v_before uuid; v_between uuid; v_after uuid;
	q public.qorpera_code_requests%rowtype;
	v_zip text := 'code/company/five/downloads/five-' || to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') || '.zip';
	v_bundle text := '20261110T160000Z-ba9876543210'; v_aside text := 'code/_set-aside/company/at-20261110T120000Z/five';
	v_made jsonb;
begin
	v_made := pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'made', 'path', v_zip, 'bytes', 55,
		'sha256', repeat('5', 64), 'mainSha', pg_temp.rec_sha('g2')));
	perform pg_temp.rec_land(97, 'g0', 'g1', p_name => 'five');
	perform pg_temp.rec_land(98, 'g1', 'g2', p_name => 'five');
	v_before := (pg_temp.req_ask('files', p_name => 'five') ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(pg_temp.req_made(v_before, (v_item ->> 'token')::uuid, v_made) = pg_temp.req_recorded(null)
		and pg_temp.req_ready('five') = jsonb_build_array(v_before), 'five''s download is ready');
	-- A restore closes the place, and its job that sets the place aside is let go: the download is over.
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', v_bundle, 'remove', 'The folder lost objects.', 'five');
	v_first := (pg_temp.req_claim() -> 0 ->> 'token')::uuid;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_bundle, 'step', 'close')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_bundle, 'step', 'set-aside')) ->> 'state' = 'go'
		and (pg_temp.rec_shop('five')).artifact_generation = 1 and pg_temp.req_download(v_before) ->> 'state' = 'failed'
		and pg_temp.req_ready('five') = '[]'::jsonb, 'the first attempt to move the place');
	-- That job fails before it moves anything, and the executor opens the untouched place again and says so. Its word
	-- that the request failed is lost: the request is still running, and will be claimed again. Meanwhile the place is
	-- open: a member asks for the code, and it is made there.
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_bundle, 'step', 'set-aside', 'held', true)
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_bundle, 'step', 'reopened')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_bundle, 'step', 'reopened')
		and (pg_temp.rec_shop('five')).artifact_generation = 1, 'five''s place is open again, and the kernel knows');
	v := pg_temp.req_ask('files', p_name => 'five');
	v_between := (v ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v_between <> v_before and v_item ->> 'requestId' = v_between::text
		and pg_temp.req_made(v_between, (v_item ->> 'token')::uuid, v_made) = pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_between)).artifact_generation = 1 and pg_temp.req_download(v_between) ->> 'state' = 'ready'
		and pg_temp.req_ready('five') = jsonb_build_array(v_between) and (pg_temp.req_row(v_id)).state = 'running',
		'a download made while the place was open again: ' || pg_temp.req_list()::text);
	-- The restore's lease ends and it is claimed again. It closes the place again. Nothing has moved yet: the download
	-- is still ready.
	perform pg_temp.req_lapse(v_id);
	v_item := pg_temp.req_claim() -> 0;
	v_second := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and (pg_temp.req_row(v_id)).attempts = 2 and v_second <> v_first
		and v_item -> 'progress' = jsonb_build_object('bundle', v_bundle, 'step', 'reopened')
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_bundle, 'step', 'close')) ->> 'state' = 'go'
		and (pg_temp.rec_shop('five')).artifact_generation = 1 and pg_temp.req_download(v_between) ->> 'state' = 'ready',
		'claimed again, and closed again: ' || coalesce(v_item::text, 'nothing'));
	-- Its job that sets the place aside is let go again, and this time it moves the place, downloads/ with it. The
	-- download made in between is over from this step: to the member who reads it, in the list, and for one who asks
	-- again.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_bundle, 'step', 'set-aside')) ->> 'state' = 'go',
		'the second attempt to move the place');
	q := pg_temp.req_row(v_between);
	v := pg_temp.req_ask('files', p_name => 'five');
	perform pg_temp.base_assert(q.state = 'expired' and q.lease_token is null and (pg_temp.rec_shop('five')).artifact_generation = 2
		and pg_temp.req_download(v_between) = jsonb_build_object('schema', 'qorpera.code-download/v1', 'requestId', v_between,
			'file', 'files', 'state', 'failed', 'reason', 'failed', 'path', null, 'bytes', null)
		and pg_temp.req_ready('five') = '[]'::jsonb and v ->> 'state' = 'queued' and v ->> 'requestId' not in (v_before::text, v_between::text),
		'a download made between two attempts is over at the second: ' || to_jsonb(q)::text || ' ' || pg_temp.req_list()::text);
	-- (The one asked for now is refused in the closed place.)
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v ->> 'requestId'
		and pg_temp.req_step((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid) ->> 'state' = 'go'
		and pg_temp.req_finish((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid,
			pg_temp.req_outcome('{"state":"failed","code":"CODE_HOST_RESTORE_IN_PROGRESS"}')) = pg_temp.req_recorded(null), 'no download from a closed place');
	-- The job that looks at what the folder kept of the move asks the same step, and may end what is ended already. The
	-- build and the open move nothing out of the place: their steps leave the generation where it is.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_bundle, 'step', 'set-aside')) ->> 'state' = 'go'
		and (pg_temp.rec_shop('five')).artifact_generation = 3
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_bundle, 'step', 'build', 'setAside', v_aside)) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_bundle, 'step', 'open', 'setAside', v_aside, 'built', true)) ->> 'state' = 'go'
		and (pg_temp.rec_shop('five')).artifact_generation = 3, 'the steps that move nothing out');
	perform pg_temp.base_assert(pg_temp.req_record(v_id, v_second, v_bundle, 'g2', 'g2') = pg_temp.req_restored(3, 2, 0, 0), 'five is restored');
	-- The repository is open again, before the request ends: a member asks for the code and it is made in the new place.
	v := pg_temp.req_ask('files', p_name => 'five');
	v_after := (v ->> 'requestId')::uuid;
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v_item ->> 'requestId' = v_after::text
		and pg_temp.req_made(v_after, (v_item ->> 'token')::uuid, v_made) = pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_after)).artifact_generation = 3 and pg_temp.req_ready('five') = jsonb_build_array(v_after),
		'a download made after the open');
	-- The restore's last job removes the set-aside copy, as asked. It moves nothing out of the place: its step ends no
	-- download, and neither does the request's finish.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_bundle, 'step', 'discard', 'setAside', v_aside,
			'built', true)) ->> 'state' = 'go'
		and (pg_temp.rec_shop('five')).artifact_generation = 3 and pg_temp.req_download(v_after) ->> 'state' = 'ready'
		and pg_temp.req_finish(v_id, v_second, pg_temp.req_restore_outcome(v_bundle, 'g2')) = pg_temp.req_recorded(3)
		and (pg_temp.req_row(v_after)).state = 'done' and pg_temp.req_download(v_after) ->> 'state' = 'ready'
		and pg_temp.req_ready('five') = jsonb_build_array(v_after) and pg_temp.req_ask('files', p_name => 'five') ->> 'requestId' = v_after::text,
		'a download made after the open outlives the discard and the finish: ' || pg_temp.req_list()::text);
end $$;

-- company/six: a restore from `fresh` that is claimed twice, with the place open in between. Its first claim took a
-- bundle, found at the close that the place had moved on, took one more and closed the place with that. The job that
-- sets the place aside was let go and failed before it moved anything, the place was opened again, and the word that
-- the request failed never reached the kernel. A change lands in the open place. The executor of the next claim reads
-- the place, takes a new bundle of it as it stands, and restores from that. So the bundle's name in the progress
-- changes inside a claim and between two claims of one request, the record is made with the last one, and main as
-- restored is main as it was. No change is lost.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'six');
do $$
declare v jsonb; v_item jsonb; v_id uuid; v_first uuid; v_second uuid; q public.qorpera_code_requests%rowtype;
	v_moved text := '20261110T155959Z-' || left(pg_temp.rec_sha('k2'), 12);
	v_old text := '20261110T160000Z-' || left(pg_temp.rec_sha('k2'), 12);
	v_new text := '20261110T170000Z-' || left(pg_temp.rec_sha('k3'), 12);
	v_closed text := '20261110T160100Z'; v_again text := '20261110T170100Z';
	v_aside text := 'code/_set-aside/company/at-20261110T170100Z/six';
begin
	perform pg_temp.rec_land(60, 'k0', 'k1', p_name => 'six');
	perform pg_temp.rec_land(61, 'k1', 'k2', p_name => 'six');
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', 'fresh', 'keep', 'A drill.', 'six');
	v_item := pg_temp.req_claim() -> 0;
	v_first := (v_item ->> 'token')::uuid;
	-- The first claim: the bundle's two jobs and the close, which is let go and so writes the kernel's word. That close
	-- writes no mark: a session's branch had moved since the bundle was taken. The executor says that the place is open
	-- (the word goes), takes one more bundle (two jobs, which still carry the first one's name) and closes with that
	-- one: the name changes inside one claim too, and a step that names `fresh` after one that named `close` moves
	-- nothing and ends no download. Then the job that sets the place aside is let go.
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item ->> 'bundle' = 'fresh' and v_item -> 'progress' = 'null'::jsonb
		and pg_temp.req_step(v_id, v_first, '{"step":"fresh"}') ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_first, '{"step":"fresh"}') ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_moved, 'step', 'close')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_moved, 'step', 'close', 'held', true)
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_moved, 'step', 'reopened')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_moved, 'step', 'reopened')
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_moved, 'step', 'fresh')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_moved, 'step', 'fresh')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_moved, 'step', 'fresh')
		and (pg_temp.rec_shop('six')).artifact_generation = 0
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_old, 'step', 'close')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'set-aside')) ->> 'state' = 'go',
		'six''s first claim: ' || coalesce(v_item::text, 'none'));
	-- That job moves nothing, and the executor opens the place again and says so. A session's change lands there: main
	-- is past the bundle.
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_first, jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'reopened')) ->> 'state' = 'go'
		and not (pg_temp.req_row(v_id)).progress ? 'held', 'six''s place is open again, and the kernel knows');
	perform pg_temp.rec_land(62, 'k2', 'k3', p_name => 'six');
	perform pg_temp.base_assert(pg_temp.req_rows('six') = '1:L 2:L 3:L' and (pg_temp.rec_shop('six')).last_main = pg_temp.rec_sha('k3')
		and (pg_temp.req_row(v_id)).state = 'running', 'a landing while the place was open again: ' || pg_temp.req_rows('six'));
	-- The request's lease ends and it is claimed again, with the first claim's bundle in its progress. The jobs that
	-- read the place and take the new bundle ask their steps with what the kernel saved; the close brings the new name.
	perform pg_temp.req_quiet();
	perform pg_temp.req_lapse(v_id);
	v_item := pg_temp.req_claim() -> 0;
	v_second := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_second <> v_first
		and v_item -> 'progress' = jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'reopened')
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'fresh')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'fresh')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'fresh')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_old, 'at', v_closed, 'step', 'fresh')
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_new, 'at', v_closed, 'step', 'close')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('bundle', v_new, 'at', v_closed, 'step', 'close', 'held', true),
		'claimed again, a new bundle: ' || coalesce(v_item::text, 'nothing') || ' ' || (pg_temp.req_row(v_id)).progress::text);
	perform pg_temp.base_assert(
		pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_new, 'at', v_again, 'step', 'set-aside')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_new, 'at', v_again, 'step', 'set-aside')) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_new, 'at', v_again, 'step', 'build', 'setAside', v_aside)) ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, jsonb_build_object('bundle', v_new, 'at', v_again, 'step', 'open', 'setAside', v_aside,
			'built', true)) ->> 'state' = 'go', 'the restore from the new bundle');
	-- The record, with the new bundle: main as restored is where the record has main. Every row stays as it is.
	v := pg_temp.req_record(v_id, v_second, v_new, 'k3', 'k3');
	perform pg_temp.base_assert(v = pg_temp.req_restored(4, 3, 0, 0) and pg_temp.req_rows('six') = '1:L 2:L 3:L 4:L'
		and pg_temp.rec_is(4, 'restore', 'landed', 'k3', 'k3', 'six') and (pg_temp.rec_row(4, 'six')).restored_from = v_new
		and (pg_temp.rec_shop('six')).restored_from = v_new and (pg_temp.rec_shop('six')).last_main = pg_temp.rec_sha('k3'),
		'nothing is lost: ' || v::text || ' ' || pg_temp.req_rows('six'));
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_second, pg_temp.req_restore_outcome(v_new, 'k3',
			jsonb_build_object('previousMainSha', pg_temp.rec_sha('k3'), 'movedTo', v_aside))) = pg_temp.req_recorded(4), 'six''s restore ends');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.state = 'done' and q.attempts = 2 and q.outcome ->> 'bundle' = v_new and q.outcome -> 'lost' = '0'
		and q.outcome -> 'keptThrough' = '3' and q.progress ->> 'bundle' = v_new and q.progress -> 'recorded' ->> 'bundle' = v_new,
		'the request names the bundle it restored: ' || to_jsonb(q)::text);
end $$;

-- company/seven: the kernel keeps for itself that a restore holds the place (`held` in the progress), by one rule: the
-- word stands from the first close step that is let go until the executor says the place is open again. No caller can
-- write it or take it away by sending it. While it stands the request is handed out and let go beside working
-- sessions, whatever a step is called: so a request whose executor stopped between closing the place and setting it
-- aside, or after it moved the place, is not put off with the repository closed. Only the step `reopened` takes the
-- word away, and from there the request waits for quiet sessions like one that has not begun. A request that ends
-- failed keeps the word, and the next restore asked for the place begins with it.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'seven');
do $$
declare v jsonb; v_item jsonb; v_id uuid; v_next uuid; v_first uuid; v_second uuid; v_third uuid; v_token uuid;
	b1 uuid := '91170000-0000-4000-8000-0000000000b1';
	v_bundle text := '20261110T160000Z-' || left(pg_temp.rec_sha('m2'), 12); v_at text := '20261110T160100Z';
	v_busy jsonb := '{"schema":"qorpera.code-request-step/v1","state":"busy"}';
	v_close jsonb; v_aside jsonb; v_word text; v_failed jsonb;
begin
	v_close := jsonb_build_object('bundle', v_bundle, 'step', 'close');
	v_aside := jsonb_build_object('bundle', v_bundle, 'at', v_at, 'step', 'set-aside');
	v_failed := pg_temp.req_outcome('{"state":"failed","code":"SET_ASIDE_FAILED:UNCLASSIFIED:PLACE_CLOSED"}');
	perform pg_temp.rec_land(63, 'm0', 'm1', p_name => 'seven');
	perform pg_temp.rec_land(64, 'm1', 'm2', p_name => 'seven');
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', v_bundle, 'keep', 'The folder lost objects.', 'seven');
	v_item := pg_temp.req_claim() -> 0;
	v_first := (v_item ->> 'token')::uuid;
	-- The place's first restore begins without the word, and the caller cannot write it: a step that brings it is
	-- saved without it.
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).progress is null and v_item -> 'progress' = 'null'::jsonb
		and pg_temp.req_step(v_id, v_first, v_close || '{"step":"fresh","held":true}') ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = v_close || '{"step":"fresh"}',
		'the caller cannot write the word: ' || (pg_temp.req_row(v_id)).progress::text);
	-- So a session that starts puts the request off, as any that does not hold the place: whatever the step is called,
	-- the close and the set-aside too, and whatever it says of `held`.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	foreach v_word in array array['close', 'fresh', 'set-aside', 'build', 'open', 'discard', 'reopened'] loop
		perform pg_temp.base_assert(pg_temp.req_step(v_id, v_first, v_aside || jsonb_build_object('step', v_word, 'held', true)) = v_busy,
			'no word, and put off at a step named ' || v_word);
	end loop;
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).progress = v_close || '{"step":"fresh"}'
		and (pg_temp.rec_shop('seven')).artifact_generation = 0, 'a step that is put off saves nothing');
	-- The sessions are quiet: the close is let go, and the kernel writes its word. Nothing has moved.
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_first, v_close) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = v_close || '{"held":true}' and (pg_temp.rec_shop('seven')).artifact_generation = 0,
		'the close that is let go sets the word: ' || (pg_temp.req_row(v_id)).progress::text);
	-- The close job writes its mark, and the executor stops before it asks the set-aside step: the repository is
	-- closed, and nothing has moved. Company work goes on: a session runs, and one of the repository's sits on a
	-- machine. The request is claimed all the same, with the word for its executor to read.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	update public.qorpera_coding_sessions set attached_machine_id = pg_temp.rec_copy(901), attachment_token = pg_temp.rec_copy(902),
		attachment_until = clock_timestamp(), attachment_turn = 1, attached_at = clock_timestamp() where worker_id = pg_temp.rec_copy(63);
	perform pg_temp.req_lapse(v_id);
	v_item := pg_temp.req_claim() -> 0;
	v_second := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(public.qorpera_code_restore_waits(pg_temp.rec_here(), 'company', 'seven', clock_timestamp()) = 'SESSIONS_BUSY'
		and v_item ->> 'requestId' = v_id::text and v_item -> 'progress' = v_close || '{"held":true}'
		and (pg_temp.req_row(v_id)).attempts = 2 and v_second <> v_first,
		'claimed again beside working sessions: ' || coalesce(v_item::text, 'nothing'));
	-- Its steps are let go, whatever they are called: the one that reads the place, the close again, the set-aside, and
	-- on from there. And the word stays: the caller takes it away neither by leaving it out nor by sending it as
	-- false, and a step of no other name than `reopened` does.
	foreach v_word in array array['fresh', 'close', 'set-aside', 'build', 'open', 'discard'] loop
		perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, v_aside || jsonb_build_object('step', v_word, 'held', false)) ->> 'state' = 'go'
			and (pg_temp.req_row(v_id)).progress = v_aside || jsonb_build_object('step', v_word, 'held', true),
			'held, and let go at a step named ' || v_word || ': ' || (pg_temp.req_row(v_id)).progress::text);
	end loop;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress -> 'held' = 'true' and (pg_temp.rec_shop('seven')).artifact_generation = 1,
		'and at a step that brings nothing');
	-- The same holds beside the session on the machine alone.
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	perform pg_temp.base_assert(public.qorpera_code_restore_waits(pg_temp.rec_here(), 'company', 'seven', clock_timestamp()) = 'SESSIONS_ATTACHED'
		and pg_temp.req_step(v_id, v_second, v_aside || '{"step":"fresh"}') ->> 'state' = 'go'
		and pg_temp.req_step(v_id, v_second, v_aside || '{"step":"close"}') ->> 'state' = 'go', 'let go beside a session on a machine');
	-- The other case: the place is open again as it was (a close that wrote no mark, or a set-aside job that moved
	-- nothing and a place opened again). The executor saw it, and says so. The word goes, whatever the call says of
	-- it. From there the request waits like one that has not begun: its close is put off beside the session on the
	-- machine, and beside a running one, and so is every other step, the set-aside too.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, v_aside || '{"step":"reopened","held":true}') ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = v_aside || '{"step":"reopened"}',
		'the step that says the place is open again takes the word away: ' || (pg_temp.req_row(v_id)).progress::text);
	foreach v_word in array array['close', 'fresh', 'set-aside', 'build', 'open', 'reopened'] loop
		perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, v_aside || jsonb_build_object('step', v_word)) = v_busy,
			'open again, and put off at a step named ' || v_word);
	end loop;
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_second, v_aside || '{"step":"close"}') = v_busy
		and (pg_temp.req_row(v_id)).progress = v_aside || '{"step":"reopened"}'
		and (pg_temp.rec_shop('seven')).artifact_generation = 1, 'and beside the session on the machine alone');
	-- Put off, the request is not handed out while that session is on its machine, and says why. The wait is no claim.
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_second, pg_temp.req_outcome('{"state":"busy"}')) = pg_temp.req_recorded(null),
		'seven''s restore is put off');
	perform pg_temp.req_now(v_id);
	perform pg_temp.base_assert(pg_temp.req_claim() = '[]'::jsonb
		and (pg_temp.req_row(v_id)).progress = v_aside || '{"step":"reopened","waiting":"SESSIONS_ATTACHED"}'
		and (pg_temp.req_row(v_id)).state = 'queued' and (pg_temp.req_row(v_id)).attempts = 2,
		'it waits like a request that has not begun: ' || (pg_temp.req_row(v_id)).progress::text);
	-- Off the machine: it is claimed, and its close is let go under the ordinary rule and writes the word again.
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = pg_temp.rec_copy(63);
	v_item := pg_temp.req_claim() -> 0;
	v_third := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item -> 'progress' = v_aside || '{"step":"reopened"}'
		and (pg_temp.req_row(v_id)).attempts = 3 and not (pg_temp.req_row(v_id)).progress ? 'held'
		and pg_temp.req_step(v_id, v_third, v_aside || '{"step":"close"}') ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = v_aside || '{"step":"close","held":true}',
		'claimed when the sessions are quiet: ' || coalesce(v_item::text, 'nothing'));
	-- The request ends failed with the place closed. It keeps the word: the place was not seen open.
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_third, v_failed) = pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_id)).state = 'failed' and (pg_temp.req_row(v_id)).progress -> 'held' = 'true', 'seven''s restore failed');
	-- A request that only proves a bundle begins with no word, whatever the place's last restore left.
	v_next := pg_temp.req_restore('verify', v_bundle, null, 'A drill.', 'seven');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert((pg_temp.req_row(v_next)).progress is null and v_item ->> 'requestId' = v_next::text
		and pg_temp.req_finish(v_next, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
			'result', 'verified', 'mainSha', pg_temp.rec_sha('m2'), 'refsSha256', repeat('a', 64), 'refs', 9))) = pg_temp.req_recorded(null),
		'a verify begins without the word');
	-- The operator asks again for the place, by the bundle's name. That request begins with the word, since the last
	-- restore of the place ended failed while holding it: the repository may still be closed. So it is handed out
	-- beside working sessions, and its steps are let go (its executor reads the place first, under the step `close`).
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	update public.qorpera_coding_sessions set attached_machine_id = pg_temp.rec_copy(901), attachment_token = pg_temp.rec_copy(902),
		attachment_until = clock_timestamp(), attachment_turn = 1, attached_at = clock_timestamp() where worker_id = pg_temp.rec_copy(63);
	v_next := pg_temp.req_restore('restore', v_bundle, 'keep', 'Once more.', 'seven');
	v_item := pg_temp.req_claim() -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert((pg_temp.req_row(v_next)).progress = '{"held":true}' and v_item ->> 'requestId' = v_next::text
		and v_item -> 'progress' = '{"held":true}' and (pg_temp.req_row(v_next)).attempts = 1
		and pg_temp.req_step(v_next, v_token, v_close) ->> 'state' = 'go'
		and pg_temp.req_step(v_next, v_token, v_close) ->> 'state' = 'go'
		and pg_temp.req_step(v_next, v_token, v_aside) ->> 'state' = 'go'
		and (pg_temp.req_row(v_next)).progress = v_aside || '{"held":true}' and (pg_temp.rec_shop('seven')).artifact_generation = 2,
		'the next request for a place that is held begins with the word: ' || coalesce(v_item::text, 'nothing'));
	-- The record keeps the word beside its own, and the restore ends.
	v := pg_temp.req_record(v_next, v_token, v_bundle, 'm2', 'm2');
	perform pg_temp.base_assert(v = pg_temp.req_restored(3, 2, 0, 0) and (pg_temp.req_row(v_next)).progress -> 'held' = 'true'
		and (pg_temp.req_row(v_next)).progress -> 'recorded' ->> 'bundle' = v_bundle
		and pg_temp.req_finish(v_next, v_token, pg_temp.req_restore_outcome(v_bundle, 'm2')) = pg_temp.req_recorded(3)
		and (pg_temp.req_row(v_next)).state = 'done', 'seven is restored: ' || v::text);
	-- A restore that ended well leaves no word to the next: the place is open. That one waits for quiet sessions, is
	-- put off at its close when a session starts, and, failed without having been let go to close, leaves none either.
	v_next := pg_temp.req_restore('restore', v_bundle, 'keep', 'A drill.', 'seven');
	perform pg_temp.base_assert((pg_temp.req_row(v_next)).progress is null and pg_temp.req_claim() = '[]'::jsonb
		and (pg_temp.req_row(v_next)).progress = '{"waiting":"SESSIONS_BUSY"}', 'no word after a restore that ended well');
	perform pg_temp.req_quiet();
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = pg_temp.rec_copy(63);
	v_item := pg_temp.req_claim() -> 0;
	v_token := (v_item ->> 'token')::uuid;
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_next::text and pg_temp.req_step(v_next, v_token, v_close) = v_busy
		and pg_temp.req_finish(v_next, v_token, pg_temp.req_outcome('{"state":"failed","code":"CLOSE_FAILED:CODE_BUNDLE_MISSING"}'))
			= pg_temp.req_recorded(null) and (pg_temp.req_row(v_next)).progress is null, 'a request that never held the place');
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	v_next := pg_temp.req_restore('restore', v_bundle, 'keep', 'A drill.', 'seven');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert((pg_temp.req_row(v_next)).progress is null and v_item ->> 'requestId' = v_next::text
		and pg_temp.req_finish(v_next, (v_item ->> 'token')::uuid,
			pg_temp.req_outcome('{"state":"failed","code":"CLOSE_FAILED:CODE_BUNDLE_MISSING"}')) = pg_temp.req_recorded(null),
		'no word after a request that never held the place');
end $$;

-- company/two: three landings, an undo of the second, and a landing. Bundles were taken at b3 and at b5.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'two');
do $$
declare v jsonb; v_item jsonb;
	v_at3 text := '20261101T020000Z-0123456789ab'; v_at5 text := '20261102T020000Z-0123456789ab';
	v_at6 text := '20261103T020000Z-0123456789ab'; v_at2 text := '20261031T020000Z-0123456789ab';
begin
	perform pg_temp.rec_land(80, 'b0', 'b1', p_name => 'two');
	perform pg_temp.rec_land(81, 'b1', 'b2', p_name => 'two');
	perform pg_temp.rec_land(82, 'b2', 'b3', p_name => 'two');
	perform pg_temp.base_assert(pg_temp.req_undone('two-undo', 2, false, 'b3', 'b4', p_name => 'two') = pg_temp.req_recorded(4), 'two''s undo');
	perform pg_temp.rec_land(83, 'b4', 'b5', p_name => 'two');
	perform pg_temp.base_assert(pg_temp.req_rows('two') = '1:L 2:R4 3:L 4:L 5:L', 'two''s rows: ' || pg_temp.req_rows('two'));
	-- Back to b3: the undo and the landing after it are lost, and the change the undo took out is in main again.
	v := pg_temp.req_restore_to(v_at3, 'b3', 'two', 'b5');
	perform pg_temp.base_assert(v = pg_temp.req_restored(6, 3, 2, 0) and pg_temp.req_rows('two') = '1:L 2:L 3:L 4:- 5:- 6:L'
		and pg_temp.req_restore_end(v_at3, 'b3') = pg_temp.req_recorded(6), 'back: ' || v::text || ' ' || pg_temp.req_rows('two'));
	-- Forward to the newer copy, at b5: the two rows are in main's history again. The undo is back, so the change it
	-- took out is out again, undone by it. The first restore's row stays: the commit it restored is in the history.
	v := pg_temp.req_restore_to(v_at5, 'b5', 'two', 'b3');
	perform pg_temp.base_assert(v = pg_temp.req_restored(7, 5, 0, 2) and pg_temp.req_rows('two') = '1:L 2:R4 3:L 4:L 5:L 6:L 7:L'
		and pg_temp.rec_is(7, 'restore', 'landed', 'b3', 'b5', 'two')
		and pg_temp.req_restore_end(v_at5, 'b5') = pg_temp.req_recorded(7), 'forward: ' || v::text || ' ' || pg_temp.req_rows('two'));
	-- What came back is undone like any change: its commits are in main.
	perform pg_temp.base_assert(pg_temp.req_undone('two-undo-back', 5, false, 'b5', 'b6', p_name => 'two') = pg_temp.req_recorded(8)
		and (current_setting('qorpera_test.req_item')::jsonb -> 'change') = jsonb_build_object('n', 5, 'mainBefore', pg_temp.rec_sha('b4'),
			'mainAfter', pg_temp.rec_sha('b5'))
		and pg_temp.req_rows('two') = '1:L 2:R4 3:L 4:L 5:R8 6:L 7:L 8:L', 'an undo of a row that came back: ' || pg_temp.req_rows('two'));
	-- Back again to b3: both undos are lost, so both changes they took out are in main again where main holds them (the
	-- second), or lost with their undo (the fifth). The restore that went forward is lost too.
	v := pg_temp.req_restore_to(v_at3, 'b3', 'two', 'b6');
	perform pg_temp.base_assert(v = pg_temp.req_restored(9, 3, 4, 0) and pg_temp.req_rows('two') = '1:L 2:L 3:L 4:- 5:- 6:L 7:- 8:- 9:L'
		and (pg_temp.rec_row(5, 'two')).reverted_by is null
		and pg_temp.req_restore_end(v_at3, 'b3') = pg_temp.req_recorded(9), 'back again: ' || v::text || ' ' || pg_temp.req_rows('two'));
	-- Forward to a copy taken after the second undo, at b6: every row is what it was then, each undo with its target.
	v := pg_temp.req_restore_to(v_at6, 'b6', 'two', 'b3');
	perform pg_temp.base_assert(v = pg_temp.req_restored(10, 8, 0, 4)
		and pg_temp.req_rows('two') = '1:L 2:R4 3:L 4:L 5:R8 6:L 7:L 8:L 9:L 10:L'
		and pg_temp.req_restore_end(v_at6, 'b6') = pg_temp.req_recorded(10), 'forward again: ' || v::text || ' ' || pg_temp.req_rows('two'));
	-- Back to b2, and the third change's commit lands again, from where main now stands. Its new row is the one that
	-- says so; an undo takes it out. Then forward to the copy at b6, whose history never held that new row: there the
	-- commit is the third row's, as it was, and the new row and its undo are lost.
	v := pg_temp.req_restore_to(v_at2, 'b2', 'two', 'b6');
	perform pg_temp.base_assert(v = pg_temp.req_restored(11, 2, 8, 0) and pg_temp.req_rows('two') = '1:L 2:L 3:- 4:- 5:- 6:- 7:- 8:- 9:- 10:- 11:L'
		and pg_temp.req_restore_end(v_at2, 'b2') = pg_temp.req_recorded(11), 'back to the second: ' || v::text || ' ' || pg_temp.req_rows('two'));
	perform pg_temp.base_assert(pg_temp.rec_land(84, 'b2', 'b3', p_name => 'two') = pg_temp.rec_answer('recorded', 12)
		and pg_temp.req_undone('two-undo-again', 12, false, 'b3', 'b7', p_name => 'two') = pg_temp.req_recorded(13)
		and pg_temp.req_rows('two') = '1:L 2:L 3:- 4:- 5:- 6:- 7:- 8:- 9:- 10:- 11:L 12:R13 13:L', 'the commit lands again: ' || pg_temp.req_rows('two'));
	v := pg_temp.req_restore_to(v_at6, 'b6', 'two', 'b7');
	perform pg_temp.base_assert(v = pg_temp.req_restored(14, 8, 2, 8)
		and pg_temp.req_rows('two') = '1:L 2:R4 3:L 4:L 5:R8 6:L 7:L 8:L 9:L 10:L 11:L 12:- 13:- 14:L'
		and (pg_temp.rec_row(12, 'two')).reverted_by is null
		and pg_temp.req_restore_end(v_at6, 'b6') = pg_temp.req_recorded(14), 'forward past a commit that landed twice: ' || v::text || ' ' || pg_temp.req_rows('two'));
	-- And at the commit itself, the newest row that put main there is the one in main.
	v := pg_temp.req_restore_to(v_at3, 'b3', 'two', 'b6');
	perform pg_temp.base_assert(v = pg_temp.req_restored(15, 12, 7, 1)
		and pg_temp.req_rows('two') = '1:L 2:L 3:- 4:- 5:- 6:L 7:- 8:- 9:L 10:- 11:L 12:L 13:- 14:- 15:L'
		and pg_temp.req_restore_end(v_at3, 'b3') = pg_temp.req_recorded(15), 'at the commit that landed twice: ' || v::text || ' ' || pg_temp.req_rows('two'));
end $$;

-- company/three: an undo that takes out several changes with an undo among them, and that undo's own undo. A restore
-- to before, between and after them leaves every row as it was when main stood there, whichever way it went.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'three');
do $$
declare v jsonb;
	v_at3 text := '20261101T020000Z-0123456789ab'; v_at6 text := '20261102T020000Z-0123456789ab';
	v_at7 text := '20261103T020000Z-0123456789ab';
begin
	perform pg_temp.rec_land(90, 't0', 't1', p_name => 'three');
	perform pg_temp.rec_land(91, 't1', 't2', p_name => 'three');
	perform pg_temp.rec_land(92, 't2', 't3', p_name => 'three');
	perform pg_temp.base_assert(pg_temp.req_undone('three-undo', 2, false, 't3', 'u4', p_name => 'three') = pg_temp.req_recorded(4), 'three''s undo');
	perform pg_temp.rec_land(93, 'u4', 't5', p_name => 'three');
	-- The third change and every later one are taken out: the undo of the second among them, so the second is in main
	-- again. Then that undo is undone, and every row is as it was before it.
	perform pg_temp.base_assert(pg_temp.req_undone('three-later', 3, true, 't5', 'u6', p_name => 'three') = pg_temp.req_recorded(6)
		and pg_temp.req_rows('three') = '1:L 2:L 3:R6 4:R6 5:R6 6:L', 'three, taken out from the third on: ' || pg_temp.req_rows('three'));
	perform pg_temp.base_assert(pg_temp.req_undone('three-undo-undo', 6, false, 'u6', 'u7', p_name => 'three') = pg_temp.req_recorded(7)
		and pg_temp.req_rows('three') = '1:L 2:R4 3:L 4:L 5:L 6:R7 7:L', 'three, and put back: ' || pg_temp.req_rows('three'));
	-- Back to the copy taken between the two: the rows are as they were then.
	v := pg_temp.req_restore_to(v_at6, 'u6', 'three', 'u7');
	perform pg_temp.base_assert(v = pg_temp.req_restored(8, 6, 1, 0) and pg_temp.req_rows('three') = '1:L 2:L 3:R6 4:R6 5:R6 6:L 7:- 8:L'
		and pg_temp.req_restore_end(v_at6, 'u6') = pg_temp.req_recorded(8), 'back between the undos: ' || v::text || ' ' || pg_temp.req_rows('three'));
	-- Forward to the copy taken after the second: as they were then.
	v := pg_temp.req_restore_to(v_at7, 'u7', 'three', 'u6');
	perform pg_temp.base_assert(v = pg_temp.req_restored(9, 7, 0, 1) and pg_temp.req_rows('three') = '1:L 2:R4 3:L 4:L 5:L 6:R7 7:L 8:L 9:L'
		and pg_temp.req_restore_end(v_at7, 'u7') = pg_temp.req_recorded(9), 'forward past both: ' || v::text || ' ' || pg_temp.req_rows('three'));
	-- Back to before every undo: none of them is in main's history, so nothing is undone.
	v := pg_temp.req_restore_to(v_at3, 't3', 'three', 'u7');
	perform pg_temp.base_assert(v = pg_temp.req_restored(10, 3, 6, 0) and pg_temp.req_rows('three') = '1:L 2:L 3:L 4:- 5:- 6:- 7:- 8:- 9:- 10:L'
		and pg_temp.req_restore_end(v_at3, 't3') = pg_temp.req_recorded(10), 'back before the undos: ' || v::text || ' ' || pg_temp.req_rows('three'));
	-- And forward again, all the way.
	v := pg_temp.req_restore_to(v_at7, 'u7', 'three', 't3');
	perform pg_temp.base_assert(v = pg_temp.req_restored(11, 7, 0, 6)
		and pg_temp.req_rows('three') = '1:L 2:R4 3:L 4:L 5:L 6:R7 7:L 8:L 9:L 10:L 11:L'
		and pg_temp.req_restore_end(v_at7, 'u7') = pg_temp.req_recorded(11), 'forward again: ' || v::text || ' ' || pg_temp.req_rows('three'));
end $$;

-- company/long: 250 changes, each on the one before. The claim hands out no rows; the kernel finds the restored main
-- among them itself, however far back it is.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_change, last_main)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'long', 250, pg_temp.rec_sha('l250'));
insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, main_before, main_after, title)
select pg_temp.rec_here(), 'company', 'long', n, '92400000-0000-4000-8000-000000000010', 'found', 'landed',
	pg_temp.rec_sha('l' || n - 1), pg_temp.rec_sha('l' || n), 'Change ' || n
from generate_series(1, 250) n;
do $$
declare v jsonb;
	v_at10 text := '20261001T020000Z-0123456789ab'; v_at250 text := '20261109T020000Z-0123456789ab';
	v_else text := '20261002T020000Z-0123456789ab';
begin
	-- Back to the tenth change, 240 changes ago: the ten are in main, and the 240 after them are lost.
	v := pg_temp.req_restore_to(v_at10, 'l10', 'long', 'l250');
	perform pg_temp.base_assert(v = pg_temp.req_restored(251, 10, 240, 0)
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n <= 10 and c.state = 'landed') = 10
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n between 11 and 250 and c.state = 'lost') = 240
		and pg_temp.rec_is(251, 'restore', 'landed', 'l250', 'l10', 'long')
		and pg_temp.req_restore_end(v_at10, 'l10') = pg_temp.req_recorded(251), 'far back: ' || v::text);
	-- A commit no row names: not known, so nothing is lost by a guess. The ten stay in main and the rest lost, as they
	-- were.
	v := pg_temp.req_restore_to(v_else, 'elsewhere', 'long');
	perform pg_temp.base_assert(v = pg_temp.req_restored(252, null, 0, 0, 'unknown')
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n <= 10 and c.state = 'landed') = 10
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n between 11 and 250 and c.state = 'lost') = 240
		and pg_temp.rec_is(251, 'restore', 'landed', 'l250', 'l10', 'long') and pg_temp.rec_is(252, 'restore', 'landed', 'l10', 'elsewhere', 'long')
		and pg_temp.req_restore_end(v_else, 'elsewhere') = pg_temp.req_recorded(252), 'not known: ' || v::text);
	-- An undo on top of that main takes the fifth change out. Then the same copy is restored again. What is known is
	-- set: the undo came after the restore whose place is not known, and main no longer holds it, so it is lost and the
	-- change it took out is in main again. What is not known stays: the rows before that restore are as they were left.
	perform pg_temp.base_assert(pg_temp.req_undone('long-undo', 5, false, 'elsewhere', 'e1', p_name => 'long') = pg_temp.req_recorded(253)
		and (pg_temp.rec_row(5, 'long')).reverted_by = 253, 'an undo after the unknown restore');
	v := pg_temp.req_restore_to(v_else, 'elsewhere', 'long', 'e1');
	perform pg_temp.base_assert(v = pg_temp.req_restored(254, null, 1, 0, 'unknown')
		and pg_temp.rec_is(253, 'undo', 'lost', 'elsewhere', 'e1', 'long') and (pg_temp.rec_row(5, 'long')).state = 'landed'
		and (pg_temp.rec_row(5, 'long')).reverted_by is null
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n <= 10 and c.state = 'landed') = 10
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n between 11 and 250 and c.state = 'lost') = 240
		and pg_temp.rec_is(252, 'restore', 'landed', 'l10', 'elsewhere', 'long') and pg_temp.rec_is(254, 'restore', 'landed', 'e1', 'elsewhere', 'long')
		and pg_temp.req_restore_end(v_else, 'elsewhere') = pg_temp.req_recorded(254), 'the unknown copy again: ' || v::text);
	-- Forward to the newest copy: all 250 are in main again. The restores to the unknown commit are lost: main does not
	-- hold what they restored.
	v := pg_temp.req_restore_to(v_at250, 'l250', 'long');
	perform pg_temp.base_assert(v = pg_temp.req_restored(255, 250, 2, 240)
		and (select count(*) from public.qorpera_code_changes c where c.name = 'long' and c.n <= 250 and c.state = 'landed') = 250
		and pg_temp.rec_is(251, 'restore', 'landed', 'l250', 'l10', 'long') and pg_temp.rec_is(252, 'restore', 'lost', 'l10', 'elsewhere', 'long')
		and pg_temp.rec_is(253, 'undo', 'lost', 'elsewhere', 'e1', 'long') and pg_temp.rec_is(254, 'restore', 'lost', 'e1', 'elsewhere', 'long')
		and pg_temp.req_restore_end(v_at250, 'l250') = pg_temp.req_recorded(255), 'all the way forward: ' || v::text);
end $$;

-- company/eight: an undo's finish that comes late, after a turn took the undo's movement for its own (the review of
-- the release that carried this migration, F1). The undo's job moved main and its finish was not heard. The record
-- then learns of that movement from somebody else: a session that fast-forwarded to the undo's commit and hands it in
-- unchanged leaves a filler for it and takes the filler over as its landing; or a landing whose report comes late
-- takes over a filler that covers the undo and itself. The finish, made again, must take that row for the undo (the
-- undo's commit is the undo job's own), add no movement that never was, and leave the record's main where it is.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'eight');
-- Session copy p_n hands in commit p_head, which main is at and has held since it got there.
create function pg_temp.req_same(p_n integer, p_head text) returns jsonb language sql as $$
	select pg_temp.rec_record(pg_temp.rec_turn(p_n, 1, pg_temp.rec_sha(p_head), '{}', pg_temp.own_repo('company', 'eight')),
		pg_temp.rec_report('unchanged', pg_temp.rec_sha(p_head), pg_temp.rec_sha(p_head), pg_temp.rec_sha(p_head)))
$$;
-- An undo of company/eight asked for and claimed, with no finish: the claim.
create function pg_temp.req_begun(p_key text, p_change integer) returns jsonb language plpgsql as $$
declare v_id uuid := (pg_temp.req_undo(p_key, p_change, false, '{}', 'eight') ->> 'requestId')::uuid; v_item jsonb;
begin
	select item into v_item from jsonb_array_elements(pg_temp.req_claim()) item where item ->> 'requestId' = v_id::text;
	perform pg_temp.base_assert(v_item is not null, 'the undo of ' || p_change || ' is claimed');
	return v_item;
end $$;
create function pg_temp.req_eight(p_n integer) returns public.qorpera_code_changes language sql as $$
	select * from public.qorpera_code_changes c
	where c.environment_id = pg_temp.rec_here() and c.owner = 'company' and c.name = 'eight' and c.n = p_n
$$;
do $$
declare v jsonb; v_item jsonb; v_id uuid; r public.qorpera_code_changes%rowtype; s public.qorpera_code_repositories%rowtype;
begin
	perform pg_temp.rec_land(700, 'g0', 'g1', p_name => 'eight');
	perform pg_temp.rec_land(701, 'g1', 'g2', p_name => 'eight');
	perform pg_temp.rec_land(702, 'g2', 'g3', p_name => 'eight');
	perform pg_temp.rec_land(703, 'g3', 'g4', p_name => 'eight');
	perform pg_temp.rec_land(704, 'g4', 'g5', p_name => 'eight');
	perform pg_temp.base_assert(pg_temp.req_rows('eight') = '1:L 2:L 3:L 4:L 5:L', 'eight''s changes');

	-- The undo of change 1 moved main from g5 to h1, and its finish was not heard. A session hands h1 in unchanged:
	-- row 6 is its landing. The finish made again takes row 6 for the undo: one movement, the undo's, and the turn has
	-- no row of its own (its report, made again, is told the row that put main there).
	v_item := pg_temp.req_begun('late-1', 1);
	v_id := (v_item ->> 'requestId')::uuid;
	perform pg_temp.base_assert(pg_temp.req_same(710, 'h1') = pg_temp.rec_answer('adopted', 6)
		and pg_temp.rec_is(6, 'landing', 'landed', 'g5', 'h1', 'eight') and (pg_temp.req_eight(6)).worker_id = pg_temp.rec_copy(710),
		'a session takes the undo''s movement for its landing');
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('g5', 'h1'));
	r := pg_temp.req_eight(6); s := pg_temp.rec_shop('eight');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(6) and pg_temp.rec_is(6, 'undo', 'landed', 'g5', 'h1', 'eight')
		and r.undoes = array[1] and r.request_id = v_id and r.title = 'Undo change 1: Session 700' and r.worker_id is null
		and r.sequence is null and r.head_sha is null and r.how is null and r.picture is null and r.files_changed = 1
		and r.own_before is null and r.own_after is null
		and r.paths = '[{"path":"src/a.ts","change":"changed"}]'
		and pg_temp.req_rows('eight') = '1:R6 2:L 3:L 4:L 5:L 6:L' and s.last_change = 6 and s.last_main = pg_temp.rec_sha('h1')
		and (pg_temp.req_row(v_id)).state = 'done' and (pg_temp.req_row(v_id)).outcome ->> 'change' = '6'
		and not (pg_temp.req_row(v_id)).outcome ? 'unrecorded', 'the undo keeps its movement: ' || v::text || ' ' || pg_temp.req_rows('eight'));
	perform pg_temp.base_assert(pg_temp.rec_record(pg_temp.rec_copy(710), pg_temp.rec_report('unchanged', pg_temp.rec_sha('h1'),
			pg_temp.rec_sha('h1'), pg_temp.rec_sha('h1'))) = pg_temp.rec_answer('known', 6)
		and (pg_temp.rec_shop('eight')).last_change = 6, 'the session''s report again');

	-- The same, and a landing went on from the undo's commit before the finish came: nothing is put behind that
	-- landing, and the record's main stays where the landing left it.
	v_item := pg_temp.req_begun('late-2', 2);
	v_id := (v_item ->> 'requestId')::uuid;
	perform pg_temp.base_assert(pg_temp.req_same(711, 'h2') = pg_temp.rec_answer('adopted', 7)
		and pg_temp.rec_land(712, 'h2', 'g6', p_name => 'eight') = pg_temp.rec_answer('recorded', 8)
		and pg_temp.rec_is(7, 'landing', 'landed', 'h1', 'h2', 'eight'), 'a session''s row, and a landing after it');
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('h1', 'h2'));
	r := pg_temp.req_eight(7); s := pg_temp.rec_shop('eight');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(7) and pg_temp.rec_is(7, 'undo', 'landed', 'h1', 'h2', 'eight')
		and r.undoes = array[2] and r.worker_id is null and pg_temp.rec_is(8, 'landing', 'landed', 'h2', 'g6', 'eight')
		and pg_temp.req_rows('eight') = '1:R6 2:R7 3:L 4:L 5:L 6:L 7:L 8:L' and s.last_change = 8
		and s.last_main = pg_temp.rec_sha('g6'), 'no movement behind the landing: ' || v::text || ' ' || pg_temp.req_rows('eight'));

	-- The other order: the undo is recorded, then a session hands its commit in unchanged. The row that put main
	-- there is the undo's, and stays it.
	v_item := pg_temp.req_begun('late-3', 3);
	v_id := (v_item ->> 'requestId')::uuid;
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('g6', 'h3'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(9) and pg_temp.req_same(713, 'h3') = pg_temp.rec_answer('known', 9)
		and pg_temp.rec_is(9, 'undo', 'landed', 'g6', 'h3', 'eight') and (pg_temp.req_eight(9)).undoes = array[3]
		and pg_temp.req_rows('eight') = '1:R6 2:R7 3:R9 4:L 5:L 6:L 7:L 8:L 9:L' and (pg_temp.rec_shop('eight')).last_change = 9,
		'the undo first, the session after it: ' || pg_temp.req_rows('eight'));

	-- A landing reported late took a filler that covers the undo and itself. The undo of change 4 moved main from h3
	-- to h4 (not heard); a landing went from h4 to g7 and its report was not heard either; the next landing left a
	-- filler from h3 to g7; then the first landing's report came and took that filler. The undo started where that row
	-- starts, so the row is the undo's: the undo takes it, its span stays, what the job counted for the undo alone is
	-- not the row's, and the landing's report, made once more, is late.
	v_item := pg_temp.req_begun('late-4', 4);
	v_id := (v_item ->> 'requestId')::uuid;
	perform pg_temp.base_assert(pg_temp.rec_land(714, 'g7', 'g8', p_name => 'eight') = pg_temp.rec_answer('recorded', 11)
		and pg_temp.rec_is(10, 'found', 'landed', 'h3', 'g7', 'eight')
		and pg_temp.rec_land(715, 'h4', 'g7', false, p_name => 'eight') = pg_temp.rec_answer('adopted', 10)
		and pg_temp.rec_is(10, 'landing', 'landed', 'h3', 'g7', 'eight')
		-- The filler began before the landing did: the landing's own two ends are kept beside the span.
		and (pg_temp.req_eight(10)).own_before = pg_temp.rec_sha('h4') and (pg_temp.req_eight(10)).own_after = pg_temp.rec_sha('g7'),
		'a late landing takes the filler: ' || pg_temp.req_rows('eight'));
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('h3', 'h4'));
	r := pg_temp.req_eight(10); s := pg_temp.rec_shop('eight');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(10) and pg_temp.rec_is(10, 'undo', 'landed', 'h3', 'g7', 'eight')
		and r.undoes = array[4] and r.worker_id is null and r.files_changed is distinct from 1
		and r.own_before = pg_temp.rec_sha('h3') and r.own_after = pg_temp.rec_sha('h4')
		and pg_temp.req_rows('eight') = '1:R6 2:R7 3:R9 4:R10 5:L 6:L 7:L 8:L 9:L 10:L 11:L' and s.last_change = 11
		and s.last_main = pg_temp.rec_sha('g8'), 'the undo takes the row that starts where it started: ' || v::text || ' ' || pg_temp.req_rows('eight'));
	perform pg_temp.base_assert(pg_temp.rec_record(pg_temp.rec_copy(715), pg_temp.rec_report('landed', pg_temp.rec_sha('g7'),
			pg_temp.rec_sha('h4'), pg_temp.rec_sha('g7'), '{"inLine":false}')) = pg_temp.rec_answer('late', null)
		and (pg_temp.rec_shop('eight')).last_change = 11, 'the landing''s report again is late');

	-- The record has had main at the undo's commit, and no row of main's history is the undo's to take: here the row
	-- that recorded it is lost, as a restore that went back past it leaves it. Nothing is written to the rows, no state
	-- changes, the record's main stays, and the request says so.
	v_item := pg_temp.req_begun('late-5', 5);
	v_id := (v_item ->> 'requestId')::uuid;
	perform pg_temp.base_assert(pg_temp.req_same(716, 'h5') = pg_temp.rec_answer('adopted', 12), 'a session''s row for the fifth undo');
	update public.qorpera_code_changes set state = 'lost'
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'eight' and n = 12;
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('g8', 'h5'));
	s := pg_temp.rec_shop('eight');
	perform pg_temp.base_assert(v = pg_temp.req_recorded(null) and pg_temp.rec_is(12, 'landing', 'lost', 'g8', 'h5', 'eight')
		and pg_temp.req_rows('eight') = '1:R6 2:R7 3:R9 4:R10 5:L 6:L 7:L 8:L 9:L 10:L 11:L 12:-' and s.last_change = 12
		and s.last_main = pg_temp.rec_sha('h5') and (pg_temp.req_row(v_id)).state = 'done'
		and (pg_temp.req_row(v_id)).outcome -> 'unrecorded' = 'true' and not (pg_temp.req_row(v_id)).outcome ? 'change'
		and pg_temp.req_read(v_id) -> 'change' = 'null', 'nothing is written behind the record: ' || v::text || ' ' || pg_temp.req_rows('eight'));

	-- Undoing the recovered undo (the review of release v232's third cut, F1). Row 10 is the undo of change 4, and its
	-- span, h3 to g7, also holds a landing from h4 to g7 that has nothing to do with it. An undo of row 10 alone works
	-- from the undo's own two ends, h3 to h4: the job puts back what the undo took out, and the landing stays.
	v_item := pg_temp.req_begun('late-6', 10);
	v_id := (v_item ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_item -> 'change' = jsonb_build_object('n', 10, 'mainBefore', pg_temp.rec_sha('h3'),
		'mainAfter', pg_temp.rec_sha('h4')) and v_item -> 'andLater' = 'false', 'the undo''s own two ends: ' || v_item::text);
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('h5', 'k1'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(13) and pg_temp.rec_is(13, 'undo', 'landed', 'h5', 'k1', 'eight')
		and (pg_temp.req_eight(13)).undoes = array[10] and (pg_temp.req_eight(13)).own_after is null
		and pg_temp.req_rows('eight') = '1:R6 2:R7 3:R9 4:L 5:L 6:L 7:L 8:L 9:L 10:R13 11:L 12:- 13:L',
		'the recovered undo is undone: ' || v::text || ' ' || pg_temp.req_rows('eight'));
	-- A row that does not know where its own movement began (a session found its commit in main already and took the
	-- filler that ends there) is not undone alone; with everything after it, it is, back to where the filler began.
	perform pg_temp.base_assert(pg_temp.req_same(717, 'm9') = pg_temp.rec_answer('adopted', 14)
		and pg_temp.rec_is(14, 'landing', 'landed', 'k1', 'm9', 'eight') and (pg_temp.req_eight(14)).own_before is null
		and (pg_temp.req_eight(14)).own_after = pg_temp.rec_sha('m9'), 'a session''s row whose beginning is not known');
	perform pg_temp.base_assert(pg_temp.req_undo('late-7', 14, false, '{}', 'eight') = pg_temp.req_refused('wall')
		and not exists (select 1 from public.qorpera_code_requests request where request.environment_id = pg_temp.rec_here()
			and request.name = 'eight' and request.state in ('queued','running')), 'it is not undone alone');
	v_id := (pg_temp.req_undo('late-8', 14, true, '{}', 'eight') ->> 'requestId')::uuid;
	select item into v_item from jsonb_array_elements(pg_temp.req_claim()) item where item ->> 'requestId' = v_id::text;
	perform pg_temp.base_assert(v_item -> 'change' = jsonb_build_object('n', 14, 'mainBefore', pg_temp.rec_sha('k1'),
		'mainAfter', pg_temp.rec_sha('m9')) and v_item -> 'andLater' = 'true', 'with everything after it: ' || coalesce(v_item::text, 'none'));
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_moved('m9', 'k2'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(15) and (pg_temp.req_eight(15)).undoes = array[14]
		and pg_temp.req_rows('eight') = '1:R6 2:R7 3:R9 4:L 5:L 6:L 7:L 8:L 9:L 10:R13 11:L 12:- 13:L 14:R15 15:L',
		'and it is taken out with what came after: ' || v::text || ' ' || pg_temp.req_rows('eight'));
end $$;

-- 6. More than 500 changes are not taken out at once ----------------------------------------------------------------------
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_change, last_main)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'big', 502, pg_temp.rec_sha('b502'));
insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, main_before, main_after, title)
select pg_temp.rec_here(), 'company', 'big', n, '92400000-0000-4000-8000-000000000010', 'found', 'landed',
	pg_temp.rec_sha('b' || n - 1), pg_temp.rec_sha('b' || n), 'Change ' || n
from generate_series(1, 502) n;
do $$
declare v jsonb;
begin
	perform pg_temp.base_assert(pg_temp.req_undo('undo-big-1', 1, true, p_name => 'big') = pg_temp.req_refused('too_many')
		and pg_temp.req_undo('undo-big-2', 2, true, p_name => 'big') = pg_temp.req_refused('too_many'), 'too many');
	-- 500 at once are asked for. Asked again the same way, that is the open request. The third change alone is another
	-- undo (and not too many): while this one is open it is told busy, not handed the request that takes out 500.
	v := pg_temp.req_undo('undo-big-3', 3, true, p_name => 'big');
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and pg_temp.req_undo('undo-big-4', 3, true, p_name => 'big') = v
		and pg_temp.req_undo('undo-big-5', 3, p_name => 'big') = pg_temp.req_refused('busy')
		and (select count(*) from public.qorpera_code_requests where name = 'big') = 1, '500 changes: ' || v::text);
	v := pg_temp.req_finish((v ->> 'requestId')::uuid, (pg_temp.req_claim() -> 0 ->> 'token')::uuid, pg_temp.req_moved('b502', 'bu'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(503) and cardinality((pg_temp.rec_row(503, 'big')).undoes) = 500
		and (pg_temp.rec_row(503, 'big')).undoes[1] = 3 and (pg_temp.rec_row(503, 'big')).undoes[500] = 502
		and (select count(*) from public.qorpera_code_changes c where c.name = 'big' and c.state = 'reverted' and c.reverted_by = 503) = 500
		and (pg_temp.rec_row(2, 'big')).state = 'landed', '500 changes taken out: ' || v::text);
end $$;

-- 7. An agent describes a change ----------------------------------------------------------------------------------------
-- Files in the company folder: a picture, a note, a folder with a picture's name, and a picture that is too large.
select pg_temp.base_commit('{"kind":"platform"}', 'req-pictures', jsonb_build_array(
	jsonb_build_object('op', 'mkdir', 'path', 'pictures'),
	jsonb_build_object('op', 'write', 'path', 'pictures/The new cart.PNG', 'file', pg_temp.base_stage('png bytes')),
	jsonb_build_object('op', 'write', 'path', 'pictures/note.md', 'file', pg_temp.base_stage('A note.')),
	jsonb_build_object('op', 'write', 'path', 'pictures/big.jpeg', 'file', pg_temp.base_stage('jpeg bytes')),
	jsonb_build_object('op', 'mkdir', 'path', 'pictures/folder.webp'))) \g /dev/null
set local session_replication_role = replica;
update public.qorpera_folder_entries set bytes = 4194305
where environment_id = pg_temp.rec_here() and key_text = 'pictures/big.jpeg';
set local session_replication_role = origin;
do $$
declare v jsonb; v_bad jsonb; r public.qorpera_code_changes%rowtype; q public.qorpera_code_changes%rowtype;
	s public.qorpera_code_repositories%rowtype; e public.qorpera_folder_entries%rowtype; v_reason record;
	v_request jsonb := jsonb_build_object('operationKey', 'describe-shape', 'owner', 'company', 'name', 'shop', 'change', 1,
		'notice', 'A cart.', 'picture', null);
begin
	-- The request has exactly its keys; a notice or a picture left out is a null, and one of the two is given.
	foreach v_bad in array array['null'::jsonb, '[]', v_request - 'change', v_request - 'owner', v_request || '{"title":"New"}',
		v_request || '{"notice":null}', v_request - 'notice' - 'picture', v_request || jsonb_build_object('notice', E'One.\nTwo.'),
		v_request || '{"notice":""}', v_request || '{"notice":7}', v_request || '{"picture":7}', v_request || '{"picture":""}',
		v_request || jsonb_build_object('picture', repeat('p', 1021) || '.png'), v_request || '{"change":0}',
		v_request || '{"change":"1"}', v_request || '{"name":"Shop"}'] loop
		perform pg_temp.base_error(format('select public.qorpera_folder_describe_code_change(pg_temp.c3_alice(), %L)', v_bad),
			'22023', 'Code request is invalid');
	end loop;
	perform pg_temp.base_error($q$select pg_temp.req_describe('describe-none', 999, '{"notice":"A cart."}')$q$, 'P0002', 'No such change');
	perform pg_temp.base_error($q$select public.qorpera_folder_describe_code_change(pg_temp.c3_alice(), '{"operationKey":"describe-none",
		"owner":"company","name":"nowhere","change":1,"notice":"A cart."}')$q$, 'P0002', 'No such change');

	-- The notice: saved on the row; its file and the list are behind again.
	r := pg_temp.rec_row(1); s := pg_temp.rec_shop();
	v := pg_temp.req_describe('describe-1', 1, '{"notice":"The shop has a cart now."}');
	q := pg_temp.rec_row(1);
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-change-described/v1', 'state', 'saved', 'change', 1,
			'notice', 'The shop has a cart now.', 'picture', null)
		and q.notice = 'The shop has a cart now.' and q.picture is null and q.file_version = r.file_version + 1
		and (pg_temp.rec_shop()).index_version = s.index_version + 1
		and to_jsonb(q) - 'notice' - 'file_version' = to_jsonb(r) - 'notice' - 'file_version', 'a notice: ' || v::text);
	-- The same call again answers the same and saves nothing more.
	perform pg_temp.base_assert(pg_temp.req_describe('describe-1', 1, '{"notice":"The shop has a cart now."}') = v
		and (pg_temp.rec_row(1)).file_version = q.file_version and (pg_temp.rec_shop()).index_version = s.index_version + 1, 'a replay');

	-- A picture: a file in the company's shared part, with a picture's name, of at most 4 MiB. Each thing wrong with
	-- one is told, and nothing is saved.
	for v_reason in select * from (values
		('members/92400000-0000-4000-8000-000000000001/private/secret.png', 'not_shared'),
		('credentials/token.png', 'not_shared'), ('pictures/../secret.png', 'not_shared'), ('/pictures/a.png', 'not_shared'),
		('pictures/none.png', 'missing'), ('pictures/folder.webp', 'not_a_file'), ('pictures', 'not_a_file'),
		('pictures/note.md', 'not_a_picture'), ('pictures/big.jpeg', 'too_large')) t(path, reason)
	loop
		v := pg_temp.req_describe('describe-' || md5(v_reason.path), 1, jsonb_build_object('picture', v_reason.path, 'notice', 'Other words.'));
		perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-change-described/v1', 'state', 'refused',
			'reason', v_reason.reason) and to_jsonb(pg_temp.rec_row(1)) = to_jsonb(q), v_reason.path || ': ' || v::text);
	end loop;
	-- A good one: the row names the file and pins its bytes; it is not copied. A null leaves the notice as it is.
	select * into strict e from public.qorpera_folder_entries
	where environment_id = pg_temp.rec_here() and key_text = public.qorpera_folder_key('pictures/The new cart.PNG');
	v := pg_temp.req_describe('describe-2', 1, '{"picture":"pictures/The new cart.PNG","notice":null}');
	r := pg_temp.rec_row(1);
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-change-described/v1', 'state', 'saved', 'change', 1,
			'notice', 'The shop has a cart now.', 'picture', jsonb_build_object('source', 'folder',
				'path', 'pictures/The new cart.PNG', 'sha256', e.file_sha256, 'bytes', e.bytes))
		and r.picture = v -> 'picture' and r.notice = 'The shop has a cart now.' and r.file_version = q.file_version + 1
		and e.file_sha256 ~ '^[0-9a-f]{64}$' and e.bytes = 9, 'a picture: ' || v::text);
	-- A notice alone leaves the picture; both at once replace both. Any row may be described: a conflict too.
	v := pg_temp.req_describe('describe-3', 1, '{"notice":"A cart, top right."}');
	perform pg_temp.base_assert(v ->> 'notice' = 'A cart, top right.' and v -> 'picture' = r.picture
		and (pg_temp.rec_row(1)).file_version = r.file_version + 1, 'a notice alone: ' || v::text);
	v := pg_temp.req_describe('describe-4', 3, '{"notice":"Nothing changed for customers.","picture":"pictures/The new cart.PNG"}');
	perform pg_temp.base_assert(v ->> 'state' = 'saved' and (pg_temp.rec_row(3)).notice = 'Nothing changed for customers.'
		and (pg_temp.rec_row(3)).picture ->> 'source' = 'folder' and (pg_temp.rec_row(3)).state = 'conflict', 'a conflict described');
	-- A picture the landing's job found wanting is no longer wanting once the agent gives one; a notice alone leaves it.
	update public.qorpera_code_changes set picture_problem = 'too_large' where name = 'shop' and n in (2, 4);
	perform pg_temp.req_describe('describe-5', 2, '{"notice":"Faster."}');
	perform pg_temp.req_describe('describe-6', 4, '{"picture":"pictures/The new cart.PNG"}');
	perform pg_temp.base_assert((pg_temp.rec_row(2)).picture_problem = 'too_large' and (pg_temp.rec_row(2)).picture is null
		and (pg_temp.rec_row(4)).picture_problem is null and (pg_temp.rec_row(4)).picture ->> 'path' = 'pictures/The new cart.PNG',
		'the picture''s problem');
end $$;

-- 8. A worker's run asks for nothing ------------------------------------------------------------------------------------
-- A coding session's own run (b1's turn, as 928 runs one) is no agent's company run: it neither undoes nor describes.
-- (The owner's coding machine is section 4's; no session is on it any more.)
set local session_replication_role = replica;
update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
	attachment_turn = null, attached_at = null where attached_machine_id is not null;
update public.qorpera_coding_sessions set phase = 'queued', updated_at = clock_timestamp()
where worker_id = '91170000-0000-4000-8000-0000000000b1';
set local session_replication_role = origin;
-- (The executor's stand-in machine goes again, as 928's executor has none, before its claim.)
update public.qorpera_coding_executors set nas_machine_id_sha256 = null where owner = 'exec-1170';
do $$
declare v_claim jsonb; v_pass jsonb; v_turn jsonb; v_token uuid; b1 uuid := '91170000-0000-4000-8000-0000000000b1';
	v_request jsonb := jsonb_build_object('operationKey', 'worker-1', 'owner', 'company', 'name', 'shop', 'change', 1,
		'andLater', false, 'reason', 'I would rather not.', 'notice', null);
	v_count bigint := (select count(*) from public.qorpera_code_requests);
begin
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-1170', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = b1::text, 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_token := (pg_temp.c3_session(b1)).lease_token;
	perform public.qorpera_begin_coding_turn(b1, v_token, '{}');
	v_pass := pg_temp.base_materialize();
	v_turn := pg_temp.base_start((v_pass -> 'run_ids' ->> 0)::uuid);
	perform pg_temp.base_error(format('select public.qorpera_folder_request_code_undo(%L, %L)', v_turn, v_request),
		'42501', 'Code authority is unavailable');
	perform pg_temp.base_error(format('select public.qorpera_folder_describe_code_change(%L, %L)', v_turn,
		v_request - 'andLater' - 'reason' || '{"notice":"Mine."}'), '42501', 'Code authority is unavailable');
	perform pg_temp.base_error(format('select public.qorpera_folder_code_request(%L, %L)', v_turn, current_setting('qorpera_test.req_first')),
		'42501', 'Code authority is unavailable');
	perform pg_temp.base_assert((select count(*) from public.qorpera_code_requests) = v_count, 'nothing was asked');
	-- A binding that names no run of this job is nobody's.
	perform pg_temp.base_error(format('select public.qorpera_folder_request_code_undo(%L, %L)',
		pg_temp.c3_alice() || jsonb_build_object('runId', pg_temp.rec_copy(1)), v_request), '42501');
end $$;
