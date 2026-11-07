begin;
-- 20260930615000: seven tiny tables rewritten every few seconds are analyzed and vacuumed about twice a day, not every
-- two minutes. Automatic vacuum stays on for them, and every other table keeps PostgreSQL's defaults.
create function pg_temp.ok(p_value boolean, p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%', p_message; end if; end $$;

select pg_temp.ok(
	coalesce((select reloptions @> array['autovacuum_analyze_threshold=20000', 'autovacuum_vacuum_threshold=20000']
		and not reloptions @> array['autovacuum_enabled=false']
		from pg_class where oid = ('public.' || tiny_table)::regclass), false),
	tiny_table || ' does not have the quiet autovacuum thresholds')
from unnest(array['qorpera_runner_orchestrators', 'qorpera_runtime_node_observations', 'qorpera_runtime_node_agent_exit',
	'qorpera_runtime_node_health_latest', 'qorpera_computer_hour_nodes', 'qorpera_computer_hour_meter',
	'qorpera_computer_hour_zero_sweep_status']) tiny_table;

-- Only those seven. A table that grows needs fresh statistics to plan by.
select pg_temp.ok((select count(*) = 7 from pg_class c
		where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
			and c.reloptions @> array['autovacuum_analyze_threshold=20000']),
	'Another table took the quiet autovacuum thresholds');
select pg_temp.ok(not exists (select 1 from pg_class c
		where c.oid in ('public.qorpera_runtime_node_observation_receipts'::regclass,
			'public.qorpera_runtime_node_inventory_receipts'::regclass, 'public.qorpera_runtime_node_health_receipts'::regclass,
			'public.qorpera_runtime_node_demands'::regclass, 'public.qorpera_runner_jobs'::regclass)
			and c.reloptions is not null),
	'A table that grows has its own autovacuum options');

-- Their updates stay on the page (HOT), which is why no vacuum is needed to reclaim the old versions. An index on a
-- column the updates change would end that: each of the seven has its primary key and nothing else.
select pg_temp.ok((select count(*) = 1 and bool_and(indisprimary) from pg_index where indrelid = ('public.' || tiny_table)::regclass),
	tiny_table || ' has another index, so its updates may leave the page: revisit its autovacuum thresholds')
from unnest(array['qorpera_runner_orchestrators', 'qorpera_runtime_node_observations', 'qorpera_runtime_node_agent_exit',
	'qorpera_runtime_node_health_latest', 'qorpera_computer_hour_nodes', 'qorpera_computer_hour_meter',
	'qorpera_computer_hour_zero_sweep_status']) tiny_table;
rollback;
