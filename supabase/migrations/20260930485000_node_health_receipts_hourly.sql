-- Production DB slowness, item D: node health receipts are deleted by the hourly receipt retention, not by
-- each health observation.
--
-- qorpera_observe_runtime_node_health ended by deleting at most 500 of the calling node's health receipts
-- observed more than seven days ago (bundle v88, 20260924060000; by an index range since 20260928248935).
-- It was the only delete on the observers' path, run on every health report (about every five seconds per
-- node), and in the steady state it deleted about one row a call. Each call walked the node's history index
-- from its left edge, through every entry deleted since the last vacuum, read a cold page and wrote a
-- full-page image, all while holding KEY SHARE on the node row (the receipt's foreign key), which the
-- inventory observation's FOR UPDATE of that row waits for. On the shared-CPU production database that wait
-- is part of the slow observer path.
--
-- Now:
-- * the health observation inserts its receipt and moves its latest row, and deletes nothing. Its answer,
--   checks, settings and grants are unchanged: the patch removes only the delete and its comment line from
--   the reviewed definition, and CREATE OR REPLACE keeps the owner and privileges (execute for service_role
--   only);
-- * qorpera_purge_runtime_node_receipts (20260928459200) also deletes health receipts: per node, at most
--   p_limit a call (its own budget, beside the observations'), oldest first, observed more than seven days
--   ago, never the one the node's health latest row names. Which receipts go is unchanged; they go
--   within the hour after they turn seven days old instead of at the node's next report. The
--   computer-hour meter does not read health receipts, so its hold does not apply to them.
--   Observation and inventory retention is unchanged. It answers healthReceipts;
--   moreEligible is true when either budget ran out;
-- * qorpera_run_runtime_node_receipt_retention records health_receipts in the status row. pg_cron runs it
--   hourly since 20260930483000, so one run must take an hour of all three kinds: about 1,440 receipts a
--   table from two nodes, three calls. Its budget of 10 calls and one second did not: in production on
--   2026-10-16 the first hourly run (15:02Z) stopped on the time budget after one call of 500 observations and
--   499 inventories (2.9 s on the shared-CPU database), so retention fell behind by about 940 receipts a
--   table an hour. The budget is now 30 calls and 20 seconds, still checked between calls. A run stops at its
--   first short call, so in the steady state it makes about three calls whatever the budget; the rest is for
--   catching up, at up to about twice the inflow.
-- The purge's deletes lock no node row (deleting a referencing row takes no lock on the referenced one), wait
-- at most a second for any lock, and touch only rows the observers never lock again. The health latest row's
-- foreign key (on delete restrict) is never hit: the latest row is never a candidate, and it moves only to a
-- newer receipt, which is not older than the one it named.
-- The migration deletes nothing itself; health receipts were already kept to seven days, so the first
-- hourly run finds about an hour's worth.
--
-- Each function is checked against its reviewed definition first (sha256 of pg_get_functiondef, as in
-- production on 2026-10-16), so a definition changed elsewhere stops the migration instead of being
-- overwritten. Every bundle activation since v148 refuses to activate unless the health observation's text
-- holds '= any(array(' (20260928248935); that text goes here, so the generator's activation template now
-- requires the purge to delete health receipts instead (scripts/generate-cloud-runtime-bundle.mjs). An
-- activation built from a tree without this migration keeps the old guard and must be applied before it.
set local lock_timeout = '3s';

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure), 'sha256'), 'hex') <> '72a0b272a28ab7198200afed9949edd724be9383bdf700087a809a75dad7ca0f' then
		raise exception 'Reviewed function definition changed: qorpera_observe_runtime_node_health';
	end if;
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_purge_runtime_node_receipts(integer)'::regprocedure), 'sha256'), 'hex') <> '6664b66f9a3c66bfc66d88496e3ffe93acb9d87c0bbdfd5805939c3bf0450564' then
		raise exception 'Reviewed function definition changed: qorpera_purge_runtime_node_receipts';
	end if;
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_run_runtime_node_receipt_retention()'::regprocedure), 'sha256'), 'hex') <> '25c2918ab40cb55febdc7040f040a83c12e2285e2773eb44d2438e0ad3595cf7' then
		raise exception 'Reviewed function definition changed: qorpera_run_runtime_node_receipt_retention';
	end if;
end $guard$;

-- The health observation without its delete. The result must be exactly the reviewed definition with that
-- statement and its comment line replaced by one comment line.
do $migration$
declare definition text:=pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure);
	anchor text:=$old$ -- Bounded retention (bundle v88): seven days, at most 500 rows per call.
 delete from public.qorpera_runtime_node_health_receipts where node_id=v_id and observation_id = any(array(
  select h.observation_id from public.qorpera_runtime_node_health_receipts h
  where h.node_id=v_id and h.observed_at<now()-interval '7 days'
   and not exists(select 1 from public.qorpera_runtime_node_health_latest l
    where l.node_id=h.node_id and l.observation_id=h.observation_id)
  order by h.observed_at,h.observation_id limit 500));
$old$;
	replacement text:=$new$ -- Old receipts are deleted by the hourly receipt retention (qorpera_purge_runtime_node_receipts, 20260930485000).
$new$;
begin
	if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
		raise exception 'Reviewed node health retention source changed'; end if;
	execute replace(definition,anchor,replacement);
	if pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure) <> replace(definition,anchor,replacement) then
		raise exception 'Node health observation did not change as reviewed'; end if;
end $migration$;

alter table public.qorpera_runtime_node_receipt_retention_status
	add column health_receipts bigint check (health_receipts >= 0);

create or replace function public.qorpera_purge_runtime_node_receipts(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
-- Never queue behind a lock for more than a second; restored for the caller when the call returns.
set lock_timeout = '1s'
as $$
declare
	v_meter timestamptz;
	v_cutoff timestamptz;
	v_node record;
	v_ids uuid[];
	v_left integer;
	v_count integer;
	v_observations integer := 0;
	v_inventories integer := 0;
	v_health_left integer;
	v_health integer := 0;
begin
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Node receipt retention limit is invalid' using errcode = '22023';
	end if;
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.runtime-node-receipt-retention', 0)) then
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', true,
			'observations', 0, 'inventories', 0, 'healthReceipts', 0, 'moreEligible', false);
	end if;
	select meter.metered_until into v_meter from public.qorpera_computer_hour_meter meter;
	-- now() is the transaction's start: a value, so each candidate read is one bounded index range.
	-- least() ignores a missing meter row.
	v_cutoff := least(now() - interval '7 days', v_meter - interval '1 day');
	v_left := p_limit;
	for v_node in
		select latest.node_id, latest.observation_id from public.qorpera_runtime_node_observations latest
		order by latest.node_id
	loop
		exit when v_left = 0;
		v_ids := array(
			select receipt.observation_id from public.qorpera_runtime_node_observation_receipts receipt
			where receipt.node_id = v_node.node_id and receipt.observed_at < v_cutoff
				and receipt.observation_id <> v_node.observation_id
			order by receipt.observed_at, receipt.observation_id
			limit v_left);
		continue when cardinality(v_ids) = 0;
		delete from public.qorpera_runtime_node_inventory_receipts
		where node_id = v_node.node_id and observation_id = any(v_ids);
		get diagnostics v_count = row_count;
		v_inventories := v_inventories + v_count;
		delete from public.qorpera_runtime_node_observation_receipts
		where node_id = v_node.node_id and observation_id = any(v_ids);
		get diagnostics v_count = row_count;
		v_observations := v_observations + v_count;
		v_left := v_left - cardinality(v_ids);
	end loop;
	-- Health receipts (20260930485000): seven days, never the one a node's health latest row names. The meter
	-- does not read them, so it does not hold them back. Their own budget, from the history index
	-- (node_id, observed_at, observation_id) as above.
	v_health_left := p_limit;
	for v_node in
		select latest.node_id, latest.observation_id from public.qorpera_runtime_node_health_latest latest
		order by latest.node_id
	loop
		exit when v_health_left = 0;
		v_ids := array(
			select receipt.observation_id from public.qorpera_runtime_node_health_receipts receipt
			where receipt.node_id = v_node.node_id and receipt.observed_at < now() - interval '7 days'
				and receipt.observation_id <> v_node.observation_id
			order by receipt.observed_at, receipt.observation_id
			limit v_health_left);
		continue when cardinality(v_ids) = 0;
		delete from public.qorpera_runtime_node_health_receipts
		where node_id = v_node.node_id and observation_id = any(v_ids);
		get diagnostics v_count = row_count;
		v_health := v_health + v_count;
		v_health_left := v_health_left - cardinality(v_ids);
	end loop;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', false,
		'observations', v_observations, 'inventories', v_inventories, 'healthReceipts', v_health,
		'moreEligible', v_left = 0 or v_health_left = 0,
		'cutoff', v_cutoff, 'heldByMeter', v_cutoff < now() - interval '7 days', 'retentionDays', 7);
end
$$;
revoke all on function public.qorpera_purge_runtime_node_receipts(integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_purge_runtime_node_receipts(integer) is
	'Deletes at most p_limit (1-500) node observation receipts older than the retention cut, oldest first, each with its inventory row, and at most p_limit node health receipts older than seven days, oldest first; never a node''s latest. Owner only (pg_cron).';

-- Run by pg_cron as its owner; no API role may execute it (nothing else calls it).
create or replace function public.qorpera_run_runtime_node_receipt_retention()
returns jsonb
language plpgsql
security definer
set search_path = ''
-- The status row, too, is never waited on for more than a second.
set lock_timeout = '1s'
as $$
declare
	v_started timestamptz := clock_timestamp();
	v_step jsonb;
	v_calls integer := 0;
	v_observations bigint := 0;
	v_inventories bigint := 0;
	v_health bigint := 0;
	v_stopped text := 'done';
	v_cutoff timestamptz;
	v_held boolean;
	v_since timestamptz;
begin
	loop
		begin
			v_step := public.qorpera_purge_runtime_node_receipts(500);
		exception when lock_not_available then
			v_stopped := 'lock_timeout';
			exit;
		end;
		if (v_step ->> 'busy')::boolean then
			v_stopped := 'busy';
			exit;
		end if;
		v_calls := v_calls + 1;
		v_observations := v_observations + (v_step ->> 'observations')::bigint;
		v_inventories := v_inventories + (v_step ->> 'inventories')::bigint;
		v_health := v_health + (v_step ->> 'healthReceipts')::bigint;
		v_cutoff := (v_step ->> 'cutoff')::timestamptz;
		v_held := (v_step ->> 'heldByMeter')::boolean;
		exit when not (v_step ->> 'moreEligible')::boolean;
		-- Hourly (20260930483000): an hour of all three kinds is about three calls; the rest is for catching up.
		if v_calls >= 30 then
			v_stopped := 'call_limit';
			exit;
		end if;
		if clock_timestamp() - v_started >= interval '20 seconds' then
			v_stopped := 'time_budget';
			exit;
		end if;
	end loop;
	-- The outcome, for operators. A run that purged nothing (busy, lock timeout) keeps the last known cut.
	-- Recording must never fail the run: any error is a warning and the run's deletes stand.
	begin
		insert into public.qorpera_runtime_node_receipt_retention_status as status (id, ran_at, stopped, calls,
			observations, inventories, health_receipts, cutoff, held_by_meter, held_by_meter_since)
		values (true, clock_timestamp(), v_stopped, v_calls, v_observations, v_inventories, v_health, v_cutoff, v_held,
			-- The hold began when the meter fell six days behind: metered_until plus six days, the cut plus seven.
			case when v_held then v_cutoff + interval '7 days' end)
		on conflict (id) do update set ran_at = excluded.ran_at, stopped = excluded.stopped, calls = excluded.calls,
			observations = excluded.observations, inventories = excluded.inventories,
			health_receipts = excluded.health_receipts,
			cutoff = coalesce(excluded.cutoff, status.cutoff),
			held_by_meter = coalesce(excluded.held_by_meter, status.held_by_meter),
			held_by_meter_since = case
				when excluded.held_by_meter is null then status.held_by_meter_since
				when excluded.held_by_meter then coalesce(status.held_by_meter_since, excluded.held_by_meter_since)
			end
		returning status.held_by_meter_since into v_since;
	exception when others then
		raise warning 'Node receipt retention status was not recorded: % (%)', sqlerrm, sqlstate;
	end;
	if v_held then
		raise warning 'Node receipt retention is held back by the computer-hour meter since %: nothing observed after % is deleted',
			coalesce(v_since, v_cutoff + interval '7 days'), v_cutoff;
	end if;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-run/v1', 'stopped', v_stopped,
		'calls', v_calls, 'observations', v_observations, 'inventories', v_inventories, 'healthReceipts', v_health,
		'cutoff', v_cutoff, 'heldByMeter', v_held);
end
$$;
revoke all on function public.qorpera_run_runtime_node_receipt_retention()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- What the next bundle activation's guard looks for, and no delete left on the observers' path.
do $check$ begin
	if position('qorpera_runtime_node_health_receipts' in pg_get_functiondef('public.qorpera_purge_runtime_node_receipts(integer)'::regprocedure)) = 0
		or position('delete from' in pg_get_functiondef('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure)) > 0 then
		raise exception '20260930485000 did not apply as reviewed';
	end if;
end $check$;
