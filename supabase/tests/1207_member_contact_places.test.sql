-- A member places their member contacts in their own rail (20260930717000), as the real client role, in one
-- transaction that is rolled back. Company "Place shop" has Ann (owner), Bo (contributor) and Cy (viewer) and one
-- section, "Product"; "Place cafe" has Ann and Dan and a section of its own. Eve is in no company. A place is its
-- member's own: nobody else's list shows it, and it goes with either membership and with the company.
begin;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
values
	('12070000-0000-4000-8000-00000000000a', 'place-ann@example.test', statement_timestamp(), '{"display_name":"Ann"}'),
	('12070000-0000-4000-8000-00000000000b', 'place-bo@example.test', statement_timestamp(), '{"display_name":"Bo"}'),
	('12070000-0000-4000-8000-00000000000c', 'place-cy@example.test', statement_timestamp(), '{"display_name":"Cy"}'),
	('12070000-0000-4000-8000-00000000000d', 'place-dan@example.test', statement_timestamp(), '{"display_name":"Dan"}'),
	('12070000-0000-4000-8000-00000000000e', 'place-eve@example.test', statement_timestamp(), '{"display_name":"Eve"}');

insert into public.qorpera_profiles (id, name, created_by_user_id)
values
	('12070000-0000-4000-8000-000000000101', 'Place shop', '12070000-0000-4000-8000-00000000000a'),
	('12070000-0000-4000-8000-000000000102', 'Place cafe', '12070000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role, joined_at)
values
	('12070000-0000-4000-8000-000000000101', '12070000-0000-4000-8000-00000000000a', 'place-ann@example.test', 'Ann', 'owner', statement_timestamp() - interval '3 days'),
	('12070000-0000-4000-8000-000000000101', '12070000-0000-4000-8000-00000000000b', 'place-bo@example.test', 'Bo', 'contributor', statement_timestamp() - interval '2 days'),
	('12070000-0000-4000-8000-000000000101', '12070000-0000-4000-8000-00000000000c', 'place-cy@example.test', 'Cy', 'viewer', statement_timestamp() - interval '1 day'),
	('12070000-0000-4000-8000-000000000102', '12070000-0000-4000-8000-00000000000a', 'place-ann@example.test', 'Ann', 'owner', statement_timestamp() - interval '3 days'),
	('12070000-0000-4000-8000-000000000102', '12070000-0000-4000-8000-00000000000d', 'place-dan@example.test', 'Dan', 'admin', statement_timestamp() - interval '2 days');
insert into public.qorpera_company_sidebar_sections (id, profile_id, name, position)
values
	('12070000-0000-4000-8000-0000000005a1', '12070000-0000-4000-8000-000000000101', 'Product', 0),
	('12070000-0000-4000-8000-0000000005a2', '12070000-0000-4000-8000-000000000102', 'Kitchen', 0);

create function pg_temp.place_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'member contact places: %', p_what; end if;
end $$;
create function pg_temp.place_user(p_who text) returns uuid language sql immutable as $$
	select ('12070000-0000-4000-8000-00000000000' || p_who)::uuid
$$;
-- Signs p_who in as the client role (null: signed out, the anon role) for the rest of the transaction or block.
create function pg_temp.place_sign_in(p_who text) returns void language plpgsql as $$
begin
	if p_who is null then
		perform set_config('request.jwt.claims', '{"role":"anon"}', true);
		set local role anon;
	else
		perform set_config('request.jwt.claims',
			jsonb_build_object('role', 'authenticated', 'sub', pg_temp.place_user(p_who))::text, true);
		set local role authenticated;
	end if;
end $$;
-- A call's text, with "$shop" and "$cafe" standing for the companies, "$a" to "$e" for the people (quoted for SQL),
-- and "#a" to "#e", "#product", "#kitchen" and "#agent" for the same ids as JSON strings, inside a places list.
create function pg_temp.place_sql(p_sql text) returns text language sql immutable as $$
	select replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(p_sql,
		'$shop', quote_literal('12070000-0000-4000-8000-000000000101')),
		'$cafe', quote_literal('12070000-0000-4000-8000-000000000102')),
		'$a', quote_literal(pg_temp.place_user('a'))), '$b', quote_literal(pg_temp.place_user('b'))),
		'$c', quote_literal(pg_temp.place_user('c'))), '$d', quote_literal(pg_temp.place_user('d'))),
		'$e', quote_literal(pg_temp.place_user('e'))),
		'#product', '"12070000-0000-4000-8000-0000000005a1"'), '#kitchen', '"12070000-0000-4000-8000-0000000005a2"'),
		'#agent', '"12070000-0000-4000-8000-0000000000aa"'),
		'#a', to_jsonb(pg_temp.place_user('a'))::text), '#b', to_jsonb(pg_temp.place_user('b'))::text),
		'#c', to_jsonb(pg_temp.place_user('c'))::text), '#d', to_jsonb(pg_temp.place_user('d'))::text),
		'#e', to_jsonb(pg_temp.place_user('e'))::text)
$$;
create function pg_temp.place_call(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; v_sql text := 'select (' || pg_temp.place_sql(p_sql) || ')::jsonb';
begin
	perform pg_temp.place_sign_in(p_who);
	execute v_sql into v;
	reset role;
	perform set_config('request.jwt.claims', '', true);
	return v;
end $$;
-- The call p_sql by p_who is refused with p_state; what it changed, the sign-in and the role end with it.
create function pg_temp.place_refused(p_who text, p_sql text, p_state text, p_what text) returns void language plpgsql as $$
declare v_state text; v_message text; v_sql text := 'select ' || pg_temp.place_sql(p_sql);
begin
	begin
		perform pg_temp.place_sign_in(p_who);
		execute v_sql;
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		if v_state = p_state then return; end if;
		raise exception 'member contact places: % refused with % %, expected %', p_what, v_state, v_message, p_state;
	end;
	raise exception 'member contact places: not refused: %', p_what;
end $$;
-- p_who places the contacts of the list p_places (the "#" names above) in "Place shop"; answers the list.
create function pg_temp.place_set(p_who text, p_places text) returns jsonb language sql as $$
	select pg_temp.place_call(p_who, format('public.qorpera_place_member_contacts($shop, %L::jsonb)', pg_temp.place_sql(p_places)))
$$;
-- One chat of a list, by the other member's letter.
create function pg_temp.place_of(p_list jsonb, p_who text) returns jsonb language sql as $$
	select chat from jsonb_array_elements(p_list -> 'chats') as chat where chat ->> 'userId' = pg_temp.place_user(p_who)::text
$$;

-- 1. The API roles: authenticated alone places, nobody reaches the table; the markers.
select pg_temp.place_assert(
	has_function_privilege('authenticated', 'public.qorpera_place_member_contacts(uuid,jsonb)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_place_member_contacts(uuid,jsonb)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_place_member_contacts(uuid,jsonb)', 'EXECUTE'),
	'authenticated alone places contacts');
select pg_temp.place_assert(
	has_function_privilege('authenticated', 'public.qorpera_list_member_chats(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_list_member_chats(uuid)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_list_member_chats(uuid)', 'EXECUTE'),
	'the list keeps its callers');
select pg_temp.place_assert(
	not has_table_privilege(role_name, 'public.qorpera_member_sidebar_contacts', 'SELECT')
		and not has_table_privilege(role_name, 'public.qorpera_member_sidebar_contacts', 'INSERT')
		and not has_table_privilege(role_name, 'public.qorpera_member_sidebar_contacts', 'UPDATE')
		and not has_table_privilege(role_name, 'public.qorpera_member_sidebar_contacts', 'DELETE'),
	role_name || ' may not touch the places')
from unnest(array['anon', 'authenticated', 'service_role']) as role_name;
select pg_temp.place_assert((select relrowsecurity from pg_catalog.pg_class where oid = 'public.qorpera_member_sidebar_contacts'::regclass),
	'row security is on');
select pg_temp.place_refused('a', '(select count(*) from public.qorpera_member_sidebar_contacts)', '42501', 'a member reading the places table');

-- 2. Before anyone placed anything: the list says places are kept here, every contact shows, none is placed.
do $$
declare v jsonb := pg_temp.place_call('a', 'public.qorpera_list_member_chats($shop)');
begin
	perform pg_temp.place_assert(v ->> 'schema' = 'qorpera.member-chats/v1' and (v ->> 'placing')::boolean
		and jsonb_array_length(v -> 'chats') = 2
		and v -> 'chats' -> 0 ->> 'userId' = pg_temp.place_user('b')::text
		and v -> 'chats' -> 1 ->> 'userId' = pg_temp.place_user('c')::text
		and (select bool_and(jsonb_typeof(chat -> 'hidden') = 'boolean' and not (chat ->> 'hidden')::boolean and not chat ? 'place'
				and chat ? 'unread' and chat ? 'readSeq' and chat ? 'theirReadSeq' and chat ? 'last' and chat ? 'lastSeenAt')
			from jsonb_array_elements(v -> 'chats') as chat),
		'the list before any place: ' || v::text);
end $$;

-- 3. Ann pins Bo after an agent and hides Cy in the Product section, in one call. The answer is her list again.
do $$
declare v jsonb; v_bo jsonb; v_cy jsonb;
begin
	v := pg_temp.place_set('a', '[{"userId": #b, "zone": "pinned", "after": #agent, "rank": 0, "hidden": false},
		{"userId": #c, "zone": "section", "sectionId": #product, "rank": 2, "hidden": true}]');
	v_bo := pg_temp.place_of(v, 'b');
	v_cy := pg_temp.place_of(v, 'c');
	perform pg_temp.place_assert(v ->> 'schema' = 'qorpera.member-chats/v1' and (v ->> 'placing')::boolean
		and v_bo -> 'place' = '{"zone": "pinned", "after": "12070000-0000-4000-8000-0000000000aa", "rank": 0}'::jsonb
		and not (v_bo ->> 'hidden')::boolean
		and v_cy -> 'place' = '{"zone": "section", "sectionId": "12070000-0000-4000-8000-0000000005a1", "rank": 2}'::jsonb
		and (v_cy ->> 'hidden')::boolean,
		'the answer to a place: ' || v::text);
	perform pg_temp.place_assert(pg_temp.place_call('a', 'public.qorpera_list_member_chats($shop)') = v,
		'the list reads what the place answered');
	-- Her own only: Bo's and Cy's lists place nobody, and her list in the other company places nobody.
	perform pg_temp.place_assert((select bool_and(not chat ? 'place' and not (chat ->> 'hidden')::boolean)
		from unnest(array['b', 'c']) as who,
			jsonb_array_elements(pg_temp.place_call(who, 'public.qorpera_list_member_chats($shop)') -> 'chats') as chat),
		'a place is its member''s own');
	perform pg_temp.place_assert(not pg_temp.place_call('a', 'public.qorpera_list_member_chats($cafe)') -> 'chats' -> 0 ? 'place',
		'a place is one company''s');
	-- A place is replaced whole: Bo back to the Members group, third; what he stood after goes.
	v := pg_temp.place_set('a', '[{"userId": #b, "zone": "members", "rank": 3, "hidden": false}]');
	perform pg_temp.place_assert(pg_temp.place_of(v, 'b') -> 'place' = '{"zone": "members", "rank": 3}'::jsonb
		and pg_temp.place_of(v, 'c') -> 'place' ->> 'zone' = 'section' and (pg_temp.place_of(v, 'c') ->> 'hidden')::boolean,
		'a place is replaced whole, and only the one named: ' || v::text);
	-- Among what is in no section, first: no anchor. A null anchor and a null section say the same as none.
	v := pg_temp.place_set('a', '[{"userId": #b, "zone": "unassigned", "after": null, "sectionId": null, "rank": 0, "hidden": false}]');
	perform pg_temp.place_assert(pg_temp.place_of(v, 'b') -> 'place' = '{"zone": "unassigned", "rank": 0}'::jsonb,
		'first among what is in no section: ' || v::text);
	perform pg_temp.place_assert((select count(*) from public.qorpera_member_sidebar_contacts) = 2, 'one row a contact');
end $$;

-- 4. A viewer places too: it is their own rail.
select pg_temp.place_assert(
	pg_temp.place_of(pg_temp.place_set('c', '[{"userId": #a, "zone": "pinned", "rank": 0, "hidden": false}]'), 'a') -> 'place' ->> 'zone' = 'pinned',
	'a viewer places a contact');

-- 5. Anything else is refused whole, and nothing is written: Ann's two places stand as they were.
select pg_temp.place_refused('a', format('public.qorpera_place_member_contacts($shop, %L::jsonb)', pg_temp.place_sql(places)), '22023', 'places ' || places)
from unnest(array[
	'{"userId": #b, "zone": "members", "rank": 0, "hidden": false}',
	'[]',
	'["x"]',
	'[{"zone": "members", "rank": 0, "hidden": false}]',
	'[{"userId": "bo", "zone": "members", "rank": 0, "hidden": false}]',
	'[{"userId": 7, "zone": "members", "rank": 0, "hidden": false}]',
	-- Herself, someone of another company, someone of none, and one contact twice.
	'[{"userId": #a, "zone": "members", "rank": 0, "hidden": false}]',
	'[{"userId": #d, "zone": "members", "rank": 0, "hidden": false}]',
	'[{"userId": #e, "zone": "members", "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "members", "rank": 0, "hidden": false}, {"userId": #b, "zone": "pinned", "rank": 0, "hidden": false}]',
	-- A good entry beside a bad one writes neither.
	'[{"userId": #c, "zone": "members", "rank": 0, "hidden": false}, {"userId": #b, "zone": "top", "rank": 0, "hidden": false}]',
	'[{"userId": #b, "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "section", "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "section", "sectionId": "product", "rank": 0, "hidden": false}]',
	-- Another company's section, and a section of none.
	'[{"userId": #b, "zone": "section", "sectionId": #kitchen, "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "section", "sectionId": #agent, "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "pinned", "sectionId": #product, "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "members", "after": #agent, "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "pinned", "after": "first", "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "pinned", "after": 3, "rank": 0, "hidden": false}]',
	'[{"userId": #b, "zone": "members", "hidden": false}]',
	'[{"userId": #b, "zone": "members", "rank": -1, "hidden": false}]',
	'[{"userId": #b, "zone": "members", "rank": 10000, "hidden": false}]',
	'[{"userId": #b, "zone": "members", "rank": 1.5, "hidden": false}]',
	'[{"userId": #b, "zone": "members", "rank": "1", "hidden": false}]',
	'[{"userId": #b, "zone": "members", "rank": 0}]',
	'[{"userId": #b, "zone": "members", "rank": 0, "hidden": "no"}]']) as places;
select pg_temp.place_refused('a', 'public.qorpera_place_member_contacts($shop, null)', '22023', 'no places at all');
-- More than a hundred at once.
select pg_temp.place_refused('a', format('public.qorpera_place_member_contacts($shop, %L::jsonb)',
	(select jsonb_agg(jsonb_build_object('userId', pg_temp.place_user('b'), 'zone', 'members', 'rank', 0, 'hidden', false))
		from generate_series(1, 101))::text), '22023', 'a hundred and one places');
do $$
declare v jsonb := pg_temp.place_call('a', 'public.qorpera_list_member_chats($shop)');
begin
	perform pg_temp.place_assert(pg_temp.place_of(v, 'b') -> 'place' = '{"zone": "unassigned", "rank": 0}'::jsonb
		and pg_temp.place_of(v, 'c') -> 'place' ->> 'zone' = 'section' and (pg_temp.place_of(v, 'c') ->> 'hidden')::boolean
		and (select count(*) from public.qorpera_member_sidebar_contacts) = 3,
		'a refused call wrote nothing: ' || v::text);
end $$;

-- 6. Dan and Eve are not in "Place shop", and nobody is signed out: refused.
select pg_temp.place_refused(who, format('public.qorpera_place_member_contacts($shop, %L::jsonb)',
		pg_temp.place_sql('[{"userId": #b, "zone": "members", "rank": 0, "hidden": true}]')), '42501',
	coalesce(who, 'signed out') || ' placing a contact')
from unnest(array['d', 'e', null]) as who;

-- 7. A company being deleted takes no place.
insert into public.qorpera_company_deletions (profile_id) values ('12070000-0000-4000-8000-000000000101');
select pg_temp.place_refused('a', format('public.qorpera_place_member_contacts($shop, %L::jsonb)',
		pg_temp.place_sql('[{"userId": #b, "zone": "members", "rank": 0, "hidden": true}]')), '42501',
	'placing in a company being deleted');
delete from public.qorpera_company_deletions where profile_id = '12070000-0000-4000-8000-000000000101';

-- 8. A deleted section leaves the place as it was written: the client reads the sidebar and puts the contact back in
-- the Members group; nothing here follows the sections.
delete from public.qorpera_company_sidebar_sections where id = '12070000-0000-4000-8000-0000000005a1';
select pg_temp.place_assert(
	pg_temp.place_of(pg_temp.place_call('a', 'public.qorpera_list_member_chats($shop)'), 'c') -> 'place' ->> 'sectionId'
		= '12070000-0000-4000-8000-0000000005a1', 'a place outlives its section');

-- 9. Bo leaves the company: the place Ann gave him goes, and so would his own; Cy's place for Ann and Ann's for Cy
-- stay. Ann's list no longer names him.
select pg_temp.place_set('b', '[{"userId": #a, "zone": "pinned", "rank": 0, "hidden": false}]') \g /dev/null
delete from public.qorpera_profile_members
where profile_id = '12070000-0000-4000-8000-000000000101' and user_id = '12070000-0000-4000-8000-00000000000b';
select pg_temp.place_assert(
	(select count(*) = 2 and bool_and('12070000-0000-4000-8000-00000000000b' not in (user_id, other_user_id))
		from public.qorpera_member_sidebar_contacts where profile_id = '12070000-0000-4000-8000-000000000101'),
	'a member who leaves takes their places and the places others gave them');
select pg_temp.place_assert(pg_temp.place_of(pg_temp.place_call('a', 'public.qorpera_list_member_chats($shop)'), 'b') is null,
	'a member who left is in no list');

-- 10. What the table hangs on: both memberships and the company, each cascading; no link to the accounts of its own
-- (an account's deletion reaches it through the memberships, as 720 lists), and no trigger, so the company's purge
-- meets none here (715).
select pg_temp.place_assert((select count(*) = 3 and bool_and(link.confdeltype = 'c')
		and count(*) filter (where link.confrelid = 'public.qorpera_profile_members'::regclass) = 2
		and count(*) filter (where link.confrelid = 'public.qorpera_profiles'::regclass) = 1
	from pg_catalog.pg_constraint as link
	where link.contype = 'f' and link.conrelid = 'public.qorpera_member_sidebar_contacts'::regclass),
	'the places hang on both memberships and the company');
select pg_temp.place_assert(not exists (select 1 from pg_catalog.pg_trigger as trigger_row
	where trigger_row.tgrelid = 'public.qorpera_member_sidebar_contacts'::regclass and not trigger_row.tgisinternal),
	'no trigger on the places');
delete from public.qorpera_profile_members where profile_id = '12070000-0000-4000-8000-000000000101'
	and user_id = '12070000-0000-4000-8000-00000000000c';
select pg_temp.place_assert((select count(*) = 0 from public.qorpera_member_sidebar_contacts
	where profile_id = '12070000-0000-4000-8000-000000000101'), 'the last places go with the last other member');

rollback;
