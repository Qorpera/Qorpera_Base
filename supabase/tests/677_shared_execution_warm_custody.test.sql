-- @fixture 396_runtime_coding_executor.test.sql until "-- 1. Dispatch is refused"
-- Public native runner admission and allocation; physical stop is supplied by
-- the root supervisor capability. No process/VM/model is started by this suite.
-- The repeatable-read race commits its fixture. As in 602, snapshot the
-- otherwise idle disposable database, then restore every pre-existing row.
select set_config('qorpera_test.warm_first_xid',xid(pg_current_xact_id())::text,false);
select dblink_connect('warm_rr','dbname=qorpera_test');
select set_config('qorpera_test.warm_rr_pid',pid::text,false) from dblink('warm_rr','select pg_backend_pid()') as backend(pid integer);
create function pg_temp.warm_alone() returns void language plpgsql as $$ begin
    if exists(select 1 from pg_stat_activity where datname=current_database() and backend_type='client backend'
        and pid not in (pg_backend_pid(),current_setting('qorpera_test.warm_rr_pid')::integer)) then
        raise exception 'Warm custody race requires a disposable database without other clients'; end if;
end $$;
select pg_temp.warm_alone();
create temp table warm_counts as select * from dblink('warm_rr',$q$
    select format('%I.%I',n.nspname,c.relname),
        (xpath('/row/n/text()',query_to_xml(format('select count(*) as n from %I.%I',n.nspname,c.relname),false,true,'')))[1]::text::bigint
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_(temp|toast)'
$q$) as counted(table_name text,row_count bigint);
create temp table warm_rows(table_name text,row_value jsonb);
do $$ declare t text; expected bigint; untouched bigint; first_xid xid:=current_setting('qorpera_test.warm_first_xid')::xid;
begin
    for t,expected in select table_name,row_count from warm_counts loop
        execute format('select count(*) from %s where age(xmin)>age(%L::xid)',t,first_xid) into untouched;
        if untouched<>expected then insert into warm_rows select t,kept.row_value
            from dblink('warm_rr',format('select to_jsonb(kept) from %s kept',t)) as kept(row_value jsonb); end if;
    end loop;
end $$;
select pg_temp.path_claims('service_role');
create function pg_temp.custody_identity(p_allocation uuid,p_secret text,p_host text default repeat('a',64))
returns jsonb language sql as $$
    select jsonb_build_object('allocationId',p_allocation,'providerAdapter','process','hostSha256',p_host,
        'workSha256',repeat('b',64),'closeSecretSha256',encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex'),
        'instanceSha256',encode(extensions.digest(convert_to(concat_ws(E'\n','qorpera.shared-host/v1','process',p_host,
            encode(extensions.digest(convert_to(p_secret,'UTF8'),'sha256'),'hex'),repeat('b',64)),'UTF8'),'sha256'),'hex'))
$$;
select set_config('qorpera_test.custody_identity',pg_temp.custody_identity(
    (select client_runner_id from public.qorpera_runners where id=(current_setting('qorpera_test.parent_binding')::jsonb->>'runnerId')::uuid),repeat('x',43))::text,true);
select pg_temp.wake_assert(public.qorpera_reserve_runtime_machine(
    (current_setting('qorpera_test.custody_identity')::jsonb->>'allocationId')::uuid,'process',
    current_setting('qorpera_test.custody_identity')::jsonb->>'instanceSha256',
    (current_setting('qorpera_test.parent_binding')::jsonb->>'runId')::uuid,
    (current_setting('qorpera_test.parent_binding')::jsonb->>'runnerId')::uuid)->>'state'='reserved','Native allocation admitted');

-- Even a native host's service credentials cannot choose a different closer
-- before the first registration: its immutable allocation commits the hash.
select pg_temp.wake_error($q$select public.qorpera_open_shared_host_custody(pg_temp.custody_identity(
    (current_setting('qorpera_test.custody_identity')::jsonb->>'allocationId')::uuid,repeat('z',43)))$q$,'42501','Shared host allocation differs');
select pg_temp.wake_error($q$select public.qorpera_open_shared_host_custody(
    jsonb_set(current_setting('qorpera_test.custody_identity')::jsonb,'{hostSha256}',to_jsonb(repeat('c',64))))$q$,
    '42501','Shared host allocation commitment differs');
select pg_temp.wake_error($q$select public.qorpera_open_shared_host_custody(
    jsonb_set(current_setting('qorpera_test.custody_identity')::jsonb,'{workSha256}',to_jsonb(1111111111111111111111111111111111111111111111111111111111111111::numeric)))$q$,
    '42501','Shared host custody identity differs');
select pg_temp.wake_error($q$select public.qorpera_open_shared_host_custody(
    current_setting('qorpera_test.custody_identity')::jsonb||'{"extra":true}')$q$,'42501','Shared host custody identity differs');
select set_config('qorpera_test.custody_revision',(select revision::text from public.qorpera_company_wake_admission_fences
    where profile_id='30000000-0000-4000-8000-000000000010'),true);
select set_config(name,current_setting(name),false) from unnest(array['qorpera_test.parent_binding','qorpera_test.custody_identity','qorpera_test.custody_revision']) name;
commit;
select dblink_exec('warm_rr','begin isolation level repeatable read');
select state from dblink('warm_rr',$q$select public.qorpera_company_paid_computer_mode('30000000-0000-4000-8000-000000000010')$q$) as snapshot(state boolean);
begin;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(public.qorpera_open_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb)->>'state'='open','Root opens durable custody');
select pg_temp.wake_assert(public.qorpera_open_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb)->>'state'='open','Registration replay is exact and idempotent');
reset role;
select pg_temp.wake_assert((select revision=current_setting('qorpera_test.custody_revision')::bigint+1 from public.qorpera_company_wake_admission_fences
    where profile_id='30000000-0000-4000-8000-000000000010'),'Open advances persistent snapshot fence once');
commit;
-- The stale operator snapshot cannot overlook newly committed host custody.
-- This is a real second connection, not a textual/revision-only assertion.
do $$ begin
    begin
        perform dblink_exec('warm_rr',$q$insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
            values('30000000-0000-4000-8000-000000000010','paid')$q$);
        raise exception 'Stale paid-mode transition unexpectedly succeeded';
    exception when serialization_failure then null;
    end;
    perform dblink_exec('warm_rr','rollback');
end $$;
begin;
select pg_temp.path_claims('service_role');
do $$ declare r text; begin
    foreach r in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
        perform pg_temp.wake_assert(not has_table_privilege(r,'public.qorpera_shared_host_custody','SELECT,INSERT,UPDATE,DELETE'),'No client may rewrite custody: '||r);
        perform pg_temp.wake_assert(not has_function_privilege(r,'public.qorpera_change_shared_host_custody(jsonb,text,boolean)','EXECUTE'),'No internal helper grant: '||r);
    end loop;
end $$;
select pg_temp.wake_error($q$select public.qorpera_close_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb,repeat('z',43))$q$,
    '42501','Shared host closure authority differs');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
select pg_temp.wake_error($q$select public.qorpera_close_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb,repeat('x',43))$q$,
    '42501','Shared host supervisor authority required');
select pg_temp.path_claims('service_role');

-- Release company capacity while the physical host stays fenced. Quiet every
-- other authority through its normal completion/stop path to isolate custody.
create temp table warm_fixture_jobs as select * from public.qorpera_runner_jobs
    where profile_id='30000000-0000-4000-8000-000000000010' and status in ('leased','running');
select public.qorpera_release_runtime_machine(id,provider_adapter,instance_sha256)
    from public.qorpera_runtime_machine_allocations
    where profile_id='30000000-0000-4000-8000-000000000010' and released_at is null
        and coding_machine_id is null and login_session_id is null and account_refresh_request_id is null;
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'final','warm-custody-parent-final');
select pg_temp.finish_job(run_id) from warm_fixture_jobs;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_machine_allocations
    where runner_id is not null and released_at is null),'Parked native host uses no company capacity');
select pg_temp.wake_error($q$insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values('30000000-0000-4000-8000-000000000010','paid')$q$,'55000','Stop and reconcile company computers before changing paid mode');
select pg_temp.wake_error($q$delete from public.qorpera_runtime_machine_allocations
    where id=(current_setting('qorpera_test.custody_identity')::jsonb->>'allocationId')::uuid$q$,
    '55000','Stop and reconcile shared hosts before deletion');

set local role service_role;
select pg_temp.wake_assert(public.qorpera_close_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb,repeat('x',43))->>'state'='closed',
    'Only root stop confirmation closes custody');
select pg_temp.wake_assert(public.qorpera_close_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb,repeat('x',43))->>'state'='closed',
    'Lost closure reply may be retried');
select pg_temp.wake_assert(public.qorpera_open_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb)->>'state'='closed',
    'A late registration cannot reopen a closed host');
reset role;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_shared_host_custody where closed_at is null),'No open shared custody remains');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runner_jobs where profile_id='30000000-0000-4000-8000-000000000010'
    and status in ('leased','running')),'No live jobs remain');
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_runtime_machine_allocations allocation
    left join public.qorpera_runtime_node_demands demand on demand.allocation_id=allocation.id
    where allocation.profile_id='30000000-0000-4000-8000-000000000010' and allocation.released_at is null
        and allocation.login_session_id is null and allocation.account_refresh_request_id is null
        and not coalesce((allocation.coding_machine_id is not null and demand.suspended_at is not null
            and demand.last_checked_at<clock_timestamp()-interval '5 seconds'),false)), 'No physical allocation remains admitted');
insert into public.qorpera_company_computer_billing_modes(profile_id,mode)
    values('30000000-0000-4000-8000-000000000010','paid');
select pg_temp.wake_assert(public.qorpera_company_paid_computer_mode('30000000-0000-4000-8000-000000000010'),'Confirmed physical closure permits the paid switch');

-- A close can arrive before an uncertain open. Simulate the missing row inside
-- a rolled-back subtransaction, without changing the allocation commitment.
savepoint absent_registration;
delete from public.qorpera_shared_host_custody;
select pg_temp.wake_assert(public.qorpera_close_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb,repeat('x',43))->>'state'='closed',
    'Root installs a tombstone when registration was uncertain');
select pg_temp.wake_assert(public.qorpera_open_shared_host_custody(current_setting('qorpera_test.custody_identity')::jsonb)->>'state'='closed',
    'Delayed open cannot defeat a close-before-open tombstone');
rollback to absent_registration;
delete from public.qorpera_runtime_machine_allocations where id=(current_setting('qorpera_test.custody_identity')::jsonb->>'allocationId')::uuid;
select pg_temp.wake_assert(not exists(select 1 from public.qorpera_shared_host_custody),'Trusted allocation cleanup can collect closed custody');
rollback;

-- Restore only this fixture's writes; no unrelated session may be present.
begin;
select pg_temp.warm_alone();
select dblink_disconnect('warm_rr');
set local session_replication_role=replica;
do $$ declare t text; columns text; expected bigint; actual bigint; first_xid xid:=current_setting('qorpera_test.warm_first_xid')::xid;
begin
    for t in select table_name from warm_counts loop
        execute format('delete from %s where age(xmin)<=age(%L::xid)',t,first_xid);
    end loop;
    for t in select distinct table_name from warm_rows loop
        select string_agg(quote_ident(attname),',' order by attnum) into columns from pg_attribute
            where attrelid=t::regclass and attnum>0 and not attisdropped and attgenerated='';
        execute format('insert into %1$s (%2$s) overriding system value select %2$s from (select (jsonb_populate_record(null::%1$s,kept.row_value)).*
            from warm_rows kept where kept.table_name=%3$L and not exists(select 1 from %1$s present where to_jsonb(present)=kept.row_value)) restored',t,columns,t);
        execute format('select count(*) from warm_rows kept where kept.table_name=%2$L and not exists(select 1 from %1$s present where to_jsonb(present)=kept.row_value)',t,t) into actual;
        if actual<>0 then raise exception 'Warm custody cleanup did not restore existing rows: %',t; end if;
    end loop;
    for t,expected in select table_name,row_count from warm_counts loop
        execute format('select count(*) from %s',t) into actual;
        if actual<>expected then raise exception 'Warm custody cleanup count differs: %',t; end if;
    end loop;
end $$;
commit;
