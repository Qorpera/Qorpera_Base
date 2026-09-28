-- Node health retention plan (the seven-day retention delete of bundle v88, 20260924060000 section 3).
--
-- qorpera_observe_runtime_node_health ends by deleting at most 500 of the calling node's receipts
-- observed more than seven days ago, never the one its latest row names. The cut used clock_timestamp(),
-- which is volatile, so it could not bound the history index (node_id, observed_at, observation_id),
-- and the rows to delete were matched with IN, which the planner may run as a semi join. With
-- statistics that do not yet know a node's receipts it chose a Nested Loop Semi Join that re-read the
-- node's whole history for every receipt: quadratic in the node's history. In production on 2026-09-28
-- (16:44 to 21:02:51Z, when autoanalyze ran) node 1's health calls took 1 to 2.4 s while holding
-- KEY SHARE on its node row (the receipt's foreign key), and its inventory observations and suspends
-- queued behind them. It recurs whenever a node starts writing health the statistics do not know.
--
-- The cut is now now(): the transaction's start, stable, so it bounds the index range. The receipts to
-- delete are chosen first, into one array, and deleted by primary key (observation_id = any(array(...))),
-- so there is no join for the planner to get wrong. Which receipts go is unchanged: the calling node's,
-- older than seven days, oldest first, at most 500, never the latest's. A call is one short transaction,
-- so the cut moves by at most that transaction's age. Nothing else in the function changes: the patch
-- replaces only that statement in the reviewed definition, and CREATE OR REPLACE keeps its owner and
-- privileges (execute for service_role only).
set local lock_timeout = '3s';

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure), 'sha256'), 'hex') <> 'e4d1c5b9f1ded59c5334c97be9866551c689c0a4e1d9d2c7caaa0dc2f2c96f22' then
		raise exception 'Reviewed function definition changed: qorpera_observe_runtime_node_health';
	end if;
end $guard$;

do $migration$
declare definition text:=pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure);
	anchor text:=$old$
 delete from public.qorpera_runtime_node_health_receipts where node_id=v_id and observation_id in (
  select h.observation_id from public.qorpera_runtime_node_health_receipts h
  where h.node_id=v_id and h.observed_at<clock_timestamp()-interval '7 days'
   and not exists(select 1 from public.qorpera_runtime_node_health_latest l
    where l.node_id=h.node_id and l.observation_id=h.observation_id)
  order by h.observed_at,h.observation_id limit 500);
$old$;
	replacement text:=$new$
 delete from public.qorpera_runtime_node_health_receipts where node_id=v_id and observation_id = any(array(
  select h.observation_id from public.qorpera_runtime_node_health_receipts h
  where h.node_id=v_id and h.observed_at<now()-interval '7 days'
   and not exists(select 1 from public.qorpera_runtime_node_health_latest l
    where l.node_id=h.node_id and l.observation_id=h.observation_id)
  order by h.observed_at,h.observation_id limit 500));
$new$;
begin
	if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
		raise exception 'Reviewed node health retention source changed'; end if;
	execute replace(definition,anchor,replacement);
end $migration$;

-- The result is exactly the reviewed definition with that one statement replaced.
do $check$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure), 'sha256'), 'hex') <> '72a0b272a28ab7198200afed9949edd724be9383bdf700087a809a75dad7ca0f' then
		raise exception 'Node health retention plan did not apply as reviewed';
	end if;
end $check$;
