-- The founding lobby (20260928248200): friends take seats at a table, each founder writes a role,
-- connects their own ChatGPT login and presses Ready for the current table revision, and one
-- repeat-safe Start makes every founder at the table an owner and hands the vision and the
-- founders to C2's creation commit, with the launcher paying for the kickoff.
-- C2's creation halves, its readiness and the availability switch are placeholders until C2;
-- this test stands in for them.
begin;

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
	('40000000-0000-4000-8000-000000000001','anna@example.test',statement_timestamp(),'{"display_name":"Anna"}'),
	('40000000-0000-4000-8000-000000000002','bo@example.test',statement_timestamp(),'{"display_name":"Bo"}'),
	('40000000-0000-4000-8000-000000000003','cy@example.test',statement_timestamp(),'{"display_name":"Cy"}'),
	('40000000-0000-4000-8000-000000000004','dee@example.test',statement_timestamp(),'{"display_name":"Dee"}');
-- Anna is friends with Bo and Cy; Dee's request to Anna is still pending; Bo and Dee are friends.
insert into public.qorpera_friendships(user_low,user_high,requested_by,status,responded_at) values
	('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','accepted',statement_timestamp()),
	('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001','accepted',statement_timestamp()),
	('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004','pending',null),
	('40000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000002','accepted',statement_timestamp());

create function pg_temp.as_user(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user,
		'email',(select email from auth.users where id = p_user))::text,true)::text::void
$$;
create function pg_temp.as_service()
returns void language sql as $$
	select set_config('request.jwt.claims','{"role":"service_role"}',true)::text::void
$$;
create function pg_temp.refused(p_sql text,p_state text)
returns void language plpgsql as $$
begin
	execute p_sql;
	raise exception 'expected SQLSTATE % from: %', p_state, p_sql;
exception when others then
	if sqlstate <> p_state then raise exception 'expected SQLSTATE %, got % (%) from: %', p_state, sqlstate, sqlerrm, p_sql; end if;
end $$;
create function pg_temp.table_revision(p_profile uuid)
returns bigint language sql as $$
	select revision from public.qorpera_company_foundings where profile_id = p_profile
$$;

-- Nothing reaches C2's halves, the lobby's helpers or its tables directly; the lobby's calls are the
-- only API, and they are for signed-in members only.
do $$
declare v_function text;
begin
	foreach v_function in array array['public.qorpera_folder_company_open(uuid,uuid,text)',
		'public.qorpera_folder_company_seed(uuid,jsonb)','public.qorpera_folder_company_ready(uuid)',
		'public.qorpera_company_founding_json(uuid)','public.qorpera_lock_company_founding(uuid)',
		'public.qorpera_company_founding_seated(uuid)','public.qorpera_company_founding_open(uuid)',
		'public.qorpera_founding_member_guard()','public.qorpera_founding_member_left()',
		'public.qorpera_founding_invitation_guard()'] loop
		if has_function_privilege('authenticated',v_function,'EXECUTE') or has_function_privilege('service_role',v_function,'EXECUTE')
			or has_function_privilege('anon',v_function,'EXECUTE') then
			raise exception 'API clients can call %', v_function; end if;
	end loop;
	foreach v_function in array array['public.qorpera_company_founding_available()',
		'public.qorpera_open_company_founding(uuid,text)','public.qorpera_read_company_founding(uuid)',
		'public.qorpera_list_company_foundings()','public.qorpera_update_company_founding(uuid,bigint,text,text)',
		'public.qorpera_invite_company_founder(uuid,uuid)','public.qorpera_respond_company_founding(uuid,boolean)',
		'public.qorpera_set_founder_role(uuid,bigint,text)','public.qorpera_set_founder_ready(uuid,bigint,boolean)',
		'public.qorpera_remove_company_founder(uuid,uuid)','public.qorpera_start_company_founding(uuid,bigint,uuid)'] loop
		if has_function_privilege('anon',v_function,'EXECUTE') or not has_function_privilege('authenticated',v_function,'EXECUTE') then
			raise exception '% is not a member call', v_function; end if;
	end loop;
	if has_table_privilege('authenticated','public.qorpera_company_foundings','SELECT')
		or has_table_privilege('authenticated','public.qorpera_company_founder_seats','SELECT')
		or has_table_privilege('authenticated','public.qorpera_company_founder_seats','INSERT')
		or has_table_privilege('service_role','public.qorpera_company_founder_seats','INSERT')
		or has_table_privilege('service_role','public.qorpera_company_foundings','UPDATE') then
		raise exception 'the lobby tables are readable or writable directly'; end if;
	if public.qorpera_company_founding_available() then raise exception 'the lobby is on before C2'; end if;
end $$;

-- Until the switch is on, opening a table is refused and nothing is written.
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($$select public.qorpera_open_company_founding('40000000-0000-4000-8000-000000000100','Nordlys')$$,'0A000');
reset role;

-- Stand-ins for C2: open makes the company row, its environment and the creator as owner without the
-- old setup chain (no Company File), repeat-safe per creation id; seed records its input once; a
-- company is ready once the test says so. The switch is on.
alter table public.qorpera_company_environments disable trigger qorpera_provision_company_file;
create table public.founding_test_seeds(profile_id uuid primary key,input jsonb not null,calls integer not null default 1,
	ready boolean not null default false);
create or replace function public.qorpera_folder_company_open(p_user_id uuid,p_client_creation_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
	select profile_id into v_profile from public.qorpera_company_creation_requests
		where created_by_user_id = p_user_id and client_creation_id = p_client_creation_id;
	if v_profile is null then
		insert into public.qorpera_profiles(name,created_by_user_id) values(p_name,p_user_id) returning id into v_profile;
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
			select v_profile,id,email,'Anna','owner' from auth.users where id = p_user_id;
		insert into public.qorpera_company_environments(profile_id,name,contract_version,created_by_user_id)
			values(v_profile,p_name,2,p_user_id);
		insert into public.qorpera_company_creation_requests(created_by_user_id,client_creation_id,profile_name,contract_version,profile_id)
			values(p_user_id,p_client_creation_id,p_name,2,v_profile);
	end if;
	return jsonb_build_object('profile_id',v_profile);
end $$;
create or replace function public.qorpera_folder_company_seed(p_profile_id uuid,p_input jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
	insert into public.founding_test_seeds(profile_id,input) values(p_profile_id,p_input)
		on conflict(profile_id) do update set calls = public.founding_test_seeds.calls+1;
	return extensions.gen_random_uuid();
end $$;
create or replace function public.qorpera_folder_company_ready(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select ready from public.founding_test_seeds where profile_id = p_profile_id),false)
$$;
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select true
$$;
select pg_temp.as_service();
select public.qorpera_set_provider_execution_policy('openai','native_subscription','codex-cli',
	'supported','enabled',32,null,'founding-lobby-fixture');

-- A founder connects their own ChatGPT login to the table's company (the Settings route).
create function pg_temp.connect_login(p_profile uuid,p_user uuid,p_n integer)
returns void language plpgsql as $$
declare v_identity jsonb; v_login jsonb; v_connection jsonb; v_hex text := lpad(to_hex(p_n),2,'0');
begin
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	v_identity := public.qorpera_upsert_member_compute_identity(p_profile,('40000000-0000-4000-8000-0000000007' || v_hex)::uuid,
		'My model account','qorpera-member-linux','v1','["agent_turn","company_substrate"]',
		'{"network":"provider-native-only","credentialExport":false}');
	v_login := public.qorpera_begin_native_provider_login(p_profile,('40000000-0000-4000-8000-0000000008' || v_hex)::uuid,
		('40000000-0000-4000-8000-0000000009' || v_hex)::uuid,(v_identity ->> 'compute_identity_id')::uuid,
		'openai','codex-cli',repeat(v_hex,32),900);
	reset role;
	perform pg_temp.as_service();
	set local role service_role;
	v_connection := public.qorpera_complete_native_provider_login((v_login ->> 'login_id')::uuid,repeat(v_hex,32),
		('40000000-0000-4000-8000-000000000a' || v_hex)::uuid,
		'object://native-capsules/40000000-0000-4000-8000-000000000a' || v_hex,repeat('d',64),'openai-' || v_hex,
		'personal-subscription','qorpera-native-provider-consent/v1',
		'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}');
	reset role;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
	from public.qorpera_provider_connection_versions v
	where connection_id = (v_connection ->> 'connection_id')::uuid and version = 1;
	perform pg_temp.as_user(p_user);
	set local role authenticated;
	perform public.qorpera_create_member_execution_sponsor(p_profile,('40000000-0000-4000-8000-000000000b' || v_hex)::uuid,
		(v_connection ->> 'connection_id')::uuid,2,true);
	reset role;
end $$;

-- Anna opens a table. Opening again with the same creation id gives the same table.
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.table',(public.qorpera_open_company_founding(
	'40000000-0000-4000-8000-000000000100','  Nordlys Kaffe ') ->> 'profileId'),true);
do $$
declare v_table jsonb := public.qorpera_open_company_founding('40000000-0000-4000-8000-000000000100','Nordlys Kaffe');
begin
	if v_table ->> 'profileId' <> current_setting('qorpera_test.table') or v_table ->> 'companyName' <> 'Nordlys Kaffe'
		or v_table ->> 'phase' <> 'open' or (v_table ->> 'revision')::bigint <> 1
		or jsonb_array_length(v_table -> 'seats') <> 1 or v_table -> 'seats' -> 0 ->> 'state' <> 'joined'
		or not (v_table -> 'seats' -> 0 ->> 'creator')::boolean or (v_table -> 'me' ->> 'canStart')::boolean then
		raise exception 'opening a table is not repeat-safe: %', v_table; end if;
	-- An open table is not a company yet: the hub lists it as a table, not as a company.
	if exists(select 1 from jsonb_array_elements(public.qorpera_list_hosted_profiles()) company
		where company ->> 'profile_id' = current_setting('qorpera_test.table')) then
		raise exception 'an open table is listed among the companies'; end if;
	if jsonb_array_length(public.qorpera_list_company_foundings()) <> 1 then
		raise exception 'the creator does not see their table: %', public.qorpera_list_company_foundings(); end if;
end $$;
-- Friends only: Dee's request is still pending.
select pg_temp.refused(format($$select public.qorpera_invite_company_founder(%L,'40000000-0000-4000-8000-000000000004')$$,
	current_setting('qorpera_test.table')),'42501');
-- No email invitations around the table, not even as an owner.
select pg_temp.refused(format($$select public.qorpera_invite_profile_member(%L,'eve@example.test','admin')$$,
	current_setting('qorpera_test.table')),'42501');
do $$
declare v_table jsonb := public.qorpera_invite_company_founder(current_setting('qorpera_test.table')::uuid,
	'40000000-0000-4000-8000-000000000002');
begin
	v_table := public.qorpera_invite_company_founder(current_setting('qorpera_test.table')::uuid,
		'40000000-0000-4000-8000-000000000003');
	-- Invitations do not change who sits at the table, so the revision stays.
	if (v_table ->> 'revision')::bigint <> 1 or jsonb_array_length(v_table -> 'seats') <> 3 then
		raise exception 'inviting changed the table: %', v_table; end if;
end $$;
reset role;

-- Dee sits nowhere: every call is refused and the list is empty.
select pg_temp.as_user('40000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_read_company_founding(%L)$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_respond_company_founding(%L,true)$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_update_company_founding(%L,1,'Mine','')$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_start_company_founding(%L,1,'40000000-0000-4000-8000-000000000299')$$,
	current_setting('qorpera_test.table')),'42501');
do $$ begin
	if jsonb_array_length(public.qorpera_list_company_foundings()) <> 0 then raise exception 'Dee sees a table'; end if;
end $$;
reset role;

-- Bo, invited, may look but not act until he joins.
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_update_company_founding(%L,1,'Mine','')$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_set_founder_role(%L,1,'x')$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_set_founder_ready(%L,1,true)$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_start_company_founding(%L,1,'40000000-0000-4000-8000-000000000299')$$,
	current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_invite_company_founder(%L,'40000000-0000-4000-8000-000000000004')$$,
	current_setting('qorpera_test.table')),'42501');
do $$
declare v_invites jsonb := public.qorpera_list_company_foundings(); v_table jsonb;
begin
	if jsonb_array_length(v_invites) <> 1 or v_invites -> 0 ->> 'myState' <> 'invited'
		or v_invites -> 0 ->> 'invitedByDisplayName' <> 'Anna' then
		raise exception 'Bo does not see his invitation: %', v_invites; end if;
	v_table := public.qorpera_read_company_founding(current_setting('qorpera_test.table')::uuid);
	if (v_table -> 'me' ->> 'canEdit')::boolean or (v_table -> 'me' ->> 'canStart')::boolean then
		raise exception 'an invitee can act on the table: %', v_table; end if;
	v_table := public.qorpera_respond_company_founding(current_setting('qorpera_test.table')::uuid,true);
	if (v_table ->> 'revision')::bigint <> 2 or v_table -> 'me' ->> 'state' <> 'joined' then
		raise exception 'joining did not change the table: %', v_table; end if;
	if (select role from public.qorpera_profile_members where profile_id = current_setting('qorpera_test.table')::uuid
		and user_id = '40000000-0000-4000-8000-000000000002') is distinct from 'contributor' then
		raise exception 'a joined founder is not a contributor until Start'; end if;
	-- A founder at the table may invite their own friends.
	v_table := public.qorpera_invite_company_founder(current_setting('qorpera_test.table')::uuid,
		'40000000-0000-4000-8000-000000000004');
	if jsonb_array_length(v_table -> 'seats') <> 4 then raise exception 'Bo could not invite Dee: %', v_table; end if;
end $$;
reset role;

-- The lobby is the only way in (a raw insert, or accepting an email invitation), and roles change only
-- at Start.
select pg_temp.refused(format($$insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	values(%L,'40000000-0000-4000-8000-000000000003','cy@example.test','Cy','contributor')$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$insert into public.qorpera_profile_invitations(profile_id,email,role,invited_by_user_id,expires_at)
	values(%L,'eve@example.test','admin','40000000-0000-4000-8000-000000000001',now() + interval '1 day')$$,
	current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$update public.qorpera_profile_members set role = 'admin' where profile_id = %L
	and user_id = '40000000-0000-4000-8000-000000000002'$$,current_setting('qorpera_test.table')),'42501');

-- Ready needs your own login and the current revision.
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_set_founder_ready(%L,2,true)$$,current_setting('qorpera_test.table')),'55000');
select pg_temp.refused(format($$select public.qorpera_set_founder_ready(%L,2,null)$$,current_setting('qorpera_test.table')),'22023');
do $$
declare v_table jsonb := public.qorpera_update_company_founding(current_setting('qorpera_test.table')::uuid,2,
	'Nordlys Kaffe','Specialty coffee. Webshop with subscriptions, and wholesale to cafés in Aarhus.');
begin
	v_table := public.qorpera_set_founder_role(current_setting('qorpera_test.table')::uuid,3,
		'Online shop, subscriptions and marketing.');
	if (v_table ->> 'revision')::bigint <> 4 or v_table ->> 'vision' not like 'Specialty coffee.%' then
		raise exception 'editing the table did not move its revision: %', v_table; end if;
	-- Saving the same text again changes nothing.
	v_table := public.qorpera_set_founder_role(current_setting('qorpera_test.table')::uuid,4,
		'Online shop, subscriptions and marketing.');
	if (v_table ->> 'revision')::bigint <> 4 then raise exception 'an unchanged role moved the revision'; end if;
end $$;
select pg_temp.refused(format($$select public.qorpera_set_founder_role(%L,4,%L)$$,
	current_setting('qorpera_test.table'),repeat('x',301)),'22023');
reset role;
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,'40000000-0000-4000-8000-000000000001',1);
select pg_temp.connect_login(current_setting('qorpera_test.table')::uuid,'40000000-0000-4000-8000-000000000002',2);
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_set_founder_ready(%L,3,true)$$,current_setting('qorpera_test.table')),'PT412');
select public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,4,true);
reset role;
-- Bo's role change clears Anna's Ready; Start waits for both.
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
declare v_table jsonb := public.qorpera_set_founder_role(current_setting('qorpera_test.table')::uuid,4,
	'Wholesale. The cafés, pricing and the roasting schedule.');
begin
	if (v_table ->> 'revision')::bigint <> 5 or (v_table -> 'seats' -> 0 ->> 'ready')::boolean
		or jsonb_array_length(v_table -> 'waitingFor') <> 2 or (v_table -> 'me' ->> 'canStart')::boolean then
		raise exception 'a changed role did not clear Ready: %', v_table; end if;
	v_table := public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,5,true);
end $$;
select pg_temp.refused(format($$select public.qorpera_start_company_founding(%L,5,'40000000-0000-4000-8000-000000000200')$$,
	current_setting('qorpera_test.table')),'55000');
reset role;
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_founder_ready(current_setting('qorpera_test.table')::uuid,5,true);
reset role;

-- A login that stops working after Ready holds Start back.
update public.qorpera_provider_connections set status = 'revoked'
	where profile_id = current_setting('qorpera_test.table')::uuid and owner_user_id = '40000000-0000-4000-8000-000000000002';
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_start_company_founding(%L,5,'40000000-0000-4000-8000-000000000200')$$,
	current_setting('qorpera_test.table')),'55000');
reset role;
update public.qorpera_provider_connections set status = 'active'
	where profile_id = current_setting('qorpera_test.table')::uuid and owner_user_id = '40000000-0000-4000-8000-000000000002';

-- Bo starts it. Every founder at the table owns the company; the vision and the roles move into
-- the seed input; Cy's and Dee's unanswered invitations are withdrawn.
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_start_company_founding(%L,4,'40000000-0000-4000-8000-000000000200')$$,
	current_setting('qorpera_test.table')),'PT412');
do $$
declare v_table jsonb := public.qorpera_start_company_founding(current_setting('qorpera_test.table')::uuid,5,
	'40000000-0000-4000-8000-000000000200');
begin
	if v_table ->> 'phase' <> 'started' or v_table -> 'start' ->> 'startedByUserId' <> '40000000-0000-4000-8000-000000000002'
		or (v_table -> 'start' ->> 'revision')::bigint <> 5 or (v_table -> 'start' ->> 'companyReady')::boolean
		or v_table -> 'start' ->> 'clientStartId' <> '40000000-0000-4000-8000-000000000200'
		or v_table ->> 'vision' <> '' or jsonb_array_length(v_table -> 'seats') <> 2 then
		raise exception 'Start did not start the table: %', v_table; end if;
	-- The started company is listed among the companies again.
	if not exists(select 1 from jsonb_array_elements(public.qorpera_list_hosted_profiles()) company
		where company ->> 'profile_id' = current_setting('qorpera_test.table')) then
		raise exception 'a started company is not listed'; end if;
end $$;
reset role;
do $$
declare v_seed jsonb := (select input from public.founding_test_seeds where profile_id = current_setting('qorpera_test.table')::uuid);
begin
	if v_seed ->> 'schema' <> 'qorpera.company-seed-input/v1' or v_seed ->> 'companyName' <> 'Nordlys Kaffe'
		or v_seed ->> 'vision' not like 'Specialty coffee.%' or v_seed ->> 'kickoffRequestedBy' <> '40000000-0000-4000-8000-000000000002'
		or jsonb_array_length(v_seed -> 'founders') <> 2
		or v_seed -> 'founders' -> 0 ->> 'userId' <> '40000000-0000-4000-8000-000000000001'
		or v_seed -> 'founders' -> 0 ->> 'role' <> 'Online shop, subscriptions and marketing.'
		or v_seed -> 'founders' -> 1 ->> 'role' not like 'Wholesale.%' then
		raise exception 'the seed input is wrong: %', v_seed; end if;
	if (select count(*) from public.qorpera_profile_members where profile_id = current_setting('qorpera_test.table')::uuid
		and role = 'owner') <> 2 then raise exception 'not every founder owns the company'; end if;
	-- No vision or role stays behind in the database.
	if exists(select 1 from public.qorpera_company_foundings where profile_id = current_setting('qorpera_test.table')::uuid
		and vision_draft is not null) or exists(select 1 from public.qorpera_company_founder_seats
		where profile_id = current_setting('qorpera_test.table')::uuid and (role_text <> '' or state <> 'joined')) then
		raise exception 'the vision or a role stayed in the lobby after Start'; end if;
end $$;
-- Anna's Start from another tab after Bo's sees the started table and seeds nothing again.
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
	if public.qorpera_start_company_founding(current_setting('qorpera_test.table')::uuid,5,
		'40000000-0000-4000-8000-000000000201') ->> 'phase' <> 'started' then
		raise exception 'a second Start did not show the started table'; end if;
	if jsonb_array_length(public.qorpera_list_company_foundings()) <> 1 then
		raise exception 'a starting company left the list early'; end if;
end $$;
select pg_temp.refused(format($$select public.qorpera_update_company_founding(%L,5,'Other','')$$,current_setting('qorpera_test.table')),'PT412');
select pg_temp.refused(format($$select public.qorpera_invite_company_founder(%L,'40000000-0000-4000-8000-000000000003')$$,
	current_setting('qorpera_test.table')),'42501');
reset role;
do $$
begin
	if (select calls from public.founding_test_seeds where profile_id = current_setting('qorpera_test.table')::uuid) <> 1 then
		raise exception 'a second Start seeded the company again'; end if;
end $$;
-- Once the company is ready it leaves the list; a founder who leaves afterwards reads nothing.
update public.founding_test_seeds set ready = true where profile_id = current_setting('qorpera_test.table')::uuid;
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
	if jsonb_array_length(public.qorpera_list_company_foundings()) <> 0 then raise exception 'a ready company stays listed'; end if;
	if not (public.qorpera_read_company_founding(current_setting('qorpera_test.table')::uuid) -> 'start' ->> 'companyReady')::boolean then
		raise exception 'a ready company does not say so'; end if;
end $$;
reset role;
delete from public.qorpera_profile_members where profile_id = current_setting('qorpera_test.table')::uuid
	and user_id = '40000000-0000-4000-8000-000000000002';
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.refused(format($$select public.qorpera_read_company_founding(%L)$$,current_setting('qorpera_test.table')),'42501');
select pg_temp.refused(format($$select public.qorpera_start_company_founding(%L,5,'40000000-0000-4000-8000-000000000202')$$,
	current_setting('qorpera_test.table')),'42501');
reset role;

-- A second table: leaving, removing and withdrawing seats.
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.table2',(public.qorpera_open_company_founding(
	'40000000-0000-4000-8000-000000000101','Second') ->> 'profileId'),true);
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000002');
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000003');
-- The one who opened the table cannot remove their own seat.
select pg_temp.refused(format($$select public.qorpera_remove_company_founder(%L,'40000000-0000-4000-8000-000000000001')$$,
	current_setting('qorpera_test.table2')),'42501');
reset role;
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table2')::uuid,true);
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000004');
-- Bo cannot withdraw Anna's invitation to Cy.
select pg_temp.refused(format($$select public.qorpera_remove_company_founder(%L,'40000000-0000-4000-8000-000000000003')$$,
	current_setting('qorpera_test.table2')),'42501');
do $$
declare v_left jsonb := public.qorpera_remove_company_founder(current_setting('qorpera_test.table2')::uuid,
	'40000000-0000-4000-8000-000000000002');
begin
	if v_left ->> 'state' <> 'left' or exists(select 1 from public.qorpera_profile_members
		where profile_id = current_setting('qorpera_test.table2')::uuid and user_id = '40000000-0000-4000-8000-000000000002') then
		raise exception 'Bo did not leave: %', v_left; end if;
end $$;
reset role;
do $$ begin
	-- Dee was Bo's friend and Bo's invitation; it left with him.
	if exists(select 1 from public.qorpera_company_founder_seats where profile_id = current_setting('qorpera_test.table2')::uuid
		and user_id = '40000000-0000-4000-8000-000000000004') then
		raise exception 'an invitation outlived the founder who sent it'; end if;
end $$;
select pg_temp.as_user('40000000-0000-4000-8000-000000000003');
set local role authenticated;
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table2')::uuid,false);
select pg_temp.refused(format($$select public.qorpera_read_company_founding(%L)$$,current_setting('qorpera_test.table2')),'42501');
reset role;
do $$
begin
	-- Opened (1), Bo joined (2), Bo left (3); invitations and a decline move nothing.
	if pg_temp.table_revision(current_setting('qorpera_test.table2')::uuid) <> 3
		or (select count(*) from public.qorpera_company_founder_seats where profile_id = current_setting('qorpera_test.table2')::uuid) <> 1 then
		raise exception 'leaving or declining left the table wrong'; end if;
end $$;
-- The one who opened the table removes a joined founder, and withdraws an invitation.
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000002');
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000003');
select public.qorpera_remove_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000003');
reset role;
select pg_temp.as_user('40000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table2')::uuid,true);
reset role;
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_table jsonb := public.qorpera_remove_company_founder(current_setting('qorpera_test.table2')::uuid,
	'40000000-0000-4000-8000-000000000002');
begin
	if (v_table ->> 'revision')::bigint <> 5 or jsonb_array_length(v_table -> 'seats') <> 1
		or exists(select 1 from public.qorpera_profile_members
			where profile_id = current_setting('qorpera_test.table2')::uuid and user_id <> '40000000-0000-4000-8000-000000000001') then
		raise exception 'removing a founder left the table wrong: %', v_table; end if;
end $$;
reset role;

-- A founder whose account is deleted leaves the table: the revision moves, so every Ready clears.
-- Someone they brought in who already joined keeps their seat; their pending invitations go.
insert into auth.users(id,email,email_confirmed_at) values
	('40000000-0000-4000-8000-000000000005','eli@example.test',statement_timestamp());
insert into public.qorpera_friendships(user_low,user_high,requested_by,status,responded_at) values
	('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000001','accepted',statement_timestamp());
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000005');
reset role;
select pg_temp.as_user('40000000-0000-4000-8000-000000000005');
set local role authenticated;
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table2')::uuid,true);
reset role;
insert into auth.users(id,email,email_confirmed_at) values
	('40000000-0000-4000-8000-000000000006','fay@example.test',statement_timestamp()),
	('40000000-0000-4000-8000-000000000007','gus@example.test',statement_timestamp());
insert into public.qorpera_friendships(user_low,user_high,requested_by,status,responded_at) values
	('40000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000005','accepted',statement_timestamp()),
	('40000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000005','accepted',statement_timestamp());
select pg_temp.as_user('40000000-0000-4000-8000-000000000005');
set local role authenticated;
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000006');
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000007');
reset role;
select pg_temp.as_user('40000000-0000-4000-8000-000000000006');
set local role authenticated;
select public.qorpera_respond_company_founding(current_setting('qorpera_test.table2')::uuid,true);
reset role;
select set_config('qorpera_test.before_delete',pg_temp.table_revision(current_setting('qorpera_test.table2')::uuid)::text,true);
delete from auth.users where id = '40000000-0000-4000-8000-000000000005';
do $$ begin
	if pg_temp.table_revision(current_setting('qorpera_test.table2')::uuid) <= current_setting('qorpera_test.before_delete')::bigint then
		raise exception 'a deleted founder left the table unchanged'; end if;
	if not exists(select 1 from public.qorpera_company_founder_seats where profile_id = current_setting('qorpera_test.table2')::uuid
		and user_id = '40000000-0000-4000-8000-000000000006' and state = 'joined') then
		raise exception 'a founder lost their seat with the one who invited them'; end if;
	if exists(select 1 from public.qorpera_company_founder_seats where profile_id = current_setting('qorpera_test.table2')::uuid
		and user_id = '40000000-0000-4000-8000-000000000007') then
		raise exception 'a deleted founder''s pending invitation stayed'; end if;
end $$;
-- Fay leaves again, so the seat count below is the table's own.
select pg_temp.as_user('40000000-0000-4000-8000-000000000006');
set local role authenticated;
select public.qorpera_remove_company_founder(current_setting('qorpera_test.table2')::uuid,'40000000-0000-4000-8000-000000000006');
reset role;

-- A table holds at most eight seats.
insert into auth.users(id,email,email_confirmed_at)
select ('40000000-0000-4000-8000-0000000001' || lpad(n::text,2,'0'))::uuid,'friend' || n || '@example.test',statement_timestamp()
from generate_series(1,8) n;
insert into public.qorpera_friendships(user_low,user_high,requested_by,status,responded_at)
select '40000000-0000-4000-8000-000000000001',('40000000-0000-4000-8000-0000000001' || lpad(n::text,2,'0'))::uuid,
	'40000000-0000-4000-8000-000000000001','accepted',statement_timestamp()
from generate_series(1,8) n;
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_invite_company_founder(current_setting('qorpera_test.table2')::uuid,
	('40000000-0000-4000-8000-0000000001' || lpad(n::text,2,'0'))::uuid) from generate_series(1,7) n;
select pg_temp.refused(format($$select public.qorpera_invite_company_founder(%L,'40000000-0000-4000-8000-000000000108')$$,
	current_setting('qorpera_test.table2')),'54000');
reset role;

-- Only a company made just now becomes a table: an existing company's creation id is refused.
insert into public.qorpera_profiles(id,name,created_by_user_id)
values('40000000-0000-4000-8000-000000000500','Existing','40000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('40000000-0000-4000-8000-000000000500','40000000-0000-4000-8000-000000000001','anna@example.test','Anna','owner'),
	('40000000-0000-4000-8000-000000000500','40000000-0000-4000-8000-000000000003','cy@example.test','Cy','contributor');
insert into public.qorpera_company_creation_requests(created_by_user_id,client_creation_id,profile_name,contract_version,profile_id)
values('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000102','Existing',2,'40000000-0000-4000-8000-000000000500');
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($$select public.qorpera_open_company_founding('40000000-0000-4000-8000-000000000102','Existing')$$,'23505');
-- Closing an open table deletes it with its seats.
select public.qorpera_delete_hosted_profile(current_setting('qorpera_test.table2')::uuid);
reset role;
do $$ begin
	if exists(select 1 from public.qorpera_company_foundings where profile_id = current_setting('qorpera_test.table2')::uuid)
		or exists(select 1 from public.qorpera_company_founder_seats where profile_id = current_setting('qorpera_test.table2')::uuid) then
		raise exception 'a closed table left rows behind'; end if;
	if exists(select 1 from public.qorpera_company_foundings where profile_id = '40000000-0000-4000-8000-000000000500') then
		raise exception 'an existing company became a table'; end if;
end $$;

-- With the switch off again, no table opens or starts.
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	select false
$$;
select pg_temp.as_user('40000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.refused($$select public.qorpera_open_company_founding('40000000-0000-4000-8000-000000000103','Later')$$,'0A000');
reset role;

rollback;
