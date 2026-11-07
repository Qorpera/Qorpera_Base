-- Node receipts older than two days keep one report in about 30 seconds, and every report that differs.
--
-- Each of the two nodes files a report every five seconds: an observation receipt and an inventory receipt, kept for
-- seven days. Measured in production on 7 November 2026: 98.2 % of the reports of the last half hour were byte for byte
-- the same as the one before (690 of 703, ignoring id and time). The two tables held 384 MB of a 918 MB database after
-- 3.9 days (the copy at the 3 November move started them empty), on their way to about 690 MB by 10 November, when the
-- seven-day retention first deletes anything.
--
-- What reads an old report, and why it gets the same answer:
-- * qorpera_runtime_computer_history holds each report's state until the next report, for at most 60 seconds, and
--   merges neighbours with the same state. A report is only removed if it says the same as the report kept before it,
--   and if the next report is at most 30 seconds after that kept one. So the same state reaches the same second, and a
--   gap longer than 60 seconds stays exactly as it was. Its first and last observation ids may name other reports.
-- * The meter reads forward from its cursor, about a minute behind. The cut is never later than metered_until minus a
--   day, the hold the seven-day retention already has.
-- * qorpera_runtime_host_inventory with an id refuses a removed report as unavailable, as it does after seven days.
-- * Every other reader reads a node's latest report, which is never removed, or the last 24 hours at most.
--
-- This is node evidence, not customer data. The reason for changing its retention: the seven-day history stays complete
-- as an answer, at under half of the rows and about 400 MB less at its peak, and the rows it no longer keeps are copies of
-- the report before them.
--
-- How: qorpera_run_runtime_node_receipt_thinning(), hourly at minute 32 (off the retention's minute 2 and the
-- every-five-minutes jobs). A cursor in a private status row, so each report is looked at once: one hour's slice of
-- reports a run in the steady state. To catch up, a run takes more slices until it has removed 6,000 reports or 5 seconds
-- have passed: on a test machine with production's row shapes one slice removed 1,124 reports in 0.24 s and 6.3 MB of WAL.
-- That WAL is not new for long: from 10 November the seven-day retention would delete these same rows anyway. It shares
-- the retention's advisory lock, waits at most a second for any lock and locks no node row; deletes touch only rows the
-- observers never read again. The inventory row goes with its observation (the only foreign key into either table). Health receipts
-- are not thinned: the observer now samples them less often.
--
-- Undo: select cron.unschedule('qorpera-runtime-node-receipts-thinning'). Removed reports do not come back; nothing else
-- depends on the two functions or the status row.
set local lock_timeout = '3s';

create table public.qorpera_runtime_node_receipt_thinning_status (
	id boolean primary key default true check (id),
	-- Reports observed before this have been looked at.
	thinned_until timestamptz,
	ran_at timestamptz,
	stopped text check (stopped in ('done', 'row_limit', 'time_budget', 'busy', 'lock_timeout')),
	slices integer check (slices >= 0),
	observations bigint check (observations >= 0),
	inventories bigint check (inventories >= 0)
);
insert into public.qorpera_runtime_node_receipt_thinning_status (id) values (true);
alter table public.qorpera_runtime_node_receipt_thinning_status enable row level security;
revoke all on public.qorpera_runtime_node_receipt_thinning_status
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One slice of time, every node. The first report of a run of equal ones stays, then one every 30 seconds or so.
create function public.qorpera_thin_runtime_node_receipts(p_from timestamptz, p_until timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
	v_node record;
	v_report record;
	v_ids uuid[];
	v_kept_at timestamptz;
	v_kept jsonb;
	v_count integer;
	v_observations integer := 0;
	v_inventories integer := 0;
begin
	for v_node in
		select latest.node_id, latest.observation_id from public.qorpera_runtime_node_observations latest
		order by latest.node_id
	loop
		v_ids := '{}';
		-- The report just before the slice is the last one kept: everything before it has been looked at.
		select observation.observed_at,
			(observation.observation - array['observationId', 'observedAt']) || jsonb_build_object('inventory', inventory.inventory,
				'nodeVersion', inventory.node_version, 'policySha256', inventory.policy_sha256, 'contextSha256', inventory.context_sha256)
		into v_kept_at, v_kept
		from public.qorpera_runtime_node_observation_receipts observation
		left join public.qorpera_runtime_node_inventory_receipts inventory
			on inventory.node_id = observation.node_id and inventory.observation_id = observation.observation_id
		where observation.node_id = v_node.node_id and observation.observed_at < p_from
		order by observation.observed_at desc, observation.observation_id desc
		limit 1;
		-- A minute past the slice, to see the report after the slice's last.
		for v_report in
			select observation.observation_id, observation.observed_at,
				(observation.observation - array['observationId', 'observedAt']) || jsonb_build_object('inventory', inventory.inventory,
					'nodeVersion', inventory.node_version, 'policySha256', inventory.policy_sha256, 'contextSha256', inventory.context_sha256) as content,
				lead(observation.observed_at) over (order by observation.observed_at, observation.observation_id) as next_at
			from public.qorpera_runtime_node_observation_receipts observation
			left join public.qorpera_runtime_node_inventory_receipts inventory
				on inventory.node_id = observation.node_id and inventory.observation_id = observation.observation_id
			where observation.node_id = v_node.node_id and observation.observed_at >= p_from
				and observation.observed_at < p_until + interval '60 seconds'
			order by observation.observed_at, observation.observation_id
		loop
			exit when v_report.observed_at >= p_until;
			if v_report.observation_id <> v_node.observation_id and v_kept_at is not null and v_report.content = v_kept
				and v_report.next_at is not null and v_report.next_at - v_kept_at <= interval '30 seconds' then
				v_ids := v_ids || v_report.observation_id;
			else
				v_kept_at := v_report.observed_at;
				v_kept := v_report.content;
			end if;
		end loop;
		continue when cardinality(v_ids) = 0;
		delete from public.qorpera_runtime_node_inventory_receipts
		where node_id = v_node.node_id and observation_id = any(v_ids);
		get diagnostics v_count = row_count;
		v_inventories := v_inventories + v_count;
		delete from public.qorpera_runtime_node_observation_receipts
		where node_id = v_node.node_id and observation_id = any(v_ids);
		get diagnostics v_count = row_count;
		v_observations := v_observations + v_count;
	end loop;
	return jsonb_build_object('observations', v_observations, 'inventories', v_inventories);
end
$$;
revoke all on function public.qorpera_thin_runtime_node_receipts(timestamptz, timestamptz)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on function public.qorpera_thin_runtime_node_receipts(timestamptz, timestamptz) is
	'Removes the node reports observed in the window that say the same as the report kept before them, while the next report is at most 30 seconds after that one; never a node''s latest. Owner only (pg_cron).';

-- Run by pg_cron as its owner; no API role may execute it (nothing else calls it).
create function public.qorpera_run_runtime_node_receipt_thinning(p_row_limit integer default 6000)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $$
declare
	v_started timestamptz := clock_timestamp();
	v_meter timestamptz;
	v_cut timestamptz;
	v_start timestamptz;
	v_from timestamptz;
	v_until timestamptz;
	v_step jsonb;
	v_slices integer := 0;
	v_observations bigint := 0;
	v_inventories bigint := 0;
	v_stopped text := 'done';
begin
	-- The retention's lock: the two never run at once.
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.runtime-node-receipt-retention', 0)) then
		v_stopped := 'busy';
	else
		begin
			select meter.metered_until into v_meter from public.qorpera_computer_hour_meter meter;
			-- least() ignores a missing meter row.
			v_cut := least(now() - interval '48 hours', v_meter - interval '1 day');
			select greatest(status.thinned_until, now() - interval '7 days') into v_start
			from public.qorpera_runtime_node_receipt_thinning_status status;
			v_from := v_start;
			loop
				exit when v_from >= v_cut;
				if v_observations >= p_row_limit then
					v_stopped := 'row_limit';
					exit;
				end if;
				if clock_timestamp() - v_started >= interval '5 seconds' then
					v_stopped := 'time_budget';
					exit;
				end if;
				v_until := least(v_from + interval '1 hour', v_cut);
				v_step := public.qorpera_thin_runtime_node_receipts(v_from, v_until);
				v_observations := v_observations + (v_step ->> 'observations')::bigint;
				v_inventories := v_inventories + (v_step ->> 'inventories')::bigint;
				v_from := v_until;
				v_slices := v_slices + 1;
			end loop;
		exception when lock_not_available then
			-- This run's slices are undone with the block; the next run starts them again.
			v_stopped := 'lock_timeout';
			v_slices := 0;
			v_observations := 0;
			v_inventories := 0;
			v_from := null;
		end;
	end if;
	update public.qorpera_runtime_node_receipt_thinning_status
	set thinned_until = coalesce(v_from, thinned_until), ran_at = clock_timestamp(), stopped = v_stopped, slices = v_slices,
		observations = v_observations, inventories = v_inventories;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-thinning-run/v1', 'stopped', v_stopped, 'slices', v_slices,
		'observations', v_observations, 'inventories', v_inventories, 'thinnedUntil', v_from);
end
$$;
revoke all on function public.qorpera_run_runtime_node_receipt_thinning(integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- As qorpera_schedule_runtime_node_receipt_retention: where pg_cron is absent or the role may not use it, nothing is
-- scheduled and the migration still applies. Scheduling by the same name replaces that one job.
create function public.qorpera_schedule_runtime_node_receipt_thinning()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
	v_job bigint;
begin
	if to_regnamespace('cron') is null then
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-thinning-schedule/v1', 'scheduled', false);
	end if;
	begin
		if to_regprocedure('cron.schedule(text,text,text)') is null then
			return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-thinning-schedule/v1', 'scheduled', false);
		end if;
		v_job := cron.schedule('qorpera-runtime-node-receipts-thinning', '32 * * * *',
			'select public.qorpera_run_runtime_node_receipt_thinning()');
	exception when insufficient_privilege then
		raise warning 'Node receipt thinning was not scheduled: % may not use pg_cron', current_user;
		return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-thinning-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.runtime-node-receipt-thinning-schedule/v1', 'scheduled', true, 'jobId', v_job);
end
$$;
revoke all on function public.qorpera_schedule_runtime_node_receipt_thinning()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
select public.qorpera_schedule_runtime_node_receipt_thinning();
