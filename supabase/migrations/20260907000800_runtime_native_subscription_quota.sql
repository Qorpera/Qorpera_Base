-- Native subscriptions have provider-enforced usage walls. Their monetary
-- policy fields are schema sentinels, not a spend allowance. Keep the shared
-- connection concurrency bound and all native lease/authority checks.
do $$
declare v_definition text:=pg_get_functiondef('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure);
 v_old text:='v_active >= v_max_concurrent or v_reserved_total + v_actual_total + v_reservation > v_monthly';
 v_new text:='v_active >= v_max_concurrent or (v_connection_version.authentication_mode <> ''native_subscription''
  and v_reserved_total + v_actual_total + v_reservation > v_monthly)';
begin
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Sponsor monetary quota guard differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;
