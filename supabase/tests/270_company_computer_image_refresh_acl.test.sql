begin;

do $$
declare
	v_function regprocedure := 'public.qorpera_prepare_company_computer_image_refresh(uuid,text,text)'::regprocedure;
begin
	if has_function_privilege('anon', v_function, 'EXECUTE')
		or has_function_privilege('authenticated', v_function, 'EXECUTE')
		or not has_function_privilege('service_role', v_function, 'EXECUTE') then
		raise exception 'company computer image refresh must be executable only by the service role';
	end if;
	if exists (
		select 1
		from pg_proc as p
		cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
		where p.oid = v_function and acl.grantee = 0
			and acl.privilege_type = 'EXECUTE'
	) then
		raise exception 'PUBLIC can execute company computer image refresh';
	end if;
end
$$;

-- Even a service-role claim cannot bypass the SQL ACL under a client role.
-- A null registry identifier ensures that an unexpectedly admitted call
-- cannot mutate a real computer; it raises 55000 rather than the expected
-- SQL permission denial.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role anon;
do $$
begin
	begin
		perform public.qorpera_prepare_company_computer_image_refresh(null, repeat('a', 64), repeat('b', 64));
		raise exception 'anonymous caller entered the image refresh RPC';
	exception when insufficient_privilege then null;
	end;
end
$$;
reset role;

set local role authenticated;
do $$
begin
	begin
		perform public.qorpera_prepare_company_computer_image_refresh(null, repeat('a', 64), repeat('b', 64));
		raise exception 'authenticated caller entered the image refresh RPC';
	exception when insufficient_privilege then null;
	end;
end
$$;
reset role;

set local role service_role;
do $$
begin
	begin
		perform public.qorpera_prepare_company_computer_image_refresh(null, repeat('a', 64), repeat('b', 64));
		raise exception 'image refresh admitted a missing computer';
	exception when sqlstate '55000' then null;
	end;
end
$$;

-- Preserve the independent JWT-role guard even for a SQL caller that has
-- EXECUTE. No table or computer state is changed by this regression.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
do $$
begin
	begin
		perform public.qorpera_prepare_company_computer_image_refresh(null, repeat('a', 64), repeat('b', 64));
		raise exception 'image refresh accepted a non-service JWT role';
	exception when insufficient_privilege then null;
	end;
end
$$;
reset role;

rollback;
