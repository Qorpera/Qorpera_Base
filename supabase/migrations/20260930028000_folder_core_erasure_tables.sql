-- Company folder core, slice P18c: erasure of deleted table folders (deploy/first-node/RUNTIME-COMPANY-FOLDER-ERASURE.md
-- §5, §12; F2's hand-over for P16a, 4 October 2026). P16a (20260930016000) indexes each table folder in
-- qorpera_folder_table_index, keyed (environment, id); a deleted table folder leaves its row retired, and a table made
-- again with the same id revives it. The request no longer refuses `tables/` and deletes the retired rows built from the
-- files it erases, as it deletes H2's task and contact rows:
-- * a plain read through the row's (environment_id, folder_key) index, with the key range written out;
-- * rank 5, after the contact index (the last table in qorpera_folder_structured_lock's order), FOR UPDATE, in
--   'environment_id:id' key order, before rank 6;
-- * the QRC01 re-read after the paths covers it too;
-- * only a retired row whose files lie before its root's cutoff (qorpera_folder_erasure_row_before, on its definition and,
--   when it has one, its rows), so a live table, or one revived meanwhile, is never touched.
-- The row holds no file text (path, key, versions, commit), so no placeholder is needed. Every patched body carries the
-- marker 20260930028000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.p18c_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P18c anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- `tables/` is erased like any other path.
select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		if split_part(v_key, '/', 1) = 'tables' then
			raise exception 'Erasing tables/ is not available yet' using errcode = '0A000'; end if;
$old$,
	$new$		-- 20260930028000 (P18c): tables/ is erased like any other path; its index rows go below.
$new$);

select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	v_tasks uuid[]; v_contacts uuid[]; v_connections uuid[];$old$,
	$new$	v_tasks uuid[]; v_contacts uuid[]; v_connections uuid[]; v_tables uuid[];$new$);

-- The plain read, after the contact rows'.
select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	from unnest(v_keys) k join public.qorpera_folder_contact_index i on i.environment_id = p_environment_id
		and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
	where i.retired_at is not null;
$old$,
	$new$	from unnest(v_keys) k join public.qorpera_folder_contact_index i on i.environment_id = p_environment_id
		and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
	where i.retired_at is not null;
	-- 20260930028000 (P18c): the retired table rows under the roots, for rank 5 (read again after the paths).
	select coalesce(array_agg(i.id order by i.environment_id::text || ':' || i.id::text collate "C"), '{}') into v_tables
	from unnest(v_keys) k join public.qorpera_folder_table_index i on i.environment_id = p_environment_id
		and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
	where i.retired_at is not null;
$new$);

-- Rank 5's last table, FOR UPDATE (they are deleted), in key order.
select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	perform 1 from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id and i.id = any(v_contacts)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
$old$,
	$new$	perform 1 from public.qorpera_folder_contact_index i where i.environment_id = p_environment_id and i.id = any(v_contacts)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
	-- 20260930028000 (P18c): the table rows, after the contact rows (qorpera_folder_structured_lock's order).
	perform 1 from public.qorpera_folder_table_index i where i.environment_id = p_environment_id and i.id = any(v_tables)
	order by i.environment_id::text || ':' || i.id::text collate "C" for update;
$new$);

-- The QRC01 re-read: a table row retired under a root since the plain read was not locked at its rank.
select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$			where i.retired_at is not null and not i.id = any(v_contacts))
$old$,
	$new$			where i.retired_at is not null and not i.id = any(v_contacts))
		-- 20260930028000 (P18c)
		or exists (select 1 from unnest(v_keys) k join public.qorpera_folder_table_index i on i.environment_id = p_environment_id
			and i.folder_key >= k and i.folder_key < k || '0' and public.qorpera_folder_erasure_covers(k, i.folder_key)
			where i.retired_at is not null and not i.id = any(v_tables))
$new$);

-- The reply counts them.
select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		'rules', cardinality(v_rules));$old$,
	$new$		'rules', cardinality(v_rules), 'tables', cardinality(v_tables)); -- 20260930028000 (P18c)$new$);

-- The delete, beside the contact rows': a retired row whose definition (and rows, when it has them) lie before its root's
-- cutoff, so a row revived by a later life is never deleted.
select pg_temp.p18c_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	delete from public.qorpera_folder_connection_index where secret_id = any(v_connections);
$old$,
	$new$	delete from public.qorpera_folder_connection_index where secret_id = any(v_connections);
	-- 20260930028000 (P18c): the table rows.
	delete from public.qorpera_folder_table_index i using jsonb_array_elements(v_roots) r
	where i.environment_id = p_environment_id and i.id = any(v_tables) and i.retired_at is not null
		and public.qorpera_folder_erasure_covers(r ->> 'key', i.folder_key)
		and public.qorpera_folder_erasure_row_before(r, i.commit_id, i.definition_version)
		and (i.rows_version is null or public.qorpera_folder_erasure_row_before(r, i.commit_id, i.rows_version));
$new$);

-- The deploy guard: every patched body carries the marker.
do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure),
			'20260930028000') = 0 then
		raise exception 'P18c did not reach qorpera_folder_erase'; end if;
end $guard$;
