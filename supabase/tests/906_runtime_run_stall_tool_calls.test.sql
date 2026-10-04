-- @fixture 830_runtime_run_no_progress_notice.test.sql until "-- A. A run that just started is working"
-- Gap 4's correction (migration 20260930051000): a tool call open for 15 minutes is a run without progress like any other.
-- With the records the runtime writes for a turn and an acting tool call (the turn's start and its result fence, then the
-- call's start, its context authority's start and finish, its action review's), a call that never finished stalls from
-- its last record, and the owner and the admin are told; the exemption the old function meant to make is gone. 830's
-- run, aged 30 minutes, so only observations are progress.

select pg_temp.age(30);

-- A. A turn opened 21 minutes ago and its acting call 20 minutes ago, never finished: the row names the stall from the
-- call's last record and the routine run's owner and admin are told.
do $$
declare v_sweep jsonb;
begin
	perform pg_temp.observe('model_turn', 'start', 21);
	perform pg_temp.observe('native_result_fence', 'start', 21);
	perform pg_temp.observe('native_result_fence', 'finish', 21);
	perform pg_temp.observe('send_mail', 'start', 20);
	perform pg_temp.observe('context_authority', 'start', 20);
	perform pg_temp.observe('context_authority', 'finish', 20);
	perform pg_temp.observe('action_review', 'start', 20);
	perform pg_temp.observe('action_review', 'finish', 20);
	if (pg_temp.bob() ->> 'no_progress_since')::timestamptz is distinct from (select max(ingested_at)
		from public.qorpera_runtime_observations where run_id = pg_temp.run()) then
		raise exception 'A: an open tool call stalls from its last record: %', pg_temp.bob(); end if;
	v_sweep := pg_temp.sweep();
	if v_sweep ->> 'opened' <> '2' or pg_temp.open_notices()
		<> '{"30000000-0000-4000-8000-000000000001": 1, "30000000-0000-4000-8000-000000000004": 1}' then
		raise exception 'A: the owner and the admin are told: % %', v_sweep, pg_temp.open_notices(); end if;
end $$;

-- B. A call made 5 minutes ago is no stall yet: the clock is the same for every record.
do $$
begin
	perform pg_temp.observe('machine_read', 'start', 5);
	perform pg_temp.observe('context_authority', 'start', 5);
	perform pg_temp.observe('context_authority', 'finish', 5);
	if pg_temp.bob() ? 'no_progress_since' then raise exception 'B: a 5-minute-old call is progress: %', pg_temp.bob(); end if;
end $$;

-- C. The exemption is gone, and the marker.
do $$
declare v_body text := pg_get_functiondef('public.qorpera_run_no_progress_since(uuid,timestamptz)'::regprocedure);
begin
	if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_run_waiting_on_tool') then
		raise exception 'C: qorpera_run_waiting_on_tool is dropped'; end if;
	if position('20260930051000' in v_body) = 0 or position('waiting_on_tool' in v_body) > 0 then
		raise exception 'C: qorpera_run_no_progress_since carries the marker and asks no tool exemption'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_run_no_progress_since(uuid,timestamptz)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_run_no_progress_since(uuid,timestamptz)', 'execute') then
		raise exception 'C: the function stays postgres-only'; end if;
end $$;

rollback;
