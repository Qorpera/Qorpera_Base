-- Synthetic credential metadata only: no broker credential, ciphertext,
-- external provider or paid model is used by these membership regressions.
begin;

create function pg_temp.member_claims(p_user uuid)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user)::text,true)::text::void
$$;
create function pg_temp.member_assert(p_value boolean,p_message text)
returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end
$$;
create function pg_temp.member_denied(p_statement text)
returns void language plpgsql as $$
begin
	begin execute p_statement; exception when insufficient_privilege then return; end;
	raise exception 'Membership operation accepted unauthorized input: %',p_statement;
end
$$;
create function pg_temp.member_grant(p_secret uuid default '30700000-0000-4000-8000-000000000050')
returns jsonb language sql as $$
	select public.qorpera_grant_cloud_secret_operation('30700000-0000-4000-8000-000000000010',
		'30700000-0000-4000-8000-000000000020',p_secret,'30700000-0000-4000-8000-000000000030',
		'linear','issue_create',1)
$$;

insert into auth.users(id,email) values
	('30700000-0000-4000-8000-000000000001','authority-owner@example.test'),
	('30700000-0000-4000-8000-000000000002','authority-member@example.test'),
	('30700000-0000-4000-8000-000000000003','authority-outsider@example.test'),
	('30700000-0000-4000-8000-000000000004','authority-viewer@example.test'),
	('30700000-0000-4000-8000-000000000005','authority-admin@example.test'),
	('30700000-0000-4000-8000-000000000006','authority-other-company@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('30700000-0000-4000-8000-000000000010','Membership authority fixture','30700000-0000-4000-8000-000000000001'),
	('30700000-0000-4000-8000-000000000011','Other company fixture','30700000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000001','authority-owner@example.test','Owner','owner'),
	('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000002','authority-member@example.test','Member','contributor'),
	('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000004','authority-viewer@example.test','Viewer','viewer'),
	('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000005','authority-admin@example.test','Admin','admin'),
	('30700000-0000-4000-8000-000000000011','30700000-0000-4000-8000-000000000006','authority-other-company@example.test','Other owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('30700000-0000-4000-8000-000000000020','30700000-0000-4000-8000-000000000010','Environment',1,'30700000-0000-4000-8000-000000000001'),
	('30700000-0000-4000-8000-000000000021','30700000-0000-4000-8000-000000000011','Other environment',1,'30700000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000030','Agent','Operations','Use typed company connectors.',
	'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'30700000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values ('30700000-0000-4000-8000-000000000040','30700000-0000-4000-8000-000000000010',
	'https://secrets.qorpera.test','fixture-key',repeat('a',64));
insert into public.qorpera_cloud_connector_operations(connector_id,operation_id,version,tool_name,description,
	input_schema,destination_origin,credential_name,adapter_sha256)
values ('linear','issue_create',1,'linear_issue_create','Create one issue.',
	'{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}',
	'https://api.linear.app','token',repeat('b',64));
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id) values
	('30700000-0000-4000-8000-000000000050','30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000020',
		'30700000-0000-4000-8000-000000000040','company',null,'linear','company','Company connection',1,'30700000-0000-4000-8000-000000000001'),
	('30700000-0000-4000-8000-000000000052','30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000020',
		'30700000-0000-4000-8000-000000000040','member','30700000-0000-4000-8000-000000000002',
		'linear','personal','Member connection',1,'30700000-0000-4000-8000-000000000002');

-- Current member authority: the driver also reuses the setup above to test
-- quarantining a pre-correction outsider-issued grant during an upgrade.
select pg_temp.member_claims('30700000-0000-4000-8000-000000000005');
set local role authenticated;
select set_config('qorpera_test.member_grant',pg_temp.member_grant()::text,true);
reset role;
do $$ declare v_user uuid; begin
	foreach v_user in array array[null::uuid,'30700000-0000-4000-8000-000000000003'::uuid,
		'30700000-0000-4000-8000-000000000006'::uuid,'30700000-0000-4000-8000-000000000002'::uuid,
		'30700000-0000-4000-8000-000000000004'::uuid] loop
		perform pg_temp.member_claims(v_user);
		set local role authenticated;
		perform pg_temp.member_denied('select pg_temp.member_grant()');
		perform pg_temp.member_denied(format('select public.qorpera_revoke_cloud_secret_grant(%L,%L)',
			'30700000-0000-4000-8000-000000000010',current_setting('qorpera_test.member_grant')::jsonb ->> 'grantId'));
		perform pg_temp.member_denied($q$select public.qorpera_revoke_cloud_secret(
			'30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000050')$q$);
		reset role;
	end loop;
	perform pg_temp.member_assert((select count(*) = 1 and bool_and(status = 'active')
		from public.qorpera_cloud_secret_operation_grants),'Denied requests changed a grant');
	perform pg_temp.member_assert((select count(*) = 1 from public.qorpera_cloud_secret_audit_events),
		'Denied requests created audit effects');
end $$;

select pg_temp.member_claims('30700000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_cloud_secret_grant('30700000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.member_grant')::jsonb ->> 'grantId')::uuid);
select public.qorpera_revoke_cloud_secret_grant('30700000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.member_grant')::jsonb ->> 'grantId')::uuid);
reset role;
select pg_temp.member_assert((select count(*) = 1 from public.qorpera_cloud_secret_audit_events where event_type = 'grant_revoked'),
	'Revocation retry duplicated its audit');
do $$ begin
	perform pg_temp.member_claims('30700000-0000-4000-8000-000000000005');
	set local role authenticated;
	perform pg_temp.member_assert(public.qorpera_revoke_cloud_secret(
		'30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000050') ->> 'status' = 'revoked',
		'Admin could not revoke a company credential');
	perform public.qorpera_revoke_cloud_secret('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000050');
	reset role;
	perform pg_temp.member_assert((select count(*) = 1 from public.qorpera_cloud_secret_audit_events where event_type = 'secret_revoked'),
		'Credential revocation retry duplicated its audit');
	raise exception using errcode = 'QT307';
exception when sqlstate 'QT307' then null;
end $$;

-- A member credential remains personal even to another company owner/admin.
select pg_temp.member_claims('30700000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.personal_grant',pg_temp.member_grant('30700000-0000-4000-8000-000000000052')::text,true);
select set_config('qorpera_test.personal_capture',public.qorpera_begin_cloud_secret_capture(
	'30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000020','member',
	'30700000-0000-4000-8000-000000000002','linear','pending_personal','Pending personal capture') ->> 'ticketId',true);
reset role;
do $$ declare v_user uuid; begin
	foreach v_user in array array['30700000-0000-4000-8000-000000000001'::uuid,'30700000-0000-4000-8000-000000000005'::uuid] loop
		perform pg_temp.member_claims(v_user);
		set local role authenticated;
		perform pg_temp.member_denied($q$select pg_temp.member_grant('30700000-0000-4000-8000-000000000052')$q$);
		perform pg_temp.member_denied(format('select public.qorpera_revoke_cloud_secret_grant(%L,%L)',
			'30700000-0000-4000-8000-000000000010',current_setting('qorpera_test.personal_grant')::jsonb ->> 'grantId'));
		perform pg_temp.member_denied($q$select public.qorpera_revoke_cloud_secret(
			'30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000052')$q$);
		reset role;
	end loop;
end $$;
update public.qorpera_profile_members set role = 'viewer' where user_id = '30700000-0000-4000-8000-000000000002';
select pg_temp.member_assert((select status = 'revoked' from public.qorpera_cloud_secret_operation_grants
	where id = (current_setting('qorpera_test.personal_grant')::jsonb ->> 'grantId')::uuid),
	'Viewer downgrade retained a personal operation grant');
select pg_temp.member_claims('30700000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.member_denied($q$select pg_temp.member_grant('30700000-0000-4000-8000-000000000052')$q$);
select public.qorpera_revoke_cloud_secret_grant('30700000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.personal_grant')::jsonb ->> 'grantId')::uuid);
select public.qorpera_revoke_cloud_secret('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000052');
reset role;
update public.qorpera_profile_members set role = 'contributor' where user_id = '30700000-0000-4000-8000-000000000002';
select pg_temp.member_assert((select status = 'revoked' from public.qorpera_cloud_secret_operation_grants
	where id = (current_setting('qorpera_test.personal_grant')::jsonb ->> 'grantId')::uuid),
	'Promotion revived a personal operation grant');
select pg_temp.member_assert((select status = 'cancelled' from public.qorpera_cloud_secret_capture_tickets
	where id = current_setting('qorpera_test.personal_capture')::uuid),
	'Promotion revived a pending personal capture authority');

-- Company grants cannot silently revive after their issuer loses authority.
select pg_temp.member_claims('30700000-0000-4000-8000-000000000005');
set local role authenticated;
select set_config('qorpera_test.downgraded_grant',pg_temp.member_grant()::text,true);
select set_config('qorpera_test.company_capture',public.qorpera_begin_cloud_secret_capture(
	'30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000020','company',null,
	'linear','pending_company','Pending company capture') ->> 'ticketId',true);
reset role;
update public.qorpera_profile_members set role = 'contributor' where user_id = '30700000-0000-4000-8000-000000000005';
update public.qorpera_profile_members set role = 'admin' where user_id = '30700000-0000-4000-8000-000000000005';
select pg_temp.member_assert((select status = 'revoked' from public.qorpera_cloud_secret_operation_grants
	where id = (current_setting('qorpera_test.downgraded_grant')::jsonb ->> 'grantId')::uuid),
	'Promotion revived a company operation grant');
select pg_temp.member_assert((select status = 'cancelled' from public.qorpera_cloud_secret_capture_tickets
	where id = current_setting('qorpera_test.company_capture')::uuid),
	'Promotion revived a pending company capture authority');
-- Re-promotion must not let the broker resume the old ticket either.
select set_config('qorpera_test.capture_sha',(select capture_capability_sha256
	from public.qorpera_cloud_secret_capture_tickets where id = current_setting('qorpera_test.company_capture')::uuid),true);
set local session authorization qorpera_secret_broker;
select pg_temp.member_denied(format($q$select public.qorpera_describe_cloud_secret_capture(
	'30700000-0000-4000-8000-000000000040',repeat('a',64),%L,%L)$q$,
	current_setting('qorpera_test.company_capture'),current_setting('qorpera_test.capture_sha')));
reset session authorization;
set local role authenticated;
select set_config('qorpera_test.removed_grant',pg_temp.member_grant()::text,true);
select set_config('qorpera_test.removed_capture',public.qorpera_begin_cloud_secret_capture(
	'30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000020','company',null,
	'linear','removed_company','Removed issuer capture') ->> 'ticketId',true);
reset role;
delete from public.qorpera_profile_members where user_id = '30700000-0000-4000-8000-000000000005';
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('30700000-0000-4000-8000-000000000010','30700000-0000-4000-8000-000000000005','authority-admin@example.test','Admin','admin');
select pg_temp.member_assert((select status = 'revoked' from public.qorpera_cloud_secret_operation_grants
	where id = (current_setting('qorpera_test.removed_grant')::jsonb ->> 'grantId')::uuid),
	'Rejoining revived a company operation grant');
select pg_temp.member_assert((select status = 'cancelled' from public.qorpera_cloud_secret_capture_tickets
	where id = current_setting('qorpera_test.removed_capture')::uuid),
	'Rejoining revived a pending capture ticket');
select pg_temp.member_assert((select status = 'active' from public.qorpera_cloud_secrets
	where id = '30700000-0000-4000-8000-000000000050'),'Removing an issuer revoked company custody');
select pg_temp.member_assert(not exists(select 1 from public.qorpera_execution_runs
	where profile_id = '30700000-0000-4000-8000-000000000010'),'Membership tests launched agent work');

set constraints all immediate;
rollback;
