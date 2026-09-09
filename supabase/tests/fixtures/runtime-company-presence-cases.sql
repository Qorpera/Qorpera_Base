-- Uses the real wake fixture/native binding. Activity never enters SQL.
set local role service_role;
select set_config('qorpera_test.presence_key','MCowBQYDK2VwAyEA'||repeat('A',43)||'=',true);
select set_config('qorpera_test.presence',public.qorpera_native_presence_register(
	current_setting('qorpera_test.wake_binding')::jsonb,'39000000-0000-4000-8000-000000000001',current_setting('qorpera_test.presence_key'))::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.presence')::jsonb->>'runId'=
	current_setting('qorpera_test.wake_binding')::jsonb->>'runId','presence identity is the admitted run');
select pg_temp.wake_assert(current_setting('qorpera_test.presence')::jsonb->>'staffAgentId'='30000000-0000-4000-8000-000000000030','presence staff is cloud-derived');
select set_config('qorpera_test.presence_scope',public.qorpera_company_presence_scope('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.wake_binding')::jsonb,array['','projects/demo/note.md'])::text,true);
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.presence_scope')::jsonb#>'{paths,1,routes}')=4,'root and exact ancestor routes');
select pg_temp.wake_assert(current_setting('qorpera_test.presence_scope')::jsonb#>>'{paths,0,routes,0,token}'=
	current_setting('qorpera_test.presence_scope')::jsonb#>>'{paths,1,routes,0,token}','same root token across queries');
select pg_temp.wake_assert(public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000020',
	'39000000-0000-4000-8000-000000000001',array['projects/demo/note.md'])#>>'{identity,runId}'=
	current_setting('qorpera_test.wake_binding')::jsonb->>'runId','subject revalidates native authority');
select pg_temp.wake_error($q$select public.qorpera_native_presence_register(current_setting('qorpera_test.wake_binding')::jsonb,
	'39000000-0000-4000-8000-000000000001','MCowBQYDK2VwAyEA'||repeat('B',43)||'=')$q$,'23505');
select pg_temp.wake_error($q$select public.qorpera_native_presence_register(current_setting('qorpera_test.wake_binding')::jsonb,
	'39000000-0000-4000-8000-000000000002',current_setting('qorpera_test.presence_key'))$q$,'23505');
select pg_temp.wake_assert(public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000099',
	'39000000-0000-4000-8000-000000000001',array['']) is null,'cross-environment identity absent');
select pg_temp.wake_error($q$select public.qorpera_company_presence_scope('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.wake_binding')::jsonb,array['../private'])$q$,'22023');
select pg_temp.wake_error($q$select public.qorpera_company_presence_scope('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.wake_binding')::jsonb,array[]::text[])$q$,'22023');
reset role;

savepoint presence_policy;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_set_company_path_resource('30000000-0000-4000-8000-000000000020','secret','subtree','member_private','normal');
select pg_temp.wake_error($q$select public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000020',
	'39000000-0000-4000-8000-000000000001',array[''])$q$,'42501');
reset role;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_company_presence_scope('30000000-0000-4000-8000-000000000020',
	current_setting('qorpera_test.wake_binding')::jsonb,array['secret/note.md'])$q$,'42501');
select pg_temp.wake_assert(jsonb_array_length(public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000020',
	'39000000-0000-4000-8000-000000000001',array['secret/note.md'])#>'{paths,0,routes}')=1,'no private path tokens, only authorized root aggregate');
reset role; rollback to presence_policy;

savepoint presence_rotation;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
do $$
declare r public.qorpera_company_path_resources%rowtype; g uuid;
begin
	select * into strict r from public.qorpera_company_path_resources where environment_id='30000000-0000-4000-8000-000000000020' and path='';
	g:=public.qorpera_grant_company_path(r.id,r.version,'member','30000000-0000-4000-8000-000000000002',array['read']);
	perform set_config('qorpera_test.presence_grant',g::text,true);
	perform set_config('qorpera_test.presence_rotated',public.qorpera_company_presence_scope(r.environment_id,null,array[''])::text,true);
	perform pg_temp.wake_assert(current_setting('qorpera_test.presence_rotated')::jsonb#>>'{paths,0,routes,0,token}'<>
		current_setting('qorpera_test.presence_scope')::jsonb#>>'{paths,0,routes,0,token}','new grant rotates path routing identity');
	perform public.qorpera_revoke_company_path(r.id,r.version,g);
	perform pg_temp.wake_assert(public.qorpera_company_presence_scope(r.environment_id,null,array[''])#>>'{paths,0,routes,0,token}'<>
		current_setting('qorpera_test.presence_rotated')::jsonb#>>'{paths,0,routes,0,token}','revocation rotates routing identity');
end
$$;
rollback to presence_rotation;

savepoint presence_grant_expiry;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
do $$
declare r public.qorpera_company_path_resources%rowtype; before_expiry jsonb;
begin
	select * into strict r from public.qorpera_company_path_resources where environment_id='30000000-0000-4000-8000-000000000020' and path='';
	perform public.qorpera_grant_company_path(r.id,r.version,'member','30000000-0000-4000-8000-000000000002',array['read'],clock_timestamp()+interval '200 milliseconds');
	before_expiry:=public.qorpera_company_presence_scope(r.environment_id,null,array['']);
	perform pg_sleep(0.25);
	perform pg_temp.wake_assert(public.qorpera_company_presence_scope(r.environment_id,null,array[''])#>>'{paths,0,routes,0,token}'<>
		before_expiry#>>'{paths,0,routes,0,token}','grant expiry changes routing identity without a write or timer job');
end
$$;
rollback to presence_grant_expiry;

select pg_temp.path_claims('service_role'); set local role service_role;
select public.qorpera_native_presence_forget(current_setting('qorpera_test.wake_binding')::jsonb||jsonb_build_object('runId',extensions.gen_random_uuid()),
	'39000000-0000-4000-8000-000000000001');
select pg_temp.wake_assert(public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000020',
	'39000000-0000-4000-8000-000000000001',array['']) is not null,'other binding cannot clear presence');
reset role;

savepoint presence_expired;
update public.qorpera_native_presence_devices set expires_at=clock_timestamp()-interval '1 second';
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.wake_assert(public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000020',
	'39000000-0000-4000-8000-000000000001',array['']) is null,'expired identities absent');
reset role; rollback to presence_expired;

savepoint presence_revoked;
update public.qorpera_native_provider_connection_leases set status='released',released_at=clock_timestamp() where id=(current_setting('qorpera_test.wake_binding')::jsonb->>'leaseId')::uuid;
select pg_temp.path_claims('service_role'); set local role service_role;
select pg_temp.wake_assert(public.qorpera_native_presence_subject('30000000-0000-4000-8000-000000000020',
	'39000000-0000-4000-8000-000000000001',array['']) is null,'revoked native lease cannot retain presence');
select public.qorpera_native_presence_forget(current_setting('qorpera_test.wake_binding')::jsonb,'39000000-0000-4000-8000-000000000001');
reset role;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_native_presence_devices),'exact cleanup remains possible after revocation');
rollback to presence_revoked;

do $$
declare r text;
begin
	foreach r in array array['anon','authenticated','service_role'] loop
		perform pg_temp.wake_assert(not has_table_privilege(r,'public.qorpera_native_presence_devices','SELECT'),'private signing registry');
		perform pg_temp.wake_assert(not has_table_privilege(r,'public.qorpera_company_presence_secrets','SELECT'),'private HMAC secret');
	end loop;
	perform pg_temp.wake_assert(not exists(select 1 from information_schema.columns where table_schema='public'
		and table_name='qorpera_native_presence_devices' and column_name in ('paths','activity','events','sequence')),'activity is never stored in SQL');
end
$$;
