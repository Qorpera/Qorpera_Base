-- @fixture 636_folder_core_feed.test.sql until "-- A member sees only what it may read."
-- Company folder core, C4 slice P33 (20260930013200): the member's file mode says 'folder' for a folder-v2 company,
-- so the web opens its read-only folder page there; a whole-tree company keeps its mode. The change-set history keeps
-- its answers with its per-change-set query bounded by the cap.

create function pg_temp.as_member(p_n integer) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated',
		'sub', '63000000-0000-4000-8000-00000000000' || p_n)::text, true)::text::void
$$;
create function pg_temp.same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;

select pg_temp.as_member(3);
do $$
declare v jsonb := public.qorpera_member_company_file_mode('63000000-0000-4000-8000-000000000010');
begin
	perform pg_temp.same(v ->> 'mode', 'folder', 'a folder-v2 company');
	perform pg_temp.same(v ->> 'environmentId', '63000000-0000-4000-8000-000000000020', 'its environment');
	perform pg_temp.same(v ->> 'companyId', '63000000-0000-4000-8000-000000000010', 'its company');
end $$;
select pg_temp.as_member(1);
do $$ begin
	perform pg_temp.same(public.qorpera_member_company_file_mode('63000000-0000-4000-8000-000000000011') ->> 'mode',
		(select case when path_gateway_version = 1 then 'governed' else 'legacy' end from public.qorpera_company_files
			where profile_id = '63000000-0000-4000-8000-000000000011'), 'a whole-tree company keeps its mode');
end $$;

select pg_temp.claims('service_role');
