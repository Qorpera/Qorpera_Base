insert into auth.users (id, email, email_confirmed_at)
values (
	'80000000-0000-4000-8000-00000000000c',
	'internal-owner@example.test',
	statement_timestamp()
)
on conflict (id) do nothing;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000c","email":"internal-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select set_config(
	'qorpera_test.entitlement_profile',
	public.qorpera_create_hosted_profile('Internal entitlement QA', 'main', 1) ->> 'profile_id',
	false
);

do $$
declare
	v_entitlement jsonb;
	v_denied boolean := false;
begin
	v_entitlement := public.qorpera_get_account_entitlement();
	if v_entitlement ->> 'plan_key' <> 'freemium'
		or v_entitlement ->> 'billing_mode' <> 'free'
		or v_entitlement ->> 'feature_set' <> 'standard'
		or v_entitlement ->> 'storage_allocation' <> 'metered'
		or (v_entitlement ->> 'storage_allocation_bytes')::bigint <> 53687091200 then
		raise exception 'default freemium NAS entitlement is invalid: %', v_entitlement;
	end if;
	begin
		perform public.qorpera_set_account_entitlement(
			'80000000-0000-4000-8000-00000000000c',
			'internal',
			'complimentary',
			'all',
			'unlimited',
			'test',
			'authenticated callers must be denied'
		);
	exception when insufficient_privilege then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'account member changed a server-controlled entitlement';
	end if;
end
$$;
reset role;

update public.qorpera_company_files
set storage_used_bytes = storage_limit_bytes
where profile_id = current_setting('qorpera_test.entitlement_profile')::uuid;

set role authenticated;
do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_authorize_profile_object_upload(
			current_setting('qorpera_test.entitlement_profile')::uuid,
			repeat('d', 64),
			1
		);
	exception when check_violation then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'freemium NAS allocation admitted an object beyond 50 GiB';
	end if;
end
$$;
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
select public.qorpera_set_account_entitlement(
	'80000000-0000-4000-8000-00000000000c',
	'internal',
	'complimentary',
	'all',
	'unlimited',
	'test-suite',
	'Company-owned account receives full complimentary access'
);
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000c","email":"internal-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_authority jsonb;
begin
	v_authority := public.qorpera_authorize_profile_object_upload(
		current_setting('qorpera_test.entitlement_profile')::uuid,
		repeat('d', 64),
		1
	);
	if (v_authority ->> 'allowed')::boolean is not true then
		raise exception 'unlimited internal NAS allocation was still quota-bound: %', v_authority;
	end if;
end
$$;
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',
	false
);
set role service_role;
select public.qorpera_confirm_profile_object_upload(
	current_setting('qorpera_test.entitlement_profile')::uuid,
	repeat('d', 64),
	1,
	'nas-object-gateway'
);

do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_set_account_entitlement(
			'80000000-0000-4000-8000-00000000000c',
			'freemium',
			'free',
			'standard',
			'metered',
			'test-suite',
			'downgrade must not strand over-allocation data'
		);
	exception when check_violation then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'over-allocation internal account was downgraded to freemium';
	end if;
end
$$;
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000c","email":"internal-owner@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_entitlement jsonb;
	v_file jsonb;
begin
	v_entitlement := public.qorpera_get_account_entitlement();
	if v_entitlement ->> 'plan_key' <> 'internal'
		or v_entitlement ->> 'billing_mode' <> 'complimentary'
		or v_entitlement ->> 'feature_set' <> 'all'
		or v_entitlement ->> 'storage_allocation' <> 'unlimited'
		or v_entitlement -> 'storage_allocation_bytes' <> 'null'::jsonb
		or v_entitlement ->> 'source' <> 'explicit' then
		raise exception 'internal account entitlement is invalid: %', v_entitlement;
	end if;
	v_file := public.qorpera_get_company_file((
		select environment.id
		from public.qorpera_company_environments as environment
		where environment.profile_id = current_setting('qorpera_test.entitlement_profile')::uuid
		limit 1
	));
	if v_file -> 'entitlement' ->> 'plan_key' <> 'internal'
		or v_file -> 'entitlement' ->> 'storage_allocation' <> 'unlimited'
		or v_file -> 'object_backends' <> '["nas-object-gateway"]'::jsonb then
		raise exception 'Company File did not project NAS backend and owner entitlement: %', v_file;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$
begin
	if has_table_privilege('authenticated', 'public.qorpera_account_entitlements', 'SELECT')
		or has_table_privilege('service_role', 'public.qorpera_account_entitlements', 'UPDATE')
		or has_function_privilege(
			'authenticated',
			'public.qorpera_set_account_entitlement(uuid,text,text,text,text,text,text)',
			'EXECUTE'
		) then
		raise exception 'account entitlement mutation authority is exposed';
	end if;
	if (
		select count(*)
		from public.qorpera_account_entitlement_changes as change
		where change.user_id = '80000000-0000-4000-8000-00000000000c'
	) <> 1 then
		raise exception 'account entitlement change was not audited exactly once';
	end if;
end
$$;
