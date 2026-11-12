-- @fixture 1211_code_requests.test.sql until "-- 1. An agent asks for an undo"
-- What a restore leaves behind, and the GitHub copies in Storage (migration 20260930735000). 1211's fixture (1210's
-- helpers before it): company/shop with six rows, session copies that hand commits in, the record call, and a restore
-- from the operator's call to the executor's finish. This file's repository is company/strand, and its session copies
-- are numbered from 2800.
--   1. Rights and the marker.
--   2. The strand: refused for a request that is no restore of the place, and before the restore is recorded; then it
--      archives only the stranded sessions whose worker is not active, as the kernel archives a session, counts the
--      active ones and leaves them; asked again it changes nothing, and archives what became quiet since; it refuses
--      every session the restore's claim does not name, the whole call, and after the finish every one its outcome
--      does not name; a company that is not on the company folder, or has no folder, is refused as the company's
--      entry refuses it; the executor that does not hold the company, a company being deleted and a request that is
--      not there are lost.
--   3. githubCopies: the places of the company's GitHub-host sessions where no repository is kept in Qorpera, as their
--      newest session names them, in order, at most 100.
--   4. The lock order, on three connections (committed, removed at the end): the strand takes no registry row and no
--      request row, takes a session's coding worker before its row, archives no worker that became active while it
--      waited for it, and never waits for an archived session's worker.

-- The strand as the executor calls it: the service role, with its claims.
create function pg_temp.str_strand(p_id uuid, p_stranded uuid[], p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_restore_strand(p_owner, p_machine, p_id, p_stranded);
	reset role;
	return v;
end $$;
-- The strand of p_ids refused as p_state p_message, or the case p_what fails.
create function pg_temp.str_refused(p_what text, p_id uuid, p_ids uuid[], p_state text default '22023',
	p_message text default 'Code restore strand invalid') returns void language plpgsql as $$
begin
	perform pg_temp.base_error(format('select pg_temp.str_strand(%L, %L)', p_id, p_ids), p_state, p_message);
exception when others then
	raise exception '%: %', p_what, sqlerrm;
end $$;
-- What it answers.
create function pg_temp.str_done(p_archived integer, p_active integer) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-restore-strand/v1', 'state', 'done', 'archived', p_archived,
		'active', p_active)
$$;
create function pg_temp.str_lost() returns jsonb language sql immutable as $$
	select '{"schema":"qorpera.code-restore-strand/v1","state":"lost","archived":0,"active":0}'::jsonb
$$;
-- The ids of session copies.
create function pg_temp.str_ids(variadic p_n integer[]) returns uuid[] language sql immutable as $$
	select array_agg(pg_temp.rec_copy(n) order by place) from unnest(p_n) with ordinality copy(n, place)
$$;
-- Session copy p_n of company/p_name, handing nothing in, and its worker active or not.
create function pg_temp.str_copy(p_n integer, p_name text default 'strand', p_repository jsonb default null) returns uuid
language sql as $$
	select pg_temp.rec_turn(p_n, 1, pg_temp.rec_sha('h' || p_n), '{}', coalesce(p_repository, pg_temp.own_repo('company', p_name)))
$$;
-- p_count more copies of the cancelled session b2 from p_from on, of repository p_repository (a # in it is the copy's
-- number from 001), with a base; their workers are not active. No turn of theirs.
create function pg_temp.str_bulk(p_from integer, p_count integer, p_repository jsonb) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_workers
	select (jsonb_populate_record(null::public.qorpera_runtime_workers, to_jsonb(w) || jsonb_build_object(
		'id', pg_temp.rec_copy(p_from + n), 'worker_key', 'str-' || (p_from + n), 'title', 'Session ' || (p_from + n),
		'folder_path', 'QorperaOS/agents/alice/todos/fix-login/str-' || (p_from + n),
		'folder_key', 'qorperaos/agents/alice/todos/fix-login/str-' || (p_from + n)))).*
	from public.qorpera_runtime_workers w, generate_series(0, p_count - 1) n where w.id = '91170000-0000-4000-8000-0000000000b2';
	insert into public.qorpera_coding_sessions
	select (jsonb_populate_record(null::public.qorpera_coding_sessions, to_jsonb(s) || jsonb_build_object(
		'worker_id', pg_temp.rec_copy(p_from + n), 'branch', 'qorpera/coding/' || pg_temp.rec_copy(p_from + n)::text,
		'repository', replace(p_repository::text, '#', lpad((n + 1)::text, 3, '0'))::jsonb,
		'base_sha', pg_temp.rec_sha('base')))).*
	from public.qorpera_coding_sessions s, generate_series(0, p_count - 1) n
	where s.worker_id = '91170000-0000-4000-8000-0000000000b2';
	perform set_config('session_replication_role', 'origin', true);
end $$;
create function pg_temp.str_worker(p_n integer, p_active boolean) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_runtime_workers set state = case when p_active then 'active' else 'succeeded' end,
		result = case when p_active then null else '{"summary":"Done."}'::jsonb end
	where id = pg_temp.rec_copy(p_n);
	perform set_config('session_replication_role', 'origin', true);
end $$;
-- Who archived session copy p_n (null: it is open), and how many times the kernel said it archived it.
create function pg_temp.str_by(p_n integer) returns text language sql as $$
	select coalesce(archived_by, 'open') from public.qorpera_coding_sessions where worker_id = pg_temp.rec_copy(p_n)
$$;
create function pg_temp.str_events(p_n integer) returns integer language sql as $$
	select count(*)::integer from public.qorpera_coding_session_events event
	where event.worker_id = pg_temp.rec_copy(p_n) and event.kind = 'step' and event.actor = 'kernel'
		and event.body ->> 'text' = 'Archived' and event.body -> 'archived' = 'true'::jsonb and event.body ->> 'by' = 'kernel'
$$;
-- What the sessions and workers of copies p_n hold, to see that a call changed nothing.
create function pg_temp.str_state(p_n integer[]) returns jsonb language sql as $$
	select jsonb_agg(jsonb_build_array(to_jsonb(session), to_jsonb(worker),
			(select count(*) from public.qorpera_coding_session_events event where event.worker_id = session.worker_id))
		order by session.worker_id)
	from public.qorpera_coding_sessions session join public.qorpera_runtime_workers worker on worker.id = session.worker_id
	where session.worker_id = any (select pg_temp.rec_copy(n) from unnest(p_n) n)
$$;

-- 1. Rights and the marker --------------------------------------------------------------------------------------------
do $$
declare v_role text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(has_function_privilege(v_role,
				'public.qorpera_code_restore_strand(text,text,uuid,uuid[])', 'EXECUTE') = (v_role = 'service_role'),
			'the strand is the service role''s only: ' || v_role);
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_list_code_repositories(uuid)', 'EXECUTE')
			= (v_role = 'authenticated'), 'the list is a member''s only: ' || v_role);
	end loop;
	perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""'] from pg_proc
			where oid = 'public.qorpera_code_restore_strand(text,text,uuid,uuid[])'::regprocedure)
		and position('20260930735000' in pg_get_functiondef('public.qorpera_list_code_repositories(uuid)'::regprocedure)) > 0,
		'a definer with an empty search path, and the list carries the marker');
end $$;

-- 2. The strand -------------------------------------------------------------------------------------------------------
-- company/strand: three landings (copies 2801 to 2803), and four more sessions (2804 to 2807). Sessions that are not
-- the restore's to strand: 2810 of company/shop, 2811 a GitHub copy at company/strand's place, 2812 of company/strand
-- with no base, 2813 of company/strand in Another company's environment, 2814 of other/strand.
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'strand');
do $$
begin
	perform pg_temp.rec_land(2801, 't0', 't1', p_name => 'strand');
	perform pg_temp.rec_land(2802, 't1', 't2', p_name => 'strand');
	perform pg_temp.rec_land(2803, 't2', 't3', p_name => 'strand');
	perform pg_temp.str_copy(n) from generate_series(2804, 2807) n;
	perform pg_temp.str_copy(2810, 'shop');
	perform pg_temp.str_copy(2811, p_repository => '{"host":"github.com","owner":"company","name":"strand","baseBranch":"main"}');
	perform pg_temp.str_copy(2812);
	perform pg_temp.str_copy(2813);
	perform pg_temp.str_copy(2814, p_repository => pg_temp.own_repo('other', 'strand'));
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_sessions set base_sha = null where worker_id = pg_temp.rec_copy(2812);
	update public.qorpera_coding_sessions set environment_id = '91170000-0000-4000-8000-000000000020',
		profile_id = '91170000-0000-4000-8000-000000000010' where worker_id = pg_temp.rec_copy(2813);
	update public.qorpera_runtime_workers set environment_id = '91170000-0000-4000-8000-000000000020',
		profile_id = '91170000-0000-4000-8000-000000000010' where id = pg_temp.rec_copy(2813);
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(pg_temp.req_rows('strand') = '1:L 2:L 3:L', 'strand''s rows: ' || pg_temp.req_rows('strand'));
end $$;
do $$
declare v jsonb; v_id uuid; v_item jsonb; v_token uuid; v_before jsonb; v_request public.qorpera_code_requests%rowtype;
	v_bundle text := '20261112T020000Z-0123456789ab'; v_call text; v_ids uuid[];
	v_stranded uuid[] := pg_temp.str_ids(2801, 2802, 2803, 2804, 2805, 2806);
begin
	-- Only a restore of the place strands: an undo whose input says restore, and a verify, claimed or not.
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, progress)
	values (pg_temp.rec_here(), 'company', 'strand', '92400000-0000-4000-8000-000000000010', 'undo',
		'{"change":1,"andLater":false,"reason":"x","notice":null,"mode":"restore"}', 'done', 'agent', '{"recorded":{}}')
	returning id into v_id;
	perform pg_temp.str_refused('an undo', v_id, pg_temp.str_ids(2804));
	v_id := pg_temp.req_restore('verify', v_bundle, null, 'The monthly drill.', 'strand');
	perform pg_temp.str_refused('a verify', v_id, pg_temp.str_ids(2804));
	v_item := pg_temp.req_claim() -> 0;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text, 'the verify is claimed: ' || coalesce(v_item::text, 'none'));
	perform pg_temp.str_refused('a claimed verify', v_id, pg_temp.str_ids(2804));
	perform pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'verified', 'mainSha', pg_temp.rec_sha('t3'), 'refsSha256', repeat('a', 64), 'refs', 9)));
	perform pg_temp.str_refused('a finished verify', v_id, pg_temp.str_ids(2804));
	perform pg_temp.base_assert(pg_temp.str_by(2804) = 'open', 'a verify strands nothing');

	-- A restore of the place, claimed and let go to move it: not recorded yet, so nothing is stranded.
	perform pg_temp.req_quiet();
	v_id := pg_temp.req_restore('restore', v_bundle, 'keep', 'A drill.', 'strand');
	perform pg_temp.str_refused('a queued restore', v_id, pg_temp.str_ids(2804), '55000', 'Code restore is not recorded');
	v_item := pg_temp.req_claim() -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item -> 'sessions' = (select jsonb_agg(
			jsonb_build_object('workerId', pg_temp.rec_copy(n), 'baseSha', pg_temp.rec_sha('base')) order by pg_temp.rec_copy(n))
			from generate_series(2801, 2807) n), 'the restore is claimed with its sessions: ' || coalesce(v_item::text, 'none'));
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('bundle', v_bundle, 'step', 'set-aside'))
		->> 'state' = 'go', 'the restore is let go to move the place');
	perform pg_temp.str_refused('a restore that moves the place', v_id, pg_temp.str_ids(2804), '55000',
		'Code restore is not recorded');
	perform pg_temp.base_assert(pg_temp.str_by(2804) = 'open', 'an unrecorded restore strands nothing');
	perform pg_temp.base_assert(pg_temp.req_record(v_id, v_token, v_bundle, 't1', 't3') ->> 'state' = 'recorded',
		'the restore is recorded');

	-- The sessions as the restore left them: 2801, 2802 and 2804 quiet; 2803 and 2806 in a turn (it began after the
	-- place opened); 2805 quiet and archived by a member already; 2807 quiet, and not stranded.
	perform pg_temp.str_worker(n, n in (2803, 2806)) from generate_series(2801, 2807) n;
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
	where worker_id = pg_temp.rec_copy(2805);
	v_request := pg_temp.req_row(v_id);
	v_before := pg_temp.str_state(array[2803, 2805, 2806, 2807]);
	-- Archived: each one whose worker is not active, as the kernel archives a session (its words, by the kernel),
	-- once; the active ones are counted and left as they are, and so is the one a member archived. The workers stay as
	-- they were, and the call writes nothing to the request or the repository.
	v := pg_temp.str_strand(v_id, v_stranded);
	perform pg_temp.base_assert(v = pg_temp.str_done(4, 2), 'the strand: ' || v::text);
	perform pg_temp.base_assert(pg_temp.str_by(2801) = 'kernel' and pg_temp.str_by(2802) = 'kernel'
		and pg_temp.str_by(2804) = 'kernel' and pg_temp.str_events(2801) = 1 and pg_temp.str_events(2802) = 1
		and pg_temp.str_events(2804) = 1, 'each quiet one is archived by the kernel, with its words');
	perform pg_temp.base_assert(pg_temp.str_state(array[2803, 2805, 2806, 2807]) = v_before,
		'the active ones, the one a member archived and the one not stranded are as they were');
	perform pg_temp.base_assert((select bool_and(state = 'succeeded') from public.qorpera_runtime_workers
		where id = any (pg_temp.str_ids(2801, 2802, 2804))), 'the workers stay as they were');
	perform pg_temp.base_assert(to_jsonb(pg_temp.req_row(v_id)) = to_jsonb(v_request), 'the request is as it was');

	-- Asked again: the same answer, and nothing changes.
	v_before := pg_temp.str_state(array[2801, 2802, 2803, 2804, 2805, 2806, 2807]);
	v := pg_temp.str_strand(v_id, v_stranded);
	perform pg_temp.base_assert(v = pg_temp.str_done(4, 2)
		and pg_temp.str_state(array[2801, 2802, 2803, 2804, 2805, 2806, 2807]) = v_before, 'again, the same: ' || v::text);
	-- 2803's turn ended: asked again, it is archived; 2806 is still in its turn.
	perform pg_temp.str_worker(2803, false);
	v := pg_temp.str_strand(v_id, v_stranded);
	perform pg_temp.base_assert(v = pg_temp.str_done(5, 1) and pg_temp.str_by(2803) = 'kernel' and pg_temp.str_events(2803) = 1
		and pg_temp.str_by(2806) = 'open' and pg_temp.str_events(2801) = 1, 'what became quiet since: ' || v::text);
	-- Nothing to strand.
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, '{}') = pg_temp.str_done(0, 0), 'none asked');

	-- Every session the restore's claim does not name is refused, and the whole call with it: 2807 (quiet, open) stays
	-- open. Each id is checked before the company is entered, so ids of two environments never reach it.
	perform pg_temp.str_worker(2807, false);
	perform pg_temp.str_refused('another repository''s session', v_id, pg_temp.str_ids(2807, 2810));
	perform pg_temp.str_refused('a GitHub copy at the place', v_id, pg_temp.str_ids(2807, 2811));
	perform pg_temp.str_refused('a session with no base', v_id, pg_temp.str_ids(2807, 2812));
	perform pg_temp.str_refused('a session of another environment', v_id, pg_temp.str_ids(2807, 2813));
	perform pg_temp.str_refused('another owner''s repository of that name', v_id, pg_temp.str_ids(2807, 2814));
	perform pg_temp.str_refused('a worker that is no session', v_id,
		array[pg_temp.rec_copy(2807), '91210000-0000-4000-8000-00000000ffff'::uuid]);
	perform pg_temp.str_refused('an id twice', v_id, pg_temp.str_ids(2807, 2807));
	perform pg_temp.str_refused('a null', v_id, array[pg_temp.rec_copy(2807), null]);
	perform pg_temp.str_refused('none given', v_id, null);
	perform pg_temp.base_assert(pg_temp.str_by(2807) = 'open' and pg_temp.str_events(2807) = 0, 'a refused call archives nothing');
	-- At most 200: with 194 more quiet sessions of company/strand (from 3001), the stranded six and those are 200, and
	-- 2807 with them is one too many.
	perform pg_temp.str_bulk(3001, 194, pg_temp.own_repo('company', 'strand'));
	v_ids := v_stranded || array(select pg_temp.rec_copy(n) from generate_series(3001, 3194) n);
	perform pg_temp.str_refused('201', v_id, v_ids || pg_temp.rec_copy(2807));
	perform pg_temp.base_assert(pg_temp.str_by(2807) = 'open' and pg_temp.str_by(3001) = 'open', '201 are too many');
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, v_ids) = pg_temp.str_done(199, 1) and pg_temp.str_by(3194) = 'kernel'
		and pg_temp.str_by(2806) = 'open', '200 are not');

	-- A company that is not on the company folder (folder-v2) has no coding session that turns, and its sessions are
	-- not entered: the call is refused as the entry refuses it, and writes nothing. So is one whose folder is not there.
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_company_files set core = 'snapshot-v1', state = 'provisioning' where environment_id = pg_temp.rec_here();
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.str_refused('not on folder-v2', v_id, pg_temp.str_ids(2806, 2807), '0A000',
			'Coding sessions serve folder-v2 companies only');
		raise exception 'put back' using errcode = 'QT228';
	exception when sqlstate 'QT228' then null;
	end;
	begin
		perform set_config('session_replication_role', 'replica', true);
		delete from public.qorpera_folder_fences where profile_id = '92400000-0000-4000-8000-000000000010';
		perform set_config('session_replication_role', 'origin', true);
		perform pg_temp.str_refused('no folder', v_id, pg_temp.str_ids(2806, 2807), '42501', 'Company folder is unavailable');
		raise exception 'put back' using errcode = 'QT228';
	exception when sqlstate 'QT228' then null;
	end;
	perform pg_temp.base_assert(pg_temp.str_by(2807) = 'open' and pg_temp.str_by(2806) = 'open'
		and public.qorpera_company_is_folder_v2('92400000-0000-4000-8000-000000000010'), 'nothing written, and put back');

	-- The executor that does not hold the company, or not from that machine; the company's executor switched off; a
	-- company being deleted; a request that is not there: lost, and nothing is archived. Custody first.
	foreach v_call in array array[
		format('pg_temp.str_strand(%L, %L, %L)', v_id, pg_temp.str_ids(2807), 'exec-other'),
		format('pg_temp.str_strand(%L, %L, p_machine => %L)', v_id, pg_temp.str_ids(2807), repeat('6', 64)),
		format('pg_temp.str_strand(%L, %L)', '91210000-0000-4000-8000-00000000fffe', pg_temp.str_ids(2807))] loop
		execute 'select ' || v_call into v;
		perform pg_temp.base_assert(v = pg_temp.str_lost(), v_call || ': ' || v::text);
	end loop;
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.rec_here();
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, pg_temp.str_ids(2807)) = pg_temp.str_lost(), 'no executor holds it');
	update public.qorpera_coding_executors set enabled = true where environment_id = pg_temp.rec_here();
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', null);
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, pg_temp.str_ids(2807)) = pg_temp.str_lost(), 'the company is being deleted');
	delete from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010';
	begin
		perform pg_temp.base_error(format('select pg_temp.str_strand(%L, %L, %L)', v_id, pg_temp.str_ids(2807), 'exec 1170'),
			'42501', 'Coding machine custody required');
		perform pg_temp.base_error(format('select pg_temp.str_strand(%L, %L, p_machine => %L)', v_id, pg_temp.str_ids(2807),
			repeat('5', 63)), '42501', 'Coding machine custody required');
	exception when others then
		raise exception 'custody: %', sqlerrm;
	end;
	perform pg_temp.base_assert(pg_temp.str_by(2807) = 'open' and pg_temp.str_events(2807) = 0, 'a lost call archives nothing');

	-- After the finish: the outcome names the stranded sessions, and only those are stranded. 2806's turn ended.
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_restore_outcome(v_bundle, 't1',
			jsonb_build_object('previousMainSha', pg_temp.rec_sha('t3'), 'stranded', to_jsonb(v_stranded::text[]))))
		->> 'state' = 'recorded' and (pg_temp.req_row(v_id)).state = 'done', 'the restore is finished');
	perform pg_temp.str_refused('not in the outcome', v_id, pg_temp.str_ids(2807));
	perform pg_temp.str_refused('the outcome''s and one more', v_id, v_stranded || pg_temp.rec_copy(2807));
	perform pg_temp.base_assert(pg_temp.str_by(2807) = 'open', 'one the outcome does not name stays open');
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, v_stranded) = pg_temp.str_done(5, 1), 'after the finish, the same');
	perform pg_temp.str_worker(2806, false);
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, v_stranded) = pg_temp.str_done(6, 0) and pg_temp.str_by(2806) = 'kernel'
		and pg_temp.str_events(2806) = 1, 'and the last one, once its turn ended');
	perform pg_temp.base_assert(pg_temp.str_strand(v_id, pg_temp.str_ids(2801, 2806)) = pg_temp.str_done(2, 0), 'some of them');
	perform pg_temp.base_assert(pg_temp.str_by(2810) = 'open' and pg_temp.str_by(2811) = 'open' and pg_temp.str_by(2812) = 'open'
		and pg_temp.str_by(2813) = 'open' and pg_temp.str_by(2814) = 'open', 'nothing of another repository went');
end $$;

-- 3. githubCopies -----------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_list jsonb;
begin
	-- The keys the list had are as they were. A GitHub copy at a place that keeps a repository in Qorpera (2811, at
	-- company/strand) is none.
	v := pg_temp.req_list();
	perform pg_temp.base_assert(v ? 'githubCopies' and v -> 'githubCopies' = '[]'::jsonb
		and (select array_agg(key order by key) from jsonb_object_keys(v) key) = array['canDownload', 'githubCopies',
			'repositories', 'schema'], 'no GitHub copy yet: ' || v::text);
	-- GitHub sessions: Qorpera/Qorpera_Base, archived (Another company keeps a repository at qorpera/qorpera_base: that
	-- is its own); acme/Storefront and, newer, Acme/StoreFront at one place; Company/Shop at company/shop, which is kept
	-- in Qorpera; another company's at other/thing. A session kept in Qorpera at company/unkept, whose place has no
	-- registry row, is no GitHub copy either.
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values ('91170000-0000-4000-8000-000000000020', '91170000-0000-4000-8000-000000000010', 'qorpera', 'qorpera_base');
	-- (Another company is on the company folder too.)
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_company_files set core = 'folder-v2', head_snapshot_id = null, path_gateway_version = null,
		path_index_snapshot_id = null where environment_id = '91170000-0000-4000-8000-000000000020';
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(public.qorpera_company_is_folder_v2('91170000-0000-4000-8000-000000000010'),
		'fixture: Another company is on the company folder');
	perform pg_temp.str_copy(2820, p_repository => pg_temp.c3_repo());
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
	where worker_id = pg_temp.rec_copy(2820);
	perform pg_temp.str_copy(2821, p_repository => '{"host":"github.com","owner":"acme","name":"Storefront","baseBranch":"main"}');
	perform pg_temp.str_copy(2822, p_repository => '{"host":"github.com","owner":"Acme","name":"StoreFront","baseBranch":"dev"}');
	perform pg_temp.str_copy(2823, p_repository => '{"host":"github.com","owner":"Company","name":"Shop","baseBranch":"main"}');
	perform pg_temp.str_copy(2824, p_repository => '{"host":"github.com","owner":"Other","name":"Thing","baseBranch":"main"}');
	perform pg_temp.str_copy(2825, 'unkept');
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_sessions set created_at = clock_timestamp() - interval '2 days'
	where worker_id = pg_temp.rec_copy(2821);
	update public.qorpera_coding_sessions set created_at = clock_timestamp() - interval '1 day'
	where worker_id = pg_temp.rec_copy(2822);
	update public.qorpera_coding_sessions set environment_id = '91170000-0000-4000-8000-000000000020',
		profile_id = '91170000-0000-4000-8000-000000000010' where worker_id = pg_temp.rec_copy(2824);
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_repositories where name = 'unkept'),
		'fixture: company/unkept has no registry row');
	v_list := '[{"owner":"acme","name":"storefront","github":"Acme/StoreFront"},'
		'{"owner":"qorpera","name":"qorpera_base","github":"Qorpera/Qorpera_Base"}]';
	v := pg_temp.req_list();
	perform pg_temp.base_assert(v -> 'githubCopies' = v_list, 'the GitHub copies: ' || v::text);
	perform pg_temp.base_assert(pg_temp.req_list('92400000-0000-4000-8000-000000000003') -> 'githubCopies' = v_list,
		'a viewer reads them too');
	-- A company that is not on the company folder lists none, as it lists no repository.
	begin
		perform set_config('session_replication_role', 'replica', true);
		update public.qorpera_company_files set core = 'snapshot-v1', state = 'provisioning' where environment_id = pg_temp.rec_here();
		perform set_config('session_replication_role', 'origin', true);
		v := pg_temp.req_list();
		perform pg_temp.base_assert(v -> 'githubCopies' = '[]'::jsonb and v -> 'repositories' = '[]'::jsonb,
			'not on the company folder: ' || v::text);
		raise exception 'put back' using errcode = 'QT228';
	exception when sqlstate 'QT228' then null;
	end;
	-- The newest session names the copy, whichever spelling it uses.
	update public.qorpera_coding_sessions set created_at = clock_timestamp() where worker_id = pg_temp.rec_copy(2821);
	perform pg_temp.base_assert(pg_temp.req_list() #> '{githubCopies,0}'
		= '{"owner":"acme","name":"storefront","github":"acme/Storefront"}', 'the newest session''s spelling');
	-- At most 100, in the order of their places: bulk/b-001 to bulk/b-100 between them leave the last two out.
	perform pg_temp.str_bulk(2901, 100, '{"host":"github.com","owner":"Bulk","name":"b-#","baseBranch":"main"}');
	v := pg_temp.req_list() -> 'githubCopies';
	perform pg_temp.base_assert(jsonb_array_length(v) = 100 and v -> 0 ->> 'name' = 'storefront'
		and v -> 1 = '{"owner":"bulk","name":"b-001","github":"Bulk/b-001"}'
		and v -> 99 = '{"owner":"bulk","name":"b-099","github":"Bulk/b-099"}'
		and not exists (select 1 from jsonb_array_elements(v) copy where copy - array['owner', 'name', 'github'] <> '{}'::jsonb),
		'at most 100: ' || (v -> 99)::text || ', ' || jsonb_array_length(v));
	-- Once the company keeps a repository at a copy's place, it is no copy.
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'acme', 'storefront');
	perform pg_temp.base_assert(pg_temp.req_list() #> '{githubCopies,0}' = '{"owner":"bulk","name":"b-001","github":"Bulk/b-001"}'
		and pg_temp.req_list() #> '{githubCopies,99}' = '{"owner":"bulk","name":"b-100","github":"Bulk/b-100"}',
		'a kept place is no copy');
end $$;

rollback;

-- 4. The lock order ---------------------------------------------------------------------------------------------------
-- A committed company of its own, removed at the end: Ann owns it; repository company/race, whose restore is recorded
-- and running on exec-1228; sessions c1 to c4 of it, each quiet. Locks show only across connections. Each call that
-- must wait is seen waiting with pg_blocking_pids, never by time (a call that must not wait is seen done instead), and
-- every connection gives up after 20 s. Foreign keys and triggers are off only while the rows go in.
insert into auth.users(id, email) values ('12280000-0000-4000-8000-00000000000a', 'race-1228@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12280000-0000-4000-8000-000000000101', 'Strand company', '12280000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12280000-0000-4000-8000-000000000101', '12280000-0000-4000-8000-00000000000a', 'race-1228@example.test', 'Ann', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12280000-0000-4000-8000-000000000201', '12280000-0000-4000-8000-000000000101', 'Environment', 1,
	'12280000-0000-4000-8000-00000000000a');
set session_replication_role = replica;
-- (The environment made its company file; the company is on the company folder, folder-v2.)
insert into public.qorpera_company_files(environment_id, profile_id, canonical_workspace_id, created_by_user_id, core)
values ('12280000-0000-4000-8000-000000000201', '12280000-0000-4000-8000-000000000101', '12280000-0000-4000-8000-000000000301',
	'12280000-0000-4000-8000-00000000000a', 'folder-v2')
on conflict (environment_id) do update set core = 'folder-v2', head_snapshot_id = null, path_gateway_version = null,
	path_index_snapshot_id = null;
insert into public.qorpera_folder_fences(profile_id) values ('12280000-0000-4000-8000-000000000101') on conflict do nothing;
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
values ('12280000-0000-4000-8000-000000000201', 'exec-1228', true, array['codex'], repeat('8', 64));
insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, last_change, last_main)
values ('12280000-0000-4000-8000-000000000201', '12280000-0000-4000-8000-000000000101', 'company', 'race', 1, repeat('b', 40));
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
	state, result)
select ('12280000-0000-4000-8000-0000000000c' || n)::uuid, '12280000-0000-4000-8000-000000000101',
	'12280000-0000-4000-8000-000000000201', '12280000-0000-4000-8000-000000000401', '12280000-0000-4000-8000-000000000501',
	'w-1228-' || n, 'coding', 'Code ' || n, 'read', 'each', '{}', '12280000-0000-4000-8000-00000000000a',
	'12280000-0000-4000-8000-000000000601', '12280000-0000-4000-8000-00000000000a', '12280000-0000-4000-8000-000000000701', 1,
	'succeeded', '{"summary":"Done."}'
from generate_series(1, 4) n;
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, base_sha, phase,
	started_at, updated_at)
select ('12280000-0000-4000-8000-0000000000c' || n)::uuid, '12280000-0000-4000-8000-000000000101',
	'12280000-0000-4000-8000-000000000201', 'codex', '{"host":"qorpera","owner":"company","name":"race","baseBranch":"main"}',
	'qorpera/coding/12280000-0000-4000-8000-0000000000c' || n, repeat('a', 40), 'completed', clock_timestamp(), clock_timestamp()
from generate_series(1, 4) n;
insert into public.qorpera_code_requests(id, environment_id, owner, name, profile_id, kind, input, state, by_kind, lease_token,
	lease_owner, lease_until, attempts, progress)
values ('12280000-0000-4000-8000-0000000000e1', '12280000-0000-4000-8000-000000000201', 'company', 'race',
	'12280000-0000-4000-8000-000000000101', 'restore', '{"mode":"restore","bundle":"20261112T020000Z-0123456789ab",'
		'"damaged":"keep","note":"A drill.","path":null}', 'running', 'operator', '12280000-0000-4000-8000-0000000000e2',
	'exec-1228', clock_timestamp() + interval '1 hour', 1,
	jsonb_build_object('step', 'open', 'held', true, 'recorded', jsonb_build_object('change', 1, 'boundary', 'found',
		'keptThrough', 1, 'lost', 0, 'back', 0, 'bundle', '20261112T020000Z-0123456789ab', 'mainSha', repeat('b', 40))));
set session_replication_role = origin;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_hold', 'race_act', 'race_other']) name;
select set_config('qorpera_test.race_' || name || '_pid', (select pid::text from dblink('race_' || name,
	'select pg_backend_pid()') as b(pid integer)), false) from unnest(array['hold', 'act', 'other']) name \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null
select dblink_exec('race_act', $q$set request.jwt.claims = '{"role":"service_role"}'$q$) \g /dev/null
select dblink_exec('race_act', 'set role service_role') \g /dev/null

-- Whether race_act's call waits on race_hold; false when the call ended first.
create function pg_temp.race_waits() returns boolean language plpgsql as $$
declare v_by integer := current_setting('qorpera_test.race_hold_pid')::integer;
	v_conn integer := current_setting('qorpera_test.race_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_by = any(pg_blocking_pids(v_conn)) then return true; end if;
		exit when dblink_is_busy('race_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The answer of race_act's call, or its error as {"error":<sqlstate>,"message":…}.
create function pg_temp.race_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('race_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('race_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('race_act') as call(answer text);
	return v::jsonb;
end $$;
-- The executor's strand of session c<n>, as race_act sends it.
create function pg_temp.race_strand(p_n integer) returns text language sql immutable as $$
	select format('select public.qorpera_code_restore_strand(%L, %L, %L, %L)::text', 'exec-1228', repeat('8', 64),
		'12280000-0000-4000-8000-0000000000e1', array[format('12280000-0000-4000-8000-0000000000c%s', p_n)::uuid])
$$;
-- Whether race_other can lock that row at once (and lets it go again): null, or why not.
create function pg_temp.race_probe(p_sql text) returns text language plpgsql as $$
declare v_state text;
begin
	perform dblink_exec('race_other', 'begin');
	begin
		perform * from dblink('race_other', p_sql) as probe(x text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate;
	end;
	perform dblink_exec('race_other', 'rollback');
	return v_state;
end $$;
create function pg_temp.race_by(p_n integer) returns text language sql as $$
	select coalesce(archived_by, 'open') from public.qorpera_coding_sessions
	where worker_id = format('12280000-0000-4000-8000-0000000000c%s', p_n)::uuid
$$;

-- R1. No registry row and no request row: with both held elsewhere (as a restore's record and finish hold them), the
-- strand does not wait, and archives c1.
do $$
declare v jsonb;
begin
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select name from public.qorpera_code_repositories
		where environment_id = '12280000-0000-4000-8000-000000000201' and name = 'race' for update$q$) as held(name text);
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_code_requests
		where id = '12280000-0000-4000-8000-0000000000e1' for update$q$) as held(id text);
	perform dblink_send_query('race_act', pg_temp.race_strand(1));
	if pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R1: the strand waited for the registry row or the request: %', pg_temp.race_answer(); end if;
	v := pg_temp.race_answer();
	perform dblink_exec('race_hold', 'rollback');
	if v is distinct from '{"schema":"qorpera.code-restore-strand/v1","state":"done","archived":1,"active":0}'::jsonb
		or pg_temp.race_by(1) <> 'kernel' then
		raise exception 'R1: c1 is archived: %', v; end if;
end $$;

-- R2. A session's coding worker before its row: while c2's session row is held elsewhere, the strand waits for it
-- holding c2's worker (a second connection cannot take it), then archives c2.
do $$
declare v jsonb; v_probe text;
begin
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select worker_id::text from public.qorpera_coding_sessions
		where worker_id = '12280000-0000-4000-8000-0000000000c2' for update$q$) as held(id text);
	perform dblink_send_query('race_act', pg_temp.race_strand(2));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R2: the strand did not wait for the session row: %', pg_temp.race_answer(); end if;
	v_probe := pg_temp.race_probe($q$select id::text from public.qorpera_runtime_workers
		where id = '12280000-0000-4000-8000-0000000000c2' for no key update nowait$q$);
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v_probe is distinct from '55P03' then
		raise exception 'R2: the strand waited for the session row without holding its worker (%)', coalesce(v_probe, 'free'); end if;
	if v is distinct from '{"schema":"qorpera.code-restore-strand/v1","state":"done","archived":1,"active":0}'::jsonb
		or pg_temp.race_by(2) <> 'kernel' then
		raise exception 'R2: c2 is archived: %', v; end if;
end $$;

-- R3. While c3's worker is held elsewhere (as a turn's call holds it before the session), the strand waits for it
-- holding nothing of c3's session (a second connection locks it at once), then archives c3.
do $$
declare v jsonb; v_probe text;
begin
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_runtime_workers
		where id = '12280000-0000-4000-8000-0000000000c3' for no key update$q$) as held(id text);
	perform dblink_send_query('race_act', pg_temp.race_strand(3));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R3: the strand did not wait for the worker: %', pg_temp.race_answer(); end if;
	v_probe := pg_temp.race_probe($q$select worker_id::text from public.qorpera_coding_sessions
		where worker_id = '12280000-0000-4000-8000-0000000000c3' for update nowait$q$);
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v_probe is not null then
		raise exception 'R3: the strand held c3''s session while it waited for its worker (%)', v_probe; end if;
	if v is distinct from '{"schema":"qorpera.code-restore-strand/v1","state":"done","archived":1,"active":0}'::jsonb
		or pg_temp.race_by(3) <> 'kernel' then
		raise exception 'R3: c3 is archived: %', v; end if;
end $$;

-- R4. c4's turn begins while the strand waits for its worker: once held, the worker is active, and its session stays
-- open, counted.
do $$
declare v jsonb;
begin
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select set_config('session_replication_role', 'replica', true)$q$) as held(x text);
	perform dblink_exec('race_hold', $q$update public.qorpera_runtime_workers set state = 'active', result = null
		where id = '12280000-0000-4000-8000-0000000000c4'$q$);
	perform dblink_send_query('race_act', pg_temp.race_strand(4));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R4: the strand did not wait for the worker: %', pg_temp.race_answer(); end if;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v is distinct from '{"schema":"qorpera.code-restore-strand/v1","state":"done","archived":0,"active":1}'::jsonb
		or pg_temp.race_by(4) <> 'open' then
		raise exception 'R4: a worker that became active keeps its session: %', v; end if;
end $$;

-- R5. An archived session is left as it is: asked for c1 again (R1 archived it) while c1's worker is held elsewhere, the
-- strand does not wait for it, and answers c1 archived.
do $$
declare v jsonb;
begin
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', $q$select id::text from public.qorpera_runtime_workers
		where id = '12280000-0000-4000-8000-0000000000c1' for no key update$q$) as held(id text);
	perform dblink_send_query('race_act', pg_temp.race_strand(1));
	if pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R5: the strand waited for an archived session''s worker: %', pg_temp.race_answer(); end if;
	v := pg_temp.race_answer();
	perform dblink_exec('race_hold', 'rollback');
	if v is distinct from '{"schema":"qorpera.code-restore-strand/v1","state":"done","archived":1,"active":0}'::jsonb then
		raise exception 'R5: c1 is archived: %', v; end if;
end $$;

select dblink_disconnect(name) from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null

-- Remove the company (526's way): the sessions' events, then every row of the company and its environment, then the
-- company and Ann.
set session_replication_role = replica;
delete from public.qorpera_coding_session_events where worker_id in (select worker_id from public.qorpera_coding_sessions
	where profile_id = '12280000-0000-4000-8000-000000000101');
do $$
declare v_table record;
begin
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id') and c.data_type = 'uuid'
			and c.table_name <> 'qorpera_profiles' loop
		execute format('delete from public.%I where %I = $1', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then '12280000-0000-4000-8000-000000000101'::uuid
			else '12280000-0000-4000-8000-000000000201'::uuid end;
	end loop;
end $$;
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '12280000-0000-4000-8000-000000000101';
delete from auth.users where id = '12280000-0000-4000-8000-00000000000a';
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id = '12280000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_company_environments where id = '12280000-0000-4000-8000-000000000201')
		or exists (select 1 from public.qorpera_runtime_workers where profile_id = '12280000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_coding_sessions where profile_id = '12280000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_coding_session_events where worker_id::text like '12280000-%')
		or exists (select 1 from public.qorpera_code_requests where profile_id = '12280000-0000-4000-8000-000000000101')
		or exists (select 1 from auth.users where id = '12280000-0000-4000-8000-00000000000a') then
		raise exception 'the strand''s races left rows behind'; end if;
end $$;
