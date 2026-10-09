-- The API roles cannot touch the office, node and presence tables (ported in the legacy sweep from the non-CI
-- scripts on fixture 300, which D3 deletes). Supabase's default privileges grant every new public table to anon,
-- authenticated and service_role; these tables are read and written only through their functions.
-- Which of those functions the API roles may execute is pinned elsewhere: anon and authenticated by
-- 001_api_function_allowlist, the secret broker by 306_governed_company_computer_privileges.
begin;

-- 1. anon, authenticated and the secret broker hold no row privilege on any office, runtime node, login gateway,
-- presence, runtime machine, fleet, compute request, viewer or browser table.
do $$
declare v_pairs integer; v_open text[];
begin
	select count(*), array_agg(format('%s: %s', class.oid::regclass, role.rolname) order by class.relname, role.rolname)
		filter (where has_table_privilege(role.rolname, class.oid, 'SELECT,INSERT,UPDATE,DELETE'))
	into v_pairs, v_open
	from pg_class as class
	cross join (values ('anon'), ('authenticated'), ('qorpera_secret_broker')) as role(rolname)
	where class.relnamespace = 'public'::regnamespace and class.relkind in ('r', 'v', 'p')
		and class.relname ~ '^qorpera_.*(office|runtime_node|login_gateway|presence|runtime_machine|fleet|compute_request|viewer|browser)';
	if v_pairs = 0 then raise exception 'API role tables: the office and node table pattern matched nothing'; end if;
	if v_open is not null then
		raise exception 'API role tables: an API role can touch %', array_to_string(v_open, ', ');
	end if;
end
$$;

-- 2. service_role cannot read or write what signs and checks presence: the device signing registry and the
-- company's HMAC secret.
do $$
declare v_table text;
begin
	foreach v_table in array array['public.qorpera_native_presence_devices', 'public.qorpera_company_presence_secrets'] loop
		if has_table_privilege('service_role', v_table, 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'API role tables: service_role can touch %', v_table;
		end if;
	end loop;
end
$$;

-- 3. service_role cannot grant itself the office-software operator capability, read the office software custody,
-- or call the capability check directly.
do $$
declare v_table text;
begin
	foreach v_table in array array['provider_capabilities', 'baselines', 'revisions', 'updates', 'challenges', 'measurements'] loop
		if has_table_privilege('service_role', 'public.qorpera_office_software_' || v_table, 'SELECT,INSERT,UPDATE,DELETE') then
			raise exception 'API role tables: service_role can touch qorpera_office_software_%', v_table;
		end if;
	end loop;
	if has_function_privilege('service_role', 'public.qorpera_require_office_software_capability(uuid,text,boolean)', 'EXECUTE') then
		raise exception 'API role tables: service_role can call the office-software capability check';
	end if;
end
$$;

rollback;
