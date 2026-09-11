-- Exercise public human entrypoints, not only the internal actor helper.
-- Unauthorized input must not look like a retryable storage outage.
begin;

insert into auth.users(id,email) values
	('34500000-0000-4000-8000-000000000001','admission-owner@example.test'),
	('34500000-0000-4000-8000-000000000002','admission-outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('34500000-0000-4000-8000-000000000010','Admission fixture','34500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('34500000-0000-4000-8000-000000000010','34500000-0000-4000-8000-000000000001',
	'admission-owner@example.test','Owner','owner');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('34500000-0000-4000-8000-000000000020','34500000-0000-4000-8000-000000000010',
	'Unprepared environment',1,'34500000-0000-4000-8000-000000000001');

create function pg_temp.admission_state(p_command text,p_expected text)
returns void language plpgsql as $$
begin
	begin
		execute p_command;
		raise exception 'Denied request succeeded' using errcode = 'QTC01';
	exception when others then
		if sqlstate <> p_expected then
			raise exception 'Expected SQLSTATE %, received %',p_expected,sqlstate; end if;
	end;
end
$$;

do $$
declare method text; target uuid; caller uuid; expected text; statement text;
begin
	foreach caller in array array['34500000-0000-4000-8000-000000000001'::uuid,
		'34500000-0000-4000-8000-000000000002'::uuid] loop
		perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',caller)::text,true);
		foreach target in array array[null::uuid,'34500000-0000-4000-8000-000000000099'::uuid,
			'34500000-0000-4000-8000-000000000020'::uuid] loop
			expected := case when caller='34500000-0000-4000-8000-000000000001'::uuid
				and target='34500000-0000-4000-8000-000000000020'::uuid then '55000' else '42501' end;
			foreach method in array array['qorpera_read_company_path','qorpera_list_member_company_snapshot_paths',
				'qorpera_read_member_company_snapshot_path','qorpera_authorize_member_company_path_object',
				'qorpera_authorize_member_company_snapshot_object'] loop
				statement := format('select public.%I(p_environment_id=>%L::uuid',method,target);
				if method <> 'qorpera_list_member_company_snapshot_paths' then
					statement := statement || ',p_path=>''note.md'''; end if;
				if method like '%snapshot%' then
					statement := statement || ',p_snapshot_id=>''34500000-0000-4000-8000-000000000030''::uuid';
				elsif method='qorpera_authorize_member_company_path_object' then
					statement := statement || ',p_version=>''34500000-0000-4000-8000-000000000030''::uuid';
				else statement := statement || ',p_binding=>null'; end if;
				if method like 'qorpera_authorize_%' then
					statement := statement || ',p_sha256=>repeat(''0'',64)'; end if;
				statement := statement || ')';
				set local role authenticated;
				perform pg_temp.admission_state(statement,expected);
				reset role;
			end loop;
		end loop;
	end loop;
end
$$;

set constraints all immediate;
rollback;
