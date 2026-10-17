-- @fixture 523_coding_machine_folder_restart.test.sql until "-- 1. A crashed service's coding view marks its machine"
-- A member coding machine is not put to sleep under a turn (20260924220000's `live` guard, in the list as 20260928187000
-- and 20260928319760 left it). Its last use and its last busy check-in are both past the sleep delay, as after a long
-- turn whose guest stayed quiet. While a session holds a leased turn on it (preparing, running or publishing),
-- qorpera_list_coding_machines does not say sleepDue and its stop custody refuses (MACHINE_IN_USE; the machine is not
-- marked for a folder restart, which 523 covers). Once that lease runs
-- out, the same machine is due to sleep and its stop is granted. 523's node, executor exec-1 and helpers; exec-1's
-- machine policy is the machines' binding, so they are current (not superseded).

-- exec-1's policy and a sleep delay of 10 minutes.
select pg_temp.fx(format('update public.qorpera_coding_executors set vm_policy = %L, machine_sleep_after_seconds = 600
	where environment_id = %L and owner = %L', jsonb_build_object('providerPolicySha256', repeat('d', 64)),
	'63200000-0000-4000-8000-000000000020', 'exec-1'));

-- A machine's entry in the executor's list.
create function pg_temp.aw_entry(p_machine uuid) returns jsonb language plpgsql as $$
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	return (select entry from jsonb_array_elements(public.qorpera_list_coding_machines('exec-1', pg_temp.fr_node())) entry
		where entry ->> 'machineId' = p_machine::text);
end $$;

do $$
declare cm uuid := pg_temp.fr_machine(); s jsonb := pg_temp.fr_session(cm); e jsonb; r jsonb; v_phase text;
begin
	-- Used and last busy 11 minutes ago.
	perform pg_temp.fx(format('update public.qorpera_coding_machines set last_used_at = clock_timestamp() - interval %L,
		busy_at = clock_timestamp() - interval %L where id = %L', '11 minutes', '11 minutes', cm));
	foreach v_phase in array array['preparing', 'running', 'publishing'] loop
		perform pg_temp.fx(format('update public.qorpera_coding_sessions set phase = %L, lease_owner = %L,
			lease_token = extensions.gen_random_uuid(), lease_until = clock_timestamp() + interval %L, started_at = clock_timestamp(),
			vm_allocation_id = attached_machine_id where worker_id = %L', v_phase, 'exec-1', '5 minutes', s ->> 'workerId'));
		e := pg_temp.aw_entry(cm);
		if e is null or (e ->> 'live')::boolean is not true or (e ->> 'reserved')::boolean is not true
			or (e ->> 'superseded')::boolean is not false or (e ->> 'sleepDue')::boolean is not false then
			raise exception 'A leased turn (%) keeps its quiet machine awake: %', v_phase, e; end if;
		r := pg_temp.fr_custody(cm, 'stop');
		if r is distinct from '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb then
			raise exception 'Its stop waits (%): %', v_phase, r; end if;
	end loop;
	if (select stop_authorized_at from public.qorpera_coding_machines where id = cm) is not null then
		raise exception 'No stop was granted under the turn'; end if;
	-- The lease runs out, with the turn still publishing.
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval %L
		where worker_id = %L', '1 second', s ->> 'workerId'));
	e := pg_temp.aw_entry(cm);
	if e is null or (e ->> 'live')::boolean is not false or (e ->> 'sleepDue')::boolean is not true then
		raise exception 'With no turn holding it, the quiet machine is due to sleep: %', e; end if;
	r := pg_temp.fr_custody(cm, 'stop');
	if r ->> 'intent' is distinct from 'stop' or (select stop_authorized_at from public.qorpera_coding_machines where id = cm) is null then
		raise exception 'And its stop is granted: %', r; end if;
end $$;

rollback;
