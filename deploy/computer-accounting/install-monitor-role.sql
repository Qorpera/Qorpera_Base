-- Explicit operator installation, never an application migration or API RPC.
-- Grant membership only to the dedicated monitoring login after reviewing its
-- pg_hba/TLS policy. NOLOGIN prevents accidental direct password use of this role.
begin;
do $$ begin
 if exists(select 1 from pg_roles where rolname='qorpera_accounting_monitor') then
  raise exception 'Monitor role already exists; review existing grants before installation';
 end if;
 create role qorpera_accounting_monitor nologin nosuperuser nocreatedb nocreaterole noinherit noreplication bypassrls;
end $$;
grant usage on schema public to qorpera_accounting_monitor;
grant select(id,state,generation,physical_id,guest_boot_id,last_sample) on public.qorpera_coding_computer_permits to qorpera_accounting_monitor;
grant select(permit_id,generation,reservation_id,deadline) on public.qorpera_coding_computer_windows to qorpera_accounting_monitor;
grant select(id,allocation_id,epoch,deadline,settled_at,reserved_us) on public.qorpera_computer_allowance_reservations to qorpera_accounting_monitor;
grant select(permit_id) on public.qorpera_computer_prestart_attempts to qorpera_accounting_monitor;
grant select(allocation_id,epoch,resource_shape) on public.qorpera_computer_usage_streams to qorpera_accounting_monitor;
grant select(reservation_id,bucket_id,amount_us) on public.qorpera_computer_allowance_holds to qorpera_accounting_monitor;
grant select(bucket_id,debited_us) on public.qorpera_computer_allowance_debits to qorpera_accounting_monitor;
grant select(id,issued_us,reserved_us,debited_us,funded_us) on public.qorpera_computer_allowance_buckets to qorpera_accounting_monitor;
grant select(id,result,recovered_terminal,created_at,lease_until) on public.qorpera_computer_billing_commands to qorpera_accounting_monitor;
commit;
