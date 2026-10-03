-- @fixture 766_folder_core_object_gc.test.sql until "-- 1. The sweep, and when objects lost their roots (G4)"
-- Company folder core, C1d-2c part 1 (migration 20260930009100): what the catalog says of an object the object gateway
-- holds bytes or a blocked journal entry for (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §9.9). On 766's fixture,
-- a folder-v2 company; rolled back at the end.

create function pg_temp.state(p_sha text, p_profile uuid default '63400000-0000-4000-8000-000000000010') returns text
language sql as $$
	select public.qorpera_folder_gc_catalog_state(p_profile, p_sha)
$$;

-- 1. Catalogued, listed, missing.
do $$
declare v_never text := pg_temp.hash('gc never listed'); v_chunk text := 'gc chunk never confirmed'; v_open jsonb; v_file jsonb;
begin
	if pg_temp.state(v_never) <> 'missing' then raise exception 'No row and no intent: missing'; end if;
	v_file := pg_temp.stage('gc catalogued');
	if pg_temp.state(v_file ->> 'manifestSha256') <> 'catalogued' or pg_temp.state(pg_temp.hash('gc catalogued')) <> 'catalogued' then
		raise exception 'A staged file''s manifest and chunk are catalogued'; end if;
	-- An open intent lists a chunk whose confirm never ran: its writer may still confirm it.
	v_open := pg_temp.open('{"kind":"platform"}', pg_temp.manifest(array[v_chunk], 'text/plain'));
	if pg_temp.state(pg_temp.hash(v_chunk)) <> 'listed' then raise exception 'An open intent lists it'; end if;
	-- Within the grace window after the intent's expiry it is still listed; past it, missing (the root rule's window).
	perform pg_temp.expire((v_open ->> 'intentId')::uuid, interval '23 hours');
	if pg_temp.state(pg_temp.hash(v_chunk)) <> 'listed' then raise exception 'An intent expired within grace still lists it'; end if;
	perform pg_temp.expire((v_open ->> 'intentId')::uuid, interval '25 hours');
	if pg_temp.state(pg_temp.hash(v_chunk)) <> 'missing' then raise exception 'An intent expired past grace lists nothing'; end if;
end $$;

-- 2. Companies folder GC does not serve: unknown, being deleted, mixed.
do $$
declare v_never text := pg_temp.hash('gc never listed');
begin
	if pg_temp.state(v_never, '88100000-0000-4000-8000-000000000010') <> 'other' then raise exception 'An unknown company is other'; end if;
	perform pg_temp.fx($f$insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
		values ('63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001')$f$);
	if pg_temp.state(v_never) <> 'other' then raise exception 'A company being deleted is other'; end if;
	delete from public.qorpera_company_deletions where profile_id = '63400000-0000-4000-8000-000000000010';
	if pg_temp.state(v_never) <> 'missing' then raise exception 'Missing again once the deletion is gone'; end if;
	insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
	values ('63400000-0000-4000-8000-000000000881', '63400000-0000-4000-8000-000000000010', 'Snapshot', 1,
		'63400000-0000-4000-8000-000000000001');
	if pg_temp.state(v_never) <> 'other' then raise exception 'A company with a snapshot-v1 environment is other'; end if;
end $$;

-- 3. Arguments, the caller, grants and the lock text.
do $$
declare v_state text;
begin
	foreach v_state in array array['null', 'bad'] loop
		begin
			perform public.qorpera_folder_gc_catalog_state(case when v_state = 'null' then null else '63400000-0000-4000-8000-000000000010' end::uuid,
				case when v_state = 'null' then repeat('a', 64) else 'A' || repeat('a', 63) end);
			raise exception 'An invalid object is refused (%)', v_state;
		exception when invalid_parameter_value then null;
		end;
	end loop;
	perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
	begin
		perform pg_temp.state(repeat('a', 64));
		raise exception 'Only the service role asks';
	exception when insufficient_privilege then null;
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if not has_function_privilege('service_role', 'public.qorpera_folder_gc_catalog_state(uuid,text)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_folder_gc_catalog_state(uuid,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_gc_catalog_state(uuid,text)', 'execute') then
		raise exception 'Only the service role may ask'; end if;
	if (select prosrc from pg_proc where oid = 'public.qorpera_folder_gc_catalog_state(uuid,text)'::regprocedure)
			~* '(for (update|share|no key update|key share)|nowait|lock_profile_gc_fence|qorpera_folder_fences)'
		or not (select proconfig @> array['lock_timeout=2s'] from pg_proc
			where oid = 'public.qorpera_folder_gc_catalog_state(uuid,text)'::regprocedure) then
		raise exception 'Plain reads under the lock budget'; end if;
end $$;

rollback;
