-- @fixture 1263_company_reading.test.sql until "-- 1. The privileges."
-- 20260930773000: the Co-Founder's senses list the views the company is owed now (company views step 4, slice O1). On
-- 1263's fixture (924's company through 596: Alice's run holds the base binding, and Alice is the company's Co-Founder,
-- so her run reads the senses; 924 seeded QorperaOS/vision/vision.md). Covered:
-- 1. The patch: both markers, the platform's definer read as before, the comment.
-- 2. products is owed while the vision is there, and only then; money is not owed without a bank.
-- 3. An app.toml anywhere but apps/products/ (another folder, a folder below, an archive, a folder of that name,
--    another environment's file) does not make the view.
-- 4. Made: apps/products/App.toml (the key is lowercase) makes it; deleting it unmakes it; written again it is made.
-- 5. money: owed while the bank's consent is live (waiting, current with or without an end ahead, failed), not when
--    the consent's end has passed, it ended, it is disconnected, its secret is no longer active or of another
--    environment; made by apps/money/app.toml; products first.
-- 6. The answer stays within 8,192 bytes with 765000's largest fixture (twenty members, cards, twenty long non-ASCII
--    hires, ten ended, a reading) and still lists both views.
-- 7. A real disconnect: money is no longer owed.

create function pg_temp.ov_view(p_name text, p_made boolean) returns jsonb language sql immutable as $$
	select jsonb_build_object('name', p_name, 'app', 'apps/' || p_name, 'made', p_made)
$$;
create function pg_temp.ov_is(p_expected jsonb, p_what text) returns void language plpgsql as $$
declare v jsonb := pg_temp.rd_senses();
begin
	perform pg_temp.base_assert(v ? 'views' and v -> 'views' = p_expected,
		p_what || ': ' || coalesce((v -> 'views')::text, 'no views'));
end $$;
-- A plain file written by the owner (its parent folders must exist).
create function pg_temp.ov_file(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op', 'write', 'path', p_path,
		'file', pg_temp.base_stage(E'name = "View"\n# ' || p_path || E'\n'))
$$;
create function pg_temp.ov_mkdir(p_path text) returns jsonb language sql immutable as $$
	select jsonb_build_object('op', 'mkdir', 'path', p_path)
$$;
-- The company's bank sync as the vault leaves it in each state.
create function pg_temp.ov_bank(p_status text, p_consent_until timestamptz) returns void language plpgsql as $$
declare v_rows integer;
begin
	update public.qorpera_bank_syncs set status = p_status,
		due_at = case when p_status in ('ended', 'disconnected') then null else clock_timestamp() + interval '6 hours' end,
		consent_until = p_consent_until, updated_at = clock_timestamp()
	where profile_id = '92400000-0000-4000-8000-000000000010';
	get diagnostics v_rows = row_count;
	perform pg_temp.base_assert(v_rows = 1, 'fixture: the company has its bank sync');
end $$;

-- 1. The patch.
do $$
begin
	perform pg_temp.base_assert((select prosecdef and proconfig = array['search_path=""']
			and prosrc like '%20260930765000%' and prosrc like '%20260930773000%'
		from pg_proc where oid = 'public.qorpera_describe_company_senses(jsonb)'::regprocedure),
		'the senses are still the definer read, with both markers');
	perform pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_describe_company_senses(jsonb)', 'EXECUTE')
		and not has_function_privilege('authenticated', 'public.qorpera_describe_company_senses(jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_describe_company_senses(jsonb)', 'EXECUTE'),
		'the senses are still the platform''s');
	perform pg_temp.base_assert(obj_description('public.qorpera_describe_company_senses(jsonb)'::regprocedure, 'pg_proc')
		like '%20260930773000%', 'the comment names the views');
end $$;

-- 2. products is owed while the company has its vision; no bank, so money is not.
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', false)), 'a vision and no app: products, not made');
savepoint ov_no_vision;
set local session_replication_role = replica;
delete from public.qorpera_folder_entries
where environment_id = '92400000-0000-4000-8000-000000000020' and key_text = 'qorperaos/vision/vision.md';
set local session_replication_role = origin;
select pg_temp.ov_is('[]', 'without a vision nothing is owed');
rollback to savepoint ov_no_vision;

-- 3. An app.toml anywhere else is no products view.
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-elsewhere-1', jsonb_build_array(
	pg_temp.ov_mkdir('apps'), pg_temp.ov_mkdir('apps/products'), pg_temp.ov_file('apps/products/index.html'),
	pg_temp.ov_mkdir('apps/products-old'), pg_temp.ov_file('apps/products-old/app.toml'),
	pg_temp.ov_mkdir('apps/products/v2'), pg_temp.ov_file('apps/products/v2/app.toml'),
	pg_temp.ov_mkdir('archive'), pg_temp.ov_mkdir('archive/apps'), pg_temp.ov_mkdir('archive/apps/products'),
	pg_temp.ov_file('archive/apps/products/app.toml'),
	pg_temp.ov_mkdir('products'), pg_temp.ov_file('products/app.toml'))) \g /dev/null
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', false)),
	'an app.toml in another folder, below the view''s folder or in an archive does not make it');
savepoint ov_folder;
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-folder-1', jsonb_build_array(pg_temp.ov_mkdir('apps/products/app.toml')))
	\g /dev/null
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', false)), 'a folder named app.toml is no app');
rollback to savepoint ov_folder;
-- Another environment's file at the same key.
savepoint ov_other;
set local session_replication_role = replica;
insert into public.qorpera_folder_entries(environment_id, path, kind, version, commit_id, manifest_sha256, file_sha256,
	bytes, media_type, executable)
values ('12710000-0000-4000-8000-000000000020', 'apps/products/app.toml', 'file', extensions.gen_random_uuid(),
	extensions.gen_random_uuid(), repeat('1', 64), repeat('2', 64), 10, 'text/plain', false);
set local session_replication_role = origin;
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', false)), 'another environment''s app is not this company''s');
rollback to savepoint ov_other;

-- 4. Made: the key is the lowercase path, so apps/products/App.toml is the view's app.toml.
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-made-1', jsonb_build_array(pg_temp.ov_file('apps/products/App.toml')))
	\g /dev/null
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', true)), 'apps/products/App.toml makes the view');
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-unmade-1', jsonb_build_array(jsonb_build_object('op', 'delete',
	'path', 'apps/products/App.toml', 'expectedVersion', pg_temp.base_version('apps/products/app.toml')))) \g /dev/null
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', false)), 'a deleted app.toml is no app');
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-remade-1', jsonb_build_array(pg_temp.ov_file('apps/products/app.toml')))
	\g /dev/null
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', true)), 'written again, the view is made');

-- 5. money. A bank connected (the trigger makes the sync, waiting for its first fetch): the consent was just given.
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256) values
	('12710000-0000-4000-8000-0000000000d1', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test', 'key-1',
		repeat('6', 64));
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, current_version, created_by_user_id, account_label)
values ('12710000-0000-4000-8000-0000000000b1', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '12710000-0000-4000-8000-0000000000d1', 'company', 'bank', 'primary',
	'Company bank', 1, '92400000-0000-4000-8000-000000000001', '••6243');
do $$
declare v_both jsonb := jsonb_build_array(pg_temp.ov_view('products', true), pg_temp.ov_view('money', false));
	v_products jsonb := jsonb_build_array(pg_temp.ov_view('products', true));
begin
	perform pg_temp.base_assert((select status = 'waiting' and consent_until is null from public.qorpera_bank_syncs
		where profile_id = '92400000-0000-4000-8000-000000000010'), 'fixture: the connect makes a waiting sync');
	perform pg_temp.ov_is(v_both, 'a bank just connected: money is owed, after products');
	perform pg_temp.ov_bank('current', statement_timestamp() + interval '90 days');
	perform pg_temp.ov_is(v_both, 'a current sync whose consent ends in 90 days');
	perform pg_temp.ov_bank('current', null);
	perform pg_temp.ov_is(v_both, 'a current sync whose bank gave no end');
	perform pg_temp.ov_bank('failed', null);
	perform pg_temp.ov_is(v_both, 'a first fetch that failed and is tried again');
	perform pg_temp.ov_bank('current', statement_timestamp() - interval '1 minute');
	perform pg_temp.ov_is(v_products, 'a consent past its end, before the vault notices');
	perform pg_temp.ov_bank('ended', statement_timestamp() + interval '90 days');
	perform pg_temp.ov_is(v_products, 'the bank said the consent ended');
	perform pg_temp.ov_bank('disconnected', null);
	perform pg_temp.ov_is(v_products, 'a disconnected bank');
	perform pg_temp.ov_bank('current', statement_timestamp() + interval '90 days');
	perform pg_temp.ov_is(v_both, 'connected again');
end $$;
-- The secret is what the consent lives in: one no longer active, or of another environment, is no live consent.
savepoint ov_secret;
set local session_replication_role = replica;
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp()
where id = '12710000-0000-4000-8000-0000000000b1';
set local session_replication_role = origin;
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', true)), 'a secret no longer active');
rollback to savepoint ov_secret;
savepoint ov_environment;
set local session_replication_role = replica;
update public.qorpera_cloud_secrets set environment_id = '12710000-0000-4000-8000-000000000020'
where id = '12710000-0000-4000-8000-0000000000b1';
set local session_replication_role = origin;
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', true)), 'a bank of another environment');
rollback to savepoint ov_environment;
-- The money view made.
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-money-1', jsonb_build_array(pg_temp.ov_mkdir('apps/money'),
	pg_temp.ov_file('apps/money/app.toml'))) \g /dev/null
select pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', true), pg_temp.ov_view('money', true)),
	'apps/money/app.toml makes the money view');

-- 6. 765000's largest fixture, both views owed and made: at most 8,192 bytes, the views kept whole.
savepoint ov_churn;
insert into auth.users(id, email)
select ('12710000-0000-4000-8000-' || lpad(to_hex(512 + n), 12, '0'))::uuid, 'views-member-' || n || '@example.test'
from generate_series(1, 16) as n;
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
select '92400000-0000-4000-8000-000000000010', ('12710000-0000-4000-8000-' || lpad(to_hex(512 + n), 12, '0'))::uuid,
	'views-member-' || n || '@example.test', 'Medlem ' || n, 'contributor'
from generate_series(1, 16) as n;
select pg_temp.base_commit(pg_temp.base_owner(), 'ov-reading-1', jsonb_build_array(pg_temp.rd_write('sales'))) \g /dev/null
set local session_replication_role = replica;
update public.qorpera_folder_path_versions set created_at = created_at - interval '1 hour'
where version = pg_temp.base_version('QorperaOS/vision/reading.md');
set local session_replication_role = origin;
do $$
declare b jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_card integer;
begin
	for v_card in 1..10 loop
		perform public.qorpera_append_native_interaction_request((b ->> 'leaseId')::uuid, (b ->> 'runId')::uuid,
			(b ->> 'jobId')::uuid, (b ->> 'runnerId')::uuid, (b ->> 'assignmentId')::uuid, (b ->> 'credentialCapsuleId')::uuid,
			(b ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli',
			('12710000-0000-4000-8000-' || lpad(to_hex(2304 + v_card), 12, '0'))::uuid,
			jsonb_build_object('schema', 'qorpera.interaction/v1', 'surface', 'question', 'title', 'Question ' || v_card,
				'payload', '{"options":[{"label":"Yes"},{"label":"No"}]}'::jsonb));
	end loop;
	perform pg_temp.base_commit(pg_temp.base_owner(), 'ov-churn-1', (select jsonb_agg(pg_temp.base_hire('churn-' || n,
		('12710000-0000-4000-8000-' || lpad(to_hex(768 + n), 12, '0'))::uuid, rpad('Ærøskøbing ' || n || ' ', 150, 'ø')))
		from generate_series(1, 20) as n));
end $$;
set local session_replication_role = replica;
update public.qorpera_profile_staff set employment_status = 'archived', updated_at = clock_timestamp()
where profile_id = '92400000-0000-4000-8000-000000000010'
	and staff_agent_id in (select ('12710000-0000-4000-8000-' || lpad(to_hex(768 + n), 12, '0'))::uuid from generate_series(1, 10) as n);
set local session_replication_role = origin;
do $$
declare v jsonb := pg_temp.rd_senses();
begin
	perform pg_temp.base_assert(octet_length(v::text) <= 8192 and v #>> '{agents,0,handle}' = 'alice'
		and v #> '{agents,0,cofounder}' = 'true' and jsonb_array_length(v -> 'members') = 20
		and v #> '{questions,truncated}' = 'true' and v #> '{team,truncated}' = 'true' and v -> 'agentsTruncated' = 'true'
		and v #>> '{reading,attention}' = 'sales'
		and v -> 'views' = jsonb_build_array(pg_temp.ov_view('products', true), pg_temp.ov_view('money', true)),
		'the largest fixture stays within 8,192 bytes with both views: ' || octet_length(v::text) || ' bytes: ' || v::text);
end $$;
rollback to savepoint ov_churn;

-- 7. A member disconnects the bank (the sync follows the secret): money is no longer owed.
update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = statement_timestamp(),
	revoked_by_user_id = '92400000-0000-4000-8000-000000000001'
where id = '12710000-0000-4000-8000-0000000000b1';
do $$
begin
	perform pg_temp.base_assert((select status from public.qorpera_bank_syncs
		where profile_id = '92400000-0000-4000-8000-000000000010') = 'disconnected', 'fixture: the sync follows the disconnect');
	perform pg_temp.ov_is(jsonb_build_array(pg_temp.ov_view('products', true)), 'a disconnected bank owes no money view');
end $$;

-- The fixture's rows go with the test.
rollback;
