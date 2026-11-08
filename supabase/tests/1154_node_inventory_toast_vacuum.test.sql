begin;
-- 20260930654000: the node inventory receipts' TOAST table is vacuumed after 1,000 dead chunks whatever its size, always
-- with the index pass, so the space each hourly thinning run frees there is reused within the hour. The table's own (heap)
-- options stay unset, and so do those of the other node receipt tables.
create function pg_temp.ok(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end $$;

select pg_temp.ok(
	coalesce((select toast.reloptions @> array['autovacuum_vacuum_threshold=1000', 'autovacuum_vacuum_scale_factor=0']
			and not toast.reloptions @> array['autovacuum_enabled=false']
		from pg_class heap join pg_class toast on toast.oid = heap.reltoastrelid
		where heap.oid = 'public.qorpera_runtime_node_inventory_receipts'::regclass), false),
	'The inventory receipts'' TOAST table does not vacuum after 1,000 dead chunks');

-- The index pass every time. Without it PostgreSQL 14+ skips that pass when under 2 % of the pages hold dead items (a steady
-- thinning run is about 1.5 %), and PostgreSQL 17 then keeps the run's space out of the free space map until a later vacuum
-- does the pass: in the lab the space came back only every second run.
select pg_temp.ok(
	coalesce((select toast.reloptions @> array['vacuum_index_cleanup=on']
		from pg_class heap join pg_class toast on toast.oid = heap.reltoastrelid
		where heap.oid = 'public.qorpera_runtime_node_inventory_receipts'::regclass), false),
	'The inventory receipts'' TOAST vacuum may skip its index pass, so a thinning run''s space can wait for the next run');

-- Three options and nothing else: an insert threshold or a cost limit here would be a separate decision.
select pg_temp.ok(
	(select cardinality(toast.reloptions) = 3
		from pg_class heap join pg_class toast on toast.oid = heap.reltoastrelid
		where heap.oid = 'public.qorpera_runtime_node_inventory_receipts'::regclass),
	'The inventory receipts'' TOAST table has other options than the three of 20260930654000');

-- The heap keeps the defaults until the random observation ids of the reports filed before 7 November 2026 are gone: an
-- hourly index vacuum would touch nearly every page of the primary key while it holds them.
select pg_temp.ok(
	(select reloptions is null from pg_class where oid = 'public.qorpera_runtime_node_inventory_receipts'::regclass),
	'The inventory receipts table has its own autovacuum options: revisit 20260930654000');

-- Only this TOAST table. The other node receipt tables have no large column, and their heaps keep the defaults.
select pg_temp.ok(not exists (select 1 from pg_class heap left join pg_class toast on toast.oid = heap.reltoastrelid
		where heap.oid in ('public.qorpera_runtime_node_observation_receipts'::regclass,
			'public.qorpera_runtime_node_health_receipts'::regclass)
			and (heap.reloptions is not null or toast.reloptions is not null)),
	'Another node receipt table has its own autovacuum options');
select pg_temp.ok(
	(select count(*) = 1 from pg_class toast
		where toast.relnamespace = 'pg_toast'::regnamespace and toast.relkind = 't'
			and toast.reloptions @> array['autovacuum_vacuum_threshold=1000']),
	'Another TOAST table took the 1,000-chunk vacuum threshold');
rollback;
