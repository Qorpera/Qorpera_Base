-- @fixture 1210_code_change_record.test.sql until "-- The checks start here"
-- Undo, download and restore of the repositories kept in Qorpera (migration 20260930720000): the requests, the calls
-- that add them (an agent's, a member's, an operator's), the executor's claim, step and finish, and what a finish does
-- to the change record. 1210's helpers: company/shop, session copies that hand commits in, and the record call.
--   1. An agent asks for an undo: the request's shape, each refusal, a replay, one open at a time.
--   2. The executor's claim, step and finish of an undo: refused, undone, already; a filler first; an undo of an undo;
--      andLater across undo rows, and its own undo; a finish that comes late; too many starts; put off; nothing.
--   3. Downloads: the member's three calls per role, made and ready, the same main again, too large, put off, the
--      rate, no executor, and the file's removal.
--   4. Restore: the operator's call, verify, the wait for quiet sessions, progress, what a restore does to the record
--      (lost rows, files and care due again), the wall for undo, and discard.
--   5. More than 500 changes are not taken out at once.
--   6. An agent describes a change: the notice, and each thing wrong with a picture.
--   7. A worker's run asks for nothing.

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
	-- The same call again answers the same; the same key for another request is another operation's.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-1', 6, p_keys => '{"notice":"The old checkout is back."}') = v
		and (select count(*) from public.qorpera_code_requests) = 1, 'a replay');
	perform pg_temp.base_error($q$select pg_temp.req_undo('undo-1', 5)$q$, '23505', 'logical operation key is already bound to other work');
	-- Another call for the same change finds the open request, whatever else it says; one for another change is told
	-- that the repository is busy.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-1b', 6) = v and pg_temp.req_undo('undo-1c', 6, true) = v
		and pg_temp.req_undo('undo-1d', 5) = pg_temp.req_refused('busy')
		and (select count(*) from public.qorpera_code_requests) = 1, 'one open undo');
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
	-- A download is never busy at a step, whatever the company's sessions do: a turn's job cancels its job instead.
	perform pg_temp.base_assert(public.qorpera_code_care_busy(pg_temp.rec_here(), clock_timestamp())
		and pg_temp.req_step(v_files, q.lease_token) ->> 'state' = 'go'
		and (pg_temp.req_row(v_files)).lease_until > clock_timestamp() + interval '29 minutes'
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
	-- Once the newer one is made, it replaced the older one's file: nothing is left to remove, and no job is asked for.
	perform pg_temp.req_finish(v_history, (pg_temp.req_row(v_history)).lease_token, pg_temp.req_outcome(jsonb_build_object(
		'state', 'done', 'result', 'made', 'path', 'code/company/shop/downloads/shop-' || v_day || '.bundle', 'bytes', 99,
		'sha256', repeat('e', 64), 'mainSha', pg_temp.rec_sha('c23'))));
	update public.qorpera_code_requests set created_at = clock_timestamp() - interval '25 hours' where kind = 'download' and state = 'failed';
	perform pg_temp.base_assert(pg_temp.rec_land(33, 'c23', 'c24') = pg_temp.rec_answer('recorded', 18), 'main moves again');
	v_next := (pg_temp.req_ask('history') ->> 'requestId')::uuid;
	update public.qorpera_code_requests set expires_at = clock_timestamp() - interval '1 second' where id = v_history;
	v := pg_temp.req_claim();
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v -> 0 ->> 'requestId' = v_next::text
		and (pg_temp.req_row(v_history)).state = 'done' and (pg_temp.req_row(v_history)).lease_token is null, 'the older one waits: ' || v::text);
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
	v_progress jsonb; v_restored jsonb; b1 uuid := '91170000-0000-4000-8000-0000000000b1';
begin
	v_progress := jsonb_build_object('bundle', v_bundle, 'setAside', v_aside);
	v_restored := pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'restored', 'bundle', v_bundle,
		'mainSha', pg_temp.rec_sha('r1'), 'previousMainSha', pg_temp.rec_sha('s6'), 'refsSha256', repeat('a', 64), 'refs', 9,
		'keptThrough', 3, 'stranded', jsonb_build_array(pg_temp.rec_copy(44)), 'movedTo', v_aside));
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
	-- folder), for two hours, with the rows that moved main, newest first, and the repository's open sessions.
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
	perform pg_temp.base_assert(jsonb_array_length(v) = 2 and v_item - 'tips' - 'sessions' = jsonb_build_object('requestId', v_id,
			'token', q.lease_token, 'leaseUntil', q.lease_until, 'companyId', '92400000-0000-4000-8000-000000000010',
			'environmentId', pg_temp.rec_here(), 'owner', 'company', 'name', 'site', 'kind', 'restore', 'mode', 'verify',
			'bundle', v_bundle, 'damaged', 'keep', 'progress', null, 'path', null)
		and v_item -> 'tips' = jsonb_build_array(jsonb_build_object('n', 7, 'mainAfter', pg_temp.rec_sha('s6')),
			jsonb_build_object('n', 6, 'mainAfter', pg_temp.rec_sha('s5')), jsonb_build_object('n', 4, 'mainAfter', pg_temp.rec_sha('s4')),
			jsonb_build_object('n', 3, 'mainAfter', pg_temp.rec_sha('s3')), jsonb_build_object('n', 2, 'mainAfter', pg_temp.rec_sha('s2')),
			jsonb_build_object('n', 1, 'mainAfter', pg_temp.rec_sha('s1')))
		and v_item -> 'sessions' = (select jsonb_agg(jsonb_build_object('workerId', pg_temp.rec_copy(n), 'baseSha', pg_temp.rec_sha('base'))
			order by pg_temp.rec_copy(n)) from generate_series(40, 44) n)
		and q.lease_until between clock_timestamp() + interval '119 minutes' and clock_timestamp() + interval '2 hours'
		and v -> 1 ->> 'kind' = 'undo', 'the verify is claimed: ' || v::text);
	perform pg_temp.req_finish((v -> 1 ->> 'requestId')::uuid, (v -> 1 ->> 'token')::uuid, pg_temp.req_outcome(
		jsonb_build_object('state', 'done', 'result', 'nothing', 'mainSha', pg_temp.rec_sha('c24'))));
	-- A request ends as its mode does, and a verify writes no row.
	foreach v_bad in array array[v_restored, pg_temp.req_outcome('{"state":"done","result":"discarded"}')] loop
		perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, q.lease_token, v_bad),
			'22023', 'Code request outcome invalid');
	end loop;
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
		and jsonb_array_length(v_item -> 'tips') = 6 and jsonb_array_length(v_item -> 'sessions') = 5, 'the restore is claimed: ' || v_item::text);
	-- Before each job: the lease is renewed and what was done so far is kept. A session that starts stops the next job.
	v := pg_temp.req_step(v_id, v_token, v_progress);
	perform pg_temp.base_assert(v ->> 'state' = 'go' and (pg_temp.req_row(v_id)).progress = v_progress
		and pg_temp.req_step(v_id, v_token) ->> 'state' = 'go' and (pg_temp.req_row(v_id)).progress = v_progress, 'a restore''s step: ' || v::text);
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = b1;
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, '{"bundle":"other"}') = '{"schema":"qorpera.code-request-step/v1","state":"busy"}'
		and (pg_temp.req_row(v_id)).progress = v_progress, 'busy at a step');
	update public.qorpera_coding_sessions set phase = 'completed' where worker_id = b1;
	update public.qorpera_coding_sessions set attached_machine_id = pg_temp.rec_copy(901), attachment_token = pg_temp.rec_copy(902),
		attachment_until = clock_timestamp(), attachment_turn = 1, attached_at = clock_timestamp() where worker_id = pg_temp.rec_copy(41);
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token) ->> 'state' = 'busy', 'a session went on a machine');
	update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null, attachment_until = null,
		attachment_turn = null, attached_at = null where worker_id = pg_temp.rec_copy(41);
	-- The executor stopped: the next claim hands the request out with what it had done.
	perform pg_temp.req_lapse(v_id);
	v_item := pg_temp.req_claim() -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item -> 'progress' = v_progress
		and (pg_temp.req_row(v_id)).attempts = 2 and v_token <> q.lease_token, 'it goes on where it was: ' || v_item::text);

	-- Restored, from a bundle older than main: main still holds the rows up to the third.
	foreach v_bad in array array[pg_temp.req_outcome('{"state":"done","result":"verified"}') || jsonb_build_object(
			'mainSha', pg_temp.rec_sha('r1'), 'refsSha256', repeat('a', 64), 'refs', 9),
		v_restored - 'stranded', v_restored - 'previousMainSha', v_restored || '{"keptThrough":0}', v_restored || '{"keptThrough":"3"}',
		v_restored || '{"bundle":"fresh"}', v_restored || '{"movedTo":"code/company/site"}', v_restored || '{"stranded":[7]}',
		v_restored || '{"refs":-1}', v_restored || '{"extra":true}'] loop
		perform pg_temp.base_error(format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token, v_bad),
			'22023', 'Code request outcome invalid');
	end loop;
	v := pg_temp.req_finish(v_id, v_token, v_restored);
	r := pg_temp.rec_row(8, 'site'); s := pg_temp.rec_shop('site'); q := pg_temp.req_row(v_id);
	-- The rows after the third that moved main are lost; the undo among them first gave its target back to main, so
	-- change 2 is in main again, as it was when the bundle was taken. A conflict stays what it was.
	perform pg_temp.base_assert(v = pg_temp.req_recorded(8) and pg_temp.req_rows('site') = '1:L 2:L 3:L 4:- 5:C 6:- 7:- 8:L'
		and (pg_temp.rec_row(4, 'site')).reverted_by is null and (pg_temp.rec_row(2, 'site')).reverted_by is null
		and pg_temp.rec_is(8, 'restore', 'landed', 's6', 'r1', 'site') and r.title = 'Restored from the copy of 2026-11-09 02:14 UTC'
		and r.summary = 'The folder lost objects.' and r.restored_from = v_bundle and r.request_id = v_id and r.undoes is null
		and r.worker_id is null and r.files_changed is null, 'restored: ' || pg_temp.req_rows('site') || ' ' || to_jsonb(r)::text);
	-- The registry: main as restored, when and from what; care is due at once and trusts no refs it knew.
	perform pg_temp.base_assert(s.last_change = 8 and s.last_main = pg_temp.rec_sha('r1') and s.main_sha = pg_temp.rec_sha('r1')
		and s.restored_at between clock_timestamp() - interval '1 minute' and clock_timestamp() and s.restored_from = v_bundle
		and s.refs_sha256 is null and s.next_care_at <= clock_timestamp() and s.index_written = 0 and s.index_version > 0,
		'the registry after a restore: ' || to_jsonb(s)::text);
	perform pg_temp.base_assert(q.state = 'done' and q.outcome = v_restored || '{"change":8}' and q.progress = v_progress
		and q.lease_token is null, 'the restore''s request: ' || to_jsonb(q)::text);
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
			pg_temp.rec_report('unchanged', pg_temp.rec_sha('s5'), pg_temp.rec_sha('r1'), pg_temp.rec_sha('s5')));
		perform pg_temp.base_assert(v = pg_temp.rec_answer('nothing', null) and pg_temp.rec_is(6, 'found', 'lost', 's4', 's5', 'site'),
			'a lost filler is not taken over: ' || v::text);
		v := pg_temp.rec_land(46, 'r1', 's5', false, p_name => 'site');
		perform pg_temp.base_assert(v = pg_temp.rec_answer('recorded', 9) and pg_temp.rec_is(6, 'found', 'lost', 's4', 's5', 'site')
			and pg_temp.rec_is(9, 'landing', 'landed', 'r1', 's5', 'site'), 'a landing on a lost filler''s commit: ' || v::text);
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
	perform pg_temp.base_assert(pg_temp.req_undone('undo-before', 3, false, 'r1', 'r1u', p_name => 'site') = pg_temp.req_recorded(9)
		and pg_temp.req_rows('site') = '1:L 2:L 3:R9 4:- 5:C 6:- 7:- 8:L 9:L', 'an undo before the wall: ' || pg_temp.req_rows('site'));
	-- andLater from the restore's row on is not across it; from a row after it, neither.
	perform pg_temp.base_assert(pg_temp.req_undo('undo-after', 9, true, p_name => 'site') ->> 'state' = 'queued', 'andLater after the wall');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.req_finish((v_item ->> 'requestId')::uuid, (v_item ->> 'token')::uuid, pg_temp.req_outcome(
		jsonb_build_object('state', 'done', 'result', 'nothing', 'mainSha', pg_temp.rec_sha('r1u'))));

	-- A restore from a fresh bundle of a place whose main no row knows: main holds none of the rows, so every row
	-- that moved main is lost, the earlier restore's too. The place it replaced was removed, so nothing was moved.
	v_id := pg_temp.req_restore('restore', 'fresh', 'remove', null, 'site');
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'bundle' = 'fresh' and v_item ->> 'damaged' = 'remove' and jsonb_array_length(v_item -> 'tips') = 8,
		'a fresh restore is claimed: ' || v_item::text);
	v := pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, v_restored || jsonb_build_object('bundle', '20261110T160000Z-ba9876543210',
		'mainSha', pg_temp.rec_sha('r2'), 'previousMainSha', null, 'keptThrough', null, 'stranded', '[]'::jsonb, 'movedTo', null));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(10) and pg_temp.req_rows('site') = '1:- 2:- 3:- 4:- 5:C 6:- 7:- 8:- 9:- 10:L'
		and pg_temp.rec_is(10, 'restore', 'landed', 'r1u', 'r2', 'site') and (pg_temp.rec_row(10, 'site')).summary is null
		and (pg_temp.rec_row(10, 'site')).title = 'Restored from the copy of 2026-11-10 16:00 UTC'
		and (pg_temp.rec_shop('site')).restored_from = '20261110T160000Z-ba9876543210', 'nothing kept: ' || pg_temp.req_rows('site'));

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
		'a restore that did not finish keeps its progress');

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
		= pg_temp.req_recorded(null) and (pg_temp.req_row(v_id)).state = 'done' and (pg_temp.rec_shop('site')).last_change = 10, 'discarded');
end $$;

-- 5. More than 500 changes are not taken out at once ----------------------------------------------------------------------
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
	-- 500 at once, and one alone, are asked for.
	v := pg_temp.req_undo('undo-big-3', 3, true, p_name => 'big');
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and pg_temp.req_undo('undo-big-4', 3, p_name => 'big') = v, '500 changes: ' || v::text);
	v := pg_temp.req_finish((v ->> 'requestId')::uuid, (pg_temp.req_claim() -> 0 ->> 'token')::uuid, pg_temp.req_moved('b502', 'bu'));
	perform pg_temp.base_assert(v = pg_temp.req_recorded(503) and cardinality((pg_temp.rec_row(503, 'big')).undoes) = 500
		and (pg_temp.rec_row(503, 'big')).undoes[1] = 3 and (pg_temp.rec_row(503, 'big')).undoes[500] = 502
		and (select count(*) from public.qorpera_code_changes c where c.name = 'big' and c.state = 'reverted' and c.reverted_by = 503) = 500
		and (pg_temp.rec_row(2, 'big')).state = 'landed', '500 changes taken out: ' || v::text);
end $$;

-- 6. An agent describes a change ----------------------------------------------------------------------------------------
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

-- 7. A worker's run asks for nothing ------------------------------------------------------------------------------------
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
