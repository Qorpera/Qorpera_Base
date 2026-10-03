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

-- The member's own guillemets (Danish »ja«, French « merci ») sit beside a kept quote, in the save that adds it and
-- the next one alike. The same text without its quote is refused, and a stale save answers with the quotes.
do $$
declare v_body text := 'Svar »ja« til «Order 7 is late», « merci ».';
	v_next text := 'Svar »ja« til «Order 7 is late», « merci ». Tak.';
begin
	perform pg_temp.expect(pg_temp.draft(4, v_body, pg_temp.span(v_body, 'Order 7 is late')) ->> 'status', 'ok',
		'own marks beside a new quote');
	perform pg_temp.expect(pg_temp.draft(5, v_next, pg_temp.span(v_next, 'Order 7 is late')) ->> 'status', 'ok',
		'own marks in the next save');
	perform pg_temp.expect(pg_temp.state_of(format('select pg_temp.draft(6, %L)', v_next)), '22023',
		'the same text without its quote');
	perform pg_temp.expect(pg_temp.draft(2, 'x') ->> 'status', 'stale', 'a stale save');
	perform pg_temp.expect(pg_temp.draft(2, 'x') -> 'draft' -> 'quotes', pg_temp.span(v_next, 'Order 7 is late'),
		'a stale save answers with the quotes');
end $$;

-- A co-editor's older client saves text only: keeping the quote's words is refused, removing the quote whole while
-- the owner's own marks stay is an ordinary save.
select pg_temp.path_claims('service_role');
insert into public.qorpera_company_room_members (room_id, principal_kind, principal_id, status, source_path_version)
values ('30000000-0000-4000-8000-000000081605', 'member', '30000000-0000-4000-8000-000000000002', 'active',
	'30000000-0000-4000-8000-000000081606');
select pg_temp.member('30000000-0000-4000-8000-000000000002');
do $$ begin
	perform pg_temp.expect(pg_temp.state_of($call$select pg_temp.draft(6, 'Svar »ja« til «Order 7 is late», « merci ». Tak!')$call$),
		'22023', 'a co-editor''s text-only save keeping the quote');
	perform pg_temp.expect(pg_temp.state_of($call$select pg_temp.draft(6, 'Svar »ja« til «Order 7 is late!», « merci ». Tak.')$call$),
		'22023', 'a co-editor''s text-only save changing the quote''s words');
	perform pg_temp.expect(pg_temp.draft(6, 'Svar »ja« til, « merci ». Tak.') ->> 'status', 'ok',
		'a co-editor''s text-only save removing the quote whole');
end $$;

-- A client that knows quotes and has none left sends an empty list: removing the last quote and writing the member's
-- own marks in one save is ordinary, and the draft holds no quotes. The empty list still keeps no quote's words, and
-- an older client's text-only save of the same change is refused.
select pg_temp.member();
do $$
declare v_body text := 'Svar «Order 7 is late» i dag.';
	v_result jsonb;
begin
	perform pg_temp.expect(pg_temp.draft(7, v_body, pg_temp.span(v_body, 'Order 7 is late')) ->> 'status', 'ok',
		'a quote again');
	perform pg_temp.expect(pg_temp.state_of($call$select pg_temp.draft(8, 'Svar »ja« og »nej« i dag.')$call$), '22023',
		'an older client''s save removing the last quote and adding own marks');
	-- The draft's own refusal, not the message check's ("Message quotes are invalid"), which refuses an empty list.
	perform pg_temp.expect(pg_temp.message_of($call$select pg_temp.draft(8, 'Svar «Order 7 is late» nu.', '[]')$call$),
		'A save would keep a quote''s words without its record', 'an empty list keeping the quote''s words');
	v_result := pg_temp.draft(8, 'Svar »ja« og »nej« i dag.', '[]');
	perform pg_temp.expect(v_result ->> 'status', 'ok', 'an empty list removing the last quote and adding own marks');
	perform pg_temp.expect((v_result -> 'draft' ? 'quotes')::text, 'false', 'stored as none');
	perform pg_temp.expect(((select quotes from public.qorpera_room_drafts
		where room_id = '30000000-0000-4000-8000-000000081605'
			and owner_user_id = '30000000-0000-4000-8000-000000000001') is null)::text, 'true', 'the row holds none');
	perform pg_temp.expect(pg_temp.draft(9, 'Svar »ja« og »nej« i dag.', '[]') -> 'draft' ->> 'revision', '9',
		'the same text with an empty list changes nothing');
end $$;

-- Only a company whose runs fence quotes takes them. This company is on the company path; the same company as a
-- whole-tree one (snapshot-v1, no path gateway) is refused, and as a folder-v2 one it takes them. Each change is the
-- company row's alone, for its savepoint (triggers skipped: the path head guard refuses a write outside the gateway).
select pg_temp.path_claims('service_role');
do $$ begin
	perform pg_temp.expect((select count(*) from public.qorpera_company_files
		where environment_id = '30000000-0000-4000-8000-000000000020' and path_gateway_version = 1)::text, '1',
		'the fixture company is on the company path');
end $$;
create function pg_temp.check_here() returns text language sql as $$
	select pg_temp.message_of(format('select public.qorpera_check_member_quotes(%L::uuid, %L::uuid, %L::jsonb)',
		'30000000-0000-4000-8000-000000000010', '30000000-0000-4000-8000-000000000020',
		pg_temp.quoted('About ', 'Order 7', '.', current_setting('qorpera_test.mail_thread'))))
$$;
savepoint quotes_whole_tree;
set local session_replication_role = replica;
update public.qorpera_company_files set path_gateway_version = null, path_index_snapshot_id = null
where environment_id = '30000000-0000-4000-8000-000000000020';
do $$ begin
	perform pg_temp.expect(pg_temp.check_here(), 'Quotes need a company whose runs fence them', 'a whole-tree company');
end $$;
rollback to savepoint quotes_whole_tree;
savepoint quotes_folder_v2;
set local session_replication_role = replica;
-- A folder-v2 company has no snapshot head and no path gateway (qorpera_company_files_core_head): it takes quotes as
-- folder-v2 alone.
update public.qorpera_company_files
set core = 'folder-v2', head_snapshot_id = null, path_gateway_version = null, path_index_snapshot_id = null
where environment_id = '30000000-0000-4000-8000-000000000020';
do $$ begin
	perform pg_temp.expect(pg_temp.check_here(), 'ok', 'a folder-v2 company');
end $$;
rollback to savepoint quotes_folder_v2;
do $$ begin
	perform pg_temp.expect(current_setting('session_replication_role'), 'origin', 'triggers are back');
	perform pg_temp.expect(pg_temp.check_here(), 'ok', 'the company path again');
end $$;

-- Every function this part patches or adds carries its marker; the check keeps part 1's too.
do $$
declare v_function regprocedure;
begin
	if strpos(pg_get_functiondef('public.qorpera_check_member_quotes(uuid,uuid,jsonb)'::regprocedure),
		'I5d-1 (20260930000100)') = 0 then raise exception 'the quote check lost part 1''s marker'; end if;
	foreach v_function in array array['public.qorpera_check_member_quotes(uuid,uuid,jsonb)',
		'public.qorpera_draft_keeps_quotes(text,jsonb,text,jsonb)',
		'public.qorpera_room_draft_json_internal(public.qorpera_room_drafts)',
		'public.qorpera_put_room_draft(uuid,uuid,bigint,text,jsonb)']::regprocedure[] loop
		if strpos(pg_get_functiondef(v_function), 'I5d-2 (20260930008000)') = 0 then
			raise exception '% has no body marker', v_function; end if;
	end loop;
	foreach v_function in array array['public.qorpera_draft_keeps_quotes(text,jsonb,text,jsonb)']::regprocedure[] loop
		if has_function_privilege('authenticated', v_function, 'EXECUTE') or has_function_privilege('service_role', v_function, 'EXECUTE') then
			raise exception '% is exposed', v_function; end if;
	end loop;
end $$;
