-- @fixture 816_runtime_member_message_quotes.test.sql until "-- Privileges: the helpers are nobody's to call."
-- A quote's words hold no mark of their own (20260930087000; contract: the 2026-10-02 amendment "quoted outside
-- content in a member's message", item 1, as amended on 5 October 2026). A quote whose words hold « or » is refused
-- with 22023 on every path that takes quotes: a conversation input, a turn request, a room message on either path, and
-- a room draft. Ordinary quotes, and the member's own marks beside them, still pass.

-- The check carries this migration's marker and keeps those of I5d parts 1 and 2.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_check_member_quotes(uuid,uuid,jsonb)'::regprocedure);
	v_marker text;
begin
	foreach v_marker in array array['20260930087000', 'I5d-1 (20260930000100)', 'I5d-2 (20260930008000)'] loop
		if strpos(v_definition, v_marker) = 0 then
			raise exception 'the quote check has no marker %', v_marker; end if;
	end loop;
	if has_function_privilege('authenticated', 'public.qorpera_check_member_quotes(uuid,uuid,jsonb)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_check_member_quotes(uuid,uuid,jsonb)', 'EXECUTE') then
		raise exception 'the quote check is exposed'; end if;
end $$;

-- Bodies whose quote holds marks of its own: nested («Use «root» now»), one mark of either kind, and a span across
-- two quotes' marks («A»«B» «A»«B»«C», quoting A»«B). Each sits just inside « », as a quote's place must.
create function pg_temp.marked() returns table (name text, body jsonb) language sql as $$
	select * from (values
		('nested marks', pg_temp.quoted('Please read ', 'Use «root» now', '.', current_setting('qorpera_test.mail_thread'))),
		('a closing mark', pg_temp.quoted('About ', 'a » b', '.', current_setting('qorpera_test.mail_thread'))),
		('an opening mark', pg_temp.quoted('About ', 'a « b', '.', current_setting('qorpera_test.mail_thread'))),
		('a span across quotes', jsonb_build_object('schema', 'qorpera.session-prompt/v1', 'images', '[]'::jsonb,
			'text', '«A»«B» «A»«B»«C»', 'quotes', jsonb_build_array(jsonb_build_object('start', 8, 'end', 12,
				'source', 'mail', 'ref', current_setting('qorpera_test.mail_thread')))))
	) as cases(name, body)
$$;

-- A conversation input: each is refused with 22023, as an invalid list, and nothing is written.
select pg_temp.member();
do $$
declare
	v_case record;
	v_before bigint := (select count(*) from public.qorpera_session_inputs);
begin
	for v_case in select * from pg_temp.marked() loop
		perform pg_temp.expect(pg_temp.message_of(format('select pg_temp.append(%L::jsonb)', v_case.body)),
			'Message quotes are invalid', 'an input with ' || v_case.name);
		perform pg_temp.expect(pg_temp.state_of(format('select pg_temp.append(%L::jsonb)', v_case.body)), '22023',
			'an input with ' || v_case.name || ', its state');
	end loop;
	perform pg_temp.expect((select count(*) from public.qorpera_session_inputs)::text, v_before::text,
		'nothing was written');
end $$;

-- A turn request and a room message are refused the same way, before anything else is asked of them (a room message
-- without a sponsor reaches the quote check first).
do $$
declare v_case record;
begin
	for v_case in select * from pg_temp.marked() loop
		perform pg_temp.expect(pg_temp.state_of(format($call$select public.qorpera_request_session_turn_v2(
			%L::uuid, extensions.gen_random_uuid(), extensions.gen_random_uuid(), %L::jsonb,
			'member', null, null, null, null, null)$call$, current_setting('qorpera_test.session'), v_case.body)), '22023',
			'a turn request with ' || v_case.name);
		perform pg_temp.expect(pg_temp.state_of(format($call$select public.qorpera_post_company_room_message(
			'30000000-0000-4000-8000-000000081605', extensions.gen_random_uuid(), %L::jsonb, null, null)$call$,
			v_case.body - 'images')), '22023', 'a room message with ' || v_case.name);
	end loop;
end $$;

-- The folder-v2 room path, with a valid sponsor, stops at the quote check too.
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.binding', (select binding.id::text from public.qorpera_execution_sponsor_bindings as binding
	where binding.profile_id = '30000000-0000-4000-8000-000000000010' and binding.status = 'active'
		and binding.created_by_user_id = '30000000-0000-4000-8000-000000000001' order by binding.id limit 1), false);
select set_config('qorpera_test.binding_version', (select max(version.version)::text
	from public.qorpera_execution_sponsor_versions as version
	where version.binding_id = current_setting('qorpera_test.binding')::uuid), false);
select pg_temp.member();
do $$
declare v_case record;
begin
	for v_case in select * from pg_temp.marked() loop
		perform pg_temp.expect(pg_temp.state_of(format($call$select public.qorpera_folder_post_room_message(
			'30000000-0000-4000-8000-000000081605', extensions.gen_random_uuid(), %L::jsonb, %L::uuid, %s)$call$,
			v_case.body - 'images', current_setting('qorpera_test.binding'),
			current_setting('qorpera_test.binding_version'))), '22023', 'the folder-v2 room path with ' || v_case.name);
	end loop;
end $$;

-- A room draft's quotes are checked as a message's are.
create function pg_temp.draft(p_revision bigint, p_body text, p_quotes jsonb default null) returns jsonb
language sql as $$
	select public.qorpera_put_room_draft('30000000-0000-4000-8000-000000081605', '30000000-0000-4000-8000-000000000001',
		p_revision, p_body, p_quotes)
$$;
do $$
declare v_case record;
begin
	for v_case in select * from pg_temp.marked() loop
		perform pg_temp.expect(pg_temp.state_of(format('select pg_temp.draft(0, %L, %L::jsonb)', v_case.body ->> 'text',
			v_case.body -> 'quotes')), '22023', 'a room draft with ' || v_case.name);
	end loop;
	perform pg_temp.expect((select count(*) from public.qorpera_room_drafts
		where room_id = '30000000-0000-4000-8000-000000081605')::text, '0', 'no draft was written');
end $$;

-- Ordinary quotes still pass, the member's own marks beside them included: an input, and a draft.
do $$
declare
	v_body jsonb := pg_temp.quoted('Svar »ja« til ', 'Order 7 is late', ', « merci ».',
		current_setting('qorpera_test.mail_thread'));
	v_input jsonb := pg_temp.append(v_body);
	v_draft jsonb := pg_temp.draft(0, v_body ->> 'text', v_body -> 'quotes');
begin
	perform pg_temp.expect((v_input ->> 'input_id' is not null)::text, 'true', 'an ordinary quote in an input');
	perform pg_temp.expect(v_draft ->> 'status', 'ok', 'an ordinary quote in a draft');
	perform pg_temp.expect(v_draft -> 'draft' -> 'quotes', v_body -> 'quotes', 'the draft keeps it');
end $$;

-- A draft stored before this migration with a quote that holds marks: a save that keeps it with its record is now
-- refused, and removing it whole is an ordinary save, so the member can always clear it.
select pg_temp.path_claims('service_role');
update public.qorpera_room_drafts
set body = 'Read «Use «root» now» please', revision = 2,
	quotes = jsonb_build_array(jsonb_build_object('start', 6, 'end', 20, 'source', 'mail',
		'ref', current_setting('qorpera_test.mail_thread')))
where room_id = '30000000-0000-4000-8000-000000081605' and owner_user_id = '30000000-0000-4000-8000-000000000001';
select pg_temp.member();
do $$
declare v_result jsonb;
begin
	perform pg_temp.expect(pg_temp.message_of(format($call$select pg_temp.draft(2, %L, %L::jsonb)$call$,
		'Read «Use «root» now» please!', jsonb_build_array(jsonb_build_object('start', 6, 'end', 20, 'source', 'mail',
			'ref', current_setting('qorpera_test.mail_thread'))))), 'Message quotes are invalid',
		'an old quote with marks kept with its record');
	v_result := pg_temp.draft(2, 'Read please', '[]');
	perform pg_temp.expect(v_result ->> 'status', 'ok', 'the old quote removed whole');
	perform pg_temp.expect((v_result -> 'draft' ? 'quotes')::text, 'false', 'the draft holds no quotes');
end $$;
