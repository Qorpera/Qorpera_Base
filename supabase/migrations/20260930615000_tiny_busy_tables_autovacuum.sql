-- Seven very small, very busy tables stop being analyzed and vacuumed every few minutes.
--
-- Each of these tables holds a row per node, orchestrator or meter, rewritten every few seconds (the two meter tables
-- every minute). PostgreSQL's default asks for an ANALYZE after 50 changes plus 10 % of the rows and a VACUUM after 50 dead
-- rows plus 20 %, and on a table of two rows that is every few minutes, day and night.
--
-- Measured in production from 3 November 07:06Z to 7 November 05:30Z 2026 (pg_stat_all_tables, 94 hours):
-- * these seven took 9,547 of the 12,224 automatic ANALYZE runs (78 %) and 4,838 of the 5,870 automatic VACUUM runs (82 %);
-- * pg_statistic had 94,992 row updates, and in the one hour read from the WAL archive it wrote 3.05 MB of 47.5 MB of
--   WAL (6.4 %), more than any other table except the three node receipt tables;
-- * every ANALYZE also tells every connection to forget its cached plans for that table.
--
-- ANALYZE after 20,000 changes. At the update rates of 7 November that is:
--   qorpera_runner_orchestrators             about every 9 hours
--   qorpera_runtime_node_agent_exit          about every 14 hours
--   qorpera_runtime_node_observations        about every 14 hours
--   qorpera_runtime_node_health_latest       about every 17 hours
--   qorpera_computer_hour_nodes              about every 37 hours
--   qorpera_computer_hour_meter              about every 14 days
--   qorpera_computer_hour_zero_sweep_status  about every 14 days
-- Cost: none we can find. The planner reads a table's size from its pages, each query finds its row by key, and the row
-- count of these tables moves only when a node or orchestrator is added. The last two hold one row each.
--
-- VACUUM after 500 dead rows. In normal running that means routine vacuum stops, on purpose. Every update on these tables
-- is HOT and stays on the table's one page, and pruning that page takes the old versions off the dead count, so the count
-- stays below 500: a page holds at most 291 row versions, and on 7 November the seven stood at 3 to 58 dead rows.
-- qorpera_runtime_node_observations and qorpera_runner_orchestrators already had no automatic vacuum at all in those 94
-- hours and are still 8 kB.
-- What that costs:
-- * Freezing waits for the anti-wraparound vacuum, which these settings do not affect, at 200 million transactions: about 440
--   days at the rate of 7 November (1.77 million in 94 hours). It is one page when it comes.
-- * The visibility map stays unset. Nothing reads these tables by index only: they are one page.
-- If pruning is held back (a long transaction, a stuck replication slot), the table spills past its page and the dead count
-- climbs. It reaches 500 in 13 minutes to an hour on the five busy tables and in about 8 hours on the two meter tables. Vacuum
-- then comes back, and once the hold ends it frees the spilled pages for reuse. The spill is small: about 0.9 MB an hour on
-- qorpera_runtime_node_observations (estimated). Not tested: this needs a real hold and days of autovacuum on a live database.
--
-- ALTER TABLE ... SET (autovacuum_*) takes SHARE UPDATE EXCLUSIVE: readers and writers carry on. A running autovacuum on
-- the table gives way, so the wait is short; the lock timeout stops the migration rather than queue behind anything else.
--
-- Undo: alter table ... reset (autovacuum_analyze_threshold, autovacuum_vacuum_threshold) on each table.
set local lock_timeout = '3s';

alter table public.qorpera_runner_orchestrators set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
alter table public.qorpera_runtime_node_observations set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
alter table public.qorpera_runtime_node_agent_exit set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
alter table public.qorpera_runtime_node_health_latest set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
alter table public.qorpera_computer_hour_nodes set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
alter table public.qorpera_computer_hour_meter set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
alter table public.qorpera_computer_hour_zero_sweep_status set (autovacuum_analyze_threshold = 20000, autovacuum_vacuum_threshold = 500);
