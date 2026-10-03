-- @fixture 647_folder_core_run_fence.test.sql until "-- 1. Snapshot-v1 keeps its text"
-- Company folder core, C2 R1 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §2, §3, §6): the review recorder. A run's
-- approved action review (its own allow, or a card's allow it used) is recorded as the folder review of one change set,
-- bound to the commit's own digest, and the commit then saves the run's deletion units. Everything else is refused: an
-- approval of another run, agent or company, a denial, an open ask, an approved external action, and a second change
-- set, an approval of another call or of a tool that writes no folder change sets. A card's member is the commit's
-- approver. The request's bounds, the run entry and the grants. Runs are 647's hand-built runs with their native rows;
-- files are staged on the version-2 path. Races are in 770.

-- The version-2 stage helper (as 766): open, confirm what is missing, seal. A version-2 file is held to possession, so
-- the fixture stages as the actor that commits it.
create function pg_temp.manifest(p_chunks text[], p_media text default 'text/markdown', p_exec boolean default false)
returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"%s","executable":%s,"chunks":[%s]}',
		encode(extensions.digest(convert_to(array_to_string(p_chunks, ''), 'utf8'), 'sha256'), 'hex'),
		octet_length(convert_to(array_to_string(p_chunks, ''), 'utf8')), p_media, case when p_exec then 'true' else 'false' end,
		coalesce((select string_agg(format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(c, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(c, 'utf8'))), ',' order by o) from unnest(p_chunks) with ordinality u(c, o)), ''))
$$;
create function pg_temp.hash(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;
drop function pg_temp.stage(text);
create function pg_temp.stage(p_text text, p_actor jsonb default '{"kind":"platform"}') returns jsonb language plpgsql as $$
declare v_manifest text := pg_temp.manifest(array[p_text], 'text/plain'); v_open jsonb; v_object text; v_seal jsonb;
begin
	v_open := public.qorpera_folder_open_upload('63400000-0000-4000-8000-000000000020', p_actor, v_manifest);
	foreach v_object in array array[p_text, v_manifest] loop
		if not (v_open -> 'present') ? pg_temp.hash(v_object) then
			perform public.qorpera_folder_confirm_object('63400000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid,
				pg_temp.hash(v_object), octet_length(convert_to(v_object, 'utf8'))); end if;
	end loop;
	v_seal := public.qorpera_folder_seal_upload('63400000-0000-4000-8000-000000000020', p_actor, (v_open ->> 'intentId')::uuid);
	if v_seal ->> 'state' <> 'sealed' then raise exception 'Fixture: %', v_seal; end if;
	return v_seal -> 'file';
end $$;

-- A human run of an agent for the member, with the binding the runtime sends.
create function pg_temp.agent_run(p_staff uuid default '63400000-0000-4000-8000-0000000000a1',
	p_requester uuid default '63400000-0000-4000-8000-000000000002') returns jsonb language plpgsql as $$
declare p jsonb := pg_temp.run(p_staff, 'human', p_requester);
begin
	return jsonb_build_object('actor', p, 'binding', pg_temp.native(p));
end $$;
-- The kernel's record of one acting call (qorpera_record_action_review): its id. 'ask' with no rule is the member's
-- card in the agent's thread.
create function pg_temp.action(p_binding jsonb, p_call text, p_decision text default 'allow', p_effect text default 'delegation',
	p_tool text default 'hire_agent') returns uuid language sql as $$
	select (public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', p_tool,
		'effect', p_effect, 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Hire an agent', 'target', 'nora', 'details', '{}'::jsonb),
		'decision', p_decision, 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid
$$;
-- The recorder, for the call the approval is of (its tool and argument digest), unless told otherwise.
create function pg_temp.record(p_binding jsonb, p_action uuid, p_units jsonb, p_call jsonb default '{}') returns jsonb language sql as $$
	select public.qorpera_folder_record_review(p_binding, jsonb_build_object('actionReviewId', p_action,
		'tool', coalesce(p_call ->> 'tool', (select tool_name from public.qorpera_action_reviews where id = p_action), 'hire_agent'),
		'argumentSha256', coalesce(p_call ->> 'argumentSha256', (select argument_sha256 from public.qorpera_action_reviews where id = p_action),
			repeat('0', 64)),
		'units', p_units))
$$;
-- A member answers a card (Allow once unless told otherwise), as the answer leaves the row.
create function pg_temp.answer(p_action uuid, p_answer text default 'allow_once') returns void language sql as $$
	update public.qorpera_action_reviews set answer = p_answer, answered_by_user_id = '63400000-0000-4000-8000-000000000002',
		answered_at = clock_timestamp()
	where id = p_action
$$;
-- The delete of one file, at the version the run reads.
create function pg_temp.deletes(p_path text) returns jsonb language sql as $$
	select jsonb_build_object('op', 'delete', 'path', p_path, 'expectedVersion', pg_temp.read(p_path) -> 'entry' ->> 'version')
$$;
create function pg_temp.present(p_path text) returns boolean language sql as $$
	select (pg_temp.read(p_path) ->> 'found')::boolean
$$;

-- The files the runs delete, written by the member.
do $$
declare m jsonb := pg_temp.member(2);
begin
	perform pg_temp.expect(pg_temp.commit(m, 'recorder-setup', (select jsonb_agg(jsonb_build_object('op','write','path','rr' || n || '.txt',
		'file', pg_temp.stage('recorder file ' || n, m))) from generate_series(1, 16) n)), 16, 'saved');
end $$;

-- 1. The run's own allow: recorded for the change set, used by the commit; a replay returns it; another change set is
-- refused; a commit without it, with other units, or with another run's record is denied.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; p jsonb := x -> 'actor'; v_action uuid; u jsonb; r jsonb;
	v_row public.qorpera_folder_reviews%rowtype; c jsonb;
begin
	-- Without a record the delete is denied, as before.
	perform pg_temp.expect(pg_temp.commit(p, 'recorder-none', jsonb_build_array(pg_temp.deletes('rr1.txt'))), 1, 'denied', 'review_required');
	v_action := pg_temp.action(b, 'call-allow-1');
	u := jsonb_build_array(pg_temp.deletes('rr1.txt'), jsonb_build_object('op', 'mkdir', 'path', 'rr-plain'));
	r := pg_temp.record(b, v_action, u);
	select * into v_row from public.qorpera_folder_reviews where id = (r ->> 'reviewId')::uuid;
	if r <> jsonb_build_object('schema', 'qorpera.folder-review/v1', 'reviewId', md5('qorpera.folder-review:' || v_action::text)::uuid,
			'approvedBy', null, 'units', 2)
		or v_row.environment_id <> '63400000-0000-4000-8000-000000000020' or v_row.run_id::text <> p ->> 'runId'
		or v_row.change_set_sha256 <> public.qorpera_folder_change_set_sha256(u) or v_row.units <> '{1,2}'
		or v_row.decision <> 'allow' or v_row.answer is not null or v_row.answered_by_user_id is not null then
		raise exception 'The recorded review: % %', r, to_jsonb(v_row); end if;
	-- A replay of the same change set returns the same record; another change set is refused.
	if pg_temp.record(b, v_action, u) <> r then raise exception 'A replay returns the same record'; end if;
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, jsonb_build_array(pg_temp.deletes('rr2.txt'))),
		'23505', 'This approval was already used for another change');
	if (select count(*) from public.qorpera_folder_reviews where run_id = (p ->> 'runId')::uuid) <> 1 then
		raise exception 'One approval stands for one change set'; end if;
	-- The commit with other units, or without the record, is denied; with it, both units save and the commit names it.
	perform pg_temp.expect(pg_temp.commit(p, 'recorder-other-units', jsonb_build_array(pg_temp.deletes('rr2.txt')),
		(r ->> 'reviewId')::uuid), 1, 'denied', 'review_required');
	c := pg_temp.commit(p, 'recorder-allow', u, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	perform pg_temp.expect(c, 2, 'saved');
	if pg_temp.present('rr1.txt') or (select review_id from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid)
			is distinct from (r ->> 'reviewId')::uuid then
		raise exception 'The reviewed delete is saved with its review: %', c; end if;
	-- Another run's record is denied in this run's commit.
	x := pg_temp.agent_run();
	u := jsonb_build_array(pg_temp.deletes('rr3.txt'));
	r := pg_temp.record(x -> 'binding', pg_temp.action(x -> 'binding', 'call-allow-2'), u);
	perform pg_temp.expect(pg_temp.commit(p, 'recorder-other-run', u, (r ->> 'reviewId')::uuid), 1, 'denied', 'review_required');
	perform pg_temp.expect(pg_temp.commit(x -> 'actor', 'recorder-own-run', u, (r ->> 'reviewId')::uuid), 1, 'saved');
end $$;

-- 2. A card's allow: recorded only by the run that used it (the holding call's wait, or a woken run's begin), and only
-- after the answer.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; v_action uuid; u jsonb; r jsonb; w jsonb; y jsonb;
begin
	v_action := pg_temp.action(b, 'call-ask-1', 'ask');
	if (select decision from public.qorpera_action_reviews where id = v_action) <> 'ask'
		or (select card_session_id from public.qorpera_action_reviews where id = v_action) is null then
		raise exception 'The fixture ask raises a card'; end if;
	u := jsonb_build_array(pg_temp.deletes('rr4.txt'));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This change has no approval in this run');
	perform pg_temp.answer(v_action);
	-- Answered but not yet used by this run.
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This change has no approval in this run');
	w := public.qorpera_await_action_review(b, v_action, false);
	if w ->> 'state' <> 'approved' then raise exception 'The holding call is approved: %', w; end if;
	r := pg_temp.record(b, v_action, u);
	if r ->> 'approvedBy' <> '63400000-0000-4000-8000-000000000002' or (select to_jsonb(f) - 'id' - 'environment_id' - 'run_id'
			- 'change_set_sha256' - 'units' - 'created_at' from public.qorpera_folder_reviews f where id = (r ->> 'reviewId')::uuid)
		<> jsonb_build_object('decision', 'ask', 'answer', 'allow', 'answered_by_user_id', '63400000-0000-4000-8000-000000000002',
			'answered_at', (select answered_at from public.qorpera_action_reviews where id = v_action)) then
		raise exception 'A card''s allow is recorded as its answer, with its member: %', r; end if;
	perform pg_temp.expect(pg_temp.commit(x -> 'actor', 'recorder-card', u, (r ->> 'reviewId')::uuid), 1, 'saved');
	if (select approver_user_id from public.qorpera_folder_commits where review_id = (r ->> 'reviewId')::uuid)
		is distinct from '63400000-0000-4000-8000-000000000002' then
		raise exception 'The commit records the member who approved the card'; end if;

	-- A parked card answered later: the woken run's begin uses it, so that run records it and the first cannot.
	v_action := pg_temp.action(b, 'call-ask-2', 'ask');
	perform public.qorpera_await_action_review(b, v_action, true);
	perform pg_temp.answer(v_action, 'always_allow');
	y := pg_temp.agent_run();
	w := public.qorpera_begin_action_review(y -> 'binding', jsonb_build_object('tool', 'hire_agent',
		'argumentSha256', md5('call-ask-2') || md5('call-ask-2')));
	if w ->> 'state' <> 'approved' or (w ->> 'reviewId')::uuid <> v_action then raise exception 'The woken run is approved: %', w; end if;
	u := jsonb_build_array(pg_temp.deletes('rr5.txt'));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', 'This change has no approval in this run');
	r := pg_temp.record(y -> 'binding', v_action, u);
	perform pg_temp.expect(pg_temp.commit(y -> 'actor', 'recorder-woken', u, (r ->> 'reviewId')::uuid), 1, 'saved');

	-- A card whose answering member was since deleted (on delete set null) is recorded as a plain allow.
	v_action := pg_temp.action(b, 'call-ask-3', 'ask');
	perform pg_temp.answer(v_action);
	perform public.qorpera_await_action_review(b, v_action, false);
	perform pg_temp.fx(format('update public.qorpera_action_reviews set answered_by_user_id = null where id = %L', v_action));
	u := jsonb_build_array(pg_temp.deletes('rr7.txt'));
	r := pg_temp.record(b, v_action, u);
	if r ->> 'approvedBy' is not null or (select decision from public.qorpera_folder_reviews where id = (r ->> 'reviewId')::uuid) <> 'allow' then
		raise exception 'A card without its member is a plain allow: %', r; end if;
	perform pg_temp.expect(pg_temp.commit(x -> 'actor', 'recorder-no-member', u, (r ->> 'reviewId')::uuid), 1, 'saved');
end $$;

-- 3. What is never an approval here: a denial, an answered denial, another run's allow, another agent's, another
-- company's, an approved external action, and an id that names nothing.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; y jsonb; v_action uuid; u jsonb;
	c_refused constant text := 'This change has no approval in this run';
begin
	u := jsonb_build_array(pg_temp.deletes('rr6.txt'));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, pg_temp.action(b, 'call-deny-1', 'deny'), u), '42501', c_refused);
	v_action := pg_temp.action(b, 'call-ask-deny', 'ask');
	perform pg_temp.answer(v_action, 'deny');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', c_refused);
	-- Another run of the same agent and member.
	y := pg_temp.agent_run();
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, pg_temp.action(y -> 'binding', 'call-other-run'), u),
		'42501', c_refused);
	-- Another agent's run.
	y := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, pg_temp.action(y -> 'binding', 'call-other-agent'), u),
		'42501', c_refused);
	-- Another company's row (written directly: no run of it can reach this recorder).
	v_action := pg_temp.action(b, 'call-other-company');
	perform pg_temp.fx(format('update public.qorpera_action_reviews set profile_id = %L where id = %L',
		'64700000-0000-4000-8000-000000000011', v_action));
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '42501', c_refused);
	-- An approved email never stands for folder units, nor does a delegation by a tool that writes none (a coworker
	-- message; manage_worker writes worker files since F2-5b-2, 20260930003000).
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, pg_temp.action(b, 'call-external', 'allow', 'external'), u),
		'42501', c_refused);
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b,
		pg_temp.action(b, 'call-coworker', 'allow', 'delegation', 'send_coworker_message'), u), '42501', c_refused);
	-- The approval is of one call: another tool's name or another argument digest is refused.
	v_action := pg_temp.action(b, 'call-exact');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L, %L)', b, v_action, u, '{"tool":"create_group_chat"}'),
		'42501', c_refused);
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L, %L)', b, v_action, u,
		jsonb_build_object('argumentSha256', repeat('a', 64))), '42501', c_refused);
	-- A deletion (company_delete, destructive) records and saves.
	perform pg_temp.expect(pg_temp.commit(x -> 'actor', 'recorder-destructive', u,
		(pg_temp.record(b, pg_temp.action(b, 'call-destructive', 'allow', 'destructive', 'company_delete'), u) ->> 'reviewId')::uuid), 1, 'saved');
	perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, extensions.gen_random_uuid(), u), '42501', c_refused);
	if exists (select 1 from public.qorpera_folder_reviews where change_set_sha256 = public.qorpera_folder_change_set_sha256(u)
			and run_id::text <> x -> 'actor' ->> 'runId') then
		raise exception 'A refused recording writes nothing'; end if;
	-- Two approvals of one change set are two records, and either serves the commit.
	u := jsonb_build_array(pg_temp.deletes('rr8.txt'));
	if (pg_temp.record(b, pg_temp.action(b, 'call-twice-1'), u) ->> 'reviewId')
		= (pg_temp.record(b, pg_temp.action(b, 'call-twice-2'), u) ->> 'reviewId') then
		raise exception 'Each approval has its own record'; end if;
	perform pg_temp.expect(pg_temp.commit(x -> 'actor', 'recorder-twice', u, md5('qorpera.folder-review:'
		|| (select id from public.qorpera_action_reviews where call_id = 'call-twice-2')::text)::uuid), 1, 'saved');
end $$;

-- 4. The request: exactly its four keys, a review id, a tool name, an argument digest, and 1 to 1000 units (the commit's
-- own bound).
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; v_action uuid := pg_temp.action(b, 'call-bounds');
	v_unit jsonb := jsonb_build_object('op', 'mkdir', 'path', 'rr-bounds'); v_request jsonb;
	v_call jsonb := jsonb_build_object('actionReviewId', v_action, 'tool', 'hire_agent',
		'argumentSha256', md5('call-bounds') || md5('call-bounds'));
begin
	foreach v_request in array array[
		v_call || jsonb_build_object('units', '[]'::jsonb),
		v_call || jsonb_build_object('units', (select jsonb_agg(v_unit) from generate_series(1, 1001))),
		v_call || jsonb_build_object('units', v_unit),
		v_call,
		v_call || jsonb_build_object('units', jsonb_build_array(v_unit), 'decision', 'allow'),
		v_call || jsonb_build_object('actionReviewId', 'not-a-uuid', 'units', jsonb_build_array(v_unit)),
		v_call || jsonb_build_object('actionReviewId', 42, 'units', jsonb_build_array(v_unit)),
		(v_call - 'tool') || jsonb_build_object('units', jsonb_build_array(v_unit)),
		v_call || jsonb_build_object('tool', 7, 'units', jsonb_build_array(v_unit)),
		v_call || jsonb_build_object('tool', 'Hire agent', 'units', jsonb_build_array(v_unit)),
		v_call || jsonb_build_object('argumentSha256', upper(md5('a') || md5('a')), 'units', jsonb_build_array(v_unit)),
		(v_call - 'argumentSha256') || jsonb_build_object('units', jsonb_build_array(v_unit)),
		'[]'::jsonb] loop
		perform pg_temp.raises_like(format('select public.qorpera_folder_record_review(%L, %L)', b, v_request), '22023',
			'Folder review request is invalid');
	end loop;
	-- The request is checked before the run entry: a malformed one is refused as such even while the company is paused.
	perform pg_temp.fx(format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
		'63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000001', 'test'));
	perform pg_temp.raises_like(format('select public.qorpera_folder_record_review(%L, %L)', b, v_call), '22023',
		'Folder review request is invalid');
	perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L',
		'63400000-0000-4000-8000-000000000010'));
	if (pg_temp.record(b, v_action, (select jsonb_agg(v_unit) from generate_series(1, 1000))) ->> 'units')::integer <> 1000 then
		raise exception 'A change set of 1000 units is recorded'; end if;
end $$;

-- 5. The run entry: a snapshot-v1 company's binding and a stopped company are refused, and the body enters through the
-- run check before it reads the approval (the recorder is a run effect).
do $$
declare
	c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	x jsonb := pg_temp.agent_run(); b jsonb := x -> 'binding'; v_action uuid := pg_temp.action(b, 'call-entry');
	u jsonb := jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'rr-entry')); v_stop text;
begin
	perform pg_temp.raises(format('select pg_temp.record(%L, %L, %L)', current_setting('qorpera_test.snapshot_binding')::jsonb,
		v_action, u), '42501');
	foreach v_stop in array array[
		format('insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id, reason) values (%L, %L, %L)',
			c_profile, '63400000-0000-4000-8000-000000000001', 'test'),
		format('insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values (%L, null)', c_profile)] loop
		perform pg_temp.fx(v_stop);
		perform pg_temp.raises_like(format('select pg_temp.record(%L, %L, %L)', b, v_action, u), '55000', 'Company execution is paused');
		perform pg_temp.fx(format('delete from public.qorpera_company_execution_pauses where profile_id = %L', c_profile));
		perform pg_temp.fx(format('delete from public.qorpera_company_deletions where profile_id = %L', c_profile));
	end loop;
	-- The body enters through the run check, before any read of the approval.
	if pg_get_functiondef('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure)
			not like '%Folder review request is invalid%v_tool := public.qorpera_folder_tool_run(p_binding, ''[]''::jsonb);%from public.qorpera_action_reviews%for share;%insert into public.qorpera_folder_reviews%' then
		raise exception 'The recorder checks the request, enters through the run check, shares the approval, then inserts'; end if;
end $$;

-- 6. Grants: only the runtime's role, through the Company File control list.
do $$
begin
	if has_function_privilege('anon', 'public.qorpera_folder_record_review(jsonb,jsonb)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_folder_record_review(jsonb,jsonb)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_folder_record_review(jsonb,jsonb)', 'execute') then
		raise exception 'The recorder is the runtime''s alone'; end if;
	if (select prosecdef from pg_proc where oid = 'public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure) is not true
		or (select proconfig from pg_proc where oid = 'public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure)
			<> array['search_path=""'] then
		raise exception 'The recorder is security definer with an empty search path'; end if;
end $$;

rollback;
