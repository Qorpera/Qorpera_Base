-- @fixture 1274_company_numbers_orders.test.sql until "-- The checks start here."

create function pg_temp.w_orders() returns text language sql as $$
	select '55000 Not connected: orders count once card payments are connected or an order is added by hand'
$$;
create function pg_temp.w_site() returns text language sql as $$
	select '55000 Not connected: visits count once the company publishes a website'
$$;
create function pg_temp.w_money() returns text language sql as $$
	select '55000 Not connected: the bank''s numbers come once the company connects its bank'
$$;
create function pg_temp.w_other(p_question text, p_params jsonb default '{}'::jsonb) returns text language sql as $$
	select pg_temp.o_refused(p_question, p_params, '12740000-0000-4000-8000-000000000006',
		'12740000-0000-4000-8000-000000000020')
$$;
create function pg_temp.w_other_ask(p_question text, p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select pg_temp.o_member('12740000-0000-4000-8000-000000000006', p_question, p_params,
		'12740000-0000-4000-8000-000000000020')
$$;
create function pg_temp.w_site_live(p_id uuid, p_slug text, p_version uuid) returns void language plpgsql as $$
begin
	insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values (p_id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', p_slug, null, 'web',
		'92400000-0000-4000-8000-000000000030');
	insert into public.qorpera_company_site_secrets(site_id, password) values (p_id, p_slug || '-password');
	if p_version is null then return; end if;
	insert into public.qorpera_company_site_versions(id, site_id, run_id, call_id, staff_agent_id, first_publish, source_path,
		manifest_sha256, file_count, total_bytes, state, published_at)
	values (p_version, p_id, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, 'w-' || p_slug,
		'92400000-0000-4000-8000-000000000030', true, 'web', repeat('a', 64), 1, 3, 'live', clock_timestamp());
	insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type, content)
	values (p_version, 'index.html', 3, encode(extensions.digest('<p>', 'sha256'), 'hex'), 'text/html; charset=utf-8',
		convert_to('<p>', 'utf8'));
	update public.qorpera_company_sites set current_version_id = p_version, published_at = clock_timestamp(),
		published_by_staff_agent_id = '92400000-0000-4000-8000-000000000030'
	where id = p_id;
end $$;

do $$
declare v_question text;
begin
	perform pg_temp.o_clean();
	foreach v_question in array array['orders-now', 'orders-hours', 'orders-days', 'orders-months', 'orders-states',
		'orders-sources'] loop
		perform pg_temp.o_same(pg_temp.w_other(v_question), pg_temp.w_orders(), 'nothing connected: ' || v_question);
	end loop;
	foreach v_question in array array['site-now', 'site-hours', 'site-days', 'site-pages'] loop
		perform pg_temp.o_same(pg_temp.w_other(v_question), pg_temp.w_site(), 'nothing connected: ' || v_question);
	end loop;
	foreach v_question in array array['money-now', 'money-balance', 'money-expected', 'money-months', 'money-kinds'] loop
		perform pg_temp.o_same(pg_temp.w_other(v_question), pg_temp.w_money(), 'nothing connected: ' || v_question);
	end loop;
	perform pg_temp.o_json(pg_temp.w_other_ask('sites') -> 'rows', '[]', 'sites lists no site');
	perform pg_temp.o_same(pg_temp.w_other('orders-nope'), 'P0002 No question qorpera/orders-nope that you may read',
		'an unknown orders question');
	perform pg_temp.o_same(pg_temp.w_other('site-visits'), 'P0002 No question qorpera/site-visits that you may read',
		'an unknown site question');
	perform pg_temp.o_same(pg_temp.w_other('money-days'), 'P0002 No question qorpera/money-days that you may read',
		'an unknown money question');
	perform pg_temp.o_same(pg_temp.o_refused('orders-now', '{}', '92400000-0000-4000-8000-000000000001',
		'12740000-0000-4000-8000-000000000020'), '42501 Company numbers are unavailable', 'an outsider');
	perform pg_temp.o_same(pg_temp.w_other('orders-days', '{"from": "x"}'), '22023 :from is a day as YYYY-MM-DD',
		'a bad orders parameter');
	perform pg_temp.o_same(pg_temp.w_other('orders-now', '{"site": "x"}'), '22023 The question takes no :site',
		'an orders parameter it does not take');
	perform pg_temp.o_same(pg_temp.w_other('site-days', '{"site": "nope"}'), '22023 :site is not one of the company''s sites',
		'a site the company lacks');
	perform pg_temp.o_same(pg_temp.w_other('money-balance', '{"to": "14-11-2026"}'), '22023 :to is a day as YYYY-MM-DD',
		'a bad money parameter');
	perform pg_temp.o_same(pg_temp.w_other('money-now', '{"x": 1}'), '22023 The question takes no :x',
		'a money parameter it does not take');
end $$;

do $$
declare v_rule text := pg_get_functiondef('public.qorpera_company_numbers_orders_readable(uuid,uuid,jsonb)'::regprocedure);
begin
	perform pg_temp.o_clean();
	execute replace(v_rule, 'select p_environment_id is not null', 'select false and p_environment_id is not null');
	perform pg_temp.o_same(pg_temp.w_other('orders-now'), 'P0002 No question qorpera/orders-now that you may read',
		'a refusal before not connected');
	execute v_rule;
	perform pg_temp.o_same(pg_temp.w_other('orders-now'), pg_temp.w_orders(), 'the rule back');
end $$;

savepoint w_private;
insert into public.qorpera_company_path_resources(environment_id, path, path_match, scope, owner_user_id, policy,
	created_by_user_id)
values ('92400000-0000-4000-8000-000000000020', 'bank', 'subtree', 'member_private',
	'92400000-0000-4000-8000-000000000002', 'normal', '92400000-0000-4000-8000-000000000001');
do $$
begin
	perform pg_temp.o_same(pg_temp.o_refused('money-now'), 'P0002 No question qorpera/money-now that you may read',
		'no bank read, no bank');
	perform pg_temp.o_same(pg_temp.o_state($s$select pg_temp.o_run('money-kinds')$s$),
		'P0002 No question qorpera/money-kinds that you may read', 'a run without bank read');
	perform pg_temp.o_same(pg_temp.o_refused('money-now', '{}', '92400000-0000-4000-8000-000000000002'),
		pg_temp.w_money(), 'the member bank/ is private to');
end $$;
rollback to savepoint w_private;
select pg_temp.base_claims('service_role');

select set_config('qorpera_test.w_token', 'w1411-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.w_token'), 'utf8'), 'sha256'), 'hex')
where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
do $$
declare v_question text;
begin
	perform pg_temp.o_clean();
	perform pg_temp.o_same(pg_temp.o_state($s$select pg_temp.o_run('money-now')$s$), pg_temp.w_money(), 'a run, no bank');
	perform pg_temp.o_same(pg_temp.o_state($s$select pg_temp.o_run('site-days')$s$), pg_temp.w_site(), 'a run, no site');
	perform pg_temp.o_same(pg_temp.o_state($s$select pg_temp.o_run('sites')$s$), 'ok', 'a run''s sites');
	foreach v_question in array array['money-balance', 'site-now'] loop
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
		perform pg_temp.o_same(pg_temp.o_state(format('select public.qorpera_native_host_call(%L::uuid, %L, %L, %L::jsonb)',
			current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId', current_setting('qorpera_test.w_token'),
			'qorpera_run_company_numbers', jsonb_build_object('p_environment_id', '92400000-0000-4000-8000-000000000020',
				'p_actor', pg_temp.o_actor(), 'p_question', v_question, 'p_params', '{}'::jsonb))),
			case when v_question = 'site-now' then pg_temp.w_site() else pg_temp.w_money() end,
			'the native host''s call: ' || v_question);
		perform set_config('request.path', '', true);
	end loop;
	perform pg_temp.base_claims('service_role');
end $$;

savepoint w_hook;
do $$
declare v jsonb;
begin
	perform pg_temp.o_clean();
	v := pg_temp.o_ask('orders-days');
	perform pg_temp.o_same(jsonb_array_length(v -> 'rows') || ' ' || (v #> '{rows,0}')::text || ' ' || (v #> '{rows,29}')::text,
		'30 ' || jsonb_build_array(to_char(pg_temp.o_today() - 29, 'YYYY-MM-DD'), 0, 0.00, 0.00)::text || ' '
		|| jsonb_build_array(to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 0, 0.00, 0.00)::text, 'a hook, no orders: zeros');
	perform pg_temp.o_same((pg_temp.o_now() -> 'orders_today')::text || ' ' || (pg_temp.o_now() -> 'sales_today')::text,
		'0 0.00', 'a hook, no orders: orders-now');
	perform pg_temp.o_json(pg_temp.o_run('orders-sources') -> 'rows',
		'[["stripe", 0, 0.00, 0.00], ["added", 0, 0.00, 0.00]]', 'a run, a hook, no orders');
	update public.qorpera_event_hooks set status = 'paused' where id = current_setting('qorpera_test.e3h_stripe')::uuid;
	perform pg_temp.o_same(pg_temp.o_refused('orders-now'), 'ok', 'a paused hook is connected');
	update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp()
	where id = current_setting('qorpera_test.e3h_stripe')::uuid;
	perform pg_temp.o_same(pg_temp.o_refused('orders-days'), pg_temp.w_orders(), 'a removed hook, no orders');
	perform pg_temp.o_same(pg_temp.o_state($s$select pg_temp.o_run('orders-now')$s$), pg_temp.w_orders(),
		'a removed hook, no orders, to a run');
end $$;
rollback to savepoint w_hook;
select pg_temp.base_claims('service_role');

do $$
declare v_ref text;
begin
	perform pg_temp.o_clean();
	insert into public.qorpera_orders(profile_id, environment_id, source, live, ref_sha256, ordered_at, currency,
		amount_minor, state, state_at, state_by, made_at, changed_at)
	values ('12740000-0000-4000-8000-000000000010', '12740000-0000-4000-8000-000000000020', 'stripe', false,
		public.qorpera_order_ref_sha256('12740000-0000-4000-8000-000000000010', 'pi_WTest'), pg_temp.o_at(), 'dkk', 5000,
		'paid', pg_temp.o_at(), 'stripe', clock_timestamp(), clock_timestamp());
	perform pg_temp.o_json(pg_temp.w_other_ask('orders-now') -> 'rows', '[["none", 0, 0.00, null, 0, 0.00, 0, null]]',
		'a test order: live answers zeros');
	perform pg_temp.o_same(pg_temp.w_other_ask('orders-now', '{"test": true}') #>> '{rows,0,1}', '1',
		'a test order: test answers it');
	perform pg_temp.o_clean();
	perform pg_temp.o_same(pg_temp.w_other('orders-now'), pg_temp.w_orders(), 'no order again');
	perform pg_temp.base_claims('authenticated', '12740000-0000-4000-8000-000000000006');
	v_ref := public.qorpera_member_company_numbers_change('12740000-0000-4000-8000-000000000020', 'order-add',
		jsonb_build_object('at', to_char(pg_temp.o_at() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'amount', 20,
			'currency', 'dkk')) #>> '{rows,0,0}';
	perform pg_temp.base_claims('service_role');
	perform pg_temp.o_same((v_ref ~ '^add_[0-9a-f]{32}$')::text, 'true', 'an order added by hand');
	perform pg_temp.o_json(pg_temp.w_other_ask('orders-sources') -> 'rows',
		'[["stripe", 0, 0.00, 0.00], ["added", 1, 20.00, 0.00]]', 'an added order: connected');
	perform pg_temp.o_same(pg_temp.w_other_ask('orders-now') #>> '{rows,0,0}', 'none', 'still no Stripe hook');
	perform pg_temp.o_clean();
end $$;

savepoint w_sites;
select pg_temp.w_site_live('14110000-0000-4000-8000-000000000100', 'notconn-wait', null);
do $$
begin
	perform pg_temp.o_same(pg_temp.o_refused('site-now'), pg_temp.w_site(), 'a site not published yet');
	perform pg_temp.o_same((pg_temp.o_rows('sites') #>> '{0,0}') || ' ' || (pg_temp.o_rows('sites') #>> '{0,3}'),
		'notconn-wait false', 'sites lists it');
end $$;
select pg_temp.w_site_live('14110000-0000-4000-8000-000000000200', 'notconn-live', '14110000-0000-4000-8000-000000000201');
do $$
declare v jsonb;
begin
	perform pg_temp.o_json(pg_temp.o_rows('site-now'), '[["notconn-live", 0, 0, 0], ["notconn-wait", 0, 0, 0]]', 'published: zeros');
	v := pg_temp.o_ask('site-days', '{"site": "notconn-live"}');
	perform pg_temp.o_same(jsonb_array_length(v -> 'rows') || ' ' || (v #> '{rows,29}')::text,
		'30 ' || jsonb_build_array('notconn-live', to_char(pg_temp.o_today(), 'YYYY-MM-DD'), 0, 0)::text, 'site-days: zeros');
	perform pg_temp.o_same(pg_temp.o_refused('site-days', '{"site": "notconn-wait"}'), 'ok', 'another site, unpublished, answers');
	perform pg_temp.o_json(pg_temp.o_run('site-pages') -> 'rows', '[]', 'a run: no pages viewed');
	perform pg_temp.o_same((jsonb_array_length(pg_temp.o_ask('site-hours') -> 'rows'))::text, '96', 'site-hours: zeros');
	update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = 'Test'
	where id = '14110000-0000-4000-8000-000000000200';
	perform pg_temp.o_same(pg_temp.o_refused('site-now'), 'ok', 'a site taken down was published');
end $$;
rollback to savepoint w_sites;
savepoint w_deployed;
select pg_temp.w_site_live('14110000-0000-4000-8000-000000000300', 'notconn-edge', null);
insert into public.qorpera_company_site_deployments(id, site_id, profile_id, version_number, kind, state, live_at)
values ('14110000-0000-4000-8000-000000000301', '14110000-0000-4000-8000-000000000300',
	'92400000-0000-4000-8000-000000000010', 1, 'static', 'live', clock_timestamp());
update public.qorpera_company_sites set live_deployment_id = '14110000-0000-4000-8000-000000000301'
where id = '14110000-0000-4000-8000-000000000300';
do $$
begin
	perform pg_temp.o_json(pg_temp.o_rows('site-now'), '[["notconn-edge", 0, 0, 0]]', 'a live deployment is published');
end $$;
rollback to savepoint w_deployed;
select pg_temp.base_claims('service_role');

insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('14110000-0000-4000-8000-0000000000d1', '12740000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'w1411-key', encode(extensions.digest('w1411-broker', 'sha256'), 'hex'));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, current_version, created_by_user_id, account_label)
values ('14110000-0000-4000-8000-0000000000b1', '12740000-0000-4000-8000-000000000010',
	'12740000-0000-4000-8000-000000000020', '14110000-0000-4000-8000-0000000000d1', 'company', 'bank', 'primary',
	'Company bank', 1, '12740000-0000-4000-8000-000000000006', '••1411');
do $$
begin
	perform pg_temp.o_json(pg_temp.w_other_ask('money-now') -> 'rows', '[["waiting",null,null,null,null,null,null]]',
		'a bank connected: waiting');
	perform pg_temp.o_json(pg_temp.w_other_ask('money-balance') -> 'rows', '[]', 'waiting: no balance yet');
	update public.qorpera_bank_syncs
	set summary = jsonb_build_object('schema', 'qorpera.bank-summary/v1', 'bank', 'Test Bank', 'saldo', 0,
			'updatedAt', '2026-11-14T08:00:00.000Z', 'pausedSince', '2026-11-20', 'history', '[]'::jsonb),
		summary_generation = summary_generation + 1, summary_at = clock_timestamp(), status = 'current',
		due_at = clock_timestamp() + interval '6 hours'
	where profile_id = '12740000-0000-4000-8000-000000000010';
	perform pg_temp.o_same(pg_temp.w_other_ask('money-now') #>> '{rows,0,0}' || ' '
		|| (pg_temp.w_other_ask('money-now') #> '{rows,0,2}')::text, 'paused 0.00', 'paused answers');
	update public.qorpera_bank_syncs set summary = summary - 'pausedSince'
	where profile_id = '12740000-0000-4000-8000-000000000010';
	perform pg_temp.o_same(pg_temp.w_other_ask('money-now') #>> '{rows,0,0}' || ' '
		|| (pg_temp.w_other_ask('money-now') #> '{rows,0,2}')::text, 'current 0.00', 'a balance of nothing is an answer');
	perform pg_temp.o_json(pg_temp.w_other_ask('money-kinds') -> 'rows', '[]', 'current: no kinds this month');
	update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(),
		revoked_by_user_id = '12740000-0000-4000-8000-000000000006'
	where id = '14110000-0000-4000-8000-0000000000b1';
	perform pg_temp.o_same((select status from public.qorpera_bank_syncs
		where profile_id = '12740000-0000-4000-8000-000000000010'), 'disconnected', 'the sync follows the disconnect');
	perform pg_temp.o_same(pg_temp.w_other('money-now'), pg_temp.w_money(), 'disconnected');
	perform pg_temp.o_same(pg_temp.w_other('money-months'), pg_temp.w_money(), 'disconnected: money-months');
end $$;

rollback;
