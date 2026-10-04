-- @fixture 852_folder_connection_file_marks.test.sql until "-- 1. The marks: a company connection in a folder-v2 environment"
-- Company folder core C4, E1 (migration 20260930060000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §3): hooks and
-- mailboxes on folder-v2, each described by a connection file. An owner creates, pauses and removes them in core §3's
-- order; each change marks its file due by kind; a claim answers the file's settings by an allow-list (never a hook's
-- address); the platform writes, rewrites and removes the file; members and agents change only its body; the vault's
-- files never take a hook's or a mailbox's prefix. One session plays the writer (P22b's object gateway).

create function pg_temp.as_owner() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"authenticated","sub":"70400000-0000-4000-8000-000000000001"}', true)
$$;
create function pg_temp.as_member() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"authenticated","sub":"70400000-0000-4000-8000-000000000002"}', true)
$$;
create function pg_temp.as_service() returns void language sql as $$
	select set_config('request.jwt.claims', '{"role":"service_role"}', true)
$$;
create function pg_temp.code(p_statement text) returns text language plpgsql as $$
begin
	execute p_statement;
	return 'ok';
exception when others then return sqlstate;
end $$;
create function pg_temp.hook_marks(p_kind text, p_hook uuid) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_connection_file_marks where subject_kind = p_kind and secret_id = p_hook
$$;
create function pg_temp.hook_row(p_hook uuid) returns public.qorpera_folder_hook_index language sql as $$
	select * from public.qorpera_folder_hook_index where id = p_hook
$$;
-- The file a claim says, as the writer commits it: the settings, the kind and the body as the parse; a text that hashes.
create function pg_temp.hook_parse(p_kind text, p_settings jsonb, p_purpose text) returns jsonb language sql as $$
	select p_settings || jsonb_build_object('kind', p_kind, 'purpose', p_purpose)
$$;
create function pg_temp.hook_write(p_actor jsonb, p_key text, p_path text, p_kind text, p_settings jsonb, p_purpose text,
	p_expected uuid default null) returns jsonb language sql as $$
	select pg_temp.commit(p_actor, p_key, jsonb_build_array(pg_temp.write(p_path, p_kind,
		E'---\n' || p_settings::text || E'\n---\n' || p_purpose, pg_temp.hook_parse(p_kind, p_settings, p_purpose), p_expected)))
$$;

-- 1. Creating them on folder-v2 ----------------------------------------------------------------------------------------

update public.qorpera_mail_settings set domain = 'inbox.example.test';
delete from public.qorpera_folder_connection_file_marks;

do $$
declare v_hook jsonb; v_box jsonb; v_locks bigint;
begin
	perform pg_temp.as_owner();
	v_hook := public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
		'stripe-payments', 'Payments from Stripe wake the Analyst.');
	if v_hook ->> 'name' <> 'stripe-payments' or v_hook ->> 'address' is null then
		raise exception 'An owner creates a folder company''s hook: %', v_hook; end if;
	perform set_config('qorpera_test.hook', v_hook ->> 'id', true);
	perform set_config('qorpera_test.hook_address', v_hook ->> 'address', true);
	-- The company's advisory lock serializes its creations (the caps), held to the end of the transaction.
	select count(*) into v_locks from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted;
	if v_locks = 0 then raise exception 'A folder-v2 creation holds the company''s advisory lock'; end if;
	v_box := public.qorpera_create_company_mailbox('70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
		'support', 'Customer support.');
	if v_box ->> 'email' is distinct from 'support@inbox.example.test' then
		raise exception 'An owner creates a folder company''s mailbox: %', v_box; end if;
	perform set_config('qorpera_test.box', v_box ->> 'id', true);
	if pg_temp.hook_marks('hook', (v_hook ->> 'id')::uuid) <> 1 or pg_temp.hook_marks('mailbox', (v_box ->> 'id')::uuid) <> 1
		or exists (select 1 from public.qorpera_folder_connection_file_marks where subject_kind = 'vault') then
		raise exception 'Each creation marks its own file, by kind'; end if;
	-- A contributor creates neither; a taken name is refused; mail- names are the mailboxes'.
	perform pg_temp.as_member();
	if pg_temp.code($q$select public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010',
		'70400000-0000-4000-8000-000000000020', 'forms', 'Forms.')$q$) <> '42501' then
		raise exception 'A contributor creates no hook'; end if;
	perform pg_temp.as_owner();
	if pg_temp.code($q$select public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010',
		'70400000-0000-4000-8000-000000000020', 'stripe-payments', 'Again.')$q$) <> '23505' then
		raise exception 'A live name is taken'; end if;
	if pg_temp.code($q$select public.qorpera_create_company_mailbox('70400000-0000-4000-8000-000000000010',
		'70400000-0000-4000-8000-000000000020', 'support', 'Again.')$q$) <> '23505' then
		raise exception 'A live address is taken'; end if;
end $$;

-- The cap of 50 live hooks (mailboxes count) holds on folder-v2 too.
do $$
declare i integer;
begin
	perform pg_temp.as_owner();
	for i in 1..48 loop
		perform public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
			'extra-' || i, 'Extra.');
	end loop;
	if pg_temp.code($q$select public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010',
		'70400000-0000-4000-8000-000000000020', 'one-more', 'One more.')$q$) <> '54000' then
		raise exception 'A company has at most 50 hooks'; end if;
	update public.qorpera_event_hooks set status = 'removed', removed_at = clock_timestamp() where name like 'extra-%';
	delete from public.qorpera_folder_connection_file_marks
	where secret_id in (select id from public.qorpera_event_hooks where name like 'extra-%');
end $$;

-- 2. The claim: the file's settings, never the address ---------------------------------------------------------------------

do $$
declare c jsonb; v_hook uuid := current_setting('qorpera_test.hook')::uuid; v_row public.qorpera_event_hooks;
begin
	perform pg_temp.as_service();
	select * into v_row from public.qorpera_event_hooks where id = v_hook;
	c := pg_temp.claim();
	if c ->> 'subjectKind' <> 'hook' or (c ->> 'secretId')::uuid <> v_hook or c ->> 'operationKey' <> 'hook-file:' || v_hook || ':1'
		or c ->> 'present' <> 'true' or c ->> 'path' <> 'connections/hook-stripe-payments.md' or c -> 'current' <> 'null'::jsonb
		or c ->> 'body' <> 'Payments from Stripe wake the Analyst.'
		or c -> 'settings' <> jsonb_build_object('id', v_hook, 'name', 'stripe-payments', 'proof', 'address', 'status', 'active',
			'maxBodyBytes', 65536, 'perMinute', 60, 'createdBy', '70400000-0000-4000-8000-000000000001',
			'createdAt', public.qorpera_company_state_instant_text(v_row.created_at)) then
		raise exception 'The hook''s claim: %', c; end if;
	if strpos(c::text, current_setting('qorpera_test.hook_address')) > 0 then
		raise exception 'A hook''s address left in its claim'; end if;
	perform pg_temp.expect(pg_temp.hook_write(pg_temp.platform(), c ->> 'operationKey', c ->> 'path', 'hook', c -> 'settings',
		c ->> 'body'), 1, 'saved');
	if (pg_temp.hook_row(v_hook)).kind is distinct from 'hook'
		or (pg_temp.hook_row(v_hook)).folder_key <> 'connections/hook-stripe-payments.md' then
		raise exception 'The hook''s file is indexed: %', to_jsonb(pg_temp.hook_row(v_hook)); end if;
	if not (public.qorpera_finish_connection_file('85200000-0000-4000-8000-00000000000a', v_hook, 1, null, 'hook')
		->> 'finished')::boolean then raise exception 'The hook''s claim finishes by kind'; end if;
	-- The mailbox's claim: its address, its own prefix.
	c := pg_temp.claim();
	if c ->> 'subjectKind' <> 'mailbox' or c ->> 'path' <> 'connections/mailbox-support.md'
		or c -> 'settings' ->> 'address' <> 'support@inbox.example.test' or c ->> 'operationKey' not like 'mailbox-file:%'
		or (c -> 'settings') ? 'proof' then
		raise exception 'The mailbox''s claim: %', c; end if;
	perform pg_temp.expect(pg_temp.hook_write(pg_temp.platform(), c ->> 'operationKey', c ->> 'path', 'mailbox', c -> 'settings',
		c ->> 'body'), 1, 'saved');
	perform public.qorpera_finish_connection_file('85200000-0000-4000-8000-00000000000a', (c ->> 'secretId')::uuid, 1, null,
		'mailbox');
	if pg_temp.claim() is not null then raise exception 'Nothing else is due'; end if;
end $$;

-- 3. The rules -----------------------------------------------------------------------------------------------------------

do $$
declare
	v_hook uuid := current_setting('qorpera_test.hook')::uuid; v_settings jsonb; r jsonb;
	v_path text := 'connections/hook-stripe-payments.md';
begin
	perform pg_temp.as_service();
	v_settings := (public.qorpera_folder_hook_file_state('hook', v_hook, '70400000-0000-4000-8000-000000000020')) -> 'settings';
	-- A member changes the body; never a setting.
	perform pg_temp.expect(pg_temp.hook_write(pg_temp.owner(), 'e1-body-1', v_path, 'hook', v_settings,
		'Payments, and what the Analyst does with them.', pg_temp.version(v_path)), 1, 'saved');
	r := pg_temp.hook_write(pg_temp.owner(), 'e1-status-1', v_path, 'hook', v_settings || '{"status":"paused"}',
		'Payments.', pg_temp.version(v_path));
	if not pg_temp.refused(r) then raise exception 'A member pauses a hook in its file: %', r; end if;
	-- No second file for a hook, and no file for a hook of another company or kind, or one that does not exist.
	r := pg_temp.hook_write(pg_temp.platform(), 'e1-second-1', 'connections/hook-again.md', 'hook', v_settings, '');
	if not pg_temp.refused(r) then raise exception 'A hook has one file: %', r; end if;
	r := pg_temp.hook_write(pg_temp.platform(), 'e1-unknown-1', 'connections/hook-ghost.md', 'hook',
		v_settings || '{"id":"91200000-0000-4000-8000-0000000000f1"}', '');
	if not pg_temp.refused(r) then raise exception 'A file names a hook of this company: %', r; end if;
	r := pg_temp.hook_write(pg_temp.platform(), 'e1-kind-1', 'connections/mailbox-stripe.md', 'mailbox',
		jsonb_build_object('id', v_hook, 'address', 'stripe@inbox.example.test', 'status', 'active',
			'createdBy', v_settings ->> 'createdBy', 'createdAt', v_settings ->> 'createdAt'), '');
	if not pg_temp.refused(r) then raise exception 'A hook is no mailbox: %', r; end if;
	-- The platform writes only what the hook says.
	r := pg_temp.hook_write(pg_temp.platform(), 'e1-stale-1', v_path, 'hook', v_settings || '{"perMinute":120}', '',
		pg_temp.version(v_path));
	if not pg_temp.refused(r) then raise exception 'The platform''s settings match the hook: %', r; end if;
	-- Only the platform removes a hook's file, and only once the hook is removed.
	r := pg_temp.commit(pg_temp.owner(), 'e1-delete-1', jsonb_build_array(jsonb_build_object('op', 'delete', 'path', v_path,
		'expectedVersion', pg_temp.version(v_path))));
	if not pg_temp.refused(r) then raise exception 'A member removes a hook''s file: %', r; end if;
	r := pg_temp.commit(pg_temp.platform(), 'e1-delete-2', jsonb_build_array(jsonb_build_object('op', 'delete', 'path', v_path,
		'expectedVersion', pg_temp.version(v_path))));
	if not pg_temp.refused(r) then raise exception 'The platform removes a live hook''s file: %', r; end if;
	-- A rename within the prefix follows the file; anything else is a kind change.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'e1-move-1', jsonb_build_array(jsonb_build_object('op', 'move',
		'from', v_path, 'to', 'connections/hook-stripe.md', 'expectedVersion', pg_temp.version(v_path)))), 1, 'saved');
	if (pg_temp.hook_row(v_hook)).folder_key <> 'connections/hook-stripe.md' then
		raise exception 'A moved hook file is repointed: %', to_jsonb(pg_temp.hook_row(v_hook)); end if;
	r := pg_temp.commit(pg_temp.owner(), 'e1-move-2', jsonb_build_array(jsonb_build_object('op', 'move',
		'from', 'connections/hook-stripe.md', 'to', 'connections/stripe.md', 'expectedVersion', pg_temp.version('connections/hook-stripe.md'))));
	if r -> 'units' -> 0 ->> 'reason' is distinct from 'kind_change' then
		raise exception 'A hook''s file stays a hook''s file: %', r; end if;
	-- A vault account's file never takes a hook's or a mailbox's prefix.
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,
		purpose,status,current_version,created_by_user_id,account_label) values
		('91200000-0000-4000-8000-0000000000e1','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020',
			'70400000-0000-4000-8000-0000000000d1','company','website','portal','x','active',1,'70400000-0000-4000-8000-000000000001',
			'ops@nordlys.test');
	insert into public.qorpera_company_accounts(secret_id, profile_id, environment_id, site, sign_in_hosts, login, status,
		opened_by_user_id)
	values ('91200000-0000-4000-8000-0000000000e1','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020',
		'hook-x.example.com', '{hook-x.example.com}', 'ops@nordlys.test', 'pending', '70400000-0000-4000-8000-000000000001');
	if public.qorpera_folder_connection_file_state('91200000-0000-4000-8000-0000000000e1') ->> 'path'
		<> 'connections/connection-hook-x-example-com.md' then
		raise exception 'A vault file took a hook''s prefix: %',
			public.qorpera_folder_connection_file_state('91200000-0000-4000-8000-0000000000e1'); end if;
	delete from public.qorpera_folder_connection_file_marks where subject_kind = 'vault';
end $$;

-- 4. Pausing and removing ------------------------------------------------------------------------------------------------

do $$
declare v_hook uuid := current_setting('qorpera_test.hook')::uuid; c jsonb; v_path text := 'connections/hook-stripe.md';
begin
	perform pg_temp.as_member();
	if pg_temp.code(format('select public.qorpera_set_event_hook_status(%L, %L)', v_hook, 'paused')) <> '42501' then
		raise exception 'A contributor pauses no hook'; end if;
	perform pg_temp.as_owner();
	if public.qorpera_set_event_hook_status(v_hook, 'paused') ->> 'status' <> 'paused' or pg_temp.hook_marks('hook', v_hook) <> 1 then
		raise exception 'A pause marks the hook''s file'; end if;
	perform pg_temp.as_service();
	c := pg_temp.claim();
	if c ->> 'subjectKind' <> 'hook' or c -> 'settings' ->> 'status' <> 'paused' or c -> 'current' ->> 'path' <> v_path then
		raise exception 'The paused hook''s claim: %', c; end if;
	perform pg_temp.expect(pg_temp.hook_write(pg_temp.platform(), c ->> 'operationKey', v_path, 'hook', c -> 'settings',
		'Payments, and what the Analyst does with them.', (c -> 'current' ->> 'version')::uuid), 1, 'saved');
	perform public.qorpera_finish_connection_file('85200000-0000-4000-8000-00000000000a', v_hook, 2, null, 'hook');
	-- Removed: the file goes, by the platform, and its row retires.
	perform pg_temp.as_owner();
	perform public.qorpera_set_event_hook_status(v_hook, 'removed');
	perform pg_temp.as_service();
	c := pg_temp.claim();
	if c ->> 'present' <> 'false' or c -> 'settings' <> 'null'::jsonb or c ->> 'body' is not null
		or c -> 'current' ->> 'path' <> v_path then
		raise exception 'The removed hook''s claim: %', c; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), c ->> 'operationKey', jsonb_build_array(jsonb_build_object('op',
		'delete', 'path', v_path, 'expectedVersion', c -> 'current' ->> 'version'))), 1, 'saved');
	if (pg_temp.hook_row(v_hook)).retired_at is null then raise exception 'A removed hook''s row retires'; end if;
	if not (public.qorpera_finish_connection_file('85200000-0000-4000-8000-00000000000a', v_hook, 3, null, 'hook')
		->> 'finished')::boolean then raise exception 'The removal''s claim finishes'; end if;
	-- A vault finish never closes a hook's claim of the same id.
	if (public.qorpera_finish_connection_file('85200000-0000-4000-8000-00000000000a', v_hook, 3) ->> 'finished')::boolean then
		raise exception 'A finish is by kind'; end if;
end $$;

-- 5. The company and the platform's own reach ----------------------------------------------------------------------------

do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		foreach v_function in array array['public.qorpera_folder_hook_file_state(text,uuid,uuid)',
			'public.qorpera_company_state_hook_rules(uuid,uuid,jsonb,text,text,jsonb)',
			'public.qorpera_company_state_index_hook(uuid,uuid,uuid,text,uuid,text,jsonb)',
			'public.qorpera_folder_hook_file_mark()'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% may execute %', v_role, v_function; end if;
		end loop;
	end loop;
	foreach v_role in array array['anon','authenticated'] loop
		if has_function_privilege(v_role, 'public.qorpera_finish_connection_file(uuid,uuid,bigint,text,text)', 'EXECUTE')
			or has_table_privilege(v_role, 'public.qorpera_folder_hook_index', 'SELECT') then
			raise exception 'Only the platform finishes and reads the hook index (%)', v_role; end if;
	end loop;
	-- No claim this test answered ever carried a hook's address.
	if exists (select 1 from claims_seen where strpos(answer::text, current_setting('qorpera_test.hook_address')) > 0) then
		raise exception 'A claim carried a hook''s address'; end if;
end $$;

rollback;
