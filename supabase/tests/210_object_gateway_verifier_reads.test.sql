-- Trusted verifier reads resolve immutable catalog authority with the service
-- role, while member and unrelated-account boundaries remain unchanged.

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000a","email":"sep-owner-a@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
select set_config(
	'qorpera_test.verifier_profile',
	public.qorpera_create_hosted_profile('Verifier reads', 'main', 1) ->> 'profile_id',
	false
);
reset role;

select set_config('request.jwt.claims', '{}', false);
set role authenticated;
do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_authorize_profile_object_download(
			current_setting('qorpera_test.verifier_profile')::uuid,
			repeat('a', 64)
		);
	exception when data_exception then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'authenticated role without JWT claims can use verifier download authority';
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
	current_setting('qorpera_test.verifier_profile')::uuid,
	repeat('a', 64),
	17,
	'nas-object-gateway'
);

do $$
declare
	v_authority jsonb;
begin
	v_authority := public.qorpera_authorize_profile_object_download(
		current_setting('qorpera_test.verifier_profile')::uuid,
		repeat('a', 64)
	);
	if v_authority ->> 'backend' <> 'nas-object-gateway'
		or (v_authority ->> 'bytes')::bigint <> 17 then
		raise exception 'service verifier download authority is invalid: %', v_authority;
	end if;
end
$$;
reset role;

select set_config(
	'request.jwt.claims',
	'{"sub":"80000000-0000-4000-8000-00000000000b","email":"sep-owner-b@example.test","role":"authenticated","user_metadata":{}}',
	false
);
set role authenticated;
do $$
declare
	v_denied boolean := false;
begin
	begin
		perform public.qorpera_authorize_profile_object_download(
			current_setting('qorpera_test.verifier_profile')::uuid,
			repeat('a', 64)
		);
	exception when insufficient_privilege then
		v_denied := true;
	end;
	if not v_denied then
		raise exception 'unrelated member can use verifier download authority';
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);
