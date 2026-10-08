-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Account entitlements for the owner of 924's folder-v2 company (ported from snapshot-v1 in the legacy sweep): an
-- account with no entitlement set reads the default freemium plan with the 50 GiB metered allocation, and no API role
-- reads or changes the entitlement table directly. (Only the service sets an entitlement, audited: test 920.)
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare
	v_entitlement jsonb;
begin
	v_entitlement := public.qorpera_get_account_entitlement();
	if v_entitlement ->> 'plan_key' <> 'freemium'
		or v_entitlement ->> 'billing_mode' <> 'free'
		or v_entitlement ->> 'feature_set' <> 'standard'
		or v_entitlement ->> 'storage_allocation' <> 'metered'
		or (v_entitlement ->> 'storage_allocation_bytes')::bigint <> 53687091200 then
		raise exception 'default freemium NAS entitlement is invalid: %', v_entitlement;
	end if;
end
$$;
reset role;
select pg_temp.base_claims('service_role');

do $$
begin
	if has_table_privilege('authenticated', 'public.qorpera_account_entitlements', 'SELECT')
		or has_table_privilege('service_role', 'public.qorpera_account_entitlements', 'UPDATE') then
		raise exception 'account entitlement table authority is exposed';
	end if;
end
$$;
rollback;
