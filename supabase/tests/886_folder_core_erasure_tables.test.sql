-- @fixture 864_folder_state_interfaces.test.sql until "-- 1. The kinds, by the path's shape alone"
-- Company folder core, P18c (migration 20260930028000; deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md §12):
-- erasure of deleted table folders. The request deletes the retired qorpera_folder_table_index rows built from the files
-- it erases, never a live row: not one a later life at the same path made, not one revived at another path, and not
-- one revived at the same path. An interface folder, which has no index, is erased like any path. The lock order and
-- the reply's count. On 864's seeded company; rolled back at the end.

create function pg_temp.erase(p_paths text[], p_key text) returns jsonb language sql as $$
	select public.qorpera_folder_erase('63400000-0000-4000-8000-000000000020', pg_temp.member(1), to_jsonb(p_paths), p_key)
$$;
create function pg_temp.drain(p_id uuid) returns public.qorpera_folder_erasures language plpgsql as $$
declare v public.qorpera_folder_erasures%rowtype;
begin
	for i in 1..60 loop
		select * into v from public.qorpera_folder_erasures where id = p_id;
		exit when v.state <> 'working';
		perform public.qorpera_folder_erasure_step();
	end loop;
	select * into v from public.qorpera_folder_erasures where id = p_id;
	return v;
end $$;
create function pg_temp.versions_at(p_key text) returns bigint language sql as $$
	select count(*) from public.qorpera_folder_path_versions where environment_id = '63400000-0000-4000-8000-000000000020'
		and public.qorpera_folder_erasure_covers(p_key, public.qorpera_folder_key(path))
$$;
create function pg_temp.is(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A table folder with its definition and rows, as a member makes it.
create function pg_temp.table_folder(p_path text, p_id uuid) returns jsonb language sql as $$
	select pg_temp.p16_folder(pg_temp.member(1), p_path, jsonb_build_object('table.toml', pg_temp.tbl(p_id),
		'rows.csv', pg_temp.fixture('rows-empty') || '{"header":["number","at","value","unit","kept_by"]}'))
$$;
create function pg_temp.saved(p_result jsonb) returns void language plpgsql as $$
begin
	if exists (select 1 from jsonb_array_elements(p_result -> 'units') u where u ->> 'outcome' <> 'saved') then
		raise exception 'Fixture commit: %', p_result; end if;
end $$;

-- 1. A deleted table folder: its retired row goes with the request, its history with the drain -----------------------------

do $$
declare r jsonb; v public.qorpera_folder_erasures%rowtype;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-scratch-1', jsonb_build_array(
		pg_temp.table_folder('tables/scratch', '88600000-0000-4000-8000-000000000021'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-scratch-2', jsonb_build_array(pg_temp.p16_delete('tables/scratch'))));
	if not exists (select 1 from public.qorpera_folder_table_index where id = '88600000-0000-4000-8000-000000000021'
			and retired_at is not null) then raise exception 'Fixture: the deleted table''s row is retired'; end if;
	r := pg_temp.erase(array['tables/scratch'], 'p18c-erase-scratch');
	if exists (select 1 from public.qorpera_folder_table_index where id = '88600000-0000-4000-8000-000000000021') then
		raise exception 'The retired row goes with the request'; end if;
	perform pg_temp.is(r -> 'erased' ->> 'tables', '1', 'the reply counts it');
	v := pg_temp.drain((r ->> 'erasureId')::uuid);
	if v.state not in ('done', 'waiting') then raise exception 'Drained: %', to_jsonb(v); end if;
	perform pg_temp.is(pg_temp.versions_at('tables/scratch')::text, '0', 'its history goes');
end $$;

-- 2. Live rows are never touched -----------------------------------------------------------------------------------------

do $$
declare r jsonb; v_live uuid;
begin
	-- Revived at another path, then deleted there: the row is retired again, its key inside the root's raw range
	-- (tables/moved-again sorts before tables/moved0), but under another folder: only the path filter keeps it.
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-moved-1', jsonb_build_array(
		pg_temp.table_folder('tables/moved', '88600000-0000-4000-8000-000000000022'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-moved-2', jsonb_build_array(pg_temp.p16_delete('tables/moved'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-moved-3', jsonb_build_array(
		pg_temp.table_folder('tables/moved-again', '88600000-0000-4000-8000-000000000022'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-moved-4', jsonb_build_array(pg_temp.p16_delete('tables/moved-again'))));
	r := pg_temp.erase(array['tables/moved'], 'p18c-erase-moved');
	perform pg_temp.is(r -> 'erased' ->> 'tables', '0', 'a table revived elsewhere is no row of the root');
	if not exists (select 1 from public.qorpera_folder_table_index where id = '88600000-0000-4000-8000-000000000022'
			and folder_key = 'tables/moved-again' and retired_at is not null) then
		raise exception 'The row of the other folder stays'; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(pg_temp.versions_at('tables/moved')::text, '0', 'the old path''s history goes');
	if pg_temp.versions_at('tables/moved-again') = 0 then raise exception 'The new path''s history stays'; end if;

	-- A later life at the same path, with another id: the earlier table's row goes, the live one stays with its files.
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-live-1', jsonb_build_array(
		pg_temp.table_folder('tables/live', '88600000-0000-4000-8000-000000000023'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-live-2', jsonb_build_array(pg_temp.p16_delete('tables/live'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-live-3', jsonb_build_array(
		pg_temp.table_folder('tables/live', '88600000-0000-4000-8000-000000000024'))));
	v_live := pg_temp.p16_version('tables/live/table.toml');
	r := pg_temp.erase(array['tables/live'], 'p18c-erase-live');
	perform pg_temp.is(r -> 'erased' ->> 'tables', '1', 'the earlier life''s row');
	if exists (select 1 from public.qorpera_folder_table_index where id = '88600000-0000-4000-8000-000000000023') then
		raise exception 'The earlier life''s row goes'; end if;
	if (pg_temp.trow('tables/live')).id is distinct from '88600000-0000-4000-8000-000000000024'
		or (pg_temp.trow('tables/live')).definition_version is distinct from v_live then
		raise exception 'The live table keeps its row'; end if;
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if not exists (select 1 from public.qorpera_folder_path_versions where version = v_live) then
		raise exception 'The live table keeps its definition''s version'; end if;

	-- Revived at the same path with the same id: the row is live again, so the request leaves it; the earlier life's
	-- versions still go.
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-same-1', jsonb_build_array(
		pg_temp.table_folder('tables/same', '88600000-0000-4000-8000-000000000025'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-same-2', jsonb_build_array(pg_temp.p16_delete('tables/same'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-same-3', jsonb_build_array(
		pg_temp.table_folder('tables/same', '88600000-0000-4000-8000-000000000025'))));
	v_live := pg_temp.p16_version('tables/same/table.toml');
	r := pg_temp.erase(array['tables/same'], 'p18c-erase-same');
	perform pg_temp.is(r -> 'erased' ->> 'tables', '0', 'a revived row is live');
	if (pg_temp.trow('tables/same')).id is distinct from '88600000-0000-4000-8000-000000000025' then
		raise exception 'The revived row stays'; end if;
	perform pg_temp.is(r -> 'roots' -> 0 ->> 'versions', '6', 'the earlier life: the folder, its two files and the delete''s three rows');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if (pg_temp.trow('tables/same')).definition_version is distinct from v_live
		or not exists (select 1 from public.qorpera_folder_path_versions where version = v_live) then
		raise exception 'The revived table keeps its row and its current files'; end if;

	-- A delete and a re-create in one change set: the earlier table's row goes, the new one stays.
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-split-1', jsonb_build_array(
		pg_temp.table_folder('tables/split', '88600000-0000-4000-8000-000000000026'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-split-2', jsonb_build_array(pg_temp.p16_delete('tables/split'),
		pg_temp.table_folder('tables/split', '88600000-0000-4000-8000-000000000027'))));
	r := pg_temp.erase(array['tables/split'], 'p18c-erase-split');
	perform pg_temp.is(r -> 'erased' ->> 'tables', '1', 'the table before the re-create');
	if exists (select 1 from public.qorpera_folder_table_index where id = '88600000-0000-4000-8000-000000000026')
		or (pg_temp.trow('tables/split')).id is distinct from '88600000-0000-4000-8000-000000000027' then
		raise exception 'Split at the re-create''s unit'; end if;
end $$;

-- 3. A renamed-then-deleted table: its old name is part of its history, and the row goes with both ----------------------

do $$
declare r jsonb; v_detail text;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-ren-1', jsonb_build_array(
		pg_temp.table_folder('tables/r1', '88600000-0000-4000-8000-000000000028'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-ren-2', jsonb_build_array(pg_temp.p16_move('tables/r1', 'tables/r2'))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-ren-3', jsonb_build_array(pg_temp.p16_delete('tables/r2'))));
	begin
		perform pg_temp.erase(array['tables/r2'], 'p18c-erase-ren-1');
		raise exception 'Expected the refusal';
	exception when sqlstate '22023' then get stacked diagnostics v_detail = pg_exception_detail;
	end;
	if v_detail::jsonb -> 'add' <> '["tables/r1"]'::jsonb then raise exception 'Name the old path: %', v_detail; end if;
	r := pg_temp.erase(array['tables/r2', 'tables/r1'], 'p18c-erase-ren-2');
	perform pg_temp.is(r -> 'erased' ->> 'tables', '1', 'the renamed table''s row');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	if pg_temp.versions_at('tables/r1') + pg_temp.versions_at('tables/r2') <> 0 then raise exception 'Its whole history goes'; end if;
end $$;

-- 4. An interface folder has no index: it is erased like any path --------------------------------------------------------

do $$
declare r jsonb;
begin
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-iface-1', jsonb_build_array(
		pg_temp.p16_folder(pg_temp.member(1), 'interfaces/scratch', jsonb_build_object('interface.toml',
			pg_temp.iface('88600000-0000-4000-8000-000000000031', 'Scratch', false))))));
	perform pg_temp.saved(pg_temp.commit(pg_temp.member(1), 'p18c-iface-2', jsonb_build_array(pg_temp.p16_delete('interfaces/scratch'))));
	r := pg_temp.erase(array['interfaces/scratch'], 'p18c-erase-iface');
	perform pg_temp.drain((r ->> 'erasureId')::uuid);
	perform pg_temp.is(pg_temp.versions_at('interfaces/scratch')::text, '0', 'an interface''s history goes');
end $$;

-- 5. The lock text: the table rows are rank 5's last, after the contact rows, before the grants' resources ---------------

do $$
declare v_body text := (select prosrc from pg_proc where oid = 'public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure);
begin
	if strpos(v_body, 'from public.qorpera_folder_table_index i where i.environment_id = p_environment_id and i.id = any(v_tables)')
			<= strpos(v_body, 'from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id and i.id = any(v_contacts)')
		or strpos(v_body, 'from public.qorpera_folder_table_index i where i.environment_id = p_environment_id and i.id = any(v_tables)')
			>= strpos(v_body, 'perform public.qorpera_folder_lock_commit_rank(v_env, v_targets, 6::smallint)')
		or strpos(v_body, '20260930028000') = 0 then
		raise exception 'The table rows are locked after the contact rows and before rank 6'; end if;
end $$;

rollback;
