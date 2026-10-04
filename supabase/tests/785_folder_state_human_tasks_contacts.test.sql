-- @fixture 707_folder_state_todos.test.sql until "-- 1. The company, two agents, and a todo"
-- Company state files, H1b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "human-tasks/<name>.md" and
-- "contacts/<name>.md", §8 "Plan (H1)"): the two formats on the folder core. A task and a contact are saved with their
-- parse and checked by its shape; their folder places follow the naming rule; a folder move or copy into or out of the
-- two roots cannot change a file's kind; only the platform marks a secret saved, for a member, an agent's run and a new
-- folder alike. The review class is plain. Since H2b (test 803 has its rules): a task's `from` is an active agent, its
-- folder needs its file and belongs to its person while it is open, the roots are seeded, and a save locks its own row.

-- The file's text as the parser reads it, near enough: the database reads only the parse and the text's hash.
create function pg_temp.state_text(p_parse jsonb) returns text language sql as $$
	select E'---\n' || coalesce(string_agg(format(E'%s: %s\n', case k when 'secretState' then 'secret_state' else k end,
			case jsonb_typeof(v) when 'array' then (select '[' || string_agg(x #>> '{}', ', ') || ']' from jsonb_array_elements(v) x)
				else v #>> '{}' end), '' order by k), '')
		|| E'---\n' || coalesce(p_parse ->> 'instructions', p_parse ->> 'notes') || E'\n'
	from jsonb_each(p_parse) e(k, v)
	where k not in ('kind', 'instructions', 'steps', 'notes') and jsonb_typeof(v) <> 'null'
		and not (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0)
$$;
-- A member's task: Otto fits a disk, for the agent Nora.
create function pg_temp.task(p_id uuid default '78500000-0000-4000-8000-0000000000e1', p_set jsonb default '{}') returns jsonb
language sql as $$
	select jsonb_build_object('kind','human-task','id',p_id,'title','Fit the new disk in node 2','status','open',
		'member','70700000-0000-4000-8000-000000000002','contact',null,'from','70700000-0000-4000-8000-0000000000a1','todo',null,
		'due','2099-10-20T12:00:00Z','minutes',40,'proof','["photo","note"]'::jsonb,'files','["ops/disk-order.pdf"]'::jsonb,
		'reason',null,'secret',null,'secretState',null,'connection',null,'step',null,
		'instructions',E'## Steps\n- [ ] Fit it in slot 2\n- [x] Agree a window',
		'steps','[{"line":15,"text":"Fit it in slot 2","done":false},{"line":16,"text":"Agree a window","done":true}]'::jsonb) || p_set
$$;
-- A contact's task: Maria files the VAT return.
create function pg_temp.contact_task(p_set jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.task('78500000-0000-4000-8000-0000000000e2', jsonb_build_object('title','File the Q3 VAT return','member',null,
		'contact','78500000-0000-4000-8000-0000000000f1','minutes',null,'proof','["file"]'::jsonb,
		'files','["finance/vat-q3-draft.pdf"]'::jsonb,'instructions','Please file it.','steps','[]'::jsonb) || p_set)
$$;
create function pg_temp.contact(p_set jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind','contact','id','78500000-0000-4000-8000-0000000000f1','name','Maria Jensen',
		'organization','Jensen Revision ApS','email','maria@jensen-revision.example','phone','+45 12 34 56 78',
		'asks','["bookkeeping review","VAT filing"]'::jsonb,'notes','Our accountant since 2025.') || p_set
$$;
create function pg_temp.save(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write(p_path, p_parse ->> 'kind', pg_temp.state_text(p_parse), p_parse, pg_temp.version(p_path))
$$;
create function pg_temp.problems(p_parse jsonb) returns integer language sql as $$
	select jsonb_array_length(public.qorpera_company_state_parse_problems(p_parse ->> 'kind', p_parse))
$$;

-- 0. The company, and the agent that asks (H2: a task's `from` is an active agent) ------------------------------------

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Tasks'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70700000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')));
	for i in 1..5 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(
		pg_temp.hire('nora', '70700000-0000-4000-8000-0000000000a1', 'Nora'))), 1, 'saved');
end $$;

-- 1. A folder renamed onto a root that does not exist yet cannot land ordinary files there as tasks or contacts --------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','drafts'),
		jsonb_build_object('op','write','path','drafts/plan.md','file',pg_temp.stage('A plan')),
		jsonb_build_object('op','mkdir','path','ops'),
		jsonb_build_object('op','write','path','ops/disk-order.pdf','file',pg_temp.stage('An order'))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0002', jsonb_build_array(
		jsonb_build_object('op','move','from','drafts','to','contacts','expectedVersion',pg_temp.version('drafts'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','move','from','drafts','to','human-tasks','expectedVersion',pg_temp.version('drafts'),'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','copy','from','drafts','to','contacts'),
		jsonb_build_object('op','copy','from','ops','to','contacts')));
	perform pg_temp.expect(r, 1, 'refused', 'kind_change');
	-- Since H2b nothing moves or copies onto human-tasks/: it is made empty.
	perform pg_temp.expect(r, 2, 'refused', 'structured_rule');
	perform pg_temp.expect(r, 3, 'refused', 'structured_copy');
	-- A folder that holds no .md file may become a root: what it holds stays ordinary.
	perform pg_temp.expect(r, 4, 'saved');
end $$;

-- A new folder's files are held to the secret rule too: no task starts with its secret saved (§6).
do $$
declare saved jsonb := pg_temp.task('78500000-0000-4000-8000-0000000000eb', '{"secret":"Code","secretState":"saved"}');
	r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0017', jsonb_build_array(jsonb_build_object('op','new_folder','path','human-tasks',
		'contents', jsonb_build_array(jsonb_build_object('path','enter.md','kind','file','file',pg_temp.stage(pg_temp.state_text(saved)))),
		'structured', jsonb_build_array(pg_temp.entry('human-tasks/enter.md', 'human-task', pg_temp.state_text(saved), saved)))));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule');
end $$;

-- 2. The two roots are places; a task's folder and its proof folder follow the naming rule -----------------------------

do $$
declare r jsonb; t record;
begin
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0003', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','human-tasks'),
		jsonb_build_object('op','mkdir','path','contacts/archive'),
		jsonb_build_object('op','mkdir','path','human-tasks/Fit Disk'),
		jsonb_build_object('op','mkdir','path','human-tasks/fit_disk'),
		jsonb_build_object('op','mkdir','path','human-tasks/' || repeat('a', 65)),
		jsonb_build_object('op','new_folder','path','human-tasks/My Task','contents',
			jsonb_build_array(jsonb_build_object('path','proof','kind','folder')))));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	for i in 3..6 loop perform pg_temp.expect(r, i, 'refused', 'structured_invalid'); end loop;
	-- The same checks as the parser's structuredFolderNames (700 §7 keeps the file names).
	for t in select * from (values ('human-tasks', 0), ('contacts', 0), ('human-tasks/fit-disk', 0), ('human-tasks/fit-disk/proof', 0),
		('human-tasks/T/proof', 1), ('human-tasks/my_task', 1), ('human-tasks/fit-disk/Proof', 1), ('Human-Tasks', 1), ('Contacts', 1),
		('human-tasks/fit-disk/photos', 0), ('human-tasks/fit-disk/Photos', 0), ('human-tasks/fit-disk/proof/x', 0), ('contacts/Archive', 0),
		('human-tasks/', 0),
		('human-tasks/Fit/', 1)) v(path, problems)
	loop
		if jsonb_array_length(public.qorpera_company_state_path_problems(t.path, true)) is distinct from t.problems then
			raise exception 'Folder % expected % problems, got %', t.path, t.problems,
				public.qorpera_company_state_path_problems(t.path, true); end if;
	end loop;
	if coalesce(public.qorpera_company_state_path_problems('human-tasks/日本', true) -> 0 ->> 'message', '') not like '%a human task''s folder%' then
		raise exception 'A task folder''s problem names the place: %', public.qorpera_company_state_path_problems('human-tasks/日本', true); end if;
end $$;

-- 3. A task and a contact are saved with their parse; a wrong name or a parse that breaks the rules is refused ----------

do $$
declare r jsonb; v jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0004', jsonb_build_array(
		pg_temp.save('human-tasks/fit-disk.md', pg_temp.task()),
		pg_temp.save('contacts/maria-jensen.md', pg_temp.contact()),
		pg_temp.save('human-tasks/file-vat-q3.md', pg_temp.contact_task()),
		pg_temp.save('human-tasks/my_task.md', pg_temp.task('78500000-0000-4000-8000-0000000000e3')),
		pg_temp.save('contacts/Maria.md', pg_temp.contact('{"id":"78500000-0000-4000-8000-0000000000f2"}')),
		-- A contact's task never shows the company's people, tasks, accounts or rules.
		pg_temp.save('human-tasks/show-roster.md', pg_temp.contact_task(
			'{"id":"78500000-0000-4000-8000-0000000000e4","files":["Agents/nora/agent.md"]}')),
		-- The parse says a member's task, but names a contact too.
		pg_temp.save('human-tasks/two-people.md', pg_temp.task('78500000-0000-4000-8000-0000000000e5',
			'{"contact":"78500000-0000-4000-8000-0000000000f1"}')),
		-- A structured file must carry its parse.
		jsonb_build_object('op','write','path','contacts/bare.md','file',pg_temp.stage(E'---\nname: Bare\n---\n')),
		-- The parse of another kind.
		pg_temp.write('contacts/wrong-kind.md', 'contact', 'x', pg_temp.task('78500000-0000-4000-8000-0000000000e6'))));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	for i in 4..9 loop perform pg_temp.expect(r, i, 'refused', 'structured_invalid'); end loop;
	if coalesce(r -> 'units' -> 5 -> 'problems' -> 0 ->> 'message', '') not like '%read this file differently%(files)%'
		or coalesce(r -> 'units' -> 6 -> 'problems' -> 0 ->> 'message', '') not like '%read this file differently%(member)%' then
		raise exception 'A broken parse names the rule it breaks: %', r; end if;
	-- The parse is stored with the version, as H2's index will read it.
	select v2.structured into v from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v2 on v2.version = e.version
	where e.environment_id = '70700000-0000-4000-8000-000000000020' and e.key_text = 'human-tasks/fit-disk.md';
	if v is distinct from jsonb_build_object('kind', 'human-task', 'parse', pg_temp.task(), 'parserVersion', 1) then
		raise exception 'A task''s version keeps its parse: %', v; end if;
	select v2.structured into v from public.qorpera_folder_entries e join public.qorpera_folder_path_versions v2 on v2.version = e.version
	where e.environment_id = '70700000-0000-4000-8000-000000000020' and e.key_text = 'contacts/maria-jensen.md';
	if v is distinct from jsonb_build_object('kind', 'contact', 'parse', pg_temp.contact(), 'parserVersion', 1) then
		raise exception 'A contact''s version keeps its parse: %', v; end if;
end $$;

-- A task's folder, made by the task's person once the task is there (H2b): the proof folder and another one.
do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit(pg_temp.mem(), 'tasks-0019', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','human-tasks/fit-disk'),
		jsonb_build_object('op','mkdir','path','human-tasks/fit-disk/proof'),
		jsonb_build_object('op','mkdir','path','human-tasks/fit-disk/photos')));
	for i in 1..3 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- 4. The shapes: every limit and cross-key rule the parser holds a file to, held again on the parse --------------------

do $$
declare t record; long text := repeat('x', 501);
begin
	for t in select * from (values
		-- What the parser writes.
		(pg_temp.task(), 0), (pg_temp.contact_task(), 0), (pg_temp.contact(), 0),
		(pg_temp.task(p_set => '{"status":"cancelled"}'), 0), (pg_temp.task(p_set => '{"status":"cancelled","reason":"Not needed"}'), 0),
		(pg_temp.task(p_set => '{"status":"returned","reason":"The serial is not readable"}'), 0),
		(pg_temp.task(p_set => '{"status":"declined","reason":"I am away"}'), 0), (pg_temp.task(p_set => '{"status":"done"}'), 0),
		(pg_temp.task(p_set => '{"minutes":480,"proof":[],"files":[],"steps":[],"instructions":"x"}'), 0),
		(pg_temp.task(p_set => '{"minutes":null,"todo":"78500000-0000-4000-8000-0000000000d1"}'), 0),
		(pg_temp.task(p_set => '{"secret":"Code from the SMS","secretState":"asked","connection":"78500000-0000-4000-8000-0000000000c2",
			"step":"phone_code"}'), 0),
		(pg_temp.task(p_set => '{"secret":"Code","secretState":"saved","step":"other"}'), 0),
		(pg_temp.task(p_set => '{"files":["sales/q3 draft.pdf","a*b.md","agents/a/memory/x.md","Sales/Q4.pdf"]}'), 0),
		(pg_temp.contact_task('{"files":["finance/vat-q3-draft.pdf","agentsx/a.pdf","hooks.md"]}'), 0),
		(pg_temp.task(p_set => jsonb_build_object('title', repeat('ø', 100), 'reason', null)), 0),
		(pg_temp.task(p_set => jsonb_build_object('steps', (select jsonb_agg(jsonb_build_object('line', 10 + n, 'text', 'Step ' || n, 'done', false))
			from generate_series(1, 50) n))), 0),
		(pg_temp.task(p_set => jsonb_build_object('files', (select jsonb_agg('f' || n || '.pdf') from generate_series(1, 20) n))), 0),
		(pg_temp.contact('{"organization":null,"email":null,"phone":null,"asks":[],"notes":""}'), 0),
		(pg_temp.contact('{"email":"first.last+tag@sub.example.org","phone":"+123456","asks":["VAT filing","vat filing"]}'), 0),
		(pg_temp.contact(jsonb_build_object('phone', '+' || repeat('1', 20), 'email', 'a@b')), 0),
		-- The keys.
		(pg_temp.task(p_set => '{"note":"x"}'), 1), (pg_temp.task() - 'connection', 1), (pg_temp.contact('{"company":"x"}'), 1),
		-- No computer key: the platform finds the asking agent's screen from `from` (A1).
		(pg_temp.task(p_set => '{"computer":"78500000-0000-4000-8000-0000000000c1"}'), 1),
		(pg_temp.task(p_set => '{"kind":"contact"}'), 1),
		-- One person, by id.
		(pg_temp.task(p_set => '{"member":null}'), 1), (pg_temp.task(p_set => '{"contact":"78500000-0000-4000-8000-0000000000f1"}'), 1),
		(pg_temp.task(p_set => '{"member":"70700000-0000-4000-8000-00000000000A"}'), 1), (pg_temp.task(p_set => '{"member":7}'), 1),
		(pg_temp.task(p_set => '{"id":"fit"}'), 1), (pg_temp.task(p_set => '{"from":null}'), 1), (pg_temp.task(p_set => '{"todo":"t"}'), 1),
		-- Values and limits.
		(pg_temp.task(p_set => jsonb_build_object('title', repeat('ø', 101))), 1), (pg_temp.task(p_set => '{"title":" Fit"}'), 1),
		(pg_temp.task(p_set => '{"status":"closed"}'), 1), (pg_temp.task(p_set => '{"due":"2026-10-20 12:00:00"}'), 1),
		(pg_temp.task(p_set => '{"due":"2026-10-20T12:00:00.000Z"}'), 1), (pg_temp.task(p_set => '{"minutes":0}'), 1),
		(pg_temp.task(p_set => '{"minutes":481}'), 1), (pg_temp.task(p_set => '{"minutes":"40"}'), 1), (pg_temp.task(p_set => '{"minutes":40.5}'), 1),
		(pg_temp.task(p_set => '{"proof":["photo","photo"]}'), 1), (pg_temp.task(p_set => '{"proof":["video"]}'), 1),
		(pg_temp.task(p_set => '{"proof":null}'), 1), (pg_temp.task(p_set => '{"step":"login"}'), 1),
		(pg_temp.task(p_set => '{"due":null}'), 1), (pg_temp.task(p_set => '{"connection":"github"}'), 1),
		(pg_temp.task(p_set => '{"instructions":""}'), 1), (pg_temp.task(p_set => E'{"instructions":"Fit it.\\n"}'), 1),
		(pg_temp.task(p_set => jsonb_build_object('instructions', repeat('x', 32769))), 1),
		-- Why, only with the statuses that take one.
		(pg_temp.task(p_set => '{"reason":"Because"}'), 1), (pg_temp.task(p_set => '{"status":"done","reason":"Because"}'), 1),
		(pg_temp.task(p_set => '{"status":"returned"}'), 1), (pg_temp.task(p_set => '{"status":"declined"}'), 1),
		(pg_temp.task(p_set => jsonb_build_object('status', 'returned', 'reason', long)), 1),
		(pg_temp.task(p_set => E'{"status":"returned","reason":"a\\tb"}'), 1),
		-- A secret: a label and its state together, on a member's task.
		(pg_temp.task(p_set => '{"secret":"Code"}'), 1), (pg_temp.task(p_set => '{"secretState":"asked"}'), 1),
		(pg_temp.task(p_set => '{"secret":"Code","secretState":"sent"}'), 1),
		(pg_temp.task(p_set => jsonb_build_object('secret', repeat('x', 101), 'secretState', 'asked')), 1),
		(pg_temp.contact_task('{"secret":"Code","secretState":"asked"}'), 1),
		-- Files: literal paths, at most 20, once each by key; a contact's task stays out of the inside roots.
		(pg_temp.task(p_set => '{"files":["a/../b.pdf"]}'), 1), (pg_temp.task(p_set => '{"files":["a/./b.pdf"]}'), 1),
		(pg_temp.task(p_set => '{"files":["sales/"]}'), 1), (pg_temp.task(p_set => '{"files":["/etc/passwd"]}'), 1),
		(pg_temp.task(p_set => '{"files":["a//b"]}'), 1), (pg_temp.task(p_set => '{"files":[""]}'), 1),
		(pg_temp.task(p_set => E'{"files":["a\\tb.pdf"]}'), 1), (pg_temp.task(p_set => '{"files":[7]}'), 1),
		(pg_temp.task(p_set => jsonb_build_object('files', jsonb_build_array('a' || chr(8232) || 'b.pdf'))), 1),
		(pg_temp.task(p_set => jsonb_build_object('files', jsonb_build_array('a' || chr(133) || 'b.pdf'))), 1),
		(pg_temp.task(p_set => '{"files":["Sales/Q3.pdf","sales/q3.pdf"]}'), 1),
		-- Only paths the folder can hold (the core's path rule).
		(pg_temp.task(p_set => '{"files":["a:b.pdf"]}'), 1), (pg_temp.task(p_set => '{"files":["50%.pdf"]}'), 1),
		(pg_temp.task(p_set => '{"files":["Notes /x.pdf"]}'), 1), (pg_temp.task(p_set => '{"files":["con.txt"]}'), 1),
		(pg_temp.task(p_set => '{"files":["x."]}'), 1), (pg_temp.task(p_set => E'{"files":["a\\\\b.pdf"]}'), 1),
		(pg_temp.task(p_set => jsonb_build_object('files', jsonb_build_array('e' || chr(769) || '.pdf'))), 1),
		(pg_temp.task(p_set => jsonb_build_object('files', jsonb_build_array(repeat('x', 4097)))), 1),
		(pg_temp.task(p_set => jsonb_build_object('files', (select jsonb_agg('f' || n || '.pdf') from generate_series(1, 21) n))), 1),
		(pg_temp.contact_task('{"files":["agents/nora/agent.md"]}'), 1), (pg_temp.contact_task('{"files":["CONTACTS/maria.md"]}'), 1),
		(pg_temp.contact_task('{"files":["human-tasks/fit-disk/proof/label.jpg"]}'), 1),
		(pg_temp.contact_task('{"files":["connections/github.md"]}'), 1), (pg_temp.contact_task('{"files":["rules/x.md"]}'), 1),
		(pg_temp.contact_task('{"files":["hooks/stripe/a.json"]}'), 1),
		-- Steps: at most 50, each a line, one line of 1-500 bytes, and a box.
		(pg_temp.task(p_set => jsonb_build_object('steps', (select jsonb_agg(jsonb_build_object('line', 10 + n, 'text', 'Step ' || n, 'done', false))
			from generate_series(1, 51) n))), 1),
		(pg_temp.task(p_set => jsonb_build_object('steps', jsonb_build_array(jsonb_build_object('line', 9, 'text', long, 'done', false)))), 1),
		(pg_temp.task(p_set => '{"steps":[{"line":9,"text":"","done":false}]}'), 1),
		(pg_temp.task(p_set => E'{"steps":[{"line":9,"text":"a\\tb","done":false}]}'), 1),
		(pg_temp.task(p_set => jsonb_build_object('steps', jsonb_build_array(jsonb_build_object('line', 9, 'text', 'a' || chr(8233) || 'b',
			'done', false)))), 1),
		(pg_temp.task(p_set => '{"steps":[{"line":0,"text":"Fit","done":false}]}'), 1),
		(pg_temp.task(p_set => '{"steps":[{"line":9,"text":"Fit","done":"no"}]}'), 1),
		(pg_temp.task(p_set => '{"steps":[{"line":9,"text":"Fit"}]}'), 1), (pg_temp.task(p_set => '{"steps":["Fit"]}'), 1),
		(pg_temp.task(p_set => '{"steps":null}'), 1),
		-- A contact.
		(pg_temp.contact('{"name":""}'), 1), (pg_temp.contact(jsonb_build_object('name', repeat('ø', 101))), 1),
		(pg_temp.contact(jsonb_build_object('organization', repeat('ø', 101))), 1), (pg_temp.contact('{"organization":""}'), 1),
		(pg_temp.contact('{"email":"ab"}'), 1), (pg_temp.contact('{"email":"maria.example.com"}'), 1),
		(pg_temp.contact('{"email":"a@b@c"}'), 1), (pg_temp.contact('{"email":"a@"}'), 1), (pg_temp.contact('{"email":"a@.dk"}'), 1),
		(pg_temp.contact('{"email":"a@dk."}'), 1), (pg_temp.contact('{"email":"a b@x.dk"}'), 1), (pg_temp.contact('{"email":"æ@x.dk"}'), 1),
		(pg_temp.contact(jsonb_build_object('email', repeat('a', 250) || '@x.dk')), 1),
		(pg_temp.contact('{"phone":"+12345"}'), 1), (pg_temp.contact(jsonb_build_object('phone', '+' || repeat('1', 21))), 1),
		(pg_temp.contact('{"phone":"45 12 34 56"}'), 1), (pg_temp.contact('{"phone":"+45  12 34 56"}'), 1),
		(pg_temp.contact('{"phone":"+45-12-34-56"}'), 1), (pg_temp.contact('{"phone":4512345678}'), 1),
		(pg_temp.contact('{"asks":["VAT filing","VAT filing"]}'), 1), (pg_temp.contact('{"asks":[" VAT filing"]}'), 1),
		(pg_temp.contact('{"asks":[7]}'), 1),
		(pg_temp.contact(jsonb_build_object('asks', jsonb_build_array(repeat('x', 101)))), 1), (pg_temp.contact('{"asks":[""]}'), 1),
		(pg_temp.contact(jsonb_build_object('asks', (select jsonb_agg('a' || n) from generate_series(1, 51) n))), 1),
		(pg_temp.contact('{"notes":"Notes "}'), 1), (pg_temp.contact('{"notes":null}'), 1),
		(pg_temp.contact(jsonb_build_object('notes', repeat('x', 32769))), 1)) v(parse, problems)
	loop
		if pg_temp.problems(t.parse) is distinct from t.problems then
			raise exception 'Parse % expected % problems, got %', t.parse, t.problems,
				public.qorpera_company_state_parse_problems(t.parse ->> 'kind', t.parse); end if;
	end loop;
end $$;

-- 5. A folder move or copy cannot change a file's kind; inside a root, names are checked ------------------------------

do $$
declare r jsonb;
begin
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0005', jsonb_build_array(
		jsonb_build_object('op','move','from','human-tasks','to','old-tasks','expectedVersion',pg_temp.version('human-tasks'),
			'asOfSeq',pg_temp.seq()),
		jsonb_build_object('op','copy','from','contacts','to','contacts-copy'),
		jsonb_build_object('op','copy','from','drafts/plan.md','to','contacts/plan.md'),
		jsonb_build_object('op','copy','from','human-tasks/fit-disk.md','to','human-tasks/fit-disk-again.md'),
		jsonb_build_object('op','move','from','human-tasks/file-vat-q3.md','to','drafts/file-vat-q3.md',
			'expectedVersion',pg_temp.version('human-tasks/file-vat-q3.md')),
		jsonb_build_object('op','move','from','drafts/plan.md','to','human-tasks/plan.md','expectedVersion',pg_temp.version('drafts/plan.md')),
		jsonb_build_object('op','move','from','human-tasks/file-vat-q3.md','to','human-tasks/File Vat.md',
			'expectedVersion',pg_temp.version('human-tasks/file-vat-q3.md'))));
	-- Since H2b the root is a seeded folder (Jonas, 2 October): it never moves.
	perform pg_temp.expect(r, 1, 'refused', 'seeded');
	perform pg_temp.expect(r, 2, 'refused', 'kind_change');
	perform pg_temp.expect(r, 3, 'refused', 'structured_copy');
	perform pg_temp.expect(r, 4, 'refused', 'structured_copy');
	perform pg_temp.expect(r, 5, 'refused', 'kind_change');
	perform pg_temp.expect(r, 6, 'refused', 'kind_change');
	perform pg_temp.expect(r, 7, 'refused', 'structured_invalid');
	-- A task's folder moved by its person onto a misnamed folder: the name check says so.
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'tasks-0020', jsonb_build_array(
		jsonb_build_object('op','move','from','human-tasks/fit-disk','to','human-tasks/Fit Disk 2',
			'expectedVersion',pg_temp.version('human-tasks/fit-disk'),'asOfSeq',pg_temp.seq()))), 1, 'refused', 'structured_invalid');
	-- Within a root a task file without a folder moves like any file; a task with a folder keeps its name, and its folder
	-- never goes where no task is (H2b).
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0006', jsonb_build_array(
		jsonb_build_object('op','move','from','human-tasks/file-vat-q3.md','to','human-tasks/file-vat-quarter-3.md',
			'expectedVersion',pg_temp.version('human-tasks/file-vat-q3.md')),
		jsonb_build_object('op','copy','from','contacts/archive','to','contacts/archive-2'),
		jsonb_build_object('op','move','from','human-tasks/fit-disk.md','to','human-tasks/fit-the-disk.md',
			'expectedVersion',pg_temp.version('human-tasks/fit-disk.md'))));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'refused', 'structured_rule');
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'tasks-0021', jsonb_build_array(
		jsonb_build_object('op','move','from','human-tasks/fit-disk','to','human-tasks/fit-the-disk',
			'expectedVersion',pg_temp.version('human-tasks/fit-disk'),'asOfSeq',pg_temp.seq()))), 1, 'refused', 'structured_rule');
end $$;

-- 6. Only the platform marks a secret saved ---------------------------------------------------------------------------

do $$
declare r jsonb; code constant uuid := '78500000-0000-4000-8000-0000000000e7';
	agent constant jsonb := '{"kind":"staff_agent","staffAgentId":"70700000-0000-4000-8000-0000000000a1",
		"requesterUserId":"70700000-0000-4000-8000-000000000001","sessionKind":"in_house","runId":"78500000-0000-4000-8000-0000000000ff",
		"audience":{"kind":"company"}}';
	asked jsonb := pg_temp.task(code, '{"title":"Enter the code","secret":"Code from the SMS","secretState":"asked","step":"phone_code"}');
	saved jsonb := pg_temp.task(code, '{"title":"Enter the code","secret":"Code from the SMS","secretState":"saved","step":"phone_code"}');
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tasks-0007', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', asked))),
		1, 'saved');
	-- A member, a contributor and an owner alike: never over a file that is not saved.
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0008', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', saved)));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule');
	if r -> 'units' -> 0 -> 'problems' -> 0 ->> 'key' is distinct from 'secret_state'
		or coalesce(r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '') not like 'only the platform marks a secret saved%' then
		raise exception 'The refusal names secret_state: %', r; end if;
	-- The task's person is refused earlier since H2b, by the person's own rule (803 has it).
	r := pg_temp.commit(pg_temp.mem(), 'tasks-0009', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', saved)));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule');
	if coalesce(r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '') not like 'as the task''s person you may only tick%' then
		raise exception 'The person''s rule answers first: %', r; end if;
	-- A new task cannot start saved either.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tasks-0010', jsonb_build_array(pg_temp.save('human-tasks/enter-code-2.md',
		pg_temp.task('78500000-0000-4000-8000-0000000000e8', '{"secret":"Code","secretState":"saved"}')))), 1, 'refused', 'structured_rule');
	-- The platform marks it.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'tasks-0011', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', saved))),
		1, 'saved');
	-- Anyone may keep the mark over the same task and label, as when the agent edits the title.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tasks-0012', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md',
		saved || '{"title":"Enter the code from the SMS"}'))), 1, 'saved');
	-- Not over another label, and not as a new task at another path (the same id there is H2's one-file rule).
	r := pg_temp.commit(pg_temp.owner(), 'tasks-0013', jsonb_build_array(
		pg_temp.save('human-tasks/enter-code.md', saved || '{"secret":"Code from the email"}'),
		pg_temp.save('human-tasks/enter-code-3.md', saved || '{"id":"78500000-0000-4000-8000-0000000000ef"}')));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule'); perform pg_temp.expect(r, 2, 'refused', 'structured_rule');
	if r -> 'units' -> 0 -> 'problems' -> 0 ->> 'key' is distinct from 'secret_state'
		or r -> 'units' -> 1 -> 'problems' -> 0 ->> 'key' is distinct from 'secret_state' then
		raise exception 'Both refusals name secret_state: %', r; end if;
	-- Not over another task's saved file either: the id is part of the mark.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tasks-0014', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md',
		saved || '{"id":"78500000-0000-4000-8000-0000000000e9"}'))), 1, 'refused', 'structured_rule');
	-- Taking the mark back is anyone's; after that only the platform sets it again.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tasks-0015', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', asked))),
		1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'tasks-0016', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', saved))),
		1, 'refused', 'structured_rule');
	-- An agent's run, which writes most task files, is held to the same rule (the decision its commit takes).
	r := public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020', agent, extensions.gen_random_uuid(), 1,
		pg_temp.save('human-tasks/enter-code.md', saved), 'human-tasks/enter-code.md', null);
	if r ->> 'reason' is distinct from 'structured_rule' then raise exception 'An agent never marks a secret saved: %', r; end if;
	r := public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020', agent, extensions.gen_random_uuid(), 1,
		pg_temp.save('human-tasks/enter-code-4.md', saved || '{"id":"78500000-0000-4000-8000-0000000000f5"}'), 'human-tasks/enter-code-4.md', null);
	if r ->> 'reason' is distinct from 'structured_rule' or r -> 'problems' -> 0 ->> 'key' is distinct from 'secret_state' then
		raise exception 'Not as a new task either: %', r; end if;
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'tasks-0018', jsonb_build_array(pg_temp.save('human-tasks/enter-code.md', saved))),
		1, 'saved');
	r := public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020', agent, extensions.gen_random_uuid(), 1,
		pg_temp.save('human-tasks/enter-code.md', saved || '{"title":"Enter the SMS code"}'), 'human-tasks/enter-code.md', null);
	if r is distinct from '{"ok": true}'::jsonb then raise exception 'An agent keeps the mark over the same task and label: %', r; end if;
	-- The mark is the file's at its own path: a saved task elsewhere does not lend it to a new path.
	r := public.qorpera_folder_structured_decide('70700000-0000-4000-8000-000000000020', agent, extensions.gen_random_uuid(), 1,
		pg_temp.save('human-tasks/enter-code-5.md', saved || '{"id":"78500000-0000-4000-8000-0000000000f6"}'), 'human-tasks/enter-code-5.md', null);
	if r ->> 'reason' is distinct from 'structured_rule' or r -> 'problems' -> 0 ->> 'key' is distinct from 'secret_state' then
		raise exception 'Not at a new path while another is saved: %', r; end if;
end $$;

-- 7. A save locks only its own row, at rank 5 (H2b); the review class is plain ---------------------------------------

do $$
declare env constant uuid := '70700000-0000-4000-8000-000000000020'; t jsonb; u record;
begin
	for u in select * from (values
		(pg_temp.save('human-tasks/fit-disk.md', pg_temp.task(p_set => '{"title":"Fit the disk"}')),
			'qorpera_folder_human_task_index', '78500000-0000-4000-8000-0000000000e1'),
		(pg_temp.save('contacts/maria-jensen.md', pg_temp.contact('{"asks":["VAT filing"]}')),
			'qorpera_folder_contact_index', '78500000-0000-4000-8000-0000000000f1'),
		(pg_temp.save('human-tasks/new-task.md', pg_temp.task('78500000-0000-4000-8000-0000000000ea')),
			'qorpera_folder_human_task_index', '78500000-0000-4000-8000-0000000000ea')) v(unit, tbl, id) loop
		select coalesce(jsonb_agg(to_jsonb(y)), '[]'::jsonb) into t
		from public.qorpera_folder_structured_targets(env, pg_temp.owner(), jsonb_build_array(u.unit)) y;
		if t is distinct from jsonb_build_array(jsonb_build_object('rank', 5, 'tbl', u.tbl, 'key', env || ':' || u.id, 'mode', 'nokeyupdate')) then
			raise exception 'A task or contact save locks its own row: %', t; end if;
		if public.qorpera_folder_structured_review_class(env, '{"kind":"run","sessionKind":"in_house"}', u.unit, u.unit ->> 'path', null)
			is distinct from 'plain' then raise exception 'A task or contact save is plain: %', u.unit ->> 'path'; end if;
	end loop;
end $$;

rollback;
