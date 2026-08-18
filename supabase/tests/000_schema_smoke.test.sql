begin;

insert into auth.users (id, email)
values ('10000000-0000-4000-8000-000000000001', 'owner@example.test');

select set_config(
	'request.jwt.claims',
	'{"sub":"10000000-0000-4000-8000-000000000001","email":"owner@example.test","role":"authenticated","user_metadata":{"full_name":"Fixture Owner"}}',
	true
);

select public.qorpera_create_hosted_profile('Fixture profile', 'Fixture environment', 1);

do $$
begin
	if (select count(*) from public.qorpera_profiles) <> 1 then
		raise exception 'hosted profile fixture was not created';
	end if;
	if (select count(*) from public.qorpera_profile_members where role = 'owner') <> 1 then
		raise exception 'hosted profile owner fixture was not created';
	end if;
	if not exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
			and table_name = 'qorpera_object_reachability_graphs'
			and column_name = 'closure_verified'
	) then
		raise exception 'review blocker hardening migration was not applied';
	end if;
	if not exists (
		select 1
		from pg_catalog.pg_trigger
		where tgname = 'qorpera_clear_abandoned_runner_artifacts'
			and not tgisinternal
	) then
		raise exception 'runner attempt artifact guard was not installed';
	end if;
end
$$;

rollback;
