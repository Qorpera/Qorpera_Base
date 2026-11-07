-- Seven very small, very busy tables stop being analyzed and vacuumed every few minutes.
--
-- Each of these tables holds a row per node, orchestrator or meter, rewritten every few seconds. PostgreSQL's default
-- asks for an ANALYZE after 50 changes plus 10 % of the rows and a VACUUM after 50 dead rows plus 20 %, and on a table
-- of two rows that is every two minutes, day and night.
--
-- Measured in production from 3 November 07:06Z to 7 November 05:30Z 2026 (pg_stat_all_tables, 94 hours):
-- * these seven took 9,547 of the 12,224 automatic ANALYZE runs (78 %) and 4,838 of the 5,870 automatic VACUUM runs (82 %);
-- * pg_statistic had 94,992 row updates, and in the one hour read from the WAL archive it wrote 3.05 MB of 47.5 MB of
--   WAL (6.4 %), more than any other table except the three node receipt tables;
-- * every ANALYZE also tells every connection to forget its cached plans for that table.
--
-- Nothing is lost. A few rows have no statistics worth keeping fresh: the planner reads the table's size from its pages
-- and each query finds one row by key. Their updates are all HOT (n_tup_hot_upd = n_tup_upd), so the old versions go when
-- the page is next read: qorpera_runtime_node_observations and qorpera_runner_orchestrators had no automatic vacuum at
-- all in those 94 hours and are still 8 kB. The thresholds are not "off": at 20,000 changes each table is still analyzed
-- and vacuumed about twice a day, and the anti-wraparound vacuum does not read them.
--
-- ALTER TABLE ... SET (autovacuum_*) takes SHARE UPDATE EXCLUSIVE: readers and writers carry on. A running autovacuum on
-- the table gives way, so the wait is short; the lock timeout stops the migration rather than queue behind anything else.
--
-- Undo: alter table ... reset (autovacuum_analyze_threshold, autovacuum_vacuum_threshold) on each table.
set local lock_timeout = '3s';

alter table public.qorpera_runner_orchestrators set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
alter table public.qorpera_runtime_node_observations set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
alter table public.qorpera_runtime_node_agent_exit set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
alter table public.qorpera_runtime_node_health_latest set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
alter table public.qorpera_computer_hour_nodes set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
alter table public.qorpera_computer_hour_meter set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
alter table public.qorpera_computer_hour_zero_sweep_status set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 20000);
