-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- A test machine's reads (20260930480000; F3 step 6, slice 6a-3: deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md
-- "Reads", RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views" §6 and §8). A release through the machine's view lands in the
-- view's read set and in every run with a command running on the machine's disk whose job is leased, each checked for
-- its own authority. A run takes in the view's reads when its agent and member read the root. Each read set is
-- rechecked at its own commits. The office, machine, run and view helpers are 510's, 639's and 632's; the command
-- helpers are 512's.

-- A command on the anchor's machine and placement, from the run (its agent and requester), started at p_started.
create function pg_temp.cmd(p_anchor jsonb, p_run jsonb, p_started timestamptz) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify,
		started_at, sent_at, requested_by_user_id)
	select v_id, (p_anchor ->> 'companyMachineId')::uuid, r.id, r.staff_agent_id, (p_anchor ->> 'placementId')::uuid, 'npm test', false,
		p_started, p_started, r.requested_by_user_id
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.end_cmd(p_id uuid) returns void language sql as $$
	select pg_temp.fx(format('update public.qorpera_company_machine_commands set ended_at = clock_timestamp(), state = ''succeeded'',
		exit_code = 0 where id = %L', p_id))
$$;
-- The view reads the path and releases it under the release id.
create function pg_temp.release(p_view jsonb, p_release uuid, p_path text) returns jsonb language plpgsql as $$
declare e jsonb := pg_temp.read(p_path, pg_temp.vactor(p_view)) -> 'entry';
begin
	return public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_release,
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')), repeat('6', 64));
end $$;
-- Whether the run's records (or the view's) hold the path under the release id.
create function pg_temp.run_has(p_run jsonb, p_release uuid, p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_run_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.run_id = (p_run ->> 'runId')::uuid and rec.release_id = p_release and x ->> 'path' = p_path)
$$;
create function pg_temp.view_has(p_view jsonb, p_release uuid, p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.view_id = (p_view ->> 'viewId')::uuid and rec.release_id = p_release and x ->> 'path' = p_path)
		and exists (select 1 from public.qorpera_folder_view_reads where view_id = (p_view ->> 'viewId')::uuid)
$$;
-- Whether the run's read set holds a pair of agent B's grant.
create function pg_temp.b_pair(p_run jsonb) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_run_reads rr join public.qorpera_company_path_grants g on g.id = rr.grant_id
		where rr.run_id = (p_run ->> 'runId')::uuid and g.principal_kind = 'staff_agent' and g.principal_id = '63200000-0000-4000-8000-0000000000a2')
$$;
-- The runs' ids in id order, as a release lists them.
create function pg_temp.ids(variadic p_runs jsonb[]) returns jsonb language sql as $$
	select coalesce(jsonb_agg(t.id order by t.id), '[]'::jsonb) from (select (r ->> 'runId')::uuid as id from unnest(p_runs) r) t
$$;
-- Agent B loses every grant (the root's too).
create function pg_temp.b_revoked() returns void language sql as $$
	select pg_temp.fx('update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where principal_kind = ''staff_agent''
		and principal_id = ''63200000-0000-4000-8000-0000000000a2'' and revoked_at is null')
$$;
create function pg_temp.inherit(p_run jsonb, p_view jsonb, p_id uuid) returns jsonb language sql as $$
	select public.qorpera_folder_run_inherit_view_reads('63200000-0000-4000-8000-000000000020', p_run, (p_view ->> 'viewId')::uuid, p_id)
$$;

-- The migration's marker is in the release and the take-in; the release keeps 5a's marker (20260930445000), and the
-- take-in keeps the code host's (20260930446000) and its "is distinct from" comparison of the agent and member.
do $$
declare f regprocedure; v_inherit text;
begin
	foreach f in array array['public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)',
		'public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)']::regprocedure[] loop
		if strpos(pg_get_functiondef(f), '20260930480000') = 0 then raise exception '% has no marker 20260930480000', f; end if;
	end loop;
	if strpos(pg_get_functiondef('public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)'::regprocedure),
		'20260930445000') = 0 then
		raise exception 'The release lost 5a''s marker 20260930445000'; end if;
	v_inherit := pg_get_functiondef('public.qorpera_folder_run_inherit_view_reads(uuid,jsonb,uuid,uuid)'::regprocedure);
	if strpos(v_inherit, '20260930446000') = 0 or strpos(v_inherit, 'v_view.staff_agent_id <>') > 0
		or strpos(v_inherit, 'v_view.member_user_id <>') > 0 then
		raise exception 'The take-in lost the code host''s comparison (20260930446000)'; end if;
end $$;

-- Setup: tmr/ with two files, which the machines read.
do $$
declare a jsonb := pg_temp.stage('test machine reads');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'tmr-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','tmr'),
		jsonb_build_object('op','write','path','tmr/a.txt','file',a), jsonb_build_object('op','write','path','tmr/b.txt','file',a))), 3, 'saved');
end $$;

-- Fan-out: a release reaches the view, the starter's live run and every run with a command running on the machine's
-- disk whose job is leased, here agent A's run for another member and agent B's run, in id order. A run whose command
-- ended, whose job's lease lapsed, or whose command runs on the machine's earlier disk gets nothing. Agent B's run gets
-- the read with agent B's own grant. A replay lists the same runs.
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; c_m4 constant uuid := '63200000-0000-4000-8000-000000000004';
	v jsonb := pg_temp.run('human', c_m2); w jsonb := pg_temp.run('human', c_m4); vb jsonb := pg_temp.agent_b(c_m2);
	ve jsonb := pg_temp.run('human', c_m2); vl jsonb := pg_temp.run('human', c_m2); vo jsonb := pg_temp.run('human', c_m2);
	m uuid := pg_temp.machine(v, 'reads-fan-out'); a0 jsonb := pg_temp.place(m); a jsonb; s jsonb; r jsonb; r2 jsonb;
	rid uuid := extensions.gen_random_uuid(); rid2 uuid := extensions.gen_random_uuid(); c_w uuid; c_b uuid; c_e uuid;
begin
	perform pg_temp.cmd(a0, vo, clock_timestamp() - interval '9 minutes');
	a := pg_temp.place(m); s := pg_temp.open_machine(a);
	c_w := pg_temp.cmd(a, w, clock_timestamp() - interval '5 minutes');
	c_b := pg_temp.cmd(a, vb, clock_timestamp() - interval '4 minutes');
	c_e := pg_temp.cmd(a, ve, clock_timestamp() - interval '3 minutes'); perform pg_temp.end_cmd(c_e);
	perform pg_temp.cmd(a, vl, clock_timestamp() - interval '2 minutes'); perform pg_temp.lapse(vl);
	r := pg_temp.release(s, rid, 'tmr/a.txt');
	if r -> 'runIds' is distinct from pg_temp.ids(v, w, vb) or r ->> 'runId' is distinct from v ->> 'runId' then
		raise exception 'The release reaches the live run and the running commands'' runs: %', r; end if;
	if not pg_temp.view_has(s, rid, 'tmr/a.txt') or not pg_temp.run_has(v, rid, 'tmr/a.txt') or not pg_temp.run_has(w, rid, 'tmr/a.txt')
		or not pg_temp.run_has(vb, rid, 'tmr/a.txt') then
		raise exception 'The read lands in the view''s read set and in each run''s'; end if;
	if exists (select 1 from public.qorpera_folder_run_read_records where run_id in ((ve ->> 'runId')::uuid, (vl ->> 'runId')::uuid,
			(vo ->> 'runId')::uuid))
		or exists (select 1 from public.qorpera_folder_run_reads where run_id in ((ve ->> 'runId')::uuid, (vl ->> 'runId')::uuid,
			(vo ->> 'runId')::uuid)) then
		raise exception 'An ended command, a lapsed job or an earlier disk gets nothing'; end if;
	if not pg_temp.b_pair(vb) or pg_temp.b_pair(w) then raise exception 'Agent B''s run reads with its own grant'; end if;
	r2 := pg_temp.release(s, rid, 'tmr/a.txt');
	if (r2 ->> 'replay')::boolean is not true or r2 -> 'runIds' is distinct from r -> 'runIds' then
		raise exception 'A replay: %', r2; end if;
	-- Rank 10, for each read set at its own commits: once agent B loses its grants, B's run is refused for what the
	-- machine read, while the machine still saves (its starter reads the root), and a release that reaches B's run is
	-- refused; once tmr/ narrows, the machine and the other member's run are refused (each undone after).
	begin
		perform pg_temp.b_revoked();
		perform pg_temp.refused(format('select pg_temp.commit(%L, %L, %L)', vb, 'tmr-b-narrowed', '[{"op":"mkdir","path":"refused"}]'),
			'42501', 'A read is no longer readable');
		perform pg_temp.expect(pg_temp.vcommit(s, 'tmr-machine-b-narrowed', '[{"op":"mkdir","path":"by-tmr-b-narrowed"}]'), 1, 'saved');
		perform pg_temp.refused(format('select pg_temp.release(%L, %L, %L)', s, extensions.gen_random_uuid(), 'tmr/b.txt'),
			'42501', 'A released read is no longer readable');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'tmr', 'subtree',
			'company_shared', 'normal');
		perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', s, 'tmr-narrowed', '[{"op":"mkdir","path":"refused"}]'),
			'42501', 'A read is no longer readable');
		perform pg_temp.refused(format('select pg_temp.commit(%L, %L, %L)', w, 'tmr-w-narrowed', '[{"op":"mkdir","path":"refused"}]'),
			'42501', 'A read is no longer readable');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	-- With no command running and the starter's job lapsed, a read lands in the view's read set only.
	perform pg_temp.end_cmd(c_w); perform pg_temp.end_cmd(c_b); perform pg_temp.lapse(v);
	r := pg_temp.release(s, rid2, 'tmr/b.txt');
	if r -> 'runIds' is distinct from '[]'::jsonb or r ->> 'runId' is not null or not pg_temp.view_has(s, rid2, 'tmr/b.txt')
		or exists (select 1 from public.qorpera_folder_run_read_records where release_id = rid2) then
		raise exception 'A read while no command runs: %', r; end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;

-- Take-in: agent B's run for another member takes in the machine's reads, with B's own grant, since both read the
-- root. Refused without the root read, and for a run without the company audience. Another agent's run still takes in
-- no other kind of view. A take-in that finds a read no longer readable raises (each undone after).
do $$
declare c_m2 constant uuid := '63200000-0000-4000-8000-000000000002'; c_m4 constant uuid := '63200000-0000-4000-8000-000000000004';
	v jsonb := pg_temp.run('human', c_m2); m uuid := pg_temp.machine(v, 'reads-take-in'); a jsonb := pg_temp.place(m); s jsonb;
	vb jsonb := pg_temp.agent_b(c_m4); ih uuid := extensions.gen_random_uuid(); r jsonb; s2 jsonb; s3 jsonb;
	c_refused constant text := 'A run inherits a test machine''s reads only with the company-wide view';
begin
	s := pg_temp.open_machine(a);
	perform pg_temp.release(s, extensions.gen_random_uuid(), 'tmr/a.txt');
	begin
		perform pg_temp.b_revoked();
		perform pg_temp.refused(format('select pg_temp.inherit(%L, %L, %L)', vb, s, extensions.gen_random_uuid()), '42501', c_refused);
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	perform pg_temp.refused(format('select pg_temp.inherit(%L, %L, %L)', pg_temp.run('human', c_m4, 'member_private'), s,
		extensions.gen_random_uuid()), '42501', c_refused);
	perform pg_temp.refused(format('select pg_temp.inherit(%L, %L, %L)', vb, pg_temp.open('run_box', '{}', v), extensions.gen_random_uuid()),
		'42501', 'A run inherits only its own agent''s and member''s views');
	begin
		perform public.qorpera_folder_set_resource('63200000-0000-4000-8000-000000000020', pg_temp.member(1), 'tmr', 'subtree',
			'company_shared', 'normal');
		perform pg_temp.refused(format('select pg_temp.inherit(%L, %L, %L)', vb, s, extensions.gen_random_uuid()), '42501',
			'A released read is no longer readable');
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	r := pg_temp.inherit(vb, s, ih);
	if (r ->> 'reads')::integer is distinct from 1 or not pg_temp.run_has(vb, ih, 'tmr/a.txt') or not pg_temp.b_pair(vb) then
		raise exception 'Agent B''s run takes in the machine''s reads: %', r; end if;
	-- The read set lives with the disk (510): the next boot carries it, a new disk starts clean.
	s2 := pg_temp.open_machine(pg_temp.reboot(a));
	if not exists (select 1 from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.view_id = (s2 ->> 'viewId')::uuid and x ->> 'path' = 'tmr/a.txt') then
		raise exception 'The next boot carries the disk''s reads'; end if;
	s3 := pg_temp.open_machine(pg_temp.place(m));
	if exists (select 1 from public.qorpera_folder_view_read_records where view_id = (s3 ->> 'viewId')::uuid)
		or exists (select 1 from public.qorpera_folder_view_reads where view_id = (s3 ->> 'viewId')::uuid) then
		raise exception 'A new disk starts clean'; end if;
	perform public.qorpera_folder_view_close((s3 ->> 'viewId')::uuid, s3 ->> 'pass');
end $$;
