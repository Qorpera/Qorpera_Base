-- @fixture 816_runtime_member_message_quotes.test.sql until "-- Privileges: the helpers are nobody's to call."
-- Quoted outside content in a member's message, I5d part 2 (20260930008000; contract: the 2026-10-02 amendment
-- "quoted outside content in a member's message", items 1 and 2). A room draft keeps its quotes beside its text, and
-- once it holds quotes a save that keeps a quote's words without its record, or changes them, is refused; removing a
-- quote whole is an ordinary save. Quotes are refused in a company whose runs can't fence them.

-- The draft call is authenticated's, with the quotes as an optional fifth argument.
do $$ begin
	if not has_function_privilege('authenticated', 'public.qorpera_put_room_draft(uuid,uuid,bigint,text,jsonb)', 'EXECUTE')
		or has_function_privilege('anon', 'public.qorpera_put_room_draft(uuid,uuid,bigint,text,jsonb)', 'EXECUTE')
		or to_regprocedure('public.qorpera_put_room_draft(uuid,uuid,bigint,text)') is not null then
		raise exception 'the draft call has the wrong grants or an old overload'; end if;
end $$;

create function pg_temp.draft(p_revision bigint, p_body text, p_quotes jsonb default null) returns jsonb
language sql as $$
	select public.qorpera_put_room_draft('30000000-0000-4000-8000-000000081605', '30000000-0000-4000-8000-000000000001',
		p_revision, p_body, p_quotes)
$$;
create function pg_temp.span(p_body text, p_words text, p_ref text default current_setting('qorpera_test.mail_thread'))
returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('start', strpos(p_body, '«' || p_words || '»'),
		'end', strpos(p_body, '«' || p_words || '»') + char_length(p_words), 'source', 'mail', 'ref', p_ref))
$$;

-- The owner's draft keeps a quote: saved, returned and listed with it.
select pg_temp.member();
do $$
declare v_body text := 'Please answer «Order 7 is late» today.';
	v_result jsonb := pg_temp.draft(0, v_body, pg_temp.span(v_body, 'Order 7 is late'));
begin
	perform pg_temp.expect(v_result ->> 'status', 'ok', 'a quoted draft is saved');
	perform pg_temp.expect(v_result -> 'draft' -> 'quotes', pg_temp.span(v_body, 'Order 7 is late'), 'its quotes');
	perform pg_temp.expect((public.qorpera_list_room_drafts('30000000-0000-4000-8000-000000081605') -> 'drafts' -> 0
		-> 'quotes'), pg_temp.span(v_body, 'Order 7 is late'), 'the list carries them');
end $$;

-- A save that keeps the quote's words without its record is refused, from the new call and from an older client's
-- four-argument one; so is a save that changes the words inside the marks.
do $$ begin
	perform pg_temp.expect(pg_temp.state_of($call$select pg_temp.draft(1, 'Please answer «Order 7 is late» today, thanks.')$call$),
		'22023', 'the words kept without the record');
	perform pg_temp.expect(pg_temp.state_of($call$select public.qorpera_put_room_draft(
		p_room_id => '30000000-0000-4000-8000-000000081605', p_owner_user_id => '30000000-0000-4000-8000-000000000001',
		p_base_revision => 1, p_body => 'Please answer «Order 7 is late» today, thanks.')$call$),
		'22023', 'an older client''s text-only save');
	perform pg_temp.expect(pg_temp.state_of($call$select pg_temp.draft(1, 'Please answer «Order 8 is late» today.')$call$),
		'22023', 'the words changed without the record');
end $$;

-- Text around the quote is the member's to change, with the quote kept.
do $$
declare v_body text := 'Hi, please answer «Order 7 is late» today.';
begin
	perform pg_temp.expect(pg_temp.draft(1, v_body, pg_temp.span(v_body, 'Order 7 is late')) ->> 'status', 'ok',
		'words around the quote');
end $$;

-- Removing the quote whole is an ordinary save; the draft then holds no quotes, and the member's own «» are theirs.
do $$
declare v_result jsonb := pg_temp.draft(2, 'Hi, please answer today.');
begin
	perform pg_temp.expect(v_result ->> 'status', 'ok', 'the quote removed whole');
	perform pg_temp.expect((v_result -> 'draft' ? 'quotes')::text, 'false', 'no quotes left');
	perform pg_temp.expect(pg_temp.draft(3, 'Hi, «my own words» today.') ->> 'status', 'ok', 'the member''s own marks');
end $$;

-- A draft's quotes are checked as a message's would be.
do $$
declare v_body text := 'About «Order 7».';
begin
	perform pg_temp.expect(pg_temp.state_of(format('select pg_temp.draft(4, %L, %L::jsonb)', v_body,
		jsonb_set(pg_temp.span(v_body, 'Order 7'), '{0,start}', '8'))), '22023', 'a span outside its marks');
	perform pg_temp.expect(pg_temp.state_of(format('select pg_temp.draft(4, %L, %L::jsonb)', v_body,
		pg_temp.span(v_body, 'Order 7', repeat('Z', 43)))), '22023', 'an unknown thread');
	perform pg_temp.expect(pg_temp.state_of(format('select pg_temp.draft(4, %L, %L::jsonb)', v_body,
		pg_temp.span(v_body, 'Order 7', current_setting('qorpera_test.account_thread')))), '22023', 'account mail');
end $$;

-- Only a company whose runs fence quotes takes them: this company is on the company path, and an environment with no
-- Company File on it (a whole-tree company's) is refused.
select pg_temp.path_claims('service_role');
do $$
declare v_body jsonb := pg_temp.quoted('About ', 'Order 7', '.', current_setting('qorpera_test.mail_thread'));
begin
	perform pg_temp.expect((select count(*) from public.qorpera_company_files
		where environment_id = '30000000-0000-4000-8000-000000000020' and path_gateway_version = 1)::text, '1',
		'the fixture company is on the company path');
	perform pg_temp.expect(pg_temp.state_of(format(
		'select public.qorpera_check_member_quotes(%L::uuid, extensions.gen_random_uuid(), %L::jsonb)',
		'30000000-0000-4000-8000-000000000010', v_body)), '22023', 'a company whose runs can''t fence quotes');
	perform pg_temp.expect(pg_temp.message_of(format(
		'select public.qorpera_check_member_quotes(%L::uuid, extensions.gen_random_uuid(), %L::jsonb)',
		'30000000-0000-4000-8000-000000000010', v_body)), 'Quotes need a company whose runs fence them',
		'and it says why');
end $$;

-- Both markers stay in the check: part 1's and this part's.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_check_member_quotes(uuid,uuid,jsonb)'::regprocedure);
begin
	if strpos(v_definition, 'I5d-1 (20260930000100)') = 0 or strpos(v_definition, 'I5d-2 (20260930008000)') = 0 then
		raise exception 'the quote check lost a body marker'; end if;
end $$;
