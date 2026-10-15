-- @fixture 912_folder_core_hooks_mailboxes.test.sql until "-- 1. Creating them on folder-v2"
-- Company folder core C4, E4b (migration 20260930280000; deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §6): on a
-- folder-v2 company a member opens only an address hook. qorpera_create_event_hook refuses a Stripe, GitHub or HMAC proof
-- with the host's words (0A000) and makes, marks and counts nothing; the request's own checks still come first. Address
-- hooks and mailboxes are made as before. The snapshot-v1 branch is 784's. The vault's capture refuses the event_hook
-- connector (a new secret, over the vault's, a member's own) and starts nothing; other connectors are captured as before.

-- The refusal's code and words.
create function pg_temp.refusal(p_statement text) returns text language plpgsql as $$
begin
	execute p_statement;
	return 'ok';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.create_hook(p_name text, p_proof text, p_max_body_bytes integer default null) returns text
language sql as $$
	select pg_temp.refusal(format('select public.qorpera_create_event_hook(%L, %L, %L, %L, %L, %s)',
		'70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020', p_name, 'Events from a sender.',
		p_proof, coalesce(p_max_body_bytes::text, 'null')))
$$;

update public.qorpera_mail_settings set domain = 'inbox.example.test';
delete from public.qorpera_folder_connection_file_marks;

-- 1. A signed proof is refused, and leaves nothing ---------------------------------------------------------------------

do $$
declare v_hooks bigint := (select count(*) from public.qorpera_event_hooks); v_answer text;
begin
	perform pg_temp.as_owner();
	v_answer := pg_temp.create_hook('billing', 'stripe');
	-- 20260930344000 (E3c-1): a Stripe hook too is opened through the vault.
	if v_answer is distinct from '0A000 A signed hook is opened through the vault' then
		raise exception 'A member opens no Stripe hook on folder-v2: %', v_answer; end if;
	v_answer := pg_temp.create_hook('prs', 'github');
	if v_answer is distinct from '0A000 A signed hook is opened through the vault' then
		raise exception 'A member opens no GitHub hook on folder-v2: %', v_answer; end if;
	v_answer := pg_temp.create_hook('backend', 'hmac-sha256');
	if v_answer is distinct from '0A000 A signed hook is opened through the vault' then
		raise exception 'A member opens no HMAC hook on folder-v2: %', v_answer; end if;
	if (select count(*) from public.qorpera_event_hooks) <> v_hooks
		or exists (select 1 from public.qorpera_folder_connection_file_marks) then
		raise exception 'A refused signed hook makes and marks nothing'; end if;
end $$;

-- 2. The request's own checks come first -------------------------------------------------------------------------------

do $$
declare v_answer text;
begin
	-- A contributor is refused as one, whatever the proof.
	perform pg_temp.as_member();
	v_answer := pg_temp.create_hook('prs', 'github');
	if v_answer not like '42501 %' then raise exception 'A contributor is refused first: %', v_answer; end if;
	perform pg_temp.as_owner();
	v_answer := pg_temp.create_hook('Not A Name', 'github');
	if v_answer not like '22023 A hook name %' then raise exception 'A bad name is refused first: %', v_answer; end if;
	v_answer := pg_temp.create_hook('prs', 'github', 512);
	if v_answer not like '22023 A hook body limit %' then raise exception 'A bad limit is refused first: %', v_answer; end if;
	v_answer := pg_temp.create_hook('prs', 'signed');
	if v_answer not like '22023 A hook is proven %' then raise exception 'An unknown proof stays 22023: %', v_answer; end if;
end $$;

-- 3. Address hooks and mailboxes, as before ----------------------------------------------------------------------------

do $$
declare v_hook jsonb; v_named jsonb; v_box jsonb;
begin
	perform pg_temp.as_owner();
	v_hook := public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
		'billing', 'Stripe events, by their address.');
	v_named := public.qorpera_create_event_hook('70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
		'forms', 'Form posts.', 'address');
	if v_hook ->> 'proof' <> 'address' or v_hook ->> 'address' is null or v_hook ? 'signingSecret'
		or v_named ->> 'proof' <> 'address' or v_named ->> 'address' is null then
		raise exception 'An owner opens address hooks as before: % %', v_hook, v_named; end if;
	v_box := public.qorpera_create_company_mailbox('70400000-0000-4000-8000-000000000010',
		'70400000-0000-4000-8000-000000000020', 'support', 'Customer support.');
	if v_box ->> 'email' is distinct from 'support@inbox.example.test' then
		raise exception 'An owner opens a mailbox as before: %', v_box; end if;
	if pg_temp.hook_marks('hook', (v_hook ->> 'id')::uuid) <> 1 or pg_temp.hook_marks('hook', (v_named ->> 'id')::uuid) <> 1
		or pg_temp.hook_marks('mailbox', (v_box ->> 'id')::uuid) <> 1 then
		raise exception 'Each creation marks its own file, as before'; end if;
end $$;

-- 4. No member pastes a hook's secret through the vault's capture -----------------------------------------------------

create function pg_temp.capture(p_owner_kind text, p_owner uuid, p_connector text, p_name text, p_existing uuid default null)
returns text language sql as $$
	select pg_temp.refusal(format('select public.qorpera_begin_cloud_secret_capture(%L, %L, %L, %L, %L, %L, %L, %L)',
		'70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020', p_owner_kind, p_owner, p_connector,
		p_name, 'A sender''s signing secret.', p_existing))
$$;

-- A hook's secret the vault made.
insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, connector_id,
	secret_name, purpose, status, current_version, created_by_user_id) values
	('41800000-0000-4000-8000-000000000001', '70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020',
	'70400000-0000-4000-8000-0000000000d1', 'company', 'event_hook', 'h41800000000040008000000000000002', 'Hook', 'active', 1,
	'70400000-0000-4000-8000-000000000001');

do $$
declare
	v_tickets bigint := (select count(*) from public.qorpera_cloud_secret_capture_tickets);
	v_events bigint := (select count(*) from public.qorpera_cloud_secret_audit_events);
	v_answer text;
begin
	perform pg_temp.as_owner();
	v_answer := pg_temp.capture('company', null, 'event_hook', 'h41800000000040008000000000000003');
	if v_answer is distinct from '0A000 A hook''s signing secret comes from the vault' then
		raise exception 'An owner pastes no new hook secret on folder-v2: %', v_answer; end if;
	v_answer := pg_temp.capture('company', null, 'event_hook', 'h41800000000040008000000000000002',
		'41800000-0000-4000-8000-000000000001');
	if v_answer is distinct from '0A000 A hook''s signing secret comes from the vault' then
		raise exception 'An owner pastes nothing over the vault''s hook secret: %', v_answer; end if;
	perform pg_temp.as_member();
	v_answer := pg_temp.capture('member', '70400000-0000-4000-8000-000000000002', 'event_hook',
		'h41800000000040008000000000000003');
	if v_answer is distinct from '0A000 A hook''s signing secret comes from the vault' then
		raise exception 'A member keeps no hook secret of their own on folder-v2: %', v_answer; end if;
	if (select count(*) from public.qorpera_cloud_secret_capture_tickets) <> v_tickets
		or (select count(*) from public.qorpera_cloud_secret_audit_events) <> v_events
		or (select current_version from public.qorpera_cloud_secrets where id = '41800000-0000-4000-8000-000000000001') <> 1 then
		raise exception 'A refused capture starts nothing'; end if;
	-- The capture's own checks still come first, and another connector is captured as before.
	perform pg_temp.as_owner();
	v_answer := pg_temp.capture('company', null, 'event_hook', 'Not A Name');
	if v_answer is distinct from '22023 secret capture scope is invalid' then
		raise exception 'A bad scope is refused first: %', v_answer; end if;
	v_answer := pg_temp.capture('company', null, 'github', 'token');
	if v_answer is distinct from 'ok' or (select count(*) from public.qorpera_cloud_secret_capture_tickets) <> v_tickets + 1 then
		raise exception 'Another connector is captured as before: %', v_answer; end if;
end $$;

rollback;
