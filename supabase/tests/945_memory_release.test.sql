-- @fixture 769_folder_core_review_recorder.test.sql until "-- The files the runs delete"
-- Summary trees M1b-3b (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §8, §9; 20260930203000): qorpera_memory_release,
-- the platform read of the tree blocks a zoom result showed. Its one record under the nil resource and no read-set row;
-- a replay, a release id used for other reads, and a block's older version; malformed requests; versions that are no
-- memory block; the run check and the pause, before a replay too; the consumers that re-check a run's records (the
-- run's re-check, a coworker wake's parent-reads check and its read copy) after a grant change, with the blocks in a
-- folder the agents may not read; the grants, the call list and the patch markers. Runs are 647's hand-built runs, on
-- 769's helpers.

create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;
-- A structured entry as the TS parser sends it, and a file written with it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '63400000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.agent_text(p_id uuid, p_name text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: agent\nstatus: active\n---\nSell.\n', p_id, p_name)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind','agent','status','active',
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit, staged by the owner who commits it (as 943).
create function pg_temp.hire(p_handle text, p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name), pg_temp.member(1))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name), pg_temp.agent_parse(p_id, p_name))))
$$;
-- An agent's thread conversation.
create function pg_temp.thread(p_agent uuid) returns uuid language sql as $$
	select session_id from public.qorpera_company_rooms where profile_id = '63400000-0000-4000-8000-000000000010' and bound_staff_agent_id = p_agent
$$;

-- The tree's files (as 940), with lines at level 1 and up only: level 0 is checked against the transcript.
create function pg_temp.toml(p_session uuid) returns text language sql as $$
	select format(E'format = 1\nconversation = "%s"\nnode_bytes = 1024\n', p_session)
$$;
create function pg_temp.line(p_l integer, p_k bigint, p_text text) returns text language sql as $$
	select format('{"l":%s,"k":%s,"free":false,"tries":1,"text":"%s"}', p_l, p_k, p_text)
$$;
create function pg_temp.tree_file(p_path text, p_text text) returns jsonb language sql as $$
	select pg_temp.write(p_path, x.kind, p_text, jsonb_build_object('kind', x.kind))
	from (select public.qorpera_structured_path_kind(public.qorpera_folder_key(p_path)) as kind) x
$$;
create function pg_temp.memory(p_key text, p_units jsonb, p_session uuid) returns jsonb language sql as $$
	select public.qorpera_folder_memory_commit('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_key, p_units,
		jsonb_build_object('sessionGenerations', jsonb_build_array(jsonb_build_object('sessionId', p_session,
			'generation', (select memory_generation from public.qorpera_shared_sessions where id = p_session)))))
$$;
-- Nora's first block of a tier.
create function pg_temp.t(p_tier integer) returns text language sql immutable as $$
	select format('agents/nora/memory/thread/t%s/00000000.jsonl', p_tier)
$$;

-- The release run's actor, binding and run id; a block at its current version; a request and a release by the run.
create function pg_temp.actor() returns jsonb language sql as $$ select current_setting('qorpera_test.release_actor')::jsonb $$;
create function pg_temp.b() returns jsonb language sql as $$ select current_setting('qorpera_test.release_binding')::jsonb $$;
create function pg_temp.run_id() returns uuid language sql as $$ select current_setting('qorpera_test.release_run')::uuid $$;
create function pg_temp.blk(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'version', pg_temp.version(p_path))
$$;
create function pg_temp.req(p_id text, p_blocks jsonb, p_output text default repeat('a', 64)) returns jsonb language sql as $$
	select jsonb_build_object('releaseId', p_id, 'outputSha256', p_output, 'blocks', p_blocks)
$$;
create function pg_temp.rel(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_memory_release(pg_temp.b(), p_request)
$$;
-- A run's records as [release, resource, reads, output], oldest first.
create function pg_temp.records(p_run uuid) returns jsonb language sql as $$
	select coalesce(jsonb_agg(jsonb_build_array(rec.release_id, rec.resource_id, rec.reads, rec.output_sha256)
		order by rec.created_at, rec.release_id, rec.resource_id), '[]'::jsonb)
	from public.qorpera_folder_run_read_records rec where rec.run_id = p_run
$$;
-- A block as a platform read.
create function pg_temp.platform(p_block jsonb) returns jsonb language sql immutable as $$
	select p_block || '{"authority":{"platform":true}}'::jsonb
$$;

-- The setup: Nora's hire; the release run (Agent A's, for the member); Nora's tree, a tier-0 block (a pair and a four)
-- and a tier-1 block (a sixteen).
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'release-setup', '[{"op":"mkdir","path":"agents"}]'), 1, 'saved') \g /dev/null
do $$
declare
	nora constant uuid := '94500000-0000-4000-8000-0000000000a1'; root constant text := 'agents/nora/memory/thread';
	x jsonb; s uuid; r jsonb; i integer;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'release-hire', jsonb_build_array(pg_temp.hire('nora', nora, 'Nora'))),
		1, 'saved');
	x := pg_temp.agent_run();
	perform set_config('qorpera_test.release_actor', (x -> 'actor')::text, true);
	perform set_config('qorpera_test.release_binding', (x -> 'binding')::text, true);
	perform set_config('qorpera_test.release_run', x -> 'actor' ->> 'runId', true);
	s := pg_temp.thread(nora);
	r := pg_temp.memory('release-tree', jsonb_build_array(jsonb_build_object('op','mkdir','path',root),
		pg_temp.tree_file(root || '/tree.toml', pg_temp.toml(s)), jsonb_build_object('op','mkdir','path',root || '/t0'),
		pg_temp.tree_file(pg_temp.t(0), pg_temp.line(1, 0, 'pair') || E'\n' || pg_temp.line(2, 0, 'four') || E'\n'),
		jsonb_build_object('op','mkdir','path',root || '/t1'), pg_temp.tree_file(pg_temp.t(1), pg_temp.line(4, 0, 'sixteen') || E'\n')), s);
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- The checks start here.

-- 1. A release: one record under the nil resource, each block once, in key order, and no read-set row. The same
-- request replays; the id with other reads refuses. A block's older version is still one -------------------------------

do $$
declare
	id constant text := '94500000-0000-4000-8000-00000000f001';
	b0 jsonb := pg_temp.blk(pg_temp.t(0)); b1 jsonb := pg_temp.blk(pg_temp.t(1)); first jsonb; r jsonb; s uuid;
begin
	first := pg_temp.req(id, jsonb_build_array(b1, b0, b1));
	perform set_config('qorpera_test.first', first::text, true);
	r := pg_temp.rel(first);
	perform pg_temp.same(r, jsonb_build_object('schema', 'qorpera.memory-release/v1', 'releaseId', id, 'reads', 2, 'replay', false),
		'A release');
	perform pg_temp.same(pg_temp.records(pg_temp.run_id()), jsonb_build_array(jsonb_build_array(id, '00000000-0000-0000-0000-000000000000',
		jsonb_build_array(pg_temp.platform(b0), pg_temp.platform(b1)), repeat('a', 64))), 'The record');
	if exists (select 1 from public.qorpera_folder_run_reads where run_id = pg_temp.run_id()) then
		raise exception 'A platform read writes no read-set row'; end if;
	perform pg_temp.same((select rr.result from public.qorpera_folder_run_releases rr
		where rr.run_id = pg_temp.run_id() and rr.release_id = id::uuid), r, 'The stored result');
	perform pg_temp.same(pg_temp.rel(first), r || '{"replay":true}', 'A replay');
	perform pg_temp.raises_like(format('select pg_temp.rel(%L)', pg_temp.req(id, jsonb_build_array(b1, b0, b1), repeat('b', 64))),
		'22023', 'Release id was used for other reads');
	perform pg_temp.raises_like(format('select pg_temp.rel(%L)', pg_temp.req(id, jsonb_build_array(b0))), '22023',
		'Release id was used for other reads');
	if jsonb_array_length(pg_temp.records(pg_temp.run_id())) <> 1 then raise exception 'A replay records nothing'; end if;

	-- The tier-0 block gains a line. What a result showed of its first version is still released as it was.
	s := pg_temp.thread('94500000-0000-4000-8000-0000000000a1');
	perform pg_temp.expect(pg_temp.memory('release-rewrite', jsonb_build_array(pg_temp.write(pg_temp.t(0), 'memory-block',
		pg_temp.line(1, 0, 'pair') || E'\n' || pg_temp.line(1, 1, 'pair two') || E'\n' || pg_temp.line(2, 0, 'four') || E'\n',
		'{"kind":"memory-block"}', (b0 ->> 'version')::uuid)), s), 1, 'saved');
	if pg_temp.version(pg_temp.t(0)) is not distinct from (b0 ->> 'version')::uuid then raise exception 'The block has a new version'; end if;
	perform pg_temp.same(pg_temp.rel(pg_temp.req('94500000-0000-4000-8000-00000000f002',
		jsonb_build_array(pg_temp.blk(pg_temp.t(0)), b0))) -> 'reads', '2', 'A block''s two versions');
end $$;

-- 2. Malformed requests refuse (22023) and record nothing; 10,000 blocks is the most ------------------------------------

do $$
declare
	id constant text := '94500000-0000-4000-8000-00000000f003';
	blk jsonb := pg_temp.blk(pg_temp.t(0)); ok jsonb := pg_temp.req(id, jsonb_build_array(blk)); request jsonb;
	n integer := jsonb_array_length(pg_temp.records(pg_temp.run_id()));
begin
	foreach request in array array['[]', '"release"', '1', 'null', '{}', ok || '{"depth":1}', ok - 'releaseId', ok || '{"releaseId":5}',
		ok || jsonb_build_object('releaseId', upper(id)), ok || '{"releaseId":"94500000-0000-4000-8000-00000000f00"}', ok - 'outputSha256',
		ok || jsonb_build_object('outputSha256', repeat('A', 64)), ok || jsonb_build_object('outputSha256', repeat('a', 63)),
		ok || '{"outputSha256":null}', ok - 'blocks', ok || '{"blocks":{}}', ok || '{"blocks":[]}', ok || '{"blocks":null}',
		ok || jsonb_build_object('blocks', (select jsonb_agg(blk) from generate_series(1, 10001))), ok || '{"blocks":[1]}',
		ok || '{"blocks":[null]}', ok || '{"blocks":[[]]}', ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"tier":0}')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk - 'version')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk - 'path')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"path":""}')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"path":"/agents/nora"}')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"path":"agents//nora"}')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"path":5}')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || jsonb_build_object('version', upper(blk ->> 'version')))),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"version":"block"}')),
		ok || jsonb_build_object('blocks', jsonb_build_array(blk || '{"version":null}'))] loop
		perform pg_temp.raises_like(format('select pg_temp.rel(%L)', request), '22023', 'memory release is malformed');
	end loop;
	perform pg_temp.raises_like(format('select public.qorpera_memory_release(%L, null)', pg_temp.b()), '22023', 'memory release is malformed');
	if jsonb_array_length(pg_temp.records(pg_temp.run_id())) <> n
		or exists (select 1 from public.qorpera_folder_run_releases where run_id = pg_temp.run_id() and release_id = id::uuid) then
		raise exception 'A malformed request records nothing'; end if;
	perform pg_temp.same(pg_temp.rel(ok || jsonb_build_object('blocks', (select jsonb_agg(blk) from generate_series(1, 10000)))) -> 'reads',
		'1', 'Ten thousand blocks, one read');
end $$;

-- 3. A version that is no memory block written at that exact path refuses (22023) and records nothing ------------------

do $$
declare
	root constant text := 'agents/nora/memory/thread'; v0 text := pg_temp.version(pg_temp.t(0));
	folder uuid := (select v.version from public.qorpera_folder_path_versions v
		where v.environment_id = '63400000-0000-4000-8000-000000000020' and v.path = root || '/t0' and v.op = 'mkdir');
	block jsonb; i integer := 0; n integer := jsonb_array_length(pg_temp.records(pg_temp.run_id()));
begin
	if folder is null then raise exception 'The t0 folder has a version'; end if;
	foreach block in array array[
		jsonb_build_object('path', pg_temp.t(0), 'version', extensions.gen_random_uuid()),
		jsonb_build_object('path', pg_temp.t(1), 'version', v0),
		jsonb_build_object('path', 'agents/Nora/memory/thread/t0/00000000.jsonl', 'version', v0),
		jsonb_build_object('path', 'agents/nora/memory/thread/t0/00000001.jsonl', 'version', v0),
		pg_temp.blk(root || '/tree.toml'), pg_temp.blk('agents/nora/agent.md'),
		jsonb_build_object('path', root || '/t0', 'version', folder)] loop
		i := i + 1;
		perform pg_temp.raises_like(format('select pg_temp.rel(%L)', pg_temp.req(format('94500000-0000-4000-8000-00000000f1%s',
			lpad(i::text, 2, '0')), jsonb_build_array(pg_temp.blk(pg_temp.t(1)), block))), '22023', 'memory release names a block that is not one');
	end loop;
	if jsonb_array_length(pg_temp.records(pg_temp.run_id())) <> n
		or exists (select 1 from public.qorpera_folder_run_releases where run_id = pg_temp.run_id()
			and release_id::text like '94500000-0000-4000-8000-00000000f1%') then
		raise exception 'A refused block records nothing'; end if;
end $$;

-- 4. The run check comes first: a run whose lease is gone, or a paused company, refuses even a replay -------------------

do $$
declare first jsonb := current_setting('qorpera_test.first')::jsonb;
begin
	begin
		perform pg_temp.fx(format('delete from public.qorpera_execution_run_budgets where run_id = %L', pg_temp.run_id()));
		perform pg_temp.rel(first);
		raise exception 'A run with no lease' using errcode = 'QTF02';
	exception when others then
		if sqlstate <> '42501' then raise; end if;
	end;
	begin
		perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
			'63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', 'test'));
		perform pg_temp.raises(format('select pg_temp.rel(%L)', first), '55000');
		perform pg_temp.raises(format('select pg_temp.rel(%L)', pg_temp.req('94500000-0000-4000-8000-00000000f004',
			jsonb_build_array(pg_temp.blk(pg_temp.t(1))))), '55000');
		raise exception 'Paused' using errcode = 'QTF04';
	exception when others then
		if sqlstate <> 'QTF04' then raise; end if;
	end;
	if not exists (select 1 from public.qorpera_execution_run_budgets where run_id = pg_temp.run_id())
		or exists (select 1 from public.qorpera_company_execution_pauses where profile_id = '63400000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_run_releases where run_id = pg_temp.run_id()
			and release_id = '94500000-0000-4000-8000-00000000f004') then
		raise exception 'The blocks'' rollbacks restore the run'; end if;
	perform pg_temp.same(pg_temp.rel(first) -> 'replay', 'true', 'The replay after');
end $$;

-- 5. The re-checks leave platform reads out. Agents A and B may read agents/nora, and neither its memory folder. A's
-- grant is replaced twice: A's run re-checks every path under agents/nora, and so does B's coworker wake from that run.
-- The wake copies A's platform reads as they are ------------------------------------------------------------------------

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_b constant uuid := '63400000-0000-4000-8000-0000000000a2';
	c_nil constant uuid := '00000000-0000-0000-0000-000000000000';
	p jsonb := pg_temp.actor(); r1 uuid; v jsonb; vb jsonb; e jsonb; w public.qorpera_wake_occurrences%rowtype; blocks jsonb; n bigint;
begin
	r1 := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'agents/nora', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), r1, 'staff_agent', c_a, array['read']);
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), r1, 'staff_agent', c_b, array['read']);
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'agents/nora/memory', 'subtree', 'company_shared', 'normal');
	if not public.qorpera_folder_actor_allowed(c_env, c_profile, pg_temp.resolved(p), 'agents/nora/agent.md', 'read')
		or public.qorpera_folder_actor_allowed(c_env, c_profile, pg_temp.resolved(p), pg_temp.t(1), 'read') then
		raise exception 'A reads agent.md and no block'; end if;

	-- A's run reads agent.md through the folder core, and the blocks as the platform's.
	perform pg_temp.release(p, '94500000-0000-4000-8000-00000000f005',
		jsonb_build_array(pg_temp.read('agents/nora/agent.md', p) -> 'entry'));
	blocks := jsonb_build_array(pg_temp.blk(pg_temp.t(0)), pg_temp.blk(pg_temp.t(1)));
	perform pg_temp.rel(pg_temp.req('94500000-0000-4000-8000-00000000f006', blocks));

	-- A's grant is replaced, so the grant its read used is gone: the re-check covers every path under agents/nora.
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), r1, 'staff_agent', c_a, array['read']);
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(p)) <> 1 then
		raise exception 'The run re-checks its one changed read'; end if;

	-- And again, so B's coworker wake finds the parent's read changed and re-resolves its paths for B.
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), r1, 'staff_agent', c_a, array['read']);
	v := pg_temp.run(c_b, 'agent', '63400000-0000-4000-8000-000000000002', 'coworker', p);
	select * into strict w from public.qorpera_wake_occurrences where run_id = (v ->> 'runId')::uuid;
	if not public.qorpera_folder_parent_reads_allowed(w) then raise exception 'B''s wake may take A''s reads'; end if;
	vb := pg_temp.native(v);
	e := public.qorpera_read_native_wake(vb);
	perform pg_temp.same((select jsonb_agg(jsonb_build_array(rec.resource_id,
			(select jsonb_agg(x ->> 'path' order by x ->> 'path') from jsonb_array_elements(rec.reads) x)) order by rec.resource_id = c_nil)
		from public.qorpera_folder_run_read_records rec where rec.run_id = (v ->> 'runId')::uuid and rec.release_id = (e ->> 'id')::uuid),
		jsonb_build_array(jsonb_build_array(r1, '["agents/nora/agent.md"]'::jsonb),
			jsonb_build_array(c_nil, jsonb_build_array(pg_temp.t(0), pg_temp.t(1)))),
		'The wake''s copy: agent.md under agents/nora, the blocks under the nil resource');
	perform pg_temp.same((select rec.reads from public.qorpera_folder_run_read_records rec where rec.run_id = (v ->> 'runId')::uuid
			and rec.release_id = (e ->> 'id')::uuid and rec.resource_id = c_nil),
		jsonb_build_array(pg_temp.platform(blocks -> 0), pg_temp.platform(blocks -> 1)), 'The blocks as A''s run read them last');
	n := jsonb_array_length(pg_temp.records((v ->> 'runId')::uuid));
	perform public.qorpera_read_native_wake(vb);
	if jsonb_array_length(pg_temp.records((v ->> 'runId')::uuid)) <> n then raise exception 'A second wake read copies nothing'; end if;
	-- The wake's id has records and no release: no release takes it.
	perform pg_temp.raises_like(format('select public.qorpera_memory_release(%L, %L)', vb, pg_temp.req(e ->> 'id', blocks)), '22023',
		'Release id was used for other reads');
end $$;

-- 6. The grants, the call list and the patch markers --------------------------------------------------------------------

do $$
declare v_bad text;
begin
	select string_agg(r, ', ') into v_bad from unnest(array['anon', 'authenticated', 'service_role']) r
	where has_function_privilege(r, 'public.qorpera_memory_release(jsonb,jsonb)', 'execute') is distinct from (r = 'service_role');
	if v_bad is not null then raise exception 'Wrong callers: %', v_bad; end if;
	if not (select p.prosecdef from pg_proc p where p.oid = 'public.qorpera_memory_release(jsonb,jsonb)'::regprocedure) then
		raise exception 'The release is a definer'; end if;
	perform pg_temp.same((select to_jsonb(array[c.scope, c.budget]) from public.qorpera_native_host_calls c where c.name = 'qorpera_memory_release'),
		'["binding", "standard"]', 'The call list');
	select string_agg(f, ', ') into v_bad
	from unnest(array['public.qorpera_folder_run_reads_current(uuid,uuid,jsonb)',
		'public.qorpera_folder_parent_reads_allowed(public.qorpera_wake_occurrences)', 'public.qorpera_folder_read_wake(jsonb)']) f
	where pg_get_functiondef(f::regprocedure)
		not like '%rec.resource_id <> ''00000000-0000-0000-0000-000000000000''::uuid /* 20260930203000 (M1b-3) */%';
	if v_bad is not null then raise exception 'No platform-read marker in %', v_bad; end if;
	if pg_get_functiondef('public.qorpera_folder_read_wake(jsonb)'::regprocedure)
		not like '%-- 20260930203000 (M1b-3): the parent''s platform reads of memory blocks%' then
		raise exception 'The wake copies platform reads'; end if;
end $$;

rollback;
