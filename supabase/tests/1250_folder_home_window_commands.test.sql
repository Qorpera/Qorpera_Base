-- @fixture 511_folder_test_machine_access.test.sql until "-- 1. build-a's disk never had a view"
-- A home takes no ordinary machine command (20260930754000; the agent's home slice 3). A window bounds what the home's
-- shell sees of the company folder, but not what a command leaves elsewhere on the disk: a run could copy a file it may
-- read out of the folder, and a later run's `machine_run` would print the copy. Reading the folder's root is not enough
-- to admit that command, because the window's run may have read a narrower folder the caller holds no grant on. So once
-- a placement has had a window, every machine command there (start, read, cancel) is refused, whoever asks. The home's
-- own work goes through the window and its calls. 511's build-a, its binding and its command helpers are the fixture's.

-- The run actor of 628's binding (Alice's leased run), which opens its own window.
create function pg_temp.hc_run() returns jsonb language sql as $$
	select jsonb_build_object('kind','run','runId',b ->> 'runId','jobId',b ->> 'jobId','runnerId',b ->> 'runnerId',
		'assignmentId',b ->> 'assignmentId')
	from (select pg_temp.mc_binding() b) x
$$;
create function pg_temp.hc_open() returns jsonb language sql as $$
	select public.qorpera_folder_view_open((pg_temp.mc_machine('build-a')).environment_id, pg_temp.hc_run(), 'home_window',
		jsonb_build_object('companyMachineId', (pg_temp.mc_machine('build-a')).id,
			'placementId', (pg_temp.mc_placement('build-a')).id, 'bootId', (pg_temp.mc_placement('build-a')).boot_id))
$$;


-- Before the window: build-a's disk has had no view, so its commands run as they do today (511 §1), and the caller
-- reads the root.
do $$
declare v_window jsonb;
begin
	perform pg_temp.base_assert(pg_temp.reads_root()
		and not exists (select 1 from public.qorpera_folder_views where placement_id = (pg_temp.mc_placement('build-a')).id),
		'build-a''s disk has had no view and its caller reads the root');
	perform pg_temp.base_assert(pg_temp.mc_run('51100000-0000-4000-8000-000000000021', 'hc-before', repeat('3', 64),
			'build-a', 'npm test', false) ->> 'state' = 'authorized',
		'A disk that never had a view takes a command');
	perform pg_temp.base_assert(pg_temp.command('read', '51100000-0000-4000-8000-000000000021') ->> 'executorOwner' = 'mx-a',
		'A disk that never had a view answers a read of its command');
	-- The run opens its own window on that disk.
	v_window := pg_temp.hc_open();
	perform pg_temp.base_assert((select kind from public.qorpera_folder_views where id = (v_window ->> 'viewId')::uuid)
		= 'home_window', 'The window: ' || v_window::text);
	-- From now on no machine command runs there, although the caller still reads the root: the window's run may have
	-- read a narrower folder than this caller may.
	perform pg_temp.base_assert(pg_temp.reads_root(), 'The caller still reads the root');
	perform pg_temp.refused($q$select pg_temp.command('read', '51100000-0000-4000-8000-000000000021')$q$, '42501',
		'This machine is an agent''s home', 'qorpera.home-window/home-machine');
	perform pg_temp.refused($q$select pg_temp.command('cancel', '51100000-0000-4000-8000-000000000021')$q$, '42501',
		'This machine is an agent''s home', 'qorpera.home-window/home-machine');
	perform pg_temp.refused($q$select pg_temp.mc_run('51100000-0000-4000-8000-000000000009', 'hc-start', repeat('2', 64),
		'build-a', 'npm test', false)$q$, '42501', 'This machine is an agent''s home',
		'qorpera.home-window/home-machine');
	-- A closed window leaves the disk a home: what its run read is still on it.
	perform public.qorpera_folder_view_close((v_window ->> 'viewId')::uuid, v_window ->> 'pass');
	perform pg_temp.refused($q$select pg_temp.command('read', '51100000-0000-4000-8000-000000000021')$q$, '42501',
		'This machine is an agent''s home', 'qorpera.home-window/home-machine');
	-- The company-wide view still opens there (today's rule: the starter reads the root, 20260930420000), and it carries
	-- the window's reads as the placement's newest view. The disk stays one no command runs on: it still holds what the
	-- window's run read, so the executor moves the machine to a new disk.
	v_window := pg_temp.open_build_a();
	perform pg_temp.base_assert((select kind from public.qorpera_folder_views
		where id = (v_window ->> 'viewId')::uuid) = 'test_machine',
		'The company-wide view opens on a disk whose starter reads the root');
	perform pg_temp.refused($q$select pg_temp.command('read', '51100000-0000-4000-8000-000000000021')$q$, '42501',
		'This machine is an agent''s home', 'qorpera.home-window/home-machine');
end $$;
