-- Node inventory and observation receipts: keep the latest plus seven days (session build-up audit,
-- 2026-10-03, gap 5).
--
-- Each node's observer publishes a report about every five seconds: a row in
-- qorpera_runtime_node_observation_receipts and, when its inventory scan succeeds, one in
-- qorpera_runtime_node_inventory_receipts. Nothing ever deleted them (20260908003700: "no automatic expiry
-- deletes ... observation evidence"); in production they were 904 MB and 335 MB after 20 days, about 78 %
-- of the database. Node health receipts already keep seven days (20260924060000, 20260928248935).
--
-- Kept, per node:
-- * the receipt its latest row names (qorpera_runtime_node_observations), with its inventory if it has
--   one. That is the one receipt admission, placement, capacity, wake checks and the operator pages read,
--   at any age; a node whose latest report has no inventory reads as INVENTORY_MISSING whatever older
--   receipts exist, so nothing older is kept for it;
-- * every receipt observed in the last seven days;
-- * every receipt the computer-hour meter may still read: the cut is at most its metered_until minus one
--   day, so a meter more than six days behind holds retention back instead of losing reports it counts.
-- Deleted: the other receipts, oldest first, each with its inventory row. That row's foreign key is the
-- only one into either table, and neither table has triggers.
-- An exact replay of a deleted receipt is refused: it is over seven days old, far outside the 60 seconds
-- qorpera_observe_runtime_node accepts for a new observation, so it is refused as not current; the latest
-- row, which the out-of-order check reads, is never deleted.
-- Older history is gone: computer history and lifecycle windows older than seven days report unknown
-- intervals, and qorpera_runtime_host_inventory refuses a deleted observation ID as unavailable.
--
-- qorpera_purge_runtime_node_receipts(limit) deletes at most limit (1 to 500) receipts and their inventory
-- rows. Candidates come from the existing history index (node_id, observed_at, observation_id) below a cut
-- that is a value, so each read is one bounded index range; rows are deleted by primary key
-- (observation_id = any(array), no join). No new index is needed. It waits at most one second for any
-- lock (its own lock_timeout, 55P03, restored when it returns) and locks no node row, so the observer's
-- writes never wait on it. One call at a time (advisory lock). qorpera_run_runtime_node_receipt_retention()
-- makes up to ten such calls and stops at the first short one or after about a second; a call that times
-- out on a lock is undone alone and ends the run. statement_timeout cannot shorten a statement already
-- running, so the clock bounds the run instead. pg_cron runs it every five minutes, at minutes 2, 7, 12 and
-- so on (away from the every-five-minutes jobs at minute 0, 5, 10), as
-- 'qorpera-runtime-node-receipts-retention': up to 5,000 receipts a run, 1.44 million a day, against about
-- 35,000 new ones a day from two nodes. Freed space is reused by new receipts; the files do not shrink
-- (only VACUUM FULL would do that, and nothing here runs or schedules it).
--
-- Every run, busy and lock-timed-out ones included, records its outcome in
-- qorpera_runtime_node_receipt_retention_status (one row, private like the zero sweep's status,
-- 20260928249250), so a stalled retention shows: a stale ran_at, or held_by_meter with the time the hold
-- began in held_by_meter_since. A run held by the meter also logs a warning. Recording never fails a run.
--
-- Scheduling follows 20260928319370: where pg_cron is not installed, or the applying role may not use
-- it, nothing is scheduled and the migration still applies; after enabling it, run, as the role that
-- should own the job, select public.qorpera_schedule_runtime_node_receipt_retention(). Scheduling by the
-- same name replaces that one job, so running this file or the helper again is safe.
set local lock_timeout = '3s';

create table public.qorpera_runtime_node_receipt_retention_status (
	id boolean primary key default true check (id),
	ran_at timestamptz,
	stopped text check (stopped in ('done', 'call_limit', 'time_budget', 'busy', 'lock_timeout')),
	calls integer check (calls >= 0),
	observations bigint check (observations >= 0),
	inventories bigint check (inventories >= 0),
	cutoff timestamptz,
	held_by_meter boolean,
	-- When the computer-hour meter's hold began; null while it does not hold the cut.
	held_by_meter_since timestamptz,
	check (held_by_meter_since is null or held_by_meter)
);
insert into public.qorpera_runtime_node_receipt_retention_status (id) values (true);
alter table public.qorpera_runtime_node_receipt_retention_status enable row level security;
revoke all on public.qorpera_runtime_node_receipt_retention_status
	from public, anon, authenticated, service_role, qorpera_secret_broker;

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
begin
	if p_limit is null or p_limit not between 1 and 500 then
		raise exception 'Node receipt retention limit is invalid' using errcode = '22023';
	end if;
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.runtime-node-receipt-retention', 0)) then
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', true,
			'observations', 0, 'inventories', 0, 'moreEligible', false);
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
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention/v1', 'busy', false,
		'observations', v_observations, 'inventories', v_inventories, 'moreEligible', v_left = 0,
		'cutoff', v_cutoff, 'heldByMeter', v_cutoff < now() - interval '7 days', 'retentionDays', 7);
end
$$;
revoke all on function public.qorpera_purge_runtime_node_receipts(integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_purge_runtime_node_receipts(integer) is
	'Deletes at most p_limit (1-500) node observation receipts older than the retention cut, oldest first, each with its inventory row; never a node''s latest. Owner only (pg_cron).';

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
		v_cutoff := (v_step ->> 'cutoff')::timestamptz;
		v_held := (v_step ->> 'heldByMeter')::boolean;
		exit when not (v_step ->> 'moreEligible')::boolean;
		if v_calls >= 10 then
			v_stopped := 'call_limit';
			exit;
		end if;
		if clock_timestamp() - v_started >= interval '1 second' then
			v_stopped := 'time_budget';
			exit;
		end if;
	end loop;
	-- The outcome, for operators. A run that purged nothing (busy, lock timeout) keeps the last known cut.
	-- Recording must never fail the run: any error is a warning and the run's deletes stand.
	begin
		insert into public.qorpera_runtime_node_receipt_retention_status as status (id, ran_at, stopped, calls,
			observations, inventories, cutoff, held_by_meter, held_by_meter_since)
		values (true, clock_timestamp(), v_stopped, v_calls, v_observations, v_inventories, v_cutoff, v_held,
			-- The hold began when the meter fell six days behind: metered_until plus six days, the cut plus seven.
			case when v_held then v_cutoff + interval '7 days' end)
		on conflict (id) do update set ran_at = excluded.ran_at, stopped = excluded.stopped, calls = excluded.calls,
			observations = excluded.observations, inventories = excluded.inventories,
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
		'calls', v_calls, 'observations', v_observations, 'inventories', v_inventories,
		'cutoff', v_cutoff, 'heldByMeter', v_held);
end
$$;
revoke all on function public.qorpera_run_runtime_node_receipt_retention()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Migration and operator only. Runs as its caller, who then owns the job and runs it. Without pg_cron,
-- or for a caller that may not use it (no USAGE on schema cron, or no right to schedule), the answer is
-- scheduled false (with a warning in the second case), never a failed migration.
create or replace function public.qorpera_schedule_runtime_node_receipt_retention()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	v_job bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', false);
	end if;
	begin
		-- Looking up a function in schema cron already needs USAGE on it.
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', false);
		end if;
		-- Minutes 2, 7, 12, ...: never with the every-five-minutes jobs at minutes 0, 5, 10, ...
		v_job := cron.schedule('qorpera-runtime-node-receipts-retention', '2-59/5 * * * *',
			'select public.qorpera_run_runtime_node_receipt_retention()');
	exception when insufficient_privilege then
		raise warning 'Node receipt retention was not scheduled: % may not use pg_cron', current_user;
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-retention-schedule/v1', 'scheduled', true,
		'jobId', v_job);
end
$$;
revoke all on function public.qorpera_schedule_runtime_node_receipt_retention()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select public.qorpera_schedule_runtime_node_receipt_retention();
