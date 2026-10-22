-- @fixture 707_folder_state_todos.test.sql until "-- 1. The company, two agents, and a todo"
-- A folder-v2 company's Company File answer says what the company stores (migration 20260930524000):
-- qorpera_get_company_file's storage_used_bytes is the count the folder quota keeps (qorpera_folder_storage_usage), or the
-- sum of the company's object catalog before that row exists, and never qorpera_company_files.storage_used_bytes, which
-- folder-v2 leaves alone. A company that is not folder-v2 keeps the column's count. Who may read it, and every other part
-- of the answer, are unchanged. On 707's folder-v2 company (owner …01, contributor …02, stranger …03, environments …20
-- and …22) and a snapshot-v1 company of the same owner; rolled back at the end.

create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- The answer a member reads, or 42501 when they may not read it; the service's claims come back after.
create function pg_temp.read_as(p_user uuid, p_env uuid) returns jsonb language plpgsql as $$
declare v_answer jsonb;
begin
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true);
	begin
		v_answer := public.qorpera_get_company_file(p_env);
	exception when insufficient_privilege then
		v_answer := to_jsonb('42501'::text);
	end;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return v_answer;
end $$;
-- The stored bytes a member reads, or 42501.
create function pg_temp.used_as(p_user uuid, p_env uuid default '70700000-0000-4000-8000-000000000020') returns text
language plpgsql as $$
declare v_answer jsonb := pg_temp.read_as(p_user, p_env);
begin
	return case when jsonb_typeof(v_answer) = 'object' then v_answer ->> 'storage_used_bytes' else v_answer #>> '{}' end;
end $$;
create function pg_temp.usage_bytes() returns text language sql as $$
	select bytes::text from public.qorpera_folder_storage_usage where profile_id = '70700000-0000-4000-8000-000000000010'
$$;
create function pg_temp.catalog_bytes() returns text language sql as $$
	select coalesce(sum(bytes), 0)::text from public.qorpera_profile_objects
	where profile_id = '70700000-0000-4000-8000-000000000010'
$$;

-- A snapshot-v1 company the same owner holds, whose file row keeps its own count.
insert into public.qorpera_profiles(id,name,created_by_user_id) values
	('97200000-0000-4000-8000-000000000010','Snapshot Storage','70700000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('97200000-0000-4000-8000-000000000010','70700000-0000-4000-8000-000000000001','todos-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('97200000-0000-4000-8000-000000000020','97200000-0000-4000-8000-000000000010','Environment',1,'70700000-0000-4000-8000-000000000001');

do $$
begin
	if not public.qorpera_company_is_folder_v2('70700000-0000-4000-8000-000000000010')
		or public.qorpera_company_is_folder_v2('97200000-0000-4000-8000-000000000010') then
		raise exception 'Fixture: one folder-v2 company and one snapshot-v1 company'; end if;
	-- The company stores two files: the folder quota counts their objects.
	perform pg_temp.stage('# Storage meter' || E'\n\nThe first file.\n');
	perform pg_temp.stage(repeat('Second file. ', 200));
	if coalesce(pg_temp.usage_bytes()::bigint, 0) <= 0 then raise exception 'Fixture: the folder quota counts the stored objects'; end if;
	-- What the snapshot-v1 count would say is set apart from it, so the answer can't be read from the column by chance.
	update public.qorpera_company_files set storage_used_bytes = 7 where profile_id = '70700000-0000-4000-8000-000000000010';
	update public.qorpera_company_files set storage_used_bytes = 12345 where profile_id = '97200000-0000-4000-8000-000000000010';
end $$;

-- 1. A folder-v2 company: the folder quota's count, for each of its file rows and each member who may read it ----------
do $$
begin
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000001'), pg_temp.usage_bytes(), 'the owner reads the quota''s count');
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000002'), pg_temp.usage_bytes(), 'a contributor reads it too');
	-- The count is the company's: its other environment's file row answers the same.
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000001', '70700000-0000-4000-8000-000000000022'),
		pg_temp.usage_bytes(), 'the company''s other file row');
	-- The quota's count is what the catalog holds.
	perform pg_temp.is(pg_temp.usage_bytes(), pg_temp.catalog_bytes(), 'the quota''s count is the catalog''s sum');
	-- A file staged later is counted at once.
	perform pg_temp.stage(repeat('Third file. ', 50));
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000001'), pg_temp.usage_bytes(), 'after a third file');
	if pg_temp.used_as('70700000-0000-4000-8000-000000000001')::bigint <= 7 then
		raise exception 'The answer is the stored bytes, not the snapshot-v1 column'; end if;
end $$;

-- 2. Before the quota's row exists, the catalog's sum, which the row would seed itself from --------------------------
do $$
begin
	delete from public.qorpera_folder_storage_usage where profile_id = '70700000-0000-4000-8000-000000000010';
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000001'), pg_temp.catalog_bytes(), 'no quota row yet');
	if pg_temp.catalog_bytes()::bigint <= 7 then raise exception 'The catalog holds the stored files'; end if;
	-- A count that went below 0 is answered as 0, a size every reader takes.
	insert into public.qorpera_folder_storage_usage(profile_id, bytes, objects)
	values ('70700000-0000-4000-8000-000000000010', -5, 0);
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000001'), '0', 'never below 0');
end $$;

-- 3. A company that is not folder-v2 keeps its column's count -------------------------------------------------------
do $$
begin
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000001', '97200000-0000-4000-8000-000000000020'), '12345',
		'a snapshot-v1 company');
end $$;

-- 4. Who may read, the rest of the answer, the grants, and the deploy marker -----------------------------------------
do $$
declare v_answer jsonb := pg_temp.read_as('70700000-0000-4000-8000-000000000001', '70700000-0000-4000-8000-000000000020');
begin
	perform pg_temp.is(pg_temp.used_as('70700000-0000-4000-8000-000000000003'), '42501', 'a stranger reads nothing');
	perform pg_temp.is((select string_agg(key, ',' order by key collate "C") from jsonb_object_keys(v_answer) as key),
		'canonical_workspace_id,created_at,entitlement,environment_id,head_snapshot_id,logical_bytes,object_backends,'
			|| 'profile_id,retained_storage_bytes,state,storage_limit_bytes,storage_used_bytes,updated_at',
		'the answer''s fields');
	perform pg_temp.is(v_answer ->> 'storage_limit_bytes', (select storage_limit_bytes::text from public.qorpera_company_files
		where environment_id = '70700000-0000-4000-8000-000000000020'), 'the limit is the file row''s');
	if has_function_privilege('authenticated', 'public.qorpera_company_file_json(public.qorpera_company_files)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_company_file_json(public.qorpera_company_files)', 'execute')
		or not has_function_privilege('authenticated', 'public.qorpera_get_company_file(uuid)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_get_company_file(uuid)', 'execute') then
		raise exception 'The grants are unchanged'; end if;
	if position('20260930524000' in pg_get_functiondef('public.qorpera_company_file_json(public.qorpera_company_files)'::regprocedure)) = 0
		or not (select prosecdef from pg_proc where oid = 'public.qorpera_company_file_json(public.qorpera_company_files)'::regprocedure) then
		raise exception 'The patched function names its migration and stays security definer'; end if;
end $$;

rollback;
