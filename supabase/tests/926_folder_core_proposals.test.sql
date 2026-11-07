-- @fixture 769_folder_core_review_recorder.test.sql until "-- 1. The run's own allow"
-- Company folder core, P40a (C2-R2, deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8): a view's unit that needs review
-- and carries none is parked as a proposal; the agent's next run for the same member lists it, reviews it as one
-- apply_proposal call, records the approval through R1's recorder and applies it; a deny declines it; the agent's run,
-- the asked member and owners or admins discard it; an open proposal roots its bytes; a restricted agent's hire through a
-- view asks the owners and admins; erasure erases it; an apply that finds it decided after its review cancels the call's
-- receipt, and a listed proposal names the reads its run releases and what a new folder contains (P40b). Views are run
-- boxes of 769's runs (each acts through its live run). Races are in 927.

create function pg_temp.box(p_run jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_view_open('63400000-0000-4000-8000-000000000020', p_run, 'run_box', '{}')
$$;
create function pg_temp.vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',p_view ->> 'viewId','pass',p_view ->> 'pass')
$$;
create function pg_temp.vcommit(p_view jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_key, p_units)
$$;
-- The proposal a commit parked.
create function pg_temp.parked(p_commit jsonb) returns public.qorpera_folder_proposals language sql as $$
	select * from public.qorpera_folder_proposals where commit_id = (p_commit ->> 'commitId')::uuid
$$;
create function pg_temp.proposal(p_id uuid) returns public.qorpera_folder_proposals language sql as $$
	select * from public.qorpera_folder_proposals where id = p_id
$$;
create function pg_temp.list(p_run jsonb, p_request jsonb default '{}') returns jsonb language sql as $$
	select public.qorpera_folder_agent_proposals('63400000-0000-4000-8000-000000000020', p_run, p_request)
$$;
-- The kernel's record of the apply_proposal call for a proposal: its arguments are exactly {"proposalId":…}.
create function pg_temp.apply_action(p_binding jsonb, p_call text, p_proposal uuid, p_decision text default 'allow',
	p_effect text default 'destructive') returns jsonb language sql as $$
	select public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'apply_proposal',
		'effect', p_effect, 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p_proposal),
		'action', jsonb_build_object('title', 'Apply the changes', 'target', 'files', 'details', '{}'::jsonb,
			'arguments', '{"proposalId":"' || p_proposal || '"}'),
		'decision', p_decision, 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna'))
$$;
create function pg_temp.record_apply(p_binding jsonb, p_action uuid, p_proposal uuid) returns jsonb language sql as $$
	select public.qorpera_folder_record_review(p_binding, jsonb_build_object('actionReviewId', p_action, 'tool', 'apply_proposal',
		'argumentSha256', public.qorpera_folder_proposal_call_sha256(p_proposal), 'proposalId', p_proposal))
$$;
create function pg_temp.apply(p_run jsonb, p_key text, p_proposal uuid, p_review uuid) returns jsonb language sql as $$
	select public.qorpera_folder_apply_proposal('63400000-0000-4000-8000-000000000020', p_run, p_key, p_proposal, p_review)
$$;
-- The whole approval path in the run: the reviewer's allow, the record, the apply. Returns the commit.
create function pg_temp.approve(x jsonb, p_call text, p_proposal uuid, p_effect text default 'destructive') returns jsonb
language plpgsql as $$
declare v_action uuid := (pg_temp.apply_action(x -> 'binding', p_call, p_proposal, 'allow', p_effect) ->> 'reviewId')::uuid;
begin
	return pg_temp.apply(x -> 'actor', p_call, p_proposal, (pg_temp.record_apply(x -> 'binding', v_action, p_proposal) ->> 'reviewId')::uuid);
end $$;
create function pg_temp.close(p_binding jsonb, p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_close_proposal(p_binding, p_request)
$$;
create function pg_temp.discard(p_member integer, p_proposal uuid) returns jsonb language sql as $$
	select public.qorpera_folder_member_discard_proposal('63400000-0000-4000-8000-000000000020', pg_temp.member(p_member), p_proposal)
$$;
create function pg_temp.agent_text(p_id uuid, p_name text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: agent\nstatus: active\n---\nSell.\n', p_id, p_name)
$$;
-- A new agent folder with its agent.md, as the view stages and parses it.
create function pg_temp.hire(p_view jsonb, p_handle text, p_id uuid, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','QorperaOS/agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name), pg_temp.vactor(p_view))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(jsonb_build_object('path', 'QorperaOS/agents/' || p_handle || '/agent.md', 'kind', 'agent',
			'text', pg_temp.agent_text(p_id, p_name), 'parserVersion', 1,
			'parse', jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind','agent','status','active',
				'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.'))))
$$;
create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;

-- 1. A view parks: its deletion waits for review and the plain unit saves; a parked-only commit takes no seq. A run's own
-- unit without a review is still review_required, and parks nothing.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); r jsonb; p public.qorpera_folder_proposals; u jsonb;
begin
	u := pg_temp.deletes('rr1.txt');
	r := pg_temp.vcommit(b, 'p40-park-1', jsonb_build_array(u, jsonb_build_object('op','mkdir','path','p40-plain')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	perform pg_temp.expect(r, 2, 'saved');
	if r ->> 'seq' is null then raise exception 'A commit that saved a unit takes a seq: %', r; end if;
	p := pg_temp.parked(r);
	if p.id is null or p.status <> 'open' or p.staff_agent_id <> '63400000-0000-4000-8000-0000000000a1'
		or p.member_user_id <> '63400000-0000-4000-8000-000000000002' or p.view_id <> (b ->> 'viewId')::uuid or p.view_kind <> 'run_box'
		or p.units <> jsonb_build_array(u) or p.commit_units <> '{1}' or p.effect <> 'destructive'
		or p.change_set_sha256 <> public.qorpera_folder_change_set_sha256(jsonb_build_array(u)) or p.decided_at is not null then
		raise exception 'The proposal: %', to_jsonb(p); end if;
	perform pg_temp.same((select jsonb_agg(jsonb_build_object('unit', q.unit_no, 'item', q.item_no, 'path', q.path, 'manifest', q.manifest_sha256)
		order by q.unit_no, q.item_no) from public.qorpera_folder_proposal_paths q where q.proposal_id = p.id),
		'[{"unit":1,"item":0,"path":"rr1.txt","manifest":null}]', 'Its path rows');
	if not pg_temp.present('rr1.txt') then raise exception 'A parked delete changed nothing'; end if;
	-- Parked only: no seq, one more proposal.
	r := pg_temp.vcommit(b, 'p40-park-2', jsonb_build_array(pg_temp.deletes('rr2.txt')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	if r ->> 'seq' is not null or (pg_temp.parked(r)).id is null then raise exception 'A parked-only commit: %', r; end if;
	-- The run itself, without a review: denied as before, nothing parked.
	r := pg_temp.commit(x -> 'actor', 'run-unreviewed', jsonb_build_array(pg_temp.deletes('rr3.txt')));
	perform pg_temp.expect(r, 1, 'denied', 'review_required');
	if (pg_temp.parked(r)).id is not null then raise exception 'A run''s unit was parked'; end if;
	perform set_config('qorpera_test.p1', (select id::text from public.qorpera_folder_proposals where commit_units = '{1}'
		and units -> 0 ->> 'path' = 'rr1.txt'), true);
	perform set_config('qorpera_test.p2', (select id::text from public.qorpera_folder_proposals where units -> 0 ->> 'path' = 'rr2.txt'), true);
end $$;

-- 2. The list: the agent's open proposals for the run's member, oldest first, with their units; a page and its cursor;
-- nothing for another member's run or another agent's; a bad request and an unknown cursor are refused.
do $$
declare x jsonb := pg_temp.agent_run(); l jsonb; y jsonb; z jsonb; p1 uuid := current_setting('qorpera_test.p1')::uuid;
	p2 uuid := current_setting('qorpera_test.p2')::uuid;
begin
	l := pg_temp.list(x -> 'actor');
	if l ->> 'schema' <> 'qorpera.folder-agent-proposals/v1' or jsonb_array_length(l -> 'proposals') <> 2
		or (l -> 'proposals' -> 0 ->> 'proposalId')::uuid <> p1 or (l -> 'proposals' -> 1 ->> 'proposalId')::uuid <> p2
		or (l ->> 'moreProposals')::integer <> 0 or l -> 'nextCursor' <> 'null'::jsonb then
		raise exception 'The list: %', l; end if;
	perform pg_temp.same((l -> 'proposals' -> 0) - 'createdAt' - 'reads', ('{"proposalId":"' || p1 || '","viewKind":"run_box","effect":"destructive",'
		'"createsAgent":false,"unitCount":1,"units":[{"unit":1,"op":"delete","path":"rr1.txt"}],"moreUnits":0}')::jsonb, 'A listed proposal');
	-- (P40b) Its reads: the path it names, with the receipt a read of it gives the run.
	perform pg_temp.same(l -> 'proposals' -> 0 -> 'reads', jsonb_build_array(jsonb_build_object('path', 'rr1.txt',
		'authority', pg_temp.read('rr1.txt', x -> 'actor') -> 'entry' -> 'authority')), 'A listed proposal''s reads');
	l := pg_temp.list(x -> 'actor', jsonb_build_object('cursor', p1));
	if jsonb_array_length(l -> 'proposals') <> 1 or (l -> 'proposals' -> 0 ->> 'proposalId')::uuid <> p2 then
		raise exception 'After the cursor: %', l; end if;
	-- (Each run is made in a statement of its own: the list is stable, and reads with its statement's snapshot.)
	y := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1', '63400000-0000-4000-8000-000000000004');
	z := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a2');
	if jsonb_array_length(pg_temp.list(y -> 'actor') -> 'proposals') <> 0
		or jsonb_array_length(pg_temp.list(z -> 'actor') -> 'proposals') <> 0 then
		raise exception 'Another member''s or agent''s run lists none'; end if;
	perform pg_temp.raises(format('select pg_temp.list(%L, %L)', x -> 'actor', '{"todoKey":"x"}'), '22023');
	perform pg_temp.raises(format('select pg_temp.list(%L, %L)', x -> 'actor', jsonb_build_object('cursor', extensions.gen_random_uuid())), 'P0002');
	perform pg_temp.raises(format('select pg_temp.list(%L, %L)', pg_temp.member(2), '{}'), '42501');
end $$;

-- 2b. Read authority is decided at each list: once the agent may no longer read a proposal's path (its root grant
-- revoked here), the proposal is neither listed nor counted; with the grant back, it is again.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); y jsonb; p uuid; l jsonb;
	v_grant uuid := (pg_temp.agent_grant((pg_temp.root()).id, '63400000-0000-4000-8000-0000000000a1')).id;
begin
	p := (pg_temp.parked(pg_temp.vcommit(b, 'p40-park-revoked', jsonb_build_array(pg_temp.deletes('rr8.txt'))))).id;
	y := pg_temp.agent_run();
	if not (pg_temp.list(y -> 'actor') -> 'proposals' @> jsonb_build_array(jsonb_build_object('proposalId', p))) then
		raise exception 'A readable proposal is listed'; end if;
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = %L', v_grant));
	l := pg_temp.list(y -> 'actor');
	if l -> 'proposals' <> '[]'::jsonb or (l ->> 'moreProposals')::integer <> 0 then
		raise exception 'A proposal whose paths the run may no longer read is listed: %', l; end if;
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set revoked_at = null where id = %L', v_grant));
	if not (pg_temp.list(y -> 'actor') -> 'proposals' @> jsonb_build_array(jsonb_build_object('proposalId', p))) then
		raise exception 'With the grant back it is listed again'; end if;
	perform pg_temp.discard(1, p);
end $$;

-- 2c. P40b: a listed proposal names its reads, every path it names with the authority its list was decided on, sorted;
-- the run releases them with the context that shows them (no file was read: no version). A grant revoked after the list
-- then fences the run, and a run that releases its list after the revocation is refused.
do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	x jsonb := pg_temp.agent_run(); b jsonb; y jsonb; z jsonb; p uuid; v_res uuid; v_g uuid; v_reads jsonb; v_late jsonb;
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'p40b-reads-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','p40r'),
		jsonb_build_object('op','write','path','p40r/a.txt','file',pg_temp.stage('p40b a')),
		jsonb_build_object('op','write','path','p40b-root.txt','file',pg_temp.stage('p40b root')))), 3, 'saved');
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'p40r', 'subtree', 'company_shared', 'normal') ->> 'resourceId';
	v_g := public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
		array['read','write']) ->> 'grantId';
	b := pg_temp.box(x -> 'actor');
	p := (pg_temp.parked(pg_temp.vcommit(b, 'p40b-park-reads', jsonb_build_array(pg_temp.deletes('p40r/a.txt'),
		pg_temp.deletes('p40b-root.txt'))))).id;
	y := pg_temp.agent_run();
	z := pg_temp.agent_run();
	v_reads := (select e -> 'reads' from jsonb_array_elements(pg_temp.list(y -> 'actor') -> 'proposals') e
		where e ->> 'proposalId' = p::text);
	perform pg_temp.same(v_reads, jsonb_build_array(
		jsonb_build_object('path', 'p40b-root.txt', 'authority', pg_temp.read('p40b-root.txt', y -> 'actor') -> 'entry' -> 'authority'),
		jsonb_build_object('path', 'p40r/a.txt', 'authority', pg_temp.read('p40r/a.txt', y -> 'actor') -> 'entry' -> 'authority')),
		'The reads');
	if v_reads -> 1 -> 'authority' ->> 'resourceId' <> v_res::text or v_reads -> 1 -> 'authority' ->> 'grantId' <> v_g::text then
		raise exception 'A read under the resource names its grant: %', v_reads; end if;
	v_late := (select e -> 'reads' from jsonb_array_elements(pg_temp.list(z -> 'actor') -> 'proposals') e
		where e ->> 'proposalId' = p::text);
	-- Released (with no version), the run watches the pair; nothing has changed yet.
	perform pg_temp.release(y -> 'actor', extensions.gen_random_uuid(), v_reads);
	if not exists (select 1 from pg_temp.reads(y -> 'actor') r where r.resource_id = v_res and r.grant_id = v_g) then
		raise exception 'The released reads are watched: %', (select jsonb_agg(to_jsonb(r)) from pg_temp.reads(y -> 'actor') r); end if;
	if public.qorpera_folder_run_reads_current(c_env, c_profile, pg_temp.resolved(y -> 'actor')) <> 0 then
		raise exception 'Nothing changed yet'; end if;
	-- The grant is revoked after both lists: the released run is fenced, the late release refused.
	perform public.qorpera_folder_revoke(c_env, pg_temp.member(1), v_res, v_g);
	perform pg_temp.raises(format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', c_env, c_profile,
		pg_temp.resolved(y -> 'actor')), '42501');
	perform pg_temp.raises(format('select pg_temp.release(%L, %L, %L)', z -> 'actor', extensions.gen_random_uuid(), v_late), '42501');
	perform pg_temp.discard(1, p);
end $$;

-- 3. The approval path: the reviewer's allow of apply_proposal, R1's record of the proposal's own units, the apply. The
-- unit saves, the proposal is applied and its roots go; a retry with the same key replays; any other use is refused.
do $$
declare x jsonb := pg_temp.agent_run(); p1 uuid := current_setting('qorpera_test.p1')::uuid; v_action uuid; r jsonb; c jsonb;
	p public.qorpera_folder_proposals; v_row public.qorpera_folder_reviews;
begin
	v_action := (pg_temp.apply_action(x -> 'binding', 'apply-1', p1) ->> 'reviewId')::uuid;
	r := pg_temp.record_apply(x -> 'binding', v_action, p1);
	select * into v_row from public.qorpera_folder_reviews where id = (r ->> 'reviewId')::uuid;
	if v_row.proposal_id is distinct from p1 or v_row.units <> '{1}' or v_row.change_set_sha256 <> (pg_temp.proposal(p1)).change_set_sha256
		or v_row.run_id::text <> x -> 'actor' ->> 'runId' then
		raise exception 'The recorded review: % %', r, to_jsonb(v_row); end if;
	if pg_temp.record_apply(x -> 'binding', v_action, p1) <> r then raise exception 'A replay of the record returns it'; end if;
	c := pg_temp.apply(x -> 'actor', 'apply-p1', p1, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	p := pg_temp.proposal(p1);
	if pg_temp.present('rr1.txt') or p.status <> 'applied' or p.units <> '[]' or p.apply_commit_id <> (c ->> 'commitId')::uuid
		or p.review_id <> (r ->> 'reviewId')::uuid or p.decided_by <> 'review' or p.decided_by_user_id is not null
		or exists (select 1 from public.qorpera_folder_proposal_paths where proposal_id = p1)
		or (select proposal_id from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid) is distinct from p1 then
		raise exception 'The applied proposal: % %', c, to_jsonb(p); end if;
	-- A retry with the same key replays; another key, a second record, the list: it is no longer open.
	perform pg_temp.same(pg_temp.apply(x -> 'actor', 'apply-p1', p1, (r ->> 'reviewId')::uuid) - 'replay', c - 'replay', 'The replay');
	-- The same key with another review or a receipt is another request: refused, as the commit refuses it.
	perform pg_temp.raises(format('select pg_temp.apply(%L, %L, %L, %L)', x -> 'actor', 'apply-p1', p1, extensions.gen_random_uuid()),
		'22023');
	perform pg_temp.raises(format('select public.qorpera_folder_apply_proposal(%L, %L, %L, %L, %L, %L)', '63400000-0000-4000-8000-000000000020',
		x -> 'actor', 'apply-p1', p1, r ->> 'reviewId', extensions.gen_random_uuid()), '22023');
	perform pg_temp.raises(format('select pg_temp.apply(%L, %L, %L, %L)', x -> 'actor', 'apply-p1-again', p1, r ->> 'reviewId'), 'P0002');
	perform pg_temp.raises(format('select pg_temp.record_apply(%L, %L, %L)', x -> 'binding',
		pg_temp.apply_action(x -> 'binding', 'apply-1b', p1) ->> 'reviewId', p1), '42501');
	if jsonb_array_length(pg_temp.list(x -> 'actor') -> 'proposals') <> 1 then raise exception 'An applied proposal is not listed'; end if;
end $$;

-- 4. What the recorder and the apply refuse: a call whose arguments do not name the proposal, a run for another member, an
-- approval of another proposal, a review of other units, an external effect.
do $$
declare x jsonb := pg_temp.agent_run(); other jsonb := pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1',
		'63400000-0000-4000-8000-000000000004');
	same jsonb := pg_temp.agent_run();
	p2 uuid := current_setting('qorpera_test.p2')::uuid; v_action uuid; r jsonb; v_review uuid;
begin
	-- The layering: arguments that are not exactly {"proposalId":…}, or a digest of another call.
	perform pg_temp.raises(format('select public.qorpera_record_action_review(%L, %L)', x -> 'binding', jsonb_build_object('callId', 'bad-1',
		'tool', 'apply_proposal', 'effect', 'destructive', 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p2),
		'action', jsonb_build_object('title', 'x', 'arguments', '{"proposalId": "' || p2 || '"}'), 'decision', 'allow', 'ruleIds', '[]'::jsonb,
		'builtIn', 'none', 'reason', 'r', 'proposedRule', null, 'reviewerModel', 'm')), '22023');
	perform pg_temp.raises(format('select public.qorpera_record_action_review(%L, %L)', x -> 'binding', jsonb_build_object('callId', 'bad-2',
		'tool', 'apply_proposal', 'effect', 'external', 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p2),
		'action', jsonb_build_object('title', 'x', 'arguments', '{"proposalId":"' || p2 || '"}'), 'decision', 'allow', 'ruleIds', '[]'::jsonb,
		'builtIn', 'none', 'reason', 'r', 'proposedRule', null, 'reviewerModel', 'm')), '22023');
	-- The recorder's request: a proposal id, never units.
	v_action := (pg_temp.apply_action(x -> 'binding', 'apply-2', p2) ->> 'reviewId')::uuid;
	perform pg_temp.raises(format('select public.qorpera_folder_record_review(%L, %L)', x -> 'binding', jsonb_build_object('actionReviewId',
		v_action, 'tool', 'apply_proposal', 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p2), 'units', '[]'::jsonb)), '22023');
	-- An approval of p2 does not stand for another proposal id; a run for another member has no approval of its own.
	perform pg_temp.raises(format('select pg_temp.record_apply(%L, %L, %L)', x -> 'binding', v_action, current_setting('qorpera_test.p1')),
		'42501');
	perform pg_temp.raises(format('select pg_temp.record_apply(%L, %L, %L)', other -> 'binding',
		pg_temp.apply_action(other -> 'binding', 'apply-other', p2) ->> 'reviewId', p2), '42501');
	-- The apply takes only a review of this proposal; another run's review of it applies nothing.
	r := pg_temp.record_apply(x -> 'binding', v_action, p2);
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('63400000-0000-4000-8000-000000000020', (x -> 'actor' ->> 'runId')::uuid, (pg_temp.proposal(p2)).change_set_sha256, '{1}', 'allow')
	returning id into v_review;
	perform pg_temp.raises(format('select pg_temp.apply(%L, %L, %L, %L)', x -> 'actor', 'apply-p2-plain-review', p2, v_review), '22023');
	perform pg_temp.expect(pg_temp.apply(other -> 'actor', 'apply-p2-other-run', p2, (r ->> 'reviewId')::uuid), 1, 'denied', 'review_required');
	-- Another run of the same agent for the same member, with this run's review: refused too, and the proposal is left
	-- open with its units and roots, for the run that was approved.
	perform pg_temp.expect(pg_temp.apply(same -> 'actor', 'apply-p2-same-member', p2, (r ->> 'reviewId')::uuid), 1, 'denied',
		'review_required');
	if (pg_temp.proposal(p2)).units = '[]' or not exists (select 1 from public.qorpera_folder_proposal_paths where proposal_id = p2) then
		raise exception 'A refused apply emptied p2'; end if;
	if (pg_temp.proposal(p2)).status <> 'open' or not pg_temp.present('rr2.txt') then raise exception 'A refused apply changed p2'; end if;
	perform set_config('qorpera_test.p2_review', r ->> 'reviewId', true);
	perform set_config('qorpera_test.p2_run', x::text, true);
end $$;

-- 5. A base that moved: the member edits the file first, so the parked delete is a conflict and the proposal is not
-- applied; it closes all the same.
do $$
declare x jsonb := current_setting('qorpera_test.p2_run')::jsonb; p2 uuid := current_setting('qorpera_test.p2')::uuid; c jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'p2-moved', jsonb_build_array(jsonb_build_object('op','write','path','rr2.txt',
		'file', pg_temp.stage('moved', pg_temp.member(2)), 'expectedVersion', pg_temp.read('rr2.txt') -> 'entry' ->> 'version'))), 1, 'saved');
	c := pg_temp.apply(x -> 'actor', 'apply-p2', p2, current_setting('qorpera_test.p2_review')::uuid);
	perform pg_temp.expect(c, 1, 'conflict', 'version_changed');
	if (pg_temp.proposal(p2)).status <> 'not_applied' or c ->> 'seq' is not null or not pg_temp.present('rr2.txt') then
		raise exception 'A proposal whose base moved: % %', c, to_jsonb(pg_temp.proposal(p2)); end if;
end $$;

-- 6. Closing: a deny declines it (the action review named); the agent's run discards it; a close naming no denial is
-- refused; the asked member and an admin discard, another member may not; a decided proposal answers as it stands.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); p3 uuid; p4 uuid; p5 uuid; p6 uuid; v_deny uuid; v_allow uuid;
	r jsonb;
begin
	p3 := (pg_temp.parked(pg_temp.vcommit(b, 'p40-park-3', jsonb_build_array(pg_temp.deletes('rr4.txt'))))).id;
	p4 := (pg_temp.parked(pg_temp.vcommit(b, 'p40-park-4', jsonb_build_array(pg_temp.deletes('rr5.txt'))))).id;
	p5 := (pg_temp.parked(pg_temp.vcommit(b, 'p40-park-5', jsonb_build_array(pg_temp.deletes('rr6.txt'))))).id;
	p6 := (pg_temp.parked(pg_temp.vcommit(b, 'p40-park-6', jsonb_build_array(pg_temp.deletes('rr7.txt'))))).id;
	v_deny := (pg_temp.apply_action(x -> 'binding', 'deny-3', p3, 'deny') ->> 'reviewId')::uuid;
	v_allow := (pg_temp.apply_action(x -> 'binding', 'allow-4', p4) ->> 'reviewId')::uuid;
	perform pg_temp.raises(format('select pg_temp.close(%L, %L)', x -> 'binding', jsonb_build_object('proposalId', p4, 'actionReviewId', v_allow)),
		'42501');
	perform pg_temp.raises(format('select pg_temp.close(%L, %L)', x -> 'binding', jsonb_build_object('proposalId', p4, 'actionReviewId', v_deny)),
		'42501');
	perform pg_temp.same(pg_temp.close(x -> 'binding', jsonb_build_object('proposalId', p3, 'actionReviewId', v_deny)),
		jsonb_build_object('schema', 'qorpera.folder-proposal/v1', 'proposalId', p3, 'status', 'declined'), 'A denied proposal');
	if (pg_temp.proposal(p3)).action_review_id <> v_deny or (pg_temp.proposal(p3)).decided_by <> 'review' then
		raise exception 'The decline names its denial: %', to_jsonb(pg_temp.proposal(p3)); end if;
	if pg_temp.close(x -> 'binding', jsonb_build_object('proposalId', p4)) ->> 'status' <> 'discarded'
		or (pg_temp.proposal(p4)).decided_by <> 'staff_agent' then raise exception 'The agent discarded p4'; end if;
	perform pg_temp.raises(format('select pg_temp.close(%L, %L)', x -> 'binding', jsonb_build_object('proposalId', p4, 'extra', true)), '22023');
	-- Another member's run sees no such proposal.
	perform pg_temp.raises(format('select pg_temp.close(%L, %L)', (pg_temp.agent_run('63400000-0000-4000-8000-0000000000a1',
		'63400000-0000-4000-8000-000000000004')) -> 'binding', jsonb_build_object('proposalId', p5)), 'P0002');
	perform pg_temp.raises(format('select pg_temp.discard(4, %L)', p5), '42501');
	if pg_temp.discard(2, p5) ->> 'status' <> 'discarded' or pg_temp.discard(5, p6) ->> 'status' <> 'discarded'
		or (pg_temp.proposal(p5)).decided_by_user_id <> '63400000-0000-4000-8000-000000000002'
		or (pg_temp.proposal(p6)).decided_by_user_id <> '63400000-0000-4000-8000-000000000005' then
		raise exception 'The member''s and the admin''s discards: % %', to_jsonb(pg_temp.proposal(p5)), to_jsonb(pg_temp.proposal(p6)); end if;
	-- Decided: each answers as it stands, and the files are untouched.
	if pg_temp.discard(1, p3) ->> 'status' <> 'declined' or pg_temp.close(x -> 'binding', jsonb_build_object('proposalId', p5)) ->> 'status' <> 'discarded'
		or not (pg_temp.present('rr4.txt') and pg_temp.present('rr5.txt') and pg_temp.present('rr6.txt') and pg_temp.present('rr7.txt')) then
		raise exception 'A decided proposal answers as it stands'; end if;
	if exists (select 1 from public.qorpera_folder_proposal_paths where proposal_id in (p3, p4, p5, p6))
		or exists (select 1 from public.qorpera_folder_proposals where id in (p3, p4, p5, p6) and units <> '[]') then
		raise exception 'A decided proposal keeps no units or path rows'; end if;
end $$;

-- 7. A parked hire: a new agent folder (delegation) roots its file while open. A restricted agent (its root grant
-- expires, so it cannot give a new agent its default access) asks the owners and admins: its reviewer's allow is
-- recorded as an ask, the recorder refuses it until an owner answers, and then the agent is made.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); r jsonb; p public.qorpera_folder_proposals; v_manifest text;
	nora constant uuid := '63400000-0000-4000-8000-00000000f040'; v_action jsonb; c jsonb;
begin
	-- The fixture has no QorperaOS/agents/ folder yet: the owner makes it.
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(1), 'p40-agents-folder',
		'[{"op":"mkdir","path":"QorperaOS"},{"op":"mkdir","path":"QorperaOS/agents"}]'), 2, 'saved');
	r := pg_temp.vcommit(b, 'p40-park-hire', jsonb_build_array(pg_temp.hire(b, 'nora', nora, 'Nora')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	p := pg_temp.parked(r);
	select q.manifest_sha256 into v_manifest from public.qorpera_folder_proposal_paths q where q.proposal_id = p.id and q.path = 'QorperaOS/agents/nora/agent.md';
	if p.effect <> 'delegation' or v_manifest is null
		or (select count(*) from public.qorpera_folder_proposal_paths q where q.proposal_id = p.id) <> 4 then
		raise exception 'The parked hire: % %', to_jsonb(p), (select jsonb_agg(to_jsonb(q)) from public.qorpera_folder_proposal_paths q
			where q.proposal_id = p.id); end if;
	-- Its upload's own root ends; the open proposal still roots the file.
	perform pg_temp.fx(format('update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval ''2 days''
		where environment_id = %L and manifest_sha256 = %L', '63400000-0000-4000-8000-000000000020', v_manifest));
	if not public.qorpera_folder_object_rooted('63400000-0000-4000-8000-000000000010', v_manifest) then
		raise exception 'An open proposal roots its file'; end if;
	if not (pg_temp.list(x -> 'actor') -> 'proposals' @> jsonb_build_array(jsonb_build_object('proposalId', p.id, 'createsAgent', true))) then
		raise exception 'The list says the proposal makes an agent: %', pg_temp.list(x -> 'actor'); end if;
	-- (P40b) It names what the new folder contains, each item by path and kind, for the review to read.
	perform pg_temp.same((select q -> 'units' -> 0 -> 'contains' from jsonb_array_elements(pg_temp.list(x -> 'actor') -> 'proposals') q
		where q ->> 'proposalId' = p.id::text), '[{"path":"QorperaOS/agents/nora/agent.md","kind":"file"},
		{"path":"QorperaOS/agents/nora/memory","kind":"folder"},{"path":"QorperaOS/agents/nora/todos","kind":"folder"}]'::jsonb,
		'A listed new folder''s items');
	-- Agent A becomes restricted.
	perform pg_temp.fx(format('update public.qorpera_company_path_grants set expires_at = clock_timestamp() + interval ''1 day'' where id = %L',
		(pg_temp.agent_grant((pg_temp.root()).id, '63400000-0000-4000-8000-0000000000a1')).id));
	v_action := pg_temp.apply_action(x -> 'binding', 'apply-hire', p.id, 'allow', 'delegation');
	if (select decision || ':' || approver_scope from public.qorpera_action_reviews where id = (v_action ->> 'reviewId')::uuid)
		<> 'ask:owners_admins' then raise exception 'A restricted agent''s parked hire asks the owners and admins: %', v_action; end if;
	perform pg_temp.raises(format('select pg_temp.record_apply(%L, %L, %L)', x -> 'binding', v_action ->> 'reviewId', p.id), '42501');
	perform pg_temp.fx(format('update public.qorpera_action_reviews set answer = ''allow_once'', answered_by_user_id = %L,
		answered_at = clock_timestamp(), consumed_at = clock_timestamp(), consumed_run_id = %L where id = %L',
		'63400000-0000-4000-8000-000000000001', x -> 'actor' ->> 'runId', v_action ->> 'reviewId'));
	r := pg_temp.record_apply(x -> 'binding', (v_action ->> 'reviewId')::uuid, p.id);
	if (r ->> 'approvedBy')::uuid is distinct from '63400000-0000-4000-8000-000000000001' then raise exception 'The owner approved: %', r; end if;
	c := pg_temp.apply(x -> 'actor', 'apply-hire', p.id, (r ->> 'reviewId')::uuid);
	perform pg_temp.expect(c, 1, 'saved');
	if not exists (select 1 from public.qorpera_profile_staff where profile_id = '63400000-0000-4000-8000-000000000010' and staff_agent_id = nora)
		or (pg_temp.proposal(p.id)).decided_by_user_id is distinct from '63400000-0000-4000-8000-000000000001'
		or (select approver_user_id from public.qorpera_folder_commits where id = (c ->> 'commitId')::uuid)
			is distinct from '63400000-0000-4000-8000-000000000001' then
		raise exception 'The approved hire: % %', c, to_jsonb(pg_temp.proposal(p.id)); end if;
end $$;

-- 8. A discarded proposal no longer roots its file.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); p public.qorpera_folder_proposals; v_manifest text;
begin
	p := pg_temp.parked(pg_temp.vcommit(b, 'p40-park-hire-2', jsonb_build_array(pg_temp.hire(b, 'ola', '63400000-0000-4000-8000-00000000f041', 'Ola'))));
	select q.manifest_sha256 into v_manifest from public.qorpera_folder_proposal_paths q where q.proposal_id = p.id and q.manifest_sha256 is not null;
	perform pg_temp.fx(format('update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval ''2 days''
		where environment_id = %L and manifest_sha256 = %L', '63400000-0000-4000-8000-000000000020', v_manifest));
	if not public.qorpera_folder_object_rooted('63400000-0000-4000-8000-000000000010', v_manifest) then
		raise exception 'An open proposal roots its file'; end if;
	perform pg_temp.discard(1, p.id);
	if public.qorpera_folder_object_rooted('63400000-0000-4000-8000-000000000010', v_manifest) then
		raise exception 'A discarded proposal still roots its file'; end if;
end $$;

-- 9. Erasure: a deleted root erases the open proposals naming a path under it, before its cutoff; the reply counts them.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); p uuid; e jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'erase-setup', jsonb_build_array(jsonb_build_object('op','mkdir','path','erase-me'),
		jsonb_build_object('op','write','path','erase-me/x.txt','file', pg_temp.stage('erase me', pg_temp.member(2))))), 2, 'saved');
	p := (pg_temp.parked(pg_temp.vcommit(b, 'p40-park-erase', jsonb_build_array(pg_temp.deletes('erase-me/x.txt'))))).id;
	perform pg_temp.expect(pg_temp.commit(pg_temp.member(2), 'erase-delete', jsonb_build_array(jsonb_build_object('op','delete','path','erase-me',
		'expectedVersion', pg_temp.read('erase-me') -> 'entry' ->> 'version', 'asOfSeq', (select last_seq from public.qorpera_folder_clocks
			where environment_id = '63400000-0000-4000-8000-000000000020')))), 1, 'saved');
	e := public.qorpera_folder_erase('63400000-0000-4000-8000-000000000020', pg_temp.member(1), '["erase-me"]', 'erase-p40-1');
	if (e -> 'erased' ->> 'proposals')::integer <> 1 or (pg_temp.proposal(p)).id is not null
		or exists (select 1 from public.qorpera_folder_proposal_paths where proposal_id = p) then
		raise exception 'The erased proposal: %', e; end if;
end $$;

-- 10. The grants: API clients reach none of the new functions; the tables are the service's alone.
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_folder_agent_proposals(uuid,jsonb,jsonb)',
			'public.qorpera_folder_apply_proposal(uuid,jsonb,text,uuid,uuid,uuid)', 'public.qorpera_folder_close_proposal(jsonb,jsonb)',
			'public.qorpera_folder_member_discard_proposal(uuid,jsonb,uuid)', 'public.qorpera_folder_proposal_call_sha256(uuid)',
			'public.qorpera_folder_proposal_of_call(text,text)', 'public.qorpera_folder_units_create_agent(uuid,jsonb)',
			'public.qorpera_folder_proposal_hires(uuid,jsonb)', 'public.qorpera_folder_proposal_reads(uuid,uuid,jsonb,uuid)'] loop
		if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
			raise exception 'API clients reach %', v_fn; end if;
	end loop;
	-- (P40b) The reads are the listing's alone.
	if has_function_privilege('service_role', 'public.qorpera_folder_proposal_reads(uuid,uuid,jsonb,uuid)', 'execute') then
		raise exception 'The service reaches the proposal reads'; end if;
	if has_table_privilege('service_role', 'public.qorpera_folder_proposals', 'select')
		or has_table_privilege('authenticated', 'public.qorpera_folder_proposal_paths', 'select') then
		raise exception 'The proposal tables are readable'; end if;
	if public.qorpera_folder_proposal_call_sha256('63400000-0000-4000-8000-00000000f040')
		<> encode(extensions.digest(convert_to('["qorpera","apply_proposal","{\"proposalId\":\"63400000-0000-4000-8000-00000000f040\"}"]',
			'utf8'), 'sha256'), 'hex') then
		raise exception 'The call digest is JSON.stringify of [namespace, tool, arguments]'; end if;
end $$;

-- 11. P40b: a member's discard (or an erasure) lands after the run recorded its review and began the apply's receipt.
-- The apply then cancels that receipt, the run's own for this proposal's apply, still executing with no commit, and says
-- what the proposal is, so nothing fences the run; a retry answers the same. Any other receipt is refused as before and
-- left executing. (The receipts are written here as the runtime's begin writes them; 927 begins them for real.)
create function pg_temp.receipt(p_binding jsonb, p_key text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	perform pg_temp.fx(format('insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, logical_operation_key,
		operation_kind, input_sha256, downstream_idempotency_sha256, requires_company_revision) values (%L, %L, %L, %L, %L, %L, %L, %L, true)',
		v_id, p_binding ->> 'runId', p_binding ->> 'jobId', p_binding ->> 'assignmentId', p_key, 'cloud_tool', repeat('a', 64), repeat('b', 64)));
	return v_id;
end $$;
create function pg_temp.apply_under(p_run jsonb, p_proposal uuid, p_review uuid, p_receipt uuid) returns jsonb language sql as $$
	select public.qorpera_folder_apply_proposal('63400000-0000-4000-8000-000000000020', p_run, 'apply-proposal:' || p_proposal,
		p_proposal, p_review, p_receipt)
$$;
create function pg_temp.receipt_status(p_receipt uuid) returns text language sql as $$
	select status from public.qorpera_run_operation_receipts where id = p_receipt
$$;
do $$
declare x jsonb := pg_temp.agent_run(); y jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); p uuid; q uuid;
	v_review uuid; v_erased uuid; v_receipt uuid; v_other uuid; v_wrong uuid; a jsonb; v_row public.qorpera_run_operation_receipts;
begin
	p := (pg_temp.parked(pg_temp.vcommit(b, 'p40b-park-1', jsonb_build_array(pg_temp.deletes('rr9.txt'))))).id;
	q := (pg_temp.parked(pg_temp.vcommit(b, 'p40b-park-2', jsonb_build_array(pg_temp.deletes('rr10.txt'))))).id;
	v_review := (pg_temp.record_apply(x -> 'binding', (pg_temp.apply_action(x -> 'binding', 'p40b-apply-1', p) ->> 'reviewId')::uuid, p)
		->> 'reviewId')::uuid;
	v_erased := (pg_temp.record_apply(x -> 'binding', (pg_temp.apply_action(x -> 'binding', 'p40b-apply-2', q) ->> 'reviewId')::uuid, q)
		->> 'reviewId')::uuid;
	perform pg_temp.discard(1, p);
	-- Not the call's receipt: another run's for this apply, or this run's for another proposal's.
	v_other := pg_temp.receipt(y -> 'binding', 'apply_proposal:apply:' || p);
	v_wrong := pg_temp.receipt(x -> 'binding', 'apply_proposal:apply:' || q);
	perform pg_temp.raises(format('select pg_temp.apply_under(%L, %L, %L, %L)', x -> 'actor', p, v_review, v_other), 'P0002');
	perform pg_temp.raises(format('select pg_temp.apply_under(%L, %L, %L, %L)', x -> 'actor', p, v_review, v_wrong), 'P0002');
	if pg_temp.receipt_status(v_other) <> 'executing' or pg_temp.receipt_status(v_wrong) <> 'executing' then
		raise exception 'A receipt that is not the call''s was settled'; end if;
	-- The call's own: cancelled, nothing applied.
	v_receipt := pg_temp.receipt(x -> 'binding', 'apply_proposal:apply:' || p);
	a := pg_temp.apply_under(x -> 'actor', p, v_review, v_receipt);
	perform pg_temp.same(a, jsonb_build_object('schema', 'qorpera.folder-proposal-unapplied/v1', 'proposalId', p, 'status', 'discarded',
		'receiptId', v_receipt), 'The apply of a proposal discarded after its review');
	select * into v_row from public.qorpera_run_operation_receipts where id = v_receipt;
	if v_row.status <> 'cancelled' or v_row.completed_at is null or v_row.result is not null or v_row.folder_commit_id is not null
		or exists (select 1 from public.qorpera_folder_commits c where c.receipt_id = v_receipt or c.operation_key = 'apply-proposal:' || p)
		or not pg_temp.present('rr9.txt') then
		raise exception 'The cancelled receipt: %', to_jsonb(v_row); end if;
	-- A retry answers the same and leaves the receipt as it is; without a receipt the apply is refused as before.
	perform pg_temp.same(pg_temp.apply_under(x -> 'actor', p, v_review, v_receipt), a, 'A retry');
	if (select completed_at from public.qorpera_run_operation_receipts where id = v_receipt) <> v_row.completed_at then
		raise exception 'A retry settled the receipt again'; end if;
	perform pg_temp.raises(format('select pg_temp.apply(%L, %L, %L, %L)', x -> 'actor', 'apply-proposal:' || p, p, v_review), 'P0002');
	-- Erased (deleted, as erasure deletes it in 9): answered as erased, its receipt cancelled.
	perform pg_temp.fx(format('delete from public.qorpera_folder_proposals where id = %L', q));
	perform pg_temp.same(pg_temp.apply_under(x -> 'actor', q, v_erased, v_wrong), jsonb_build_object('schema',
		'qorpera.folder-proposal-unapplied/v1', 'proposalId', q, 'status', 'erased', 'receiptId', v_wrong), 'The apply of an erased proposal');
	if pg_temp.receipt_status(v_wrong) <> 'cancelled' or pg_temp.present('rr10.txt') is not true then
		raise exception 'The erased proposal''s receipt: %', pg_temp.receipt_status(v_wrong); end if;
end $$;

-- 12. 20260930619000: a view's own file moves and deletes as ordinary work, as Blender saves (room.blend to room.blend1,
-- a new room.blend; the next save deletes room.blend1). Another view's file, a file the view did not last change, and a
-- file under QorperaOS/ still park.
do $$
declare x jsonb := pg_temp.agent_run(); y jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor');
	c jsonb := pg_temp.box(y -> 'actor'); r jsonb;
begin
	perform pg_temp.expect(pg_temp.vcommit(b, 'own-file-1', jsonb_build_array(jsonb_build_object('op','write','path','own-room.blend',
		'file', pg_temp.stage('scene 1', pg_temp.vactor(b))))), 1, 'saved');
	r := pg_temp.vcommit(b, 'own-file-2', jsonb_build_array(jsonb_build_object('op','move','from','own-room.blend','to','own-room.blend1',
		'expectedVersion', pg_temp.read('own-room.blend') -> 'entry' ->> 'version'),
		jsonb_build_object('op','write','path','own-room.blend','file', pg_temp.stage('scene 2', pg_temp.vactor(b)))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	if (pg_temp.parked(r)).id is not null or not pg_temp.present('own-room.blend1') then
		raise exception 'A view''s own rename parked: %', r; end if;
	-- Its own moved file deletes too.
	r := pg_temp.vcommit(b, 'own-file-3', jsonb_build_array(pg_temp.deletes('own-room.blend1')));
	perform pg_temp.expect(r, 1, 'saved');
	if pg_temp.present('own-room.blend1') then raise exception 'A view''s own delete changed nothing'; end if;
	-- Another view (another run's box): the file is not its own, so it parks.
	r := pg_temp.vcommit(c, 'own-file-4', jsonb_build_array(pg_temp.deletes('own-room.blend')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	-- A member's file (rr12.txt, written by the member) still parks, as in 1.
	r := pg_temp.vcommit(b, 'own-file-5', jsonb_build_array(jsonb_build_object('op','move','from','rr12.txt','to','rr12-moved.txt',
		'expectedVersion', pg_temp.read('rr12.txt') -> 'entry' ->> 'version')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	-- Under QorperaOS/: its own file still parks.
	perform pg_temp.expect(pg_temp.vcommit(b, 'own-file-6', jsonb_build_array(jsonb_build_object('op','write','path','QorperaOS/own-note.md',
		'file', pg_temp.stage('note', pg_temp.vactor(b))))), 1, 'saved');
	r := pg_temp.vcommit(b, 'own-file-7', jsonb_build_array(pg_temp.deletes('QorperaOS/own-note.md')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
end $$;

rollback;
