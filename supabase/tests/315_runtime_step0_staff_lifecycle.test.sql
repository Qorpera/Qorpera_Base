-- Runtime Order 0 staff lifecycle: cloud deletion retires live authority,
-- bins owned artifacts, preserves immutable referential identity, and cannot
-- be used to delete the company Co-Founder.
begin;

create function pg_temp.staff_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object(
		'role',p_role,'sub',p_user,'email',(select email from auth.users where id=p_user),
		'user_metadata','{}'::jsonb)::text,true)::text::void
$$;

insert into auth.users(id,email) values
	('31500000-0000-4000-8000-000000000001','owner@example.test');
select pg_temp.staff_claims('authenticated','31500000-0000-4000-8000-000000000001');
-- Legacy fixture construction is internal; staff APIs retain client authority.
select set_config('qorpera_test.staff_profile',public.qorpera_create_hosted_profile(
	'Staff lifecycle fixture','Staff lifecycle fixture',2)::text,true);
set local role authenticated;
select set_config('qorpera_test.staff_record',public.qorpera_put_profile_staff(
	(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid,
	'31500000-0000-4000-8000-000000000010','Builder','Software delivery','Own tested software delivery.',
	'software-developer',null,'blue','round','brain','openai-codex','gpt-5.6-codex-low',
	'active','setup',statement_timestamp(),null)::text,true);
select set_config('qorpera_test.staff_session',public.qorpera_ensure_staff_session(
	(current_setting('qorpera_test.staff_profile')::jsonb ->> 'environment_id')::uuid,
	'31500000-0000-4000-8000-000000000010','31500000-0000-4000-8000-000000000011','Builder')::text,true);
reset role;

insert into public.qorpera_artifacts(profile_id,environment_id,client_artifact_id,session_id,
	artifact_type,name,root_object_sha256,content_sha256,bytes,media_type,created_by_user_id)
values ((current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid,
	(current_setting('qorpera_test.staff_profile')::jsonb ->> 'environment_id')::uuid,
	'31500000-0000-4000-8000-000000000012',
	(current_setting('qorpera_test.staff_session')::jsonb ->> 'session_id')::uuid,
	'fixture','Owned artifact',repeat('a',64),repeat('a',64),1,'application/octet-stream',
	'31500000-0000-4000-8000-000000000001');

do $$ begin
	if not exists (select 1 from public.qorpera_staff_provider_models
		where profile_id=(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid
			and staff_agent_id='31500000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_artifacts
			where client_artifact_id='31500000-0000-4000-8000-000000000012'
				and owner_staff_agent_id='31500000-0000-4000-8000-000000000010') then
		raise exception 'Staff enforcement fixture did not bind provider or artifact ownership'; end if;
end $$;

select pg_temp.staff_claims('authenticated','31500000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_delete_profile_staff(
	(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid,
	'31500000-0000-4000-8000-000000000010',1);

do $$ begin
	if public.qorpera_list_profile_staff(
		(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid) <> '[]'::jsonb
		or exists (select 1 from public.qorpera_profile_staff where profile_id =
			(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid
			and staff_agent_id='31500000-0000-4000-8000-000000000010') then
		raise exception 'Deleted staff remained visible to the member'; end if;
	begin
		perform public.qorpera_put_profile_staff(
			(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid,
			'31500000-0000-4000-8000-000000000010','Builder','Software delivery','Restore it.',
			null,null,'blue','round','brain',null,null,'active','active',statement_timestamp(),2);
		raise exception 'Permanent staff deletion was restorable';
	exception when object_not_in_prerequisite_state then null; end;
	if public.qorpera_delete_profile_staff(
		(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid,
		'31500000-0000-4000-8000-000000000010',1) <> 'true'::jsonb then
		raise exception 'Staff deletion retry did not converge'; end if;
end $$;
reset role;

do $$ begin
	if not exists (select 1 from public.qorpera_profile_staff where profile_id =
		(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid
		and staff_agent_id='31500000-0000-4000-8000-000000000010'
		and deleted_at is not null and deleted_by_user_id='31500000-0000-4000-8000-000000000001'
		and employment_status='archived' and model_provider is null and model_id is null)
		or exists (select 1 from public.qorpera_staff_provider_models where profile_id =
			(current_setting('qorpera_test.staff_profile')::jsonb ->> 'profile_id')::uuid
			and staff_agent_id='31500000-0000-4000-8000-000000000010')
		or not exists (select 1 from public.qorpera_shared_sessions where id =
			(current_setting('qorpera_test.staff_session')::jsonb ->> 'session_id')::uuid and status='closed')
		or not exists (select 1 from public.qorpera_artifacts where client_artifact_id =
			'31500000-0000-4000-8000-000000000012' and deleted_at is not null) then
		raise exception 'Staff deletion did not retire its dependent enforcement state'; end if;
end $$;

rollback;
