-- @fixture 864_folder_state_interfaces.test.sql until "-- 1. The kinds, by the path's shape alone"
-- Interfaces C6c (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §2; 20260930510000): an agent authors no page or table
-- layout, whatever carries the change. The save check refuses each unit of an agent's that changes or lands anything
-- under interfaces/, or the tables/ root, a table's folder or its table.toml, with the code layout_authoring and the
-- message "page and table layout authoring is not available"; the commit's other units save. The carriers: a run's
-- tool calls (a write, a new folder, mkdir, delete, move out and in, copy in, a link), the same call again,
-- save_interface's recorded approval, a view's commit (a run box; every agent view's hook actor is the agent's), and a
-- proposal a view parked before the rule, applied after it. An agent still copies out of interfaces/, writes a table's
-- rows and README; members and the platform keep their writes (the seed above is the platform's creation commit);
-- nothing stored is deleted. The seed is 864's, runs are 647's, reviews 769's recorder, and the views and proposals
-- 926's.

create function pg_temp.box(p_run jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_view_open('63400000-0000-4000-8000-000000000020', p_run, 'run_box', '{}')
$$;
create function pg_temp.vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',p_view ->> 'viewId','pass',p_view ->> 'pass')
$$;
create function pg_temp.vcommit(p_view jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_key, p_units)
$$;
create function pg_temp.parked(p_commit jsonb) returns public.qorpera_folder_proposals language sql as $$
	select * from public.qorpera_folder_proposals where commit_id = (p_commit ->> 'commitId')::uuid
$$;
create function pg_temp.proposal(p_id uuid) returns public.qorpera_folder_proposals language sql as $$
	select * from public.qorpera_folder_proposals where id = p_id
$$;
-- The agent's next run applies a proposal: the reviewer's allow of the apply_proposal call, the record, the apply.
create function pg_temp.approve(x jsonb, p_call text, p_proposal uuid) returns jsonb language plpgsql as $$
declare v_action uuid := (public.qorpera_record_action_review(x -> 'binding', jsonb_build_object('callId', p_call,
	'tool', 'apply_proposal', 'effect', 'destructive', 'argumentSha256', public.qorpera_folder_proposal_call_sha256(p_proposal),
	'action', jsonb_build_object('title', 'Apply the changes', 'target', 'files', 'details', '{}'::jsonb,
		'arguments', '{"proposalId":"' || p_proposal || '"}'),
	'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
	'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
begin
	return public.qorpera_folder_apply_proposal('63400000-0000-4000-8000-000000000020', x -> 'actor', p_call, p_proposal,
		(public.qorpera_folder_record_review(x -> 'binding', jsonb_build_object('actionReviewId', v_action, 'tool', 'apply_proposal',
			'argumentSha256', public.qorpera_folder_proposal_call_sha256(p_proposal), 'proposalId', p_proposal)) ->> 'reviewId')::uuid);
end $$;
-- Refused by the rule: its code, its message, and no other problem.
create function pg_temp.layout(p_result jsonb, p_unit integer) returns void language plpgsql as $$
begin
	perform pg_temp.refused(p_result, p_unit, 'structured_rule', 'layout_authoring');
	if pg_temp.problem(p_result, p_unit) is distinct from 'page and table layout authoring is not available'
		or jsonb_array_length(p_result -> 'units' -> (p_unit - 1) -> 'problems') <> 1 then
		raise exception 'Unit % names the rule alone: %', p_unit, p_result using errcode = 'QTF01'; end if;
end $$;
-- Every live entry the rule keeps from agents (interfaces/ and below, the tables/ root, each table's folder and
-- table.toml), with its version.
create function pg_temp.layouts() returns jsonb language sql as $$
	select coalesce(jsonb_object_agg(key_text, coalesce(version::text, kind) order by key_text), '{}') from public.qorpera_folder_entries
	where environment_id = '63400000-0000-4000-8000-000000000020' and kind <> 'claim'
		and key_text ~ '^qorperaos/(interfaces(/|$)|tables(/[^/]+(/table\.toml)?)?$)'
$$;
-- The rule off, as before 20260930510000, or on again: for a proposal parked before the migration.
create function pg_temp.rule(p_on boolean) returns void language plpgsql as $$
declare
	v_on constant text := E'if p_actor ->> ''kind'' = ''staff_agent''\n\t\tand ((p_op <> ''copy''';
	v_off constant text := E'if false and p_actor ->> ''kind'' = ''staff_agent''\n\t\tand ((p_op <> ''copy''';
	v_definition text := pg_get_functiondef(
		'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure);
begin
	if position(case when p_on then v_off else v_on end in v_definition) = 0 then raise exception 'The rule is not as written'; end if;
	execute case when p_on then replace(v_definition, v_off, v_on) else replace(v_definition, v_on, v_off) end;
end $$;

-- 1. The platform's creation commit (above) saved; the platform adds a table and changes a definition, and a member
-- makes a page and writes in another, as before. Pages are on or off in their own table (20260930509000), never by a
-- file, so a member's page stays inert.
do $$
declare m jsonb := pg_temp.member(2); r jsonb;
begin
	if array(select jsonb_object_keys(pg_temp.layouts()) k order by k) <> array['qorperaos/interfaces', 'qorperaos/interfaces/mailbox',
			'qorperaos/interfaces/mailbox/interface.toml', 'qorperaos/interfaces/order.md', 'qorperaos/interfaces/pulse',
			'qorperaos/interfaces/pulse/interface.toml', 'qorperaos/interfaces/pulse/readme.md', 'qorperaos/tables', 'qorperaos/tables/areas',
			'qorperaos/tables/areas/table.toml', 'qorperaos/tables/numbers', 'qorperaos/tables/numbers/table.toml'] then
		raise exception 'The seed: %', pg_temp.layouts(); end if;
	r := pg_temp.commit('{"kind":"platform"}', 'c6-platform-0001', jsonb_build_array(
		pg_temp.p16_folder('{"kind":"platform"}', 'QorperaOS/tables/cards', jsonb_build_object(
			'table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000013') || '{"name":"Cards"}', 'rows.csv', pg_temp.fixture('rows'))),
		pg_temp.p16_write('{"kind":"platform"}', 'QorperaOS/tables/areas/table.toml',
			pg_temp.tbl('86400000-0000-4000-8000-000000000012', 'areas') || '{"about":"The company''s areas."}'),
		pg_temp.p16_write('{"kind":"platform"}', 'QorperaOS/interfaces/mailbox/README.md', '"About Mailbox."')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'saved');
	r := pg_temp.commit(m, 'c6-member-0001', jsonb_build_array(
		pg_temp.p16_folder(m, 'QorperaOS/interfaces/member-page', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000021', 'Member page', false))),
		pg_temp.p16_write(m, 'QorperaOS/interfaces/pulse/README.md', '"About Pulse, by a member."')));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
end $$;

-- 2. A run's tool calls: every change or landing the rule names is refused with its code, in the same commit as the
-- units that save (a plain file, the numbers table's rows with one changed and one added, its README, and a copy out of
-- interfaces/); then moves out and in, a copy in and a link; then the same call again. Nothing the rule keeps changed.
do $$
declare g jsonb := pg_temp.agent_run(); p jsonb := g -> 'actor'; v_before jsonb := pg_temp.layouts(); v_units jsonb; r jsonb; i integer;
	v_rows uuid := pg_temp.p16_version('QorperaOS/tables/numbers/rows.csv');
begin
	v_units := jsonb_build_array(
		pg_temp.p16_write(p, 'QorperaOS/interfaces/member-page/README.md', '"About the member''s page, by the agent."'),
		pg_temp.p16_folder(p, 'QorperaOS/interfaces/agent-page', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000022', 'Agent page', false))),
		jsonb_build_object('op','mkdir','path','QorperaOS/interfaces/agent-folder'),
		pg_temp.p16_write(p, 'QorperaOS/interfaces/order.md', pg_temp.fixture('order')),
		pg_temp.p16_delete('QorperaOS/interfaces/mailbox'),
		pg_temp.p16_write(p, 'QorperaOS/tables/numbers/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011') || '{"name":"Figures"}'),
		pg_temp.p16_folder(p, 'QorperaOS/tables/agent-table', jsonb_build_object('table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000023'))),
		jsonb_build_object('op','mkdir','path','QorperaOS/tables/agent-empty'),
		pg_temp.p16_delete('QorperaOS/tables/areas/table.toml'),
		jsonb_build_object('op','copy','from','QorperaOS/tables/areas/rows.csv','to','QorperaOS/tables/numbers-2'),
		pg_temp.p16_write(p, 'c6-plain.md', '"A plain file."'),
		pg_temp.p16_write(p, 'c6-plain-2.md', '"Another plain file."'),
		pg_temp.p16_write(p, 'QorperaOS/tables/numbers/rows.csv', jsonb_set(jsonb_set(pg_temp.fixture('rows'), '{rows,0,fields,2}', '"1300"'),
			'{rows,2}', '{"line":4,"fields":["Orders","2026-10-17T10:00:00Z","7","count","11111111-1111-4111-8111-000000000030"]}')),
		pg_temp.p16_write(p, 'QorperaOS/tables/numbers/README.md', '"About the numbers."'),
		jsonb_build_object('op','copy','from','QorperaOS/interfaces/pulse/readme.md','to','c6-pulse.md'));
	r := pg_temp.commit(p, 'c6-run-0001', v_units);
	for i in 1..10 loop perform pg_temp.layout(r, i); end loop;
	for i in 11..15 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- The same call again is the same answer, and changes nothing more.
	if pg_temp.commit(p, 'c6-run-0001', v_units) -> 'units' is distinct from r -> 'units' then
		raise exception 'The same call again: %', r; end if;
	r := pg_temp.commit(p, 'c6-run-0002', jsonb_build_array(
		pg_temp.p16_move('QorperaOS/interfaces/pulse/readme.md', 'c6-readme.md'),
		pg_temp.p16_move('c6-plain.md', 'QorperaOS/interfaces/pulse/c6.md'),
		jsonb_build_object('op','copy','from','c6-plain-2.md','to','QorperaOS/interfaces/c6-copy.md'),
		jsonb_build_object('op','symlink','path','QorperaOS/interfaces/pulse/c6.lnk','target','README.md'),
		pg_temp.p16_move('QorperaOS/tables/numbers', 'c6-numbers'),
		pg_temp.p16_move('QorperaOS/tables/areas/table.toml', 'c6-areas.toml'),
		jsonb_build_object('op','copy','from','c6-pulse.md','to','QorperaOS/tables/c6')));
	for i in 1..7 loop perform pg_temp.layout(r, i); end loop;
	if r ->> 'seq' is not null then raise exception 'A commit of refusals takes no seq: %', r; end if;
	if pg_temp.layouts() is distinct from v_before then raise exception 'The layouts changed: % %', v_before, pg_temp.layouts(); end if;
	if pg_temp.p16_version('c6-plain.md') is null or pg_temp.p16_version('c6-pulse.md') is null
		or pg_temp.p16_version('QorperaOS/tables/numbers/readme.md') is null or v_rows is null
		or pg_temp.p16_version('QorperaOS/tables/numbers/rows.csv') is not distinct from v_rows then
		raise exception 'The other units saved'; end if;
end $$;

-- 3. save_interface's recorded approval of a new page (the recorder still records it) saves nothing; nor does it for a
-- table's definition.
do $$
declare g jsonb := pg_temp.agent_run(); v_before jsonb := pg_temp.layouts(); v_units jsonb; v_review uuid; r jsonb;
begin
	v_units := jsonb_build_array(
		pg_temp.p16_folder(g -> 'actor', 'QorperaOS/interfaces/approved-page', jsonb_build_object('interface.toml',
			pg_temp.iface('86400000-0000-4000-8000-000000000024', 'Approved page', false))),
		pg_temp.p16_write(g -> 'actor', 'QorperaOS/tables/numbers/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000011') || '{"name":"Figures"}'));
	v_review := (pg_temp.record(g -> 'binding', pg_temp.action(g -> 'binding', 'c6-call-1', 'allow', 'delegation', 'save_interface'),
		v_units) ->> 'reviewId')::uuid;
	if v_review is null then raise exception 'The recorder records the approval'; end if;
	r := pg_temp.commit(g -> 'actor', 'c6-review-0001', v_units, v_review);
	perform pg_temp.layout(r, 1);
	perform pg_temp.layout(r, 2);
	if pg_temp.layouts() is distinct from v_before then raise exception 'The approval changed a layout'; end if;
end $$;

-- 4. A view's commit (a run box of the agent's run): a page change that saved at once before and a page delete that
-- parked before are both refused, and park nothing; its plain file saves.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); v jsonb := pg_temp.vactor(b);
	v_before jsonb := pg_temp.layouts(); r jsonb;
begin
	r := pg_temp.vcommit(b, 'c6-view-0001', jsonb_build_array(
		pg_temp.p16_write(v, 'QorperaOS/interfaces/pulse/interface.toml', pg_temp.iface('86400000-0000-4000-8000-000000000001', 'Pulse now', true)),
		pg_temp.p16_delete('QorperaOS/interfaces/member-page'),
		pg_temp.p16_write(v, 'QorperaOS/tables/areas/table.toml', pg_temp.tbl('86400000-0000-4000-8000-000000000012', 'areas')),
		pg_temp.p16_write(v, 'c6-view.md', '"From the machine."')));
	perform pg_temp.layout(r, 1);
	perform pg_temp.layout(r, 2);
	perform pg_temp.layout(r, 3);
	perform pg_temp.expect(r, 4, 'saved');
	if (pg_temp.parked(r)).id is not null then raise exception 'A refusal parks nothing'; end if;
	if pg_temp.layouts() is distinct from v_before then raise exception 'The view changed a layout'; end if;
end $$;

-- 5. A proposal a view parked before the rule (the function as it was), applied by the agent's next run after it: the
-- apply's commit decides again, so the delete is refused, the proposal closes not applied, and the page stays.
do $$
declare x jsonb := pg_temp.agent_run(); b jsonb := pg_temp.box(x -> 'actor'); v_before jsonb := pg_temp.layouts(); r jsonb;
	v_proposal uuid;
begin
	perform pg_temp.rule(false);
	r := pg_temp.vcommit(b, 'c6-park-0001', jsonb_build_array(pg_temp.p16_delete('QorperaOS/interfaces/member-page')));
	perform pg_temp.expect(r, 1, 'waiting_for_review', 'parked');
	v_proposal := (pg_temp.parked(r)).id;
	perform pg_temp.rule(true);
	r := pg_temp.approve(pg_temp.agent_run(), 'c6-apply-1', v_proposal);
	perform pg_temp.layout(r, 1);
	if (pg_temp.proposal(v_proposal)).status <> 'not_applied' or r ->> 'seq' is not null then
		raise exception 'The old proposal: % %', r, to_jsonb(pg_temp.proposal(v_proposal)); end if;
	if pg_temp.layouts() is distinct from v_before then raise exception 'The old proposal changed a layout'; end if;
end $$;

-- 6. Nothing stored was deleted: every definition the seed and the platform and the member wrote is still there, and
-- the patched body names this migration.
do $$
begin
	if not (pg_temp.layouts() ?& array['qorperaos/interfaces/mailbox/interface.toml', 'qorperaos/interfaces/member-page/interface.toml',
			'qorperaos/interfaces/order.md', 'qorperaos/interfaces/pulse/interface.toml', 'qorperaos/interfaces/pulse/readme.md',
			'qorperaos/tables/areas/table.toml', 'qorperaos/tables/cards/table.toml', 'qorperaos/tables/numbers/table.toml'])
		or position('20260930510000 (C6)' in pg_get_functiondef(
			'public.qorpera_company_state_interface_paths(uuid,uuid,jsonb,uuid,text,text,text,jsonb,text,text)'::regprocedure)) = 0 then
		raise exception 'Kept: %', pg_temp.layouts(); end if;
end $$;

rollback;
