-- @fixture 762_folder_core_bytes_concurrency.test.sql until "-- A. Step 6: a commit holds"
-- Company folder core, P18a under concurrency (migration 20260930009200; deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md
-- §2–§4, §6): a request waits for a commit that holds its root and keeps the life that commit makes; a commit that
-- creates under a root waits for the request and is a new life the drain keeps; the drain skips a company held for its
-- purge without waiting; the receipts and reviewed cards of the runs that wrote an erased path are scrubbed once the run
-- has ended and the card is answered, keeping their formats. 762's committed fixture, removed at the end.
-- Waits are detected with pg_blocking_pids.

-- Changes a hand-built fixture row with foreign keys and triggers off.
create function pg_temp.fx(p_sql text) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	execute p_sql;
	set local session_replication_role = origin;
end $$;
create function pg_temp.erase_sql(p_paths text[], p_key text) returns text language sql as $$
	select format('select public.qorpera_folder_erase(%L, %L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1)::text, to_jsonb(p_paths)::text, p_key)
$$;
create function pg_temp.drain(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
declare v public.qorpera_folder_erasures%rowtype;
begin
	for i in 1..60 loop
		select * into v from public.qorpera_folder_erasures where id = p_id;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step();
	end loop;
	select * into v from public.qorpera_folder_erasures where id = p_id;
	return v;
end $$;
create function pg_temp.versions_at(p_key text) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_path_versions where environment_id = '63500000-0000-4000-8000-000000000020'
		and public.qorpera_folder_erasure_covers(p_key, public.qorpera_folder_key(path))
$$;
create function pg_temp.vers(p_path text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020'
		and key_text = public.qorpera_folder_key(p_path)
$$;
create function pg_temp.saved(p_result jsonb) returns void language plpgsql as $$
begin
	if exists (select 1 from jsonb_array_elements(p_result -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Fixture commit: %', p_result; end if;
end $$;

-- Committed history: er/a.md lived and was deleted; er/b/ held a file and was deleted.
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-setup-1', jsonb_build_array(
	jsonb_build_object('op','mkdir','path','er'), jsonb_build_object('op','write','path','er/a.md','file',pg_temp.stage('old a')),
	jsonb_build_object('op','mkdir','path','er/b'), jsonb_build_object('op','write','path','er/b/x.md','file',pg_temp.stage('b x')))));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-setup-2', jsonb_build_array(
	jsonb_build_object('op','delete','path','er/a.md','expectedVersion',pg_temp.vers('er/a.md')),
	jsonb_build_object('op','delete','path','er/b','expectedVersion',pg_temp.vers('er/b'),
		'asOfSeq',(select last_seq from public.qorpera_folder_clocks where environment_id = '63500000-0000-4000-8000-000000000020')))));

-- E1. A request waits for a commit that holds its root, then keeps the life that commit made. The commit's bytes are
-- staged and held by the member first, committed, so the other connection sees them.
select set_config('qorpera_test.sql_a', pg_temp.sql_commit(pg_temp.member(1), 'erace-a-new',
	jsonb_build_array(jsonb_build_object('op','write','path','er/a.md','file',pg_temp.stage('new a')))), false);
do $$
declare r jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', current_setting('qorpera_test.sql_a')) as t(x jsonb);
	perform dblink_send_query('auth_two', pg_temp.erase_sql(array['er/a.md'], 'erace-erase-a'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The request waits for the root''s commit'; end if;
	perform dblink_exec('auth_one', 'commit');
	r := pg_temp.result('auth_two');
	if r -> 'roots' -> 0 ->> 'versions' <> '2'
		or (r -> 'roots' -> 0 ->> 'cutoffSeq')::bigint <> (select seq from public.qorpera_folder_commits where operation_key = 'erace-a-new') then
		raise exception 'The earlier life only, cut at the new write: %', r; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if pg_temp.versions_at('er/a.md') <> 1 or not exists (select 1 from public.qorpera_folder_path_versions
			where version = pg_temp.vers('er/a.md')) then raise exception 'The new life stays'; end if;
end $$;

-- E2. A commit that creates a held root waits for the request, then is a new life the drain keeps.
do $$
declare r jsonb; v_seq bigint;
begin
	perform dblink_exec('auth_one', 'begin');
	select x into r from dblink('auth_one', pg_temp.erase_sql(array['er/b'], 'erace-erase-b')) as t(x jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_commit(pg_temp.member(1), 'erace-b-new',
		'[{"op":"mkdir","path":"er/b"}]'::jsonb));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'A create under a held root waits'; end if;
	perform dblink_exec('auth_one', 'commit');
	perform pg_temp.saved(pg_temp.result('auth_two'));
	v_seq := (select seq from public.qorpera_folder_commits where operation_key = 'erace-b-new');
	if v_seq <= (r ->> 'asOfSeq')::bigint then raise exception 'The new life comes after the request'; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if pg_temp.versions_at('er/b') <> 1 or pg_temp.vers('er/b') is null then raise exception 'Only the new folder stays'; end if;
end $$;

-- E3. The drain skips a company whose row its purge holds, without waiting.
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-setup-c', jsonb_build_array(
	jsonb_build_object('op','write','path','er/c.md','file',pg_temp.stage('c')))));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-setup-c2', jsonb_build_array(
	jsonb_build_object('op','delete','path','er/c.md','expectedVersion',pg_temp.vers('er/c.md')))));
select set_config('qorpera_test.erase_c', public.qorpera_folder_erase('63500000-0000-4000-8000-000000000020', pg_temp.member(1),
	'["er/c.md"]', 'erace-erase-c') ->> 'erasureId', false);
do $$
declare r jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', $q$select 1 from public.qorpera_profiles where id = '63500000-0000-4000-8000-000000000010' for update$q$)
		as t(x integer);
	perform dblink_send_query('auth_two', 'select public.qorpera_folder_erasure_step()');
	if not pg_temp.finishes_unblocked('auth_two', 'auth_one') then raise exception 'The drain never waits on a purge'; end if;
	r := pg_temp.result('auth_two');
	if r ->> 'erasureId' is not null then raise exception 'A company held for its purge is skipped: %', r; end if;
	perform dblink_exec('auth_one', 'rollback');
	perform pg_temp.drain(current_setting('qorpera_test.erase_c')::uuid);
end $$;

-- E4. The receipts and reviewed cards of a run that wrote an erased path, and of a run that only read it: scrubbed once
-- the run has ended and the card is answered, each keeping its format; a receipt that does not name the path is left.
-- The same request names a live root (er/live.md lived, was deleted and lives again): a receipt quoting it from its
-- earlier life is scrubbed, one from its current life is left.
select pg_temp.saved(pg_temp.commit(pg_temp.actor('run_one'), 'erace-run-write', jsonb_build_array(
	jsonb_build_object('op','write','path','er/r.md','file',pg_temp.stage('the run''s file')))));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-live-1', jsonb_build_array(
	jsonb_build_object('op','write','path','er/live.md','file',pg_temp.stage('live one')))));
select pg_temp.fx(format($q$
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at) values
		('88400000-0000-4000-8000-0000000000c3', %1$L, %2$L, %3$L, 'read-live-1', 'company_read', repeat('a', 64), repeat('e', 64), 'completed',
			jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',repeat('a', 64),
				'content',jsonb_build_object('kind','text','value','er/live.md was: old words')), clock_timestamp());
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256) values
		(%4$L, '88400000-0000-4000-8000-0000000000e1', '63500000-0000-4000-8000-000000000020', '88400000-0000-4000-8000-0000000000e2',
			'[{"path":"er/r.md"}]', repeat('0', 64));
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at) values
		('88400000-0000-4000-8000-0000000000c5', %4$L, %5$L, %6$L, 'read-r-two', 'company_read', repeat('b', 64), repeat('e', 64), 'completed',
			jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',repeat('b', 64),
				'content',jsonb_build_object('kind','text','value','a reader saw er/r.md')), clock_timestamp())$q$,
	pg_temp.actor('run_one') ->> 'runId', pg_temp.actor('run_one') ->> 'jobId', pg_temp.actor('run_one') ->> 'assignmentId',
	pg_temp.actor('run_two') ->> 'runId', pg_temp.actor('run_two') ->> 'jobId', pg_temp.actor('run_two') ->> 'assignmentId'));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-live-2', jsonb_build_array(
	jsonb_build_object('op','delete','path','er/live.md','expectedVersion',pg_temp.vers('er/live.md')))));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-live-3', jsonb_build_array(
	jsonb_build_object('op','write','path','er/live.md','file',pg_temp.stage('live two')))));
select pg_temp.fx(format($q$
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at) values
		('88400000-0000-4000-8000-0000000000c4', %1$L, %2$L, %3$L, 'read-live-2', 'company_read', repeat('c', 64), repeat('e', 64), 'completed',
			jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',repeat('c', 64),
				'content',jsonb_build_object('kind','text','value','er/live.md is: new words')), clock_timestamp())$q$,
	pg_temp.actor('run_one') ->> 'runId', pg_temp.actor('run_one') ->> 'jobId', pg_temp.actor('run_one') ->> 'assignmentId'));
select pg_temp.fx(format($q$
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at) values
		('88400000-0000-4000-8000-0000000000c1', %1$L, %2$L, %3$L, 'read-r', 'company_read', repeat('d', 64), repeat('e', 64), 'completed',
			jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',repeat('d', 64),
				'content',jsonb_build_object('kind','text','value','er/r.md says: the secret')), clock_timestamp()),
		('88400000-0000-4000-8000-0000000000c2', %1$L, %2$L, %3$L, 'read-s', 'company_read', repeat('f', 64), repeat('e', 64), 'completed',
			jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',repeat('f', 64),
				'content',jsonb_build_object('kind','text','value','shared/a.txt says: alpha')), clock_timestamp());
	insert into public.qorpera_action_reviews(id, profile_id, run_id, call_id, staff_agent_id, tool_name, effect, argument_sha256, action,
		decision, built_in, reason, reviewer_model, approver_scope) values
		('88400000-0000-4000-8000-0000000000d1', '63500000-0000-4000-8000-000000000010', %1$L, 'call-final', '63500000-0000-4000-8000-0000000000a1',
			'send_mail', 'external', repeat('1', 64), jsonb_build_object('title','Mail er/r.md','target','er/r.md',
			'details',jsonb_build_object('file','er/r.md'),'arguments','{"path":"er/r.md"}'), 'allow', 'none', 'Looks fine.', 'test', null),
		('88400000-0000-4000-8000-0000000000d2', '63500000-0000-4000-8000-000000000010', %1$L, 'call-open', '63500000-0000-4000-8000-0000000000a1',
			'send_mail', 'external', repeat('2', 64), jsonb_build_object('title','Mail again','target','er/r.md'), 'ask', 'none',
			'Ask first.', 'test', 'owners_admins')$q$,
	pg_temp.actor('run_one') ->> 'runId', pg_temp.actor('run_one') ->> 'jobId', pg_temp.actor('run_one') ->> 'assignmentId'));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-del-r', jsonb_build_array(
	jsonb_build_object('op','delete','path','er/r.md','expectedVersion',pg_temp.vers('er/r.md')))));
select set_config('qorpera_test.erase_r', public.qorpera_folder_erase('63500000-0000-4000-8000-000000000020', pg_temp.member(1),
	'["er/r.md", "er/live.md"]', 'erace-erase-r') ->> 'erasureId', false);
do $$
declare v public.qorpera_folder_erasures%rowtype; v_id uuid := current_setting('qorpera_test.erase_r')::uuid;
	v_receipt jsonb; v_card jsonb;
begin
	-- The run is still live: nothing of it is touched yet, and the erasure waits for it.
	v := pg_temp.drain(v_id);
	if v.state <> 'waiting' or not exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = v_id
			and run_id = (pg_temp.actor('run_one') ->> 'runId')::uuid and state = 'pending') then
		raise exception 'A live run waits: %', v; end if;
	if (select result -> 'content' ->> 'value' from public.qorpera_run_operation_receipts where id = '88400000-0000-4000-8000-0000000000c1')
		<> 'er/r.md says: the secret' then raise exception 'A live run''s receipt is left'; end if;
	-- The run ends; the open card is still open: the run stays pending, the final card and the receipt are scrubbed.
	if not exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = v_id
			and run_id = (pg_temp.actor('run_two') ->> 'runId')::uuid and state = 'pending') then
		raise exception 'The run that only read the file is noted, and waits while live'; end if;
	perform pg_temp.fx(format($q$update public.qorpera_runner_jobs set status = 'failed', lease_token_sha256 = null,
		lease_expires_at = null, finished_at = clock_timestamp(), last_error = 'test' where id in (%L, %L)$q$,
		pg_temp.actor('run_one') ->> 'jobId', pg_temp.actor('run_two') ->> 'jobId'));
	update public.qorpera_folder_erasures set revisit_at = clock_timestamp() - interval '1 second' where id = v_id;
	perform public.qorpera_folder_erasure_step();
	select result into v_receipt from public.qorpera_run_operation_receipts where id = '88400000-0000-4000-8000-0000000000c1';
	if v_receipt <> jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1','inputSha256',repeat('d', 64),
			'content',jsonb_build_object('kind','text','value','[erased]')) then
		raise exception 'The receipt keeps its envelope: %', v_receipt; end if;
	if (select result -> 'content' ->> 'value' from public.qorpera_run_operation_receipts where id = '88400000-0000-4000-8000-0000000000c2')
		<> 'shared/a.txt says: alpha' then raise exception 'A receipt that does not name the path is left'; end if;
	if (select result -> 'content' ->> 'value' from public.qorpera_run_operation_receipts where id = '88400000-0000-4000-8000-0000000000c3')
		<> '[erased]' then raise exception 'A receipt from the live root''s earlier life is scrubbed'; end if;
	if (select result -> 'content' ->> 'value' from public.qorpera_run_operation_receipts where id = '88400000-0000-4000-8000-0000000000c4')
		<> 'er/live.md is: new words' then raise exception 'A receipt from the live root''s current life is left'; end if;
	if (select result -> 'content' ->> 'value' from public.qorpera_run_operation_receipts where id = '88400000-0000-4000-8000-0000000000c5')
		<> '[erased]' or not exists (select 1 from public.qorpera_folder_erasure_runs where erasure_id = v_id
			and run_id = (pg_temp.actor('run_two') ->> 'runId')::uuid and state = 'done') then
		raise exception 'The reader''s receipt is scrubbed and its run done'; end if;
	select action into v_card from public.qorpera_action_reviews where id = '88400000-0000-4000-8000-0000000000d1';
	if v_card <> jsonb_build_object('title','Erased.','target','Erased.','details','{}'::jsonb,'arguments','Erased.')
		or (select reason from public.qorpera_action_reviews where id = '88400000-0000-4000-8000-0000000000d1') <> 'Looks fine.' then
		raise exception 'The final card''s fields keep their types: %', v_card; end if;
	if (select action ->> 'target' from public.qorpera_action_reviews where id = '88400000-0000-4000-8000-0000000000d2') <> 'er/r.md' then
		raise exception 'An open card is left'; end if;
	select * into v from public.qorpera_folder_erasures where id = v_id;
	if v.state <> 'waiting' then raise exception 'The run stays pending while its card is open: %', v; end if;
	-- The card is answered: the next revisit scrubs it, and the erasure is done.
	perform pg_temp.fx($q$update public.qorpera_action_reviews set answer = 'deny', answered_at = clock_timestamp(),
		answered_by_user_id = '63500000-0000-4000-8000-000000000001' where id = '88400000-0000-4000-8000-0000000000d2'$q$);
	update public.qorpera_folder_erasures set revisit_at = clock_timestamp() - interval '1 second' where id = v_id;
	perform public.qorpera_folder_erasure_step();
	if (select action ->> 'target' from public.qorpera_action_reviews where id = '88400000-0000-4000-8000-0000000000d2') <> 'Erased.'
		or (select action ->> 'title' from public.qorpera_action_reviews where id = '88400000-0000-4000-8000-0000000000d2') <> 'Mail again' then
		raise exception 'The answered card: only the field that named the path'; end if;
	select * into v from public.qorpera_folder_erasures where id = v_id;
	if v.state <> 'done' then raise exception 'Done once no run is pending: %', v; end if;
end $$;

-- E5. Two requests with one key: the second waits on the roots, then answers the first one's reply (no 23505).
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-setup-d', jsonb_build_array(
	jsonb_build_object('op','write','path','er/d.md','file',pg_temp.stage('d')))));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-setup-d2', jsonb_build_array(
	jsonb_build_object('op','delete','path','er/d.md','expectedVersion',pg_temp.vers('er/d.md')))));
do $$
declare r jsonb; r2 jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	select x into r from dblink('auth_one', pg_temp.erase_sql(array['er/d.md'], 'erace-erase-d')) as t(x jsonb);
	perform dblink_send_query('auth_two', pg_temp.erase_sql(array['er/d.md'], 'erace-erase-d'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second request waits on the root'; end if;
	perform dblink_exec('auth_one', 'commit');
	r2 := pg_temp.result('auth_two');
	if r2 is distinct from r then raise exception 'The second request answers the first one''s reply: % / %', r2, r; end if;
	if exists (select 1 from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020'
			and kind = 'claim') then raise exception 'No claim outlives either request'; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
end $$;

-- E6. A step reads at most 4 MiB of receipts: a run with more goes on from where the last step stopped, and none is missed.
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-big-1', jsonb_build_array(
	jsonb_build_object('op','write','path','er/big.md','file',pg_temp.stage('big')))));
select pg_temp.fx(format($q$
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256) values
		(%1$L, '88400000-0000-4000-8000-0000000000e3', '63500000-0000-4000-8000-000000000020', '88400000-0000-4000-8000-0000000000e4',
			'[{"path":"er/big.md"}]', repeat('0', 64));
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key, operation_kind,
		input_sha256, downstream_idempotency_sha256, status, result, completed_at)
	select ('88400000-0000-4000-8000-' || lpad(to_hex(65536 + g), 12, '0'))::uuid, %1$L, %2$L, %3$L, 'big-' || g, 'company_read',
		repeat('a', 64), repeat('e', 64), 'completed', jsonb_build_object('schema','qorpera.cloud-tool-operation-result/v1',
			'inputSha256',repeat('a', 64),'content',jsonb_build_object('kind','text','value',repeat('x', 57344) || ' er/big.md')),
		clock_timestamp()
	from generate_series(1, 80) g$q$,
	pg_temp.actor('run_two') ->> 'runId', pg_temp.actor('run_two') ->> 'jobId', pg_temp.actor('run_two') ->> 'assignmentId'));
select pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'erace-big-2', jsonb_build_array(
	jsonb_build_object('op','delete','path','er/big.md','expectedVersion',pg_temp.vers('er/big.md')))));
do $$
declare v_id uuid; v public.qorpera_folder_erasures%rowtype; v_scrubbed integer;
begin
	v_id := (public.qorpera_folder_erase('63500000-0000-4000-8000-000000000020', pg_temp.member(1), '["er/big.md"]', 'erace-erase-big')
		->> 'erasureId')::uuid;
	for i in 1..20 loop
		select * into v from public.qorpera_folder_erasures where id = v_id;
		exit when v.phase >= 4;
		perform public.qorpera_folder_erasure_step();
	end loop;
	perform public.qorpera_folder_erasure_step();
	select * into v from public.qorpera_folder_erasures where id = v_id;
	select count(*) into v_scrubbed from public.qorpera_run_operation_receipts
	where logical_operation_key like 'big-%' and result -> 'content' ->> 'value' = '[erased]';
	if v.phase <> 4 or not v.cursor ? 'run' or v_scrubbed not between 1 and 79 then
		raise exception 'One step stops inside the run: % % %', v.phase, v.cursor, v_scrubbed; end if;
	v := pg_temp.drain(v_id);
	select count(*) into v_scrubbed from public.qorpera_run_operation_receipts
	where logical_operation_key like 'big-%' and result -> 'content' ->> 'value' = '[erased]';
	if v.state <> 'done' or v_scrubbed <> 80 then raise exception 'Every receipt is scrubbed: % %', v.state, v_scrubbed; end if;
end $$;

select dblink_disconnect(name) from unnest(array['auth_one','auth_two','auth_three']) name;

-- The committed fixture leaves the shared suite database, as 767 does.
set session_replication_role = replica;
delete from public.qorpera_folder_erasure_hashes where erasure_id in (select id from public.qorpera_folder_erasures
	where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_folder_erasure_needles where erasure_id in (select id from public.qorpera_folder_erasures
	where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_folder_erasure_runs where erasure_id in (select id from public.qorpera_folder_erasures
	where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_folder_erasures where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_action_reviews where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_run_operation_receipts where run_id in (select id from public.qorpera_execution_runs
	where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_folder_object_gc where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_verified_company_file_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_file_chunks where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intent_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_folder_storage_usage where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '63500000-0000-4000-8000-000000000010/%';
delete from public.qorpera_folder_authority_changes where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_reads where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_read_records where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_releases where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_execution_sponsor_bindings where id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_provider_connections where id = '63500000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '63500000-0000-4000-8000-000000000010';
delete from auth.users where id in ('63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_erasures where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_object_gc where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
