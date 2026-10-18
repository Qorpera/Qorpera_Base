-- @fixture 981_folder_view_shell_commands.test.sql until "-- The migration's marker is in every function it patches"
-- MC3c, the core's half (20260930516000; deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md, "Where the cache lives" and
-- decision 1, amended 18 October 2026). A company machine's folder program keeps its caches on the machine's disk and
-- serves them without asking the core, so a cache made in one view must never show in a view of different authority.
-- - A machine's desktops share one cache, `cache/desktop`. That is sound only while every desktop view reads the same
--   company-wide set whoever holds it: this test pins that set for each kind of holder, and fails if a desktop view
--   ever reads less (a shared cache would hand it files it may not read) or more (it would fill the cache with them).
-- - A command's mount uses its owner's cache, `cache/<owner>`, so a command's view answers its owner; a desktop's does not.
-- - A company-wide view (a desktop or a command) renews only while its agent and member still read the root, as its
--   open required. The folder service renews every 40 s; from the closure the core refuses every read and publish, a
--   command's mount ends, and a desktop's ends after its 60 s handoff grace (at most 40 + 60 s; the migration's header).
--   Closing a view deletes nothing: the cache stays where it is, and removing old caches is the folder program's (MC3b).
-- The office, screen and helpers are 639's and 981's.

-- Whether a view reads a path (a read the view may not make is not found).
create function pg_temp.sees(p_view jsonb, p_path text) returns boolean language sql as $$
	select coalesce((public.qorpera_folder_read('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_path)
		->> 'found')::boolean, false)
$$;
-- The company-wide set (20260928259230:258-288): the root's files and rules/, and never a narrower resource (secret/,
-- which agent A and every member read) or a member's private folder (member 2's, below).
create function pg_temp.company_wide(p_view jsonb, p_holder text) returns void language plpgsql as $$
begin
	if not pg_temp.sees(p_view, 'shared/a.txt') or not pg_temp.sees(p_view, 'rules/tone.txt') then
		raise exception 'A desktop view held by % reads less than the company-wide set', p_holder; end if;
	if pg_temp.sees(p_view, 'secret/s.txt') or pg_temp.sees(p_view, 'members/63200000-0000-4000-8000-000000000002/private/p.txt') then
		raise exception 'A desktop view held by % reads more than the company-wide set', p_holder; end if;
end $$;
create function pg_temp.desktop(p_holder jsonb) returns jsonb language sql as $$
	select pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4') || p_holder)
$$;
create function pg_temp.renew(p_view jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_view_renew((p_view ->> 'viewId')::uuid, p_view ->> 'pass')
$$;
-- Agent A loses its root read: an owner revokes its live grants on the root.
create function pg_temp.revoke_root() returns void language plpgsql as $$
declare g public.qorpera_company_path_grants%rowtype;
begin
	for g in select x.* from public.qorpera_company_path_grants x
		join public.qorpera_company_path_resources r on r.id = x.resource_id
		where r.environment_id = '63200000-0000-4000-8000-000000000020' and r.path = '' and x.revoked_at is null
			and x.principal_kind = 'staff_agent' and x.principal_id = '63200000-0000-4000-8000-0000000000a1' loop
		perform public.qorpera_folder_revoke('63200000-0000-4000-8000-000000000020', pg_temp.member(1), g.resource_id, g.id);
	end loop;
	if public.qorpera_folder_reads_root('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
		'63200000-0000-4000-8000-0000000000a1', '63200000-0000-4000-8000-000000000002') then
		raise exception 'Agent A still reads the root'; end if;
end $$;
-- The mutation: renew with its root re-check reading true, as if the re-check were gone.
create function pg_temp.renew_without_recheck() returns void language plpgsql as $$
declare d text := pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure); m text;
begin
	m := regexp_replace(d, 'public\.qorpera_folder_reads_root\(v_view\.environment_id,\s*v_view\.profile_id,\s*'
		'v_view\.staff_agent_id,\s*v_view\.member_user_id\)', 'true');
	if m = d or strpos(m, 'qorpera_folder_reads_root') > 0 then
		raise exception 'Renew''s root re-check is not where this test expects it'; end if;
	execute m;
end $$;


-- The migration's marker is in both functions it patches; their privileges are as before.
do $$
declare f regprocedure;
begin
	foreach f in array array['public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)',
		'public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)']::regprocedure[] loop
		if strpos(pg_get_functiondef(f), '20260930516000') = 0 then raise exception '% has no marker 20260930516000', f; end if;
		if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
			or not has_function_privilege('service_role', f, 'EXECUTE') then raise exception '% privileges changed', f; end if;
	end loop;
end $$;


-- Setup: member 2's private folder, with a file in it. Member 2 reads it, and secret/.
do $$
declare a jsonb := pg_temp.stage('private');
	c_private constant text := 'members/63200000-0000-4000-8000-000000000002/private';
begin
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values ('63200000-0000-4000-8000-000000000020', c_private, 'subtree', 'member_private', '63200000-0000-4000-8000-000000000002',
		'normal', '63200000-0000-4000-8000-000000000002');
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'owner-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','members'),
		jsonb_build_object('op','mkdir','path','members/63200000-0000-4000-8000-000000000002'),
		jsonb_build_object('op','mkdir','path',c_private))), 3, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'owner-private', jsonb_build_array(jsonb_build_object('op','write',
		'path',c_private || '/p.txt','file',a))), 1, 'saved');
	if (pg_temp.read(c_private || '/p.txt', pg_temp.member(2)) ->> 'found')::boolean is not true
		or (pg_temp.read('secret/s.txt', pg_temp.member(2)) ->> 'found')::boolean is not true then
		raise exception 'Member 2 reads its private folder and secret/'; end if;
end $$;


-- Every desktop view reads the same company-wide set whoever holds it (coordinator decision 2): a run (for member 2),
-- nobody once that run let go, a read-only worker's run, member 2's takeover (its own private folder stays out), and a
-- viewer's takeover. Its answer names no owner: every desktop mount on a machine uses `cache/desktop`.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); p jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	w uuid := extensions.gen_random_uuid(); t jsonb; d jsonb; m uuid;
begin
	perform pg_temp.hold(v);
	d := pg_temp.desktop(jsonb_build_object('holderRunId', v ->> 'runId'));
	if (select array_agg(x.k order by x.k) from jsonb_object_keys(d) as x(k)) is distinct from array['leaseUntil','pass','schema','viewId'] then
		raise exception 'A desktop''s answer: %', d; end if;
	perform pg_temp.company_wide(d, 'a run');
	perform pg_temp.hold(null);
	perform pg_temp.company_wide(d, 'nobody');
	set local session_replication_role = replica;
	insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
		revival, dispatch, requested_by_user_id, steering_run_id)
	values (w, '63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-0000000000a1',
		extensions.gen_random_uuid(), 'w-owner-reader', 'in-house', 'Read', 'read', 'each', '{}', '63200000-0000-4000-8000-000000000002',
		(p ->> 'runId')::uuid);
	set local session_replication_role = origin;
	t := pg_temp.turn(p, w);
	perform pg_temp.hold(t);
	d := pg_temp.desktop(jsonb_build_object('holderRunId', t ->> 'runId'));
	if (pg_temp.view_row(d)).worker_access is distinct from 'read' then raise exception 'A read-only worker holds the screen'; end if;
	perform pg_temp.company_wide(d, 'a read-only worker''s run');
	foreach m in array array['63200000-0000-4000-8000-000000000002', '63200000-0000-4000-8000-000000000003']::uuid[] loop
		perform pg_temp.hold(null, m);
		d := pg_temp.desktop(jsonb_build_object('holderUserId', m));
		if (pg_temp.view_row(d)).member_user_id is distinct from m then raise exception 'Member % holds the screen', m; end if;
		perform pg_temp.company_wide(d, 'member ' || m);
	end loop;
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
end $$;


-- A desktop's or a command's view renews only while its agent and member still read the root. An entitled run-held
-- desktop, its command and a member-held desktop renew. Agent A losing its root grant closes each on its next renewal
-- ('ended'); member 2 leaving the company closes its desktop (which the membership check already did). Renew without
-- the re-check keeps them open, so the re-check is what closes them. Each loss is undone after its check.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); d jsonb; c uuid; s jsonb; m jsonb; r jsonb; r2 jsonb;
	c_ended constant jsonb := '{"schema":"qorpera.folder-view-renew/v1","state":"closed","reason":"ended"}';
begin
	perform pg_temp.hold(v);
	d := pg_temp.desktop(jsonb_build_object('holderRunId', v ->> 'runId'));
	c := pg_temp.command(v);
	s := pg_temp.open_command(c);
	if s ->> 'owner' is distinct from 'agent-63200000-0000-4000-8000-0000000000a1' then
		raise exception 'A command''s answer names its agent: %', s; end if;
	r := pg_temp.renew(d); r2 := pg_temp.renew(s);
	if r ->> 'state' is distinct from 'open' or r2 ->> 'state' is distinct from 'open' then
		raise exception 'An entitled run-held desktop and command renew: %, %', r, r2; end if;
	begin
		perform pg_temp.revoke_root();
		r := pg_temp.renew(d); r2 := pg_temp.renew(s);
		if r is distinct from c_ended or r2 is distinct from c_ended then
			raise exception 'A run-held desktop and command whose agent lost the root still renew: %, %', r, r2; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.renew_without_recheck();
		perform pg_temp.revoke_root();
		r := pg_temp.renew(d); r2 := pg_temp.renew(s);
		if r ->> 'state' is distinct from 'open' or r2 ->> 'state' is distinct from 'open' then
			raise exception 'Without the re-check, a run-held desktop and command close anyway: %, %', r, r2; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;

	perform pg_temp.hold(null, '63200000-0000-4000-8000-000000000002');
	m := pg_temp.desktop(jsonb_build_object('holderUserId', '63200000-0000-4000-8000-000000000002'));
	r := pg_temp.renew(m);
	if r ->> 'state' is distinct from 'open' then raise exception 'An entitled member-held desktop renews: %', r; end if;
	begin
		perform pg_temp.revoke_root();
		r := pg_temp.renew(m);
		if r is distinct from c_ended then raise exception 'A member-held desktop whose agent lost the root still renews: %', r; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.renew_without_recheck();
		perform pg_temp.revoke_root();
		r := pg_temp.renew(m);
		if r ->> 'state' is distinct from 'open' then raise exception 'Without the re-check, a member-held desktop closes anyway: %', r; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;
	begin
		perform pg_temp.fx('delete from public.qorpera_profile_members where profile_id = ''63200000-0000-4000-8000-000000000010''
			and user_id = ''63200000-0000-4000-8000-000000000002''');
		if public.qorpera_folder_reads_root('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
			'63200000-0000-4000-8000-0000000000a1', '63200000-0000-4000-8000-000000000002') then
			raise exception 'A member who left still reads the root'; end if;
		r := pg_temp.renew(m);
		if r is distinct from c_ended then raise exception 'A member-held desktop whose member left still renews: %', r; end if;
		raise exception 'Undo' using errcode = 'QTF80';
	exception when sqlstate 'QTF80' then null;
	end;

	-- Every loss and the mutation are undone: the re-check is back, and the member-held desktop renews.
	if strpos(pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure),
		'qorpera_folder_reads_root') = 0 then raise exception 'The mutation was not undone'; end if;
	r := pg_temp.renew(m);
	if r ->> 'state' is distinct from 'open' then raise exception 'The member-held desktop renews again: %', r; end if;
	perform public.qorpera_folder_view_close((m ->> 'viewId')::uuid, m ->> 'pass');
end $$;

rollback;
