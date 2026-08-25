insert into auth.users (id, email, email_confirmed_at)
values (
	'90000000-0000-4000-8000-000000000001',
	'feedback-owner@example.test',
	statement_timestamp()
)
on conflict (id) do nothing;

select set_config(
	'request.jwt.claims',
	'{"sub":"90000000-0000-4000-8000-000000000001","email":"feedback-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;

do $$
declare
	v_first uuid;
	v_duplicate uuid;
begin
	v_first := public.qorpera_submit_product_feedback(
		'90000000-0000-4000-8000-000000000002',
		'bug',
		'  Feedback regression report.  ',
		false,
		'{"operatingSystem":"must be discarded"}'::jsonb
	);
	v_duplicate := public.qorpera_submit_product_feedback(
		'90000000-0000-4000-8000-000000000002',
		'bug',
		'An idempotent retry does not replace the original report.',
		true,
		'{"operatingSystem":"test"}'::jsonb
	);
	if v_first <> v_duplicate then
		raise exception 'feedback retry was not idempotent';
	end if;
	perform set_config('qorpera_test.feedback_id', v_first::text, false);
end
$$;

reset role;
select set_config('request.jwt.claims', '', false);

-- Hold both requests immediately before their insert so they each observe a
-- missing identifier. A non-atomic select-then-insert implementation raises a
-- unique violation after the fence opens; the upsert returns one durable ID.
create function public.qorpera_test_feedback_insert_fence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	perform pg_catalog.pg_advisory_xact_lock(20260824184619);
	return new;
end;
$$;

create trigger qorpera_test_feedback_insert_fence
before insert on public.qorpera_product_feedback
for each row execute function public.qorpera_test_feedback_insert_fence();

create temporary table qorpera_test_feedback_concurrent_results (
	connection_name text primary key,
	feedback_id uuid not null
);

select dblink_connect('feedback_locker', 'dbname=qorpera_test');
select dblink_connect('feedback_first', 'dbname=qorpera_test');
select dblink_connect('feedback_second', 'dbname=qorpera_test');
select dblink_exec('feedback_locker', 'begin');
select * from dblink(
	'feedback_locker',
	$$select 1 from (select pg_catalog.pg_advisory_xact_lock(20260824184619)) as fence$$
) as locked(locked integer);
select dblink_exec(
	'feedback_first',
	$$set request.jwt.claims = '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}'$$
);
select dblink_exec('feedback_first', 'set role authenticated');
select dblink_exec(
	'feedback_second',
	$$set request.jwt.claims = '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}'$$
);
select dblink_exec('feedback_second', 'set role authenticated');
select dblink_send_query(
	'feedback_first',
	$$select public.qorpera_submit_product_feedback(
		'90000000-0000-4000-8000-000000000003',
		'bug',
		'First concurrent feedback submission.',
		false,
		'{}'::jsonb
	)$$
);
select dblink_send_query(
	'feedback_second',
	$$select public.qorpera_submit_product_feedback(
		'90000000-0000-4000-8000-000000000003',
		'bug',
		'Second concurrent feedback submission.',
		false,
		'{}'::jsonb
	)$$
);
select pg_sleep(0.2);

do $$
begin
	if dblink_is_busy('feedback_first') <> 1 or dblink_is_busy('feedback_second') <> 1 then
		raise exception 'concurrent feedback submissions did not reach the insert fence';
	end if;
end
$$;

select dblink_exec('feedback_locker', 'commit');
insert into qorpera_test_feedback_concurrent_results
select 'feedback_first', feedback_id
from dblink_get_result('feedback_first') as submitted(feedback_id uuid);
insert into qorpera_test_feedback_concurrent_results
select 'feedback_second', feedback_id
from dblink_get_result('feedback_second') as submitted(feedback_id uuid);
select dblink_disconnect('feedback_second');
select dblink_disconnect('feedback_first');
select dblink_disconnect('feedback_locker');

drop trigger qorpera_test_feedback_insert_fence on public.qorpera_product_feedback;
drop function public.qorpera_test_feedback_insert_fence();

do $$
begin
	if (select count(distinct feedback_id) from qorpera_test_feedback_concurrent_results) <> 1 then
		raise exception 'concurrent feedback retries returned different identifiers';
	end if;
	if (
		select count(*)
		from public.qorpera_product_feedback
		where user_id = '90000000-0000-4000-8000-000000000001'
			and client_feedback_id = '90000000-0000-4000-8000-000000000003'
	) <> 1 then
		raise exception 'concurrent feedback retries stored more than one report';
	end if;
end
$$;

do $$
begin
	if to_regclass('public.qorpera_product_feedback') is null
		or to_regprocedure('public.qorpera_submit_product_feedback(uuid,text,text,boolean,jsonb)') is null then
		raise exception 'feedback storage or submission RPC is missing';
	end if;
	if has_table_privilege('anon', 'public.qorpera_product_feedback', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_product_feedback', 'SELECT')
		or has_table_privilege('authenticated', 'public.qorpera_product_feedback', 'INSERT') then
		raise exception 'feedback inbox table is exposed to API roles';
	end if;
	if has_function_privilege(
		'anon',
		'public.qorpera_submit_product_feedback(uuid,text,text,boolean,jsonb)',
		'EXECUTE'
	) or not has_function_privilege(
		'authenticated',
		'public.qorpera_submit_product_feedback(uuid,text,text,boolean,jsonb)',
		'EXECUTE'
	) then
		raise exception 'feedback submission RPC grants are invalid';
	end if;
	if (
		select count(*)
		from public.qorpera_product_feedback as feedback
		where feedback.id = current_setting('qorpera_test.feedback_id')::uuid
			and feedback.user_id = '90000000-0000-4000-8000-000000000001'
			and feedback.details = 'Feedback regression report.'
			and feedback.include_diagnostics is false
			and feedback.diagnostics = '{}'::jsonb
	) <> 1 then
		raise exception 'feedback report was not stored with the expected privacy boundary';
	end if;
end
$$;
