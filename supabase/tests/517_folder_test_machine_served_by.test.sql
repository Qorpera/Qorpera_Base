-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- A test machine's view and the folder service that serves it (20260930496000; F3 step 6, slice 6a-4:
-- deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md, "The service that served a view" and rule 5 of "Reads"), on 5a's
-- served_by (487 tests it for coding and code host views). The renewal needs the service's id and the first one names
-- it. A clean stop lets go of the view, which stays open for the next service. A renewal from another service while the
-- view is still named closes it as service_crashed: the old service may have served reads it never released. The
-- machine's next boot opens a new view. The office, machine, run and view helpers are 510's, 639's and 632's.

create function pg_temp.renew(p_view jsonb, p_service uuid) returns jsonb language sql as $$
	select public.qorpera_folder_view_renew((p_view ->> 'viewId')::uuid, p_view ->> 'pass', null, p_service)
$$;

-- Renew carries this migration's marker and the earlier ones, and is still the service's alone.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure);
begin
	if strpos(v_definition, '20260930496000') = 0 or strpos(v_definition, '20260930446000') = 0
		or strpos(v_definition, '20260930104000') = 0 then raise exception 'renew has lost a marker'; end if;
	if has_function_privilege('authenticated', 'public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', 'EXECUTE') then
		raise exception 'renew''s privileges changed'; end if;
end $$;


-- Renewed only with a service. The first renewal names it and the same service renews. Another service while it is
-- named: the view closes as service_crashed, stays closed and saves nothing. The machine's next boot opens a new view,
-- which the new service names.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); a jsonb := pg_temp.place(pg_temp.machine(v, 'crashed'));
	s jsonb := pg_temp.open_machine(a); s2 jsonb; r jsonb; w public.qorpera_folder_views%rowtype;
	old_service uuid := extensions.gen_random_uuid(); new_service uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.refused(format('select public.qorpera_folder_view_renew(%L, %L)', s ->> 'viewId', s ->> 'pass'), '22023',
		'Folder service is required');
	perform pg_temp.refused(format('select pg_temp.renew(%L, null)', s), '22023', 'Folder service is required');
	if (pg_temp.view_row(s)).served_by is not null then raise exception 'A test machine''s view opens served'; end if;
	r := pg_temp.renew(s, old_service);
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'test_machine' or r ->> 'machineId' is distinct from a ->> 'placementId'
		or r ->> 'companyId' is distinct from '63200000-0000-4000-8000-000000000010' or r -> 'codingMachineId' is distinct from 'null'::jsonb
		or (pg_temp.view_row(s)).served_by is distinct from old_service then
		raise exception 'First renewal: %', r; end if;
	if pg_temp.renew(s, old_service) ->> 'state' is distinct from 'open' or (pg_temp.view_row(s)).served_by is distinct from old_service then
		raise exception 'The same service renews'; end if;
	-- The service crashed: the next one renews.
	r := pg_temp.renew(s, new_service);
	w := pg_temp.view_row(s);
	if r ->> 'state' is distinct from 'closed' or r ->> 'reason' is distinct from 'service_crashed' or r ? 'kind'
		or w.state <> 'closed' or w.close_reason is distinct from 'service_crashed' or w.closed_at is null then
		raise exception 'Another service closes the view: % %', r, to_jsonb(w); end if;
	if pg_temp.renew(s, new_service) ->> 'reason' is distinct from 'service_crashed'
		or pg_temp.renew(s, old_service) ->> 'reason' is distinct from 'service_crashed' then
		raise exception 'A crashed view stays closed'; end if;
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'tm-crashed', '[{"op":"mkdir","path":"refused"}]'),
		'42501', 'Folder view has ended');
	-- The executor restarts the machine: its next boot opens a new view, which the new service names.
	s2 := pg_temp.open_machine(pg_temp.reboot(a));
	if (pg_temp.view_row(s2)).served_by is not null or pg_temp.renew(s2, new_service) ->> 'state' is distinct from 'open'
		or (pg_temp.view_row(s2)).served_by is distinct from new_service then
		raise exception 'The next boot''s view: %', to_jsonb(pg_temp.view_row(s2)); end if;
	perform public.qorpera_folder_view_close((s2 ->> 'viewId')::uuid, s2 ->> 'pass');
end $$;


-- A clean stop lets go of the service's views: they stay open, and the next service names them.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	s jsonb := pg_temp.open_machine(pg_temp.place(pg_temp.machine(v, 'stopped'))); old_service uuid := extensions.gen_random_uuid(); new_service uuid := extensions.gen_random_uuid(); r jsonb; w public.qorpera_folder_views%rowtype;
begin
	if pg_temp.renew(s, old_service) ->> 'state' is distinct from 'open' then raise exception 'First renewal'; end if;
	if public.qorpera_folder_service_stopped(old_service) is distinct from 1 then raise exception 'The stop counts the service''s view'; end if;
	w := pg_temp.view_row(s);
	if w.served_by is not null or w.state <> 'open' then raise exception 'A stopped service''s view stays open, served by no one'; end if;
	r := pg_temp.renew(s, new_service);
	if r ->> 'state' is distinct from 'open' or (pg_temp.view_row(s)).served_by is distinct from new_service then
		raise exception 'The next service takes over: %', r; end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;
