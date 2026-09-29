-- The newest-first transcript read (20260928279410): for every caller it refuses what the
-- transcript read refuses, returns the same events in the same shape, and pages back through a
-- thread without skipping or repeating an event, also while new events arrive.
begin;

insert into auth.users(id,email) values
	('74400000-0000-4000-8000-000000000001','tail-owner@example.test'),
	('74400000-0000-4000-8000-000000000002','tail-member@example.test'),
	('74400000-0000-4000-8000-000000000003','tail-viewer@example.test'),
	('74400000-0000-4000-8000-000000000004','tail-outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('74400000-0000-4000-8000-000000000010','Tail read fixture','74400000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('74400000-0000-4000-8000-000000000010','74400000-0000-4000-8000-000000000001','tail-owner@example.test','Owner','owner'),
	('74400000-0000-4000-8000-000000000010','74400000-0000-4000-8000-000000000002','tail-member@example.test','Member','contributor'),
	('74400000-0000-4000-8000-000000000010','74400000-0000-4000-8000-000000000003','tail-viewer@example.test','Viewer','viewer');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('74400000-0000-4000-8000-000000000020','74400000-0000-4000-8000-000000000010','Environment',1,'74400000-0000-4000-8000-000000000001');
-- A company conversation with 1,203 events, a member's private conversation with 7, and an
-- empty one.
insert into public.qorpera_shared_sessions(id,client_session_id,profile_id,environment_id,title,status,
	created_by_user_id,execution_scope,created_at,audience_kind,audience_user_id) values
	('74400000-0000-4000-8000-000000000030','74400000-0000-4000-8000-000000000031','74400000-0000-4000-8000-000000000010',
		'74400000-0000-4000-8000-000000000020','Company thread','open','74400000-0000-4000-8000-000000000001','{}',
		statement_timestamp(),'company',null),
	('74400000-0000-4000-8000-000000000032','74400000-0000-4000-8000-000000000033','74400000-0000-4000-8000-000000000010',
		'74400000-0000-4000-8000-000000000020','Private thread','open','74400000-0000-4000-8000-000000000002','{}',
		statement_timestamp(),'member_private','74400000-0000-4000-8000-000000000002'),
	('74400000-0000-4000-8000-000000000034','74400000-0000-4000-8000-000000000035','74400000-0000-4000-8000-000000000010',
		'74400000-0000-4000-8000-000000000020','Empty thread','open','74400000-0000-4000-8000-000000000001','{}',
		statement_timestamp(),'company',null);
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
select '74400000-0000-4000-8000-000000000030',n,extensions.gen_random_uuid(),'session_info',
	'74400000-0000-4000-8000-000000000001',jsonb_build_object('n',n),repeat('a',64),statement_timestamp() + n * interval '1 second'
from generate_series(1,1203) as n;
insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
select '74400000-0000-4000-8000-000000000032',n,extensions.gen_random_uuid(),'session_info',
	'74400000-0000-4000-8000-000000000002',jsonb_build_object('n',n),repeat('b',64),statement_timestamp() + n * interval '1 second'
from generate_series(1,7) as n;

-- What a call does, as the caller it runs as: 'ok' and its events, or the refusal's SQLSTATE
-- and message. Every refusal is compared whole.
create function pg_temp.tail_outcome(p_call text) returns text language plpgsql as $$
declare v_result jsonb;
begin
	execute 'select ' || p_call into v_result;
	return 'ok ' || v_result::text;
exception when others then
	return 'refused ' || sqlstate || ' ' || regexp_replace(sqlerrm, 'qorpera_read_session_events(_tail)?', 'READ');
end
$$;
create function pg_temp.tail_as(p_role text, p_user uuid) returns void language plpgsql as $$
begin
	perform set_config('request.jwt.claims',
		case when p_user is null then jsonb_build_object('role',p_role) else jsonb_build_object('role',p_role,'sub',p_user) end::text,
		true);
	execute format('set local role %I', p_role);
end
$$;
create function pg_temp.tail_assert(p_condition boolean, p_message text) returns void language plpgsql as $$
begin
	if p_condition is distinct from true then raise exception 'tail read: %', p_message; end if;
end
$$;
create function pg_temp.tail_sequences(p_events jsonb) returns bigint[] language sql immutable as $$
	select coalesce(array_agg((item ->> 'sequence')::bigint order by ordinality), '{}')
	from jsonb_array_elements(p_events) with ordinality as rows(item, ordinality)
$$;

-- 1. Refusals. For every caller, thread and page the transcript read is asked for, the tail read
-- gives the same outcome, whatever sequence it reads before: the same refusal, or (for a reader)
-- events. Nothing is refused ahead of the transcript read, not even an extreme sequence.
do $$
declare
	v_caller record;
	v_session uuid;
	v_limit integer;
	v_before bigint;
	v_forward text;
	v_tail text;
	v_cases integer := 0;
begin
	for v_caller in select * from (values
		('anon', null::uuid),
		('authenticated', '74400000-0000-4000-8000-000000000004'::uuid),
		('authenticated', '74400000-0000-4000-8000-000000000003'::uuid),
		('authenticated', '74400000-0000-4000-8000-000000000002'::uuid),
		('authenticated', '74400000-0000-4000-8000-000000000001'::uuid),
		('authenticated', null::uuid),
		('service_role', null::uuid),
		('qorpera_secret_broker', null::uuid)
	) as caller(role, user_id) loop
		foreach v_session in array array[
			'74400000-0000-4000-8000-000000000030'::uuid,
			'74400000-0000-4000-8000-000000000032'::uuid,
			'74400000-0000-4000-8000-000000000034'::uuid,
			'74400000-0000-4000-8000-0000000000ff'::uuid
		] loop
			foreach v_limit in array array[1, 200, 500, 0, 501, -1, null] loop
				perform pg_temp.tail_as(v_caller.role, v_caller.user_id);
				v_forward := pg_temp.tail_outcome(format('public.qorpera_read_session_events(%L::uuid, 0, %L::integer)', v_session, v_limit));
				reset role;
				foreach v_before in array array[null, -9223372036854775808, 0, 5]::bigint[] loop
					perform pg_temp.tail_as(v_caller.role, v_caller.user_id);
					v_tail := pg_temp.tail_outcome(format('public.qorpera_read_session_events_tail(%L::uuid, %L::bigint, %L::integer)',
						v_session, v_before, v_limit));
					reset role;
					-- A read that succeeds may return other events (the newest page rather than the first);
					-- a refusal must be the same refusal.
					perform pg_temp.tail_assert(
						(v_forward like 'ok %' and v_tail like 'ok %') or v_forward = v_tail,
						format('%s %s on %s limit %s before %s: transcript read %s, tail read %s',
							v_caller.role, v_caller.user_id, v_session, v_limit, v_before, v_forward, v_tail));
					v_cases := v_cases + 1;
				end loop;
			end loop;
		end loop;
	end loop;
	perform pg_temp.tail_assert(v_cases = 896, 'every case ran');
end
$$;

-- The refusals above include the ones that matter: an outsider, a company member on another
-- member's private thread, and a missing thread are refused as by the transcript read.
do $$
begin
	perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000004');
	perform pg_temp.tail_assert(pg_temp.tail_outcome($q$public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030')$q$)
		like 'refused 42501 %', 'an outsider is refused');
	reset role;
	perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000001');
	perform pg_temp.tail_assert(pg_temp.tail_outcome($q$public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000032')$q$)
		like 'refused 42501 %', 'the owner may not read a member''s private thread');
	perform pg_temp.tail_assert(pg_temp.tail_outcome($q$public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', 100, 0)$q$)
		= 'refused 22023 event page is invalid', 'a bad page is refused as the transcript read refuses it');
	reset role;
	perform pg_temp.tail_as('anon', null);
	perform pg_temp.tail_assert(pg_temp.tail_outcome($q$public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030')$q$)
		like 'refused 42501 permission denied%', 'anon may not call it');
	reset role;
end
$$;

-- 2. The same events in the same shape, speakers included: the newest page is the transcript
-- read's page that starts where it starts.
do $$
declare v_tail jsonb; v_forward jsonb;
begin
	perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000003');
	v_tail := public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', null, 200);
	v_forward := public.qorpera_read_session_events('74400000-0000-4000-8000-000000000030', 1003, 200);
	perform pg_temp.tail_assert(pg_temp.tail_sequences(v_tail) = array(select generate_series(1004, 1203)::bigint), 'the newest 200');
	perform pg_temp.tail_assert(v_tail = v_forward, 'same events, same shape as the transcript read');
	-- A thread shorter than the page, and an empty one.
	perform pg_temp.tail_assert(jsonb_array_length(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', 5, 200)) = 4
		and pg_temp.tail_sequences(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', 5, 200)) = array[1,2,3,4]::bigint[],
		'the start of the thread: only what lies before');
	perform pg_temp.tail_assert(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', 1, 200) = '[]'::jsonb,
		'nothing before the first event');
	perform pg_temp.tail_assert(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000034') = '[]'::jsonb,
		'an empty thread reads empty');
	-- A null limit reads the default page, not the whole transcript.
	perform pg_temp.tail_assert(pg_temp.tail_sequences(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', null, null))
		= array(select generate_series(1004, 1203)::bigint), 'a null limit reads the default 200');
	perform pg_temp.tail_assert(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', -9223372036854775808, 200) = '[]'::jsonb,
		'nothing before the lowest sequence');
	reset role;
	perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000002');
	perform pg_temp.tail_assert(pg_temp.tail_sequences(public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000032', null, 5))
		= array[3,4,5,6,7]::bigint[], 'the private thread''s member reads its newest page');
	reset role;
end
$$;

-- 3. Paging back: every event exactly once, in order, whatever the page size, with new events
-- arriving between pages (they take higher sequences, which later forward reads bring).
do $$
declare
	v_limit integer;
	v_before bigint;
	v_page jsonb;
	v_seen bigint[];
	v_newest bigint;
	v_round integer;
begin
	foreach v_limit in array array[500, 200, 7, 1] loop
		perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000002');
		v_page := public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', null, v_limit);
		v_seen := pg_temp.tail_sequences(v_page);
		v_newest := v_seen[array_length(v_seen, 1)];
		v_before := v_seen[1];
		reset role;
		v_round := 0;
		while v_before > 1 loop
			v_round := v_round + 1;
			-- Another member's message lands between two pages.
			if v_round % 3 = 1 then
				insert into public.qorpera_session_events(session_id,sequence,event_id,event_type,actor_user_id,body,event_hash,created_at)
				select '74400000-0000-4000-8000-000000000030',max(sequence) + 1,extensions.gen_random_uuid(),'session_info',
					'74400000-0000-4000-8000-000000000001','{"late":true}',repeat('c',64),clock_timestamp()
				from public.qorpera_session_events where session_id = '74400000-0000-4000-8000-000000000030';
			end if;
			perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000002');
			v_page := public.qorpera_read_session_events_tail('74400000-0000-4000-8000-000000000030', v_before, v_limit);
			reset role;
			perform pg_temp.tail_assert(jsonb_array_length(v_page) between 1 and v_limit, format('page %s of %s is full or the last', v_round, v_limit));
			perform pg_temp.tail_assert((pg_temp.tail_sequences(v_page))[jsonb_array_length(v_page)] = v_before - 1,
				format('page %s of %s ends right before the page after it', v_round, v_limit));
			v_seen := pg_temp.tail_sequences(v_page) || v_seen;
			v_before := v_seen[1];
			exit when v_round > 1300;
		end loop;
		perform pg_temp.tail_assert(v_seen = array(select generate_series(1, v_newest)::bigint),
			format('limit %s: every event up to the first page''s newest, once and in order', v_limit));
		-- What arrived meanwhile is exactly what a forward read after the first page returns.
		perform pg_temp.tail_as('authenticated', '74400000-0000-4000-8000-000000000002');
		perform pg_temp.tail_assert(pg_temp.tail_sequences(public.qorpera_read_session_events('74400000-0000-4000-8000-000000000030', v_newest, 500))
			= array(select sequence from public.qorpera_session_events
				where session_id = '74400000-0000-4000-8000-000000000030' and sequence > v_newest order by sequence),
			format('limit %s: the forward read brings what arrived after the first page', v_limit));
		reset role;
	end loop;
end
$$;

rollback;
