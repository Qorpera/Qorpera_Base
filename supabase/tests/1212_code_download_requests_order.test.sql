-- A company's download requests go one at a time (20260930720000; the review of the release that carried it, F2), on
-- three connections. qorpera_request_code_download counts the company's requests of the last 24 hours and then adds a
-- row. Two members who ask for two repositories at the same moment lock two different registry rows, and their key
-- share locks on the company's profile row do not exclude each other, so both counted 19 and both went in. The call now
-- takes an advisory lock on the company before it looks at anything else, held to the end of its transaction: a second
-- request of the company waits for the first one's end before it counts, whichever repository it names. A request of
-- another company does not wait.
-- Locks show only across connections, so the two companies are committed here and removed at the end. The wait is seen
-- with pg_blocking_pids, never by wall-clock time. The call's path after the lock (the count against the limit, over
-- every repository of the company, and the new row) needs a whole folder company and is 1211's, in one transaction:
-- neither company here has a repository, so a call ends "No such repository" once it holds the lock. A refused call
-- ends its transaction's locks at once, so a second call cannot be seen waiting behind a first one that was refused:
-- the first connection holds the company's lock as the call takes it (the same key, to the end of its transaction),
-- which is what a call that got as far as its new row holds.
-- "Race shop" and "Other shop": Ann owns both.

insert into auth.users(id, email) values ('12120000-0000-4000-8000-00000000000a', 'race-ann@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id) values
	('12120000-0000-4000-8000-000000000101', 'Race shop', '12120000-0000-4000-8000-00000000000a'),
	('12120000-0000-4000-8000-000000000102', 'Other shop', '12120000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12120000-0000-4000-8000-000000000101', '12120000-0000-4000-8000-00000000000a', 'race-ann@example.test', 'Ann', 'owner'),
	('12120000-0000-4000-8000-000000000102', '12120000-0000-4000-8000-00000000000a', 'race-ann@example.test', 'Ann', 'owner');

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_hold', 'race_act', 'race_other']) name;

do $$
declare
	v_hold integer; v_act integer; v_waited boolean := false; v_state text; v_message text; v_connection text;
	c_race constant text := quote_literal('12120000-0000-4000-8000-000000000101');
	c_other constant text := quote_literal('12120000-0000-4000-8000-000000000102');
begin
	select pid into v_hold from dblink('race_hold', 'select pg_backend_pid()') as b(pid integer);
	select pid into v_act from dblink('race_act', 'select pg_backend_pid()') as b(pid integer);
	foreach v_connection in array array['race_hold', 'race_act', 'race_other'] loop
		perform dblink_exec(v_connection, format('set request.jwt.claims = %L',
			'{"sub":"12120000-0000-4000-8000-00000000000a","role":"authenticated"}'));
		perform dblink_exec(v_connection, 'set role authenticated');
		-- A call that waited for a lock for ever would be refused here, not hang the suite.
		perform dblink_exec(v_connection, 'set lock_timeout = ''20s''');
	end loop;

	-- A download request of Race shop is under way and its transaction is open: the company's lock is held, as the
	-- call takes it.
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', format(
		$q$select pg_advisory_xact_lock(hashtextextended('qorpera.code-downloads:' || %s, 0))::text$q$, c_race)) as call(answer text);

	-- At that moment Ann asks for another repository of the same company: that call waits for the first one's end.
	perform dblink_send_query('race_act', format(
		$q$select public.qorpera_request_code_download(%s, 'company', 'site', 'history')::text$q$, c_race));
	for attempt in 1..400 loop
		v_waited := v_hold = any(pg_blocking_pids(v_act));
		exit when v_waited or dblink_is_busy('race_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	if not v_waited then raise exception 'a second download request of the company did not wait for the first'; end if;

	-- A request of another company meanwhile: no wait (it is refused at once, for the repository it has not got).
	begin
		perform * from dblink('race_other', format(
			$q$select public.qorpera_request_code_download(%s, 'company', 'shop', 'files')::text$q$, c_other)) as call(answer text);
		raise exception 'a download in another company was taken';
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_message not like '%No such repository%' then
			raise exception 'a request of another company waited or failed otherwise: % %', v_state, v_message; end if;
	end;
	if v_hold <> all(pg_blocking_pids(v_act)) then raise exception 'the second request went on before the first ended'; end if;

	-- The first transaction ends: the second goes on, counts, and is answered (here: no such repository).
	perform dblink_exec('race_hold', 'commit');
	begin
		perform * from dblink_get_result('race_act') as call(answer text);
		raise exception 'the request that waited was taken';
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_message not like '%No such repository%' then
			raise exception 'the request that waited: % %', v_state, v_message; end if;
	end;
end $$;

-- At the end: remove what the test committed.
select dblink_disconnect(name) from unnest(array['race_hold', 'race_act', 'race_other']) name;
delete from public.qorpera_profiles where id in ('12120000-0000-4000-8000-000000000101', '12120000-0000-4000-8000-000000000102');
delete from auth.users where id = '12120000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_code_requests where profile_id in ('12120000-0000-4000-8000-000000000101',
			'12120000-0000-4000-8000-000000000102')) then
		raise exception 'the companies left code requests behind';
	end if;
end $$;
