-- Reconcile the five deployed legacy grant differences found by review two.
-- Keep the in-function authorization checks and grant only intended callers.
revoke all on function
 public.qorpera_configure_staff_execution_authority(uuid,uuid,uuid,bigint,uuid),
 public.qorpera_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb),
 public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean),
 public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint),
 public.qorpera_upsert_cloud_routine(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid,bigint,uuid,text,text,boolean,text,text,uuid[])
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function
 public.qorpera_configure_staff_execution_authority(uuid,uuid,uuid,bigint,uuid),
 public.qorpera_set_company_execution_ceiling(uuid,bigint,bigint,bigint,bigint),
 public.qorpera_upsert_cloud_routine(uuid,uuid,uuid,uuid,text,text,jsonb,text,uuid,bigint,uuid,text,text,boolean,text,text,uuid[])
 to authenticated;
grant execute on function
 public.qorpera_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb),
 public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)
 to service_role;
