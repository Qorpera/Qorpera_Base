-- After the disposable native/office setup, within the same transaction.
reset role;
select set_config('qorpera_test.catalog_staff_count',(select count(*)::text from public.qorpera_profile_staff where profile_id='30000000-0000-4000-8000-000000000010' and employment_status='active'),true);
create function pg_temp.office_catalog(p_after uuid default null) returns jsonb language sql as $$
 select public.qorpera_member_office_catalog((current_setting('qorpera_test.office_scope')::jsonb->>'environmentId')::uuid,p_after)
$$;
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_member_office_catalog(uuid,uuid)','EXECUTE')
 and not has_function_privilege('anon','public.qorpera_member_office_catalog(uuid,uuid)','EXECUTE'),'only member catalog');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(pg_temp.office_catalog()->'scope'=current_setting('qorpera_test.office_scope')::jsonb and pg_temp.office_catalog()->'canManage'='true'::jsonb,'owner observes registered scope and management role');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.office_catalog()->'staff')=current_setting('qorpera_test.catalog_staff_count')::integer and pg_temp.office_catalog()->'nextAfter'='null'::jsonb,'current active roster');
select pg_temp.wake_error($q$select public.qorpera_member_office_catalog('30000000-0000-4000-8000-000000000099')$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.wake_assert(pg_temp.office_catalog()->'canManage'='false'::jsonb,'ordinary member metadata confers no management');
reset role;
savepoint catalog_cases;
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.office_catalog()$q$,'42501');
reset role;
rollback to savepoint catalog_cases;
do $$ declare s public.qorpera_profile_staff%rowtype; i integer; columns text; begin
 select string_agg(format('%I',attname),',' order by attnum) into columns from pg_attribute
 where attrelid='public.qorpera_profile_staff'::regclass and attnum>0 and not attisdropped and attgenerated='';
 for i in 1..50 loop
  select * into s from public.qorpera_profile_staff where profile_id='30000000-0000-4000-8000-000000000010' and staff_agent_id='30000000-0000-4000-8000-000000000030';
  s.staff_agent_id:=extensions.gen_random_uuid();s.display_name:='<img src=x> '||i;
  s.source_path:=null;s.source_environment_id:=null;s.source_path_version:=null;s.source_snapshot_id:=null;
  s.source_file_sha256:=null;s.hire_overlay:=null;s.reasoning_policy:=null;s.startup_instructions:=null;
  execute format('insert into public.qorpera_profile_staff(%s) select %s from jsonb_populate_record(null::public.qorpera_profile_staff,$1)',columns,columns) using to_jsonb(s);
 end loop;
end $$;
set local role authenticated;
select pg_temp.wake_assert(jsonb_array_length(pg_temp.office_catalog()->'staff')=50 and pg_temp.office_catalog()->>'nextAfter' is not null,'bounded first roster page');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.office_catalog((pg_temp.office_catalog()->>'nextAfter')::uuid)->'staff')=current_setting('qorpera_test.catalog_staff_count')::integer
 and pg_temp.office_catalog((pg_temp.office_catalog()->>'nextAfter')::uuid)->'nextAfter'='null'::jsonb,'exact next roster page');
reset role;
rollback to savepoint catalog_cases;
