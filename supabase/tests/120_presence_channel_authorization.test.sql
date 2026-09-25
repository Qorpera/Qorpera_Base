-- Presence channel authorization (20260819011000): the private presence topic
-- admits profile members and nobody else, for both receive (select) and
-- publish (insert), evaluated exactly the way Realtime evaluates a private
-- channel join — as the connecting role with realtime.topic() set.

-- Owner A creates the profile; B joins as a viewer; C stays outside.
insert into auth.users (id, email, email_confirmed_at)
values
	('a0000000-0000-4000-8000-0000000000aa', 'presence-owner@example.test', statement_timestamp()),
	('a0000000-0000-4000-8000-0000000000ab', 'presence-viewer@example.test', statement_timestamp()),
	('a0000000-0000-4000-8000-0000000000ac', 'presence-outsider@example.test', statement_timestamp());

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000aa","email":"presence-owner@example.test","role":"authenticated","user_metadata":{}}', false);
-- Privileged legacy-company fixture; client creation now uses founding.
select set_config('qorpera_test.pr_profile',
	public.qorpera_create_hosted_profile('Presence QA', 'main', 1) ->> 'profile_id', false);
reset role;
select set_config('request.jwt.claims', '', false);

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.pr_profile')::uuid,
	'a0000000-0000-4000-8000-0000000000ab', 'presence-viewer@example.test', 'Viewer', 'viewer');

select set_config('qorpera_test.pr_topic',
	'qorpera-presence-' || current_setting('qorpera_test.pr_profile'), false);

-- The topic parser: exact prefix and a well-formed uuid, nothing else.
do $$
begin
	if public.qorpera_presence_topic_profile(current_setting('qorpera_test.pr_topic'))
		is distinct from current_setting('qorpera_test.pr_profile')::uuid then
		raise exception 'presence topic did not parse to its profile id';
	end if;
	if public.qorpera_presence_topic_profile('qorpera-presence-not-a-uuid') is not null then
		raise exception 'malformed presence topic parsed to a profile id';
	end if;
	if public.qorpera_presence_topic_profile('qorpera-profile-' || current_setting('qorpera_test.pr_profile')) is not null then
		raise exception 'a non-presence topic parsed to a profile id';
	end if;
end
$$;

-- Members publish: the owner tracks presence, the viewer broadcasts typing.
select set_config('realtime.topic', current_setting('qorpera_test.pr_topic'), false);

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000aa","email":"presence-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
insert into realtime.messages (topic, extension, payload, event, private)
values (current_setting('qorpera_test.pr_topic'), 'presence', '{}'::jsonb, 'track', true);
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000ab","email":"presence-viewer@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
insert into realtime.messages (topic, extension, payload, event, private)
values (current_setting('qorpera_test.pr_topic'), 'broadcast', '{}'::jsonb, 'typing', true);

-- Members receive: both rows are visible to the viewer.
do $$
declare v_seen integer;
begin
	select count(*) into v_seen from realtime.messages
	where topic = current_setting('qorpera_test.pr_topic');
	if v_seen <> 2 then
		raise exception 'profile member saw % presence rows instead of 2', v_seen;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- A non-member can neither publish nor receive on the topic.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000ac","email":"presence-outsider@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_ok boolean := false;
	v_seen integer;
begin
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values (current_setting('qorpera_test.pr_topic'), 'broadcast', '{}'::jsonb, 'typing', true);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'non-member published into the presence channel'; end if;
	select count(*) into v_seen from realtime.messages
	where topic = current_setting('qorpera_test.pr_topic');
	if v_seen <> 0 then raise exception 'non-member received presence rows'; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- The anon role — the public channel's whole audience — has no policy at all.
set role anon;
do $$
declare
	v_ok boolean := false;
	v_seen integer;
begin
	begin
		insert into realtime.messages (topic, extension, payload, event, private)
		values (current_setting('qorpera_test.pr_topic'), 'broadcast', '{}'::jsonb, 'typing', true);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'anon published into the presence channel'; end if;
	select count(*) into v_seen from realtime.messages
	where topic = current_setting('qorpera_test.pr_topic');
	if v_seen <> 0 then raise exception 'anon received presence rows'; end if;
end
$$;
reset role;

-- A member of profile X gains nothing on profile Y's topic: the outsider
-- creates their own profile and still cannot see the first one's presence.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-0000000000ac","email":"presence-outsider@example.test","role":"authenticated","user_metadata":{}}', false);
-- Privileged legacy-company fixture; client creation now uses founding.
select public.qorpera_create_hosted_profile('Presence QA Other', 'main', 1);
set role authenticated;
do $$
declare v_seen integer;
begin
	select count(*) into v_seen from realtime.messages
	where topic = current_setting('qorpera_test.pr_topic');
	if v_seen <> 0 then raise exception 'membership elsewhere leaked another profile''s presence'; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);
select set_config('realtime.topic', '', false);
