-- Company state files, F2-4 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2, §4): rules on the folder core.
-- A rules/<name>.md is a company review rule in the reviewer's own table; its id never changes; the company budget
-- holds; deleting archives and a restore brings it back; the Settings RPCs refuse company rules on folder-v2.
begin;

insert into auth.users(id,email) values
	('70600000-0000-4000-8000-000000000001','rules-owner@example.test'),
	('70600000-0000-4000-8000-000000000002','rules-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('70600000-0000-4000-8000-000000000010','Nordlys Rules','70600000-0000-4000-8000-000000000001'), ('70600000-0000-4000-8000-000000000011','Second','70600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('70600000-0000-4000-8000-000000000010','70600000-0000-4000-8000-000000000001','rules-owner@example.test','Owner','owner'),
	('70600000-0000-4000-8000-000000000010','70600000-0000-4000-8000-000000000002','rules-member@example.test','Member','contributor'),
	('70600000-0000-4000-8000-000000000011','70600000-0000-4000-8000-000000000001','rules-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id) values
	('70600000-0000-4000-8000-000000000020','70600000-0000-4000-8000-000000000010','Environment',1,'70600000-0000-4000-8000-000000000001'), ('70600000-0000-4000-8000-000000000021','70600000-0000-4000-8000-000000000011','Environment',1,'70600000-0000-4000-8000-000000000001'), ('70600000-0000-4000-8000-000000000022','70600000-0000-4000-8000-000000000010','Other environment',1,'70600000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select public.qorpera_folder_enable('70600000-0000-4000-8000-000000000020') \g /dev/null
-- Verified bytes for a text, as the object gateway leaves them.
create function pg_temp.stage(p_text text, p_profile uuid default '70600000-0000-4000-8000-000000000010')
returns jsonb language plpgsql security definer as $$
declare v_hash text := encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex'); v_manifest text; v_manifest_hash text;
begin
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_hash,
		jsonb_build_object('size',octet_length(p_text))) on conflict do nothing;
	v_manifest := jsonb_build_object('schema','qorpera.cloud-file-manifest/v1','fileSha256',v_hash,
		'bytes',octet_length(p_text),'mediaType','application/octet-stream','chunks',case when p_text = '' then '[]'::jsonb
		else jsonb_build_array(jsonb_build_object('sha256',v_hash,'bytes',octet_length(p_text))) end)::text;
	v_manifest_hash := encode(extensions.digest(convert_to(v_manifest,'utf8'),'sha256'),'hex');
	insert into storage.objects(bucket_id,name,metadata)
	values ('qorpera-profile-objects',p_profile::text || '/' || v_manifest_hash,
		jsonb_build_object('size',octet_length(v_manifest))) on conflict do nothing;
	perform public.qorpera_verify_company_path_file(p_profile,v_manifest);
	return jsonb_build_object('manifestSha256',v_manifest_hash,'fileSha256',v_hash,'bytes',octet_length(p_text),
		'mediaType','text/markdown','executable',false);
end $$;

-- A structured entry as the TS parser sends it.
create function pg_temp.entry(p_path text, p_kind text, p_text text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_kind, 'text', p_text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.write(p_path text, p_kind text, p_text text, p_parse jsonb, p_expected uuid default null) returns jsonb language sql as $$
	select jsonb_build_object('op','write','path',p_path,'file',pg_temp.stage(p_text),
		'structured', jsonb_build_array(pg_temp.entry(p_path, p_kind, p_text, p_parse)))
		|| case when p_expected is not null then jsonb_build_object('expectedVersion', p_expected) else '{}'::jsonb end
$$;
create function pg_temp.agent_text(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: %s\nstatus: %s\n---\nSell.\n', p_id, p_name, p_kind, p_status)
$$;
create function pg_temp.agent_parse(p_id uuid, p_name text, p_kind text default 'agent', p_status text default 'active')
returns jsonb language sql as $$
	select jsonb_build_object('kind','agent','id',p_id,'name',p_name,'role','Sales','agentKind',p_kind,'status',p_status,
		'colour',null,'figure',null,'model',null,'effort',null,'instructions','Sell.')
$$;
-- A new agent folder with its agent.md, as one unit.
create function pg_temp.hire(p_handle text, p_id uuid, p_name text, p_kind text default 'agent') returns jsonb language sql as $$
	select jsonb_build_object('op','new_folder','path','agents/' || p_handle,
		'contents', jsonb_build_array(
			jsonb_build_object('path','agent.md','kind','file','file',pg_temp.stage(pg_temp.agent_text(p_id, p_name, p_kind))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/' || p_handle || '/agent.md', 'agent',
			pg_temp.agent_text(p_id, p_name, p_kind), pg_temp.agent_parse(p_id, p_name, p_kind))))
$$;
create function pg_temp.vision(p_name text) returns jsonb language sql as $$
	select pg_temp.write('vision/vision.md', 'vision', E'# ' || p_name || E'\n\n## What we build\n',
		jsonb_build_object('kind','vision','name',p_name),
		(select version from public.qorpera_folder_entries where environment_id = '70600000-0000-4000-8000-000000000020'
			and key_text = 'vision/vision.md'))
$$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_commit('70600000-0000-4000-8000-000000000020', p_actor, p_key, p_units)
$$;
create function pg_temp.owner() returns jsonb language sql as $$
	select '{"kind":"member","userId":"70600000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.expect(p_result jsonb, p_unit integer, p_outcome text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v jsonb := p_result -> 'units' -> (p_unit - 1);
begin
	if v ->> 'outcome' is distinct from p_outcome or v ->> 'reason' is distinct from p_reason then
		raise exception 'Unit % expected % (%), got %', p_unit, p_outcome, p_reason, p_result using errcode = 'QTF01'; end if;
	return v;
end $$;
create function pg_temp.version(p_key text) returns uuid language sql as $$
	select version from public.qorpera_folder_entries where environment_id = '70600000-0000-4000-8000-000000000020' and key_text = p_key
$$;
create function pg_temp.seq() returns bigint language sql as $$
	select last_seq from public.qorpera_folder_clocks where environment_id = '70600000-0000-4000-8000-000000000020'
$$;
create function pg_temp.staff(p_id uuid) returns public.qorpera_profile_staff language sql as $$
	select * from public.qorpera_profile_staff where profile_id = '70600000-0000-4000-8000-000000000010' and staff_agent_id = p_id
$$;

create function pg_temp.rule_text(p_id uuid, p_outcome text, p_text text) returns text language sql as $$
	select format(E'---\nid: %s\noutcome: %s\n---\n%s\n', p_id, p_outcome, p_text)
$$;
create function pg_temp.rule(p_name text, p_id uuid, p_outcome text, p_text text) returns jsonb language sql as $$
	select pg_temp.write('rules/' || p_name || '.md', 'rule', pg_temp.rule_text(p_id, p_outcome, p_text),
		jsonb_build_object('kind','rule','id',p_id,'outcome',p_outcome,'text',p_text), pg_temp.version('rules/' || p_name || '.md'))
$$;
create function pg_temp.row(p_id uuid) returns public.qorpera_review_rules language sql as $$
	select * from public.qorpera_review_rules where id = p_id
$$;
create function pg_temp.refused(p_result jsonb, p_reason text default 'structured_rule') returns boolean language sql as $$
	select coalesce(p_result -> 'units' -> 0 ->> 'outcome' = 'refused' and p_result -> 'units' -> 0 ->> 'reason' = p_reason, false)
$$;
create function pg_temp.reviewed(p_id uuid) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_review_rules_for('70600000-0000-4000-8000-000000000010', '70600000-0000-4000-8000-000000000002') r where r.id = p_id)
$$;

-- 1. The company, and an owner's rule file -----------------------------------------------------------------------------

do $$
declare r jsonb; i integer; x public.qorpera_review_rules; t jsonb;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Rules'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70600000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','rules')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- A rule save takes the company row at rank 2 (its new row's foreign key would take it after the paths).
	select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t from public.qorpera_folder_structured_targets('70600000-0000-4000-8000-000000000020', pg_temp.owner(),
		jsonb_build_array(pg_temp.rule('refunds', '70600000-0000-4000-8000-0000000000f1', 'allow', 'refund a customer under 500 kroner'))) y;
	if t is distinct from '[{"rank":2,"tbl":"qorpera_profiles","key":"70600000-0000-4000-8000-000000000010","mode":"keyshare"}]' then
		raise exception 'A rule save locks the company row only: %', t; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rule-0001', jsonb_build_array(
		pg_temp.rule('refunds', '70600000-0000-4000-8000-0000000000f1', 'allow', 'refund a customer under 500 kroner'))), 1, 'saved');
	x := pg_temp.row('70600000-0000-4000-8000-0000000000f1');
	if x.id is null or x.scope is distinct from 'company' or x.member_user_id is not null or x.outcome is distinct from 'allow_automatically'
		or x.when_text is distinct from 'refund a customer under 500 kroner' or x.created_via is distinct from 'folder'
		or x.created_by_user_id is distinct from '70600000-0000-4000-8000-000000000001' or x.folder_path is distinct from 'rules/refunds.md'
		or x.folder_path_version is distinct from pg_temp.version('rules/refunds.md') or x.archived_at is not null then
		raise exception 'A rule file is a company rule in the reviewer''s table: %', to_jsonb(x); end if;
	if not pg_temp.reviewed('70600000-0000-4000-8000-0000000000f1') then raise exception 'The reviewer reads the file''s rule'; end if;
	if public.qorpera_folder_structured_review_class('70600000-0000-4000-8000-000000000020', jsonb_build_object('kind','staff_agent','requesterUserId','70600000-0000-4000-8000-000000000002'),
		pg_temp.rule('refunds', '70600000-0000-4000-8000-0000000000f1', 'allow', 'x'), 'rules/refunds.md', null) is distinct from 'plain' then
		raise exception 'A rule file is never reviewed'; end if;
end $$;

-- 2. Edits, the id, and the shape ----------------------------------------------------------------------------------------

do $$
declare r jsonb; x public.qorpera_review_rules;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rule-0002', jsonb_build_array(
		pg_temp.rule('refunds', '70600000-0000-4000-8000-0000000000f1', 'ask-first', 'refund a customer'))), 1, 'saved');
	x := pg_temp.row('70600000-0000-4000-8000-0000000000f1');
	if x.outcome is distinct from 'ask_first' or x.when_text is distinct from 'refund a customer'
		or x.folder_path_version is distinct from pg_temp.version('rules/refunds.md') then
		raise exception 'An edit reaches the rule: %', to_jsonb(x); end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0003', jsonb_build_array(
		pg_temp.rule('refunds', '70600000-0000-4000-8000-0000000000f2', 'ask-first', 'refund a customer')))) then
		raise exception 'A rule''s id never changes'; end if;
	-- An id that belongs to a personal rule, or to another file's rule, is refused.
	insert into public.qorpera_review_rules(id, profile_id, scope, member_user_id, when_text, outcome, created_via, created_by_user_id)
	values ('70600000-0000-4000-8000-0000000000f3', '70600000-0000-4000-8000-000000000010', 'member', '70600000-0000-4000-8000-000000000002', 'send an email', 'ask_first', 'settings', '70600000-0000-4000-8000-000000000002');
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0004', jsonb_build_array(
		pg_temp.rule('mail', '70600000-0000-4000-8000-0000000000f3', 'ask-first', 'send an email')))) then
		raise exception 'A personal rule''s id is refused'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0005', jsonb_build_array(
		pg_temp.rule('twin', '70600000-0000-4000-8000-0000000000f1', 'ask-first', 'refund a customer')))) then
		raise exception 'One file per rule'; end if;
	-- The shape: two lines, or an unknown outcome, are not a rule.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0006', jsonb_build_array(
		pg_temp.rule('lines', '70600000-0000-4000-8000-0000000000f4', 'ask-first', E'first\nsecond'))), 'structured_invalid') then
		raise exception 'A rule is one line'; end if;
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0007', jsonb_build_array(
		pg_temp.rule('maybe', '70600000-0000-4000-8000-0000000000f4', 'maybe', 'send a file'))), 'structured_invalid') then
		raise exception 'An outcome is ask-first or allow'; end if;
	-- The parse has exactly the rule's keys.
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0008', jsonb_build_array(pg_temp.write('rules/keys.md', 'rule',
		pg_temp.rule_text('70600000-0000-4000-8000-0000000000f6', 'ask-first', 'send a file'),
		jsonb_build_object('kind','rule','id','70600000-0000-4000-8000-0000000000f6','outcome','ask-first','text','send a file','extra',1), null))), 'structured_invalid') then
		raise exception 'A rule''s parse has exactly its keys'; end if;
	-- An id held by a rule file of the company's other environment is refused.
	insert into public.qorpera_review_rules(id, profile_id, scope, when_text, outcome, created_via, created_by_user_id,
		folder_environment_id, folder_path, folder_path_version, folder_commit_id)
	values ('70600000-0000-4000-8000-0000000000f7', '70600000-0000-4000-8000-000000000010', 'company', 'print a page', 'ask_first', 'folder', '70600000-0000-4000-8000-000000000001', '70600000-0000-4000-8000-000000000022', 'rules/print.md',
		extensions.gen_random_uuid(), extensions.gen_random_uuid());
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'rule-0009', jsonb_build_array(
		pg_temp.rule('print', '70600000-0000-4000-8000-0000000000f7', 'ask-first', 'print a page')))) then
		raise exception 'Another environment''s rule id is refused'; end if;
	delete from public.qorpera_review_rules where id = '70600000-0000-4000-8000-0000000000f7';
	-- A file the index does not point at is not the saved version: a new id there is a new rule.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rule-0010', jsonb_build_array(
		pg_temp.rule('trust', '70600000-0000-4000-8000-0000000000f8', 'ask-first', 'share a folder'))), 1, 'saved');
	delete from public.qorpera_review_rules where id = '70600000-0000-4000-8000-0000000000f8';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'rule-0011', jsonb_build_array(
		pg_temp.rule('trust', '70600000-0000-4000-8000-0000000000f9', 'ask-first', 'share a folder'))), 1, 'saved');
end $$;

-- 3. The company budget of 48 KiB --------------------------------------------------------------------------------------

do $$
declare r jsonb;
begin
	-- 175 rules of 280 bytes (49000), plus the file's rule (17 bytes).
	insert into public.qorpera_review_rules(id, profile_id, scope, when_text, outcome, created_via, created_by_user_id)
	select extensions.gen_random_uuid(), '70600000-0000-4000-8000-000000000010', 'company', repeat('x', 280), 'ask_first', 'settings', '70600000-0000-4000-8000-000000000001' from generate_series(1, 175);
	if not pg_temp.refused(pg_temp.commit(pg_temp.owner(), 'budget-0001', jsonb_build_array(
		pg_temp.rule('big', '70600000-0000-4000-8000-0000000000f4', 'ask-first', repeat('y', 200))))) then
		raise exception 'A rule past the budget is refused'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'budget-0002', jsonb_build_array(
		pg_temp.rule('small', '70600000-0000-4000-8000-0000000000f4', 'ask-first', repeat('y', 100)))), 1, 'saved');
	-- Editing a rule counts its new text in place of its old.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'budget-0003', jsonb_build_array(
		pg_temp.rule('small', '70600000-0000-4000-8000-0000000000f4', 'ask-first', repeat('z', 110)))), 1, 'saved');
	-- Exactly 48 KiB is within the budget.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'budget-0004', jsonb_build_array(
		pg_temp.rule('edge', '70600000-0000-4000-8000-0000000000fa', 'ask-first', repeat('e', 49152 - (select sum(octet_length(when_text))::integer
			from public.qorpera_review_rules where profile_id = '70600000-0000-4000-8000-000000000010' and scope = 'company' and archived_at is null))))), 1, 'saved');
	-- An archived rule does not count.
	update public.qorpera_review_rules set archived_at = clock_timestamp()
	where id = (select id from public.qorpera_review_rules where profile_id = '70600000-0000-4000-8000-000000000010' and created_via = 'settings' and scope = 'company'
		and archived_at is null limit 1);
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'budget-0005', jsonb_build_array(
		pg_temp.rule('after', '70600000-0000-4000-8000-0000000000fb', 'ask-first', repeat('a', 200)))), 1, 'saved');
	delete from public.qorpera_review_rules where profile_id = '70600000-0000-4000-8000-000000000010' and created_via = 'settings' and scope = 'company';
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'budget-0006', jsonb_build_array(
		jsonb_build_object('op','delete','path','rules/edge.md','expectedVersion',pg_temp.version('rules/edge.md')),
		jsonb_build_object('op','delete','path','rules/after.md','expectedVersion',pg_temp.version('rules/after.md')))), 2, 'saved');
end $$;

-- 4. Moving, deleting and restoring ------------------------------------------------------------------------------------

do $$
declare x public.qorpera_review_rules;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'move-0001', jsonb_build_array(jsonb_build_object('op','move',
		'from','rules/refunds.md','to','rules/money.md','expectedVersion',pg_temp.version('rules/refunds.md')))), 1, 'saved');
	x := pg_temp.row('70600000-0000-4000-8000-0000000000f1');
	if x.folder_path is distinct from 'rules/money.md' or x.folder_path_version is distinct from pg_temp.version('rules/money.md') then
		raise exception 'A rule follows its file: %', to_jsonb(x); end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'delete-0001', jsonb_build_array(jsonb_build_object('op','delete',
		'path','rules/money.md','expectedVersion',pg_temp.version('rules/money.md')))), 1, 'saved');
	if (pg_temp.row('70600000-0000-4000-8000-0000000000f1')).archived_at is null or pg_temp.reviewed('70600000-0000-4000-8000-0000000000f1') then
		raise exception 'Deleting the file archives the rule'; end if;
	if (pg_temp.row('70600000-0000-4000-8000-0000000000f4')).archived_at is not null or (pg_temp.row('70600000-0000-4000-8000-0000000000f9')).archived_at is not null then
		raise exception 'Deleting one file archives only its rule'; end if;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'restore-0001', jsonb_build_array(
		pg_temp.rule('money', '70600000-0000-4000-8000-0000000000f1', 'ask-first', 'refund a customer'))), 1, 'saved');
	if (pg_temp.row('70600000-0000-4000-8000-0000000000f1')).archived_at is not null or not pg_temp.reviewed('70600000-0000-4000-8000-0000000000f1') then
		raise exception 'A restore brings the rule back, with its id'; end if;
end $$;

-- 5. Settings refuses company rules on folder-v2; personal rules stay rows ------------------------------------------------

do $$
begin
	perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"70600000-0000-4000-8000-000000000001"}', true);
	set local role authenticated;
	begin
		perform public.qorpera_save_review_rule('70600000-0000-4000-8000-000000000010', '70600000-0000-4000-8000-0000000000f5', 'company', 'delete a file', 'ask_first');
		raise exception 'A company rule through Settings must be refused' using errcode = 'QTF04';
	exception when sqlstate '55000' then null;
	end;
	begin
		perform public.qorpera_archive_review_rule('70600000-0000-4000-8000-000000000010', '70600000-0000-4000-8000-0000000000f1');
		raise exception 'Removing a file''s rule through Settings must be refused' using errcode = 'QTF05';
	exception when sqlstate '55000' then null;
	end;
	-- A company rule saved as a row (a card's "Always allow" until C3) can still be removed there.
	reset role;
	insert into public.qorpera_review_rules(id, profile_id, scope, when_text, outcome, created_via, created_by_user_id)
	values ('70600000-0000-4000-8000-0000000000fc', '70600000-0000-4000-8000-000000000010', 'company', 'pay an invoice', 'allow_automatically', 'card', '70600000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_archive_review_rule('70600000-0000-4000-8000-000000000010', '70600000-0000-4000-8000-0000000000fc');
	perform public.qorpera_save_review_rule('70600000-0000-4000-8000-000000000010', '70600000-0000-4000-8000-0000000000f5', 'member', 'delete a file', 'ask_first');
	reset role;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	if (pg_temp.row('70600000-0000-4000-8000-0000000000f5')).scope is distinct from 'member' or (pg_temp.row('70600000-0000-4000-8000-0000000000f1')).archived_at is not null
		or (pg_temp.row('70600000-0000-4000-8000-0000000000fc')).archived_at is null then
		raise exception 'Personal rules stay rows; the file''s rule is untouched; a row rule is removed'; end if;
end $$;

-- 6. One new folder of rules: one id per file, and the budget counts the unit's files together -------------------------

do $$
declare r jsonb;
begin
	perform public.qorpera_folder_enable('70600000-0000-4000-8000-000000000021');
	r := public.qorpera_folder_commit('70600000-0000-4000-8000-000000000021', '{"kind":"platform"}', 'pair-0001', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','rules','contents',jsonb_build_array(
			jsonb_build_object('path','a.md','kind','file','file',pg_temp.stage(pg_temp.rule_text('70600000-0000-4000-8000-0000000000e1', 'ask-first', 'one'), '70600000-0000-4000-8000-000000000011')),
			jsonb_build_object('path','b.md','kind','file','file',pg_temp.stage(pg_temp.rule_text('70600000-0000-4000-8000-0000000000e1', 'ask-first', 'one'), '70600000-0000-4000-8000-000000000011'))),
		'structured',jsonb_build_array(
			pg_temp.entry('rules/a.md','rule',pg_temp.rule_text('70600000-0000-4000-8000-0000000000e1', 'ask-first', 'one'),jsonb_build_object('kind','rule','id','70600000-0000-4000-8000-0000000000e1','outcome','ask-first','text','one')),
			pg_temp.entry('rules/b.md','rule',pg_temp.rule_text('70600000-0000-4000-8000-0000000000e1', 'ask-first', 'one'),jsonb_build_object('kind','rule','id','70600000-0000-4000-8000-0000000000e1','outcome','ask-first','text','one'))))));
	if not pg_temp.refused(r) then raise exception 'Two files with one rule id in one unit are refused: %', r; end if;
	insert into public.qorpera_review_rules(id, profile_id, scope, when_text, outcome, created_via, created_by_user_id)
	select extensions.gen_random_uuid(), '70600000-0000-4000-8000-000000000011', 'company', repeat('x', 280), 'ask_first', 'settings', '70600000-0000-4000-8000-000000000001' from generate_series(1, 175);
	-- 49000 bytes, then two files of 100: each fits alone, not together.
	r := public.qorpera_folder_commit('70600000-0000-4000-8000-000000000021', '{"kind":"platform"}', 'pair-0002', jsonb_build_array(jsonb_build_object('op','new_folder',
		'path','rules','contents',jsonb_build_array(
			jsonb_build_object('path','a.md','kind','file','file',pg_temp.stage(pg_temp.rule_text('70600000-0000-4000-8000-0000000000e1', 'ask-first', repeat('a', 100)), '70600000-0000-4000-8000-000000000011')),
			jsonb_build_object('path','b.md','kind','file','file',pg_temp.stage(pg_temp.rule_text('70600000-0000-4000-8000-0000000000e2', 'ask-first', repeat('b', 100)), '70600000-0000-4000-8000-000000000011'))),
		'structured',jsonb_build_array(
			pg_temp.entry('rules/a.md','rule',pg_temp.rule_text('70600000-0000-4000-8000-0000000000e1', 'ask-first', repeat('a', 100)),
				jsonb_build_object('kind','rule','id','70600000-0000-4000-8000-0000000000e1','outcome','ask-first','text',repeat('a', 100))),
			pg_temp.entry('rules/b.md','rule',pg_temp.rule_text('70600000-0000-4000-8000-0000000000e2', 'ask-first', repeat('b', 100)),
				jsonb_build_object('kind','rule','id','70600000-0000-4000-8000-0000000000e2','outcome','ask-first','text',repeat('b', 100)))))));
	if not pg_temp.refused(r) or r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' not like '%too long%' then
		raise exception 'The budget counts the unit''s files together: %', r; end if;
end $$;

rollback;
