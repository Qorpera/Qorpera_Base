-- @fixture 310_company_organization_kernel.test.sql until "-- A coworker is created, archived, restored, and permanently deleted by one"
-- A company formation walks every stage the table allows, one governed
-- organization/formation.json write per stage, until it is operating:
--   source_inventory -> discovery -> research -> vision_proposal
--     -> goals_ratified -> responsibility_map -> operating
-- The stage after goals_ratified is responsibility_map (renamed from
-- organization_formation on 2026-09-02). The projection used to demand the old
-- name, which the table refuses, so no formation could pass goals_ratified.

-- One stage write through the real member path: stage the bytes, begin and
-- approve the command as the founding owner, apply it as the cloud worker.
-- A refused write raises and leaves nothing behind.
create function pg_temp.formation_write(p_key text,p_document jsonb)
returns jsonb language plpgsql as $$
declare v_text text := p_document::text; v_entry jsonb; v_command jsonb; v_applied jsonb;
begin
	perform pg_temp.org_claims('service_role');
	set local role service_role;
	v_entry := pg_temp.org_stage_file('organization/formation.json',v_text);
	reset role;
	perform pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_command := public.qorpera_begin_member_company_path_command(
		(current_setting('qorpera_test.org_company')::jsonb ->> 'environment_id')::uuid,
		pg_temp.org_plan(p_key,'organization/formation.json',v_entry,
			current_setting('qorpera_test.formation_version')::uuid));
	perform public.qorpera_review_member_company_path_command(
		(v_command ->> 'commandId')::uuid,v_command ->> 'planSha256','approve');
	reset role;
	perform pg_temp.org_claims('service_role');
	set local role service_role;
	v_applied := pg_temp.org_apply(v_command,v_text);
	reset role;
	-- Each write commits on its own in production: run the deferred projection
	-- assertion for this write now, against the head it just published.
	set constraints all immediate;
	set constraints all deferred;
	perform set_config('qorpera_test.formation_version',v_applied #>> '{result,version}',true);
	return v_applied;
end
$$;

create function pg_temp.formation_document(p_state text,p_status text,p_revision integer)
returns jsonb language sql as $$
	select current_setting('qorpera_test.formation_document')::jsonb
		|| jsonb_build_object('state',p_state,'status',p_status,'revision',p_revision)
$$;

-- The enforcement row must follow the exact Company File version just written.
create function pg_temp.formation_expect(p_state text,p_status text,p_revision integer)
returns void language plpgsql as $$
declare v_company jsonb := current_setting('qorpera_test.org_company')::jsonb;
begin
	if not exists (select 1 from public.qorpera_company_formations formation
		where formation.profile_id = (v_company ->> 'profile_id')::uuid
			and formation.state = p_state and formation.status = p_status
			and formation.revision = p_revision and formation.projection_status = 'verified'
			and formation.source_path = 'organization/formation.json'
			and formation.source_path_version = current_setting('qorpera_test.formation_version')::uuid) then
		raise exception 'Formation is not at % (%) revision %',p_state,p_status,p_revision; end if;
end
$$;

select pg_temp.formation_expect('source_inventory','active',1);

do $$
declare v_stages text[] := array['discovery','research','vision_proposal','goals_ratified'];
	v_revision integer := 1; v_stage text;
begin
	foreach v_stage in array v_stages loop
		v_revision := v_revision + 1;
		perform pg_temp.formation_write('formation-' || v_stage,
			pg_temp.formation_document(v_stage,'active',v_revision));
		perform pg_temp.formation_expect(v_stage,'active',v_revision);
	end loop;
end
$$;

-- After goals_ratified: the retired name, skipping ahead, and skipping a
-- revision are each refused as a transition, and the formation stays where it
-- is. (Before 20260927185000 the retired name passed the transition and broke
-- the table's state check instead: "Organization document is invalid".)
do $$
begin
	begin
		perform pg_temp.formation_write('formation-organization-formation',
			pg_temp.formation_document('organization_formation','active',6));
		raise exception 'The retired organization_formation stage was accepted';
	exception when invalid_parameter_value then
		if sqlerrm <> 'Company formation transition is invalid' then raise; end if; end;
	begin
		perform pg_temp.formation_write('formation-skip-to-operating',
			pg_temp.formation_document('operating','active',6));
		raise exception 'Formation skipped responsibility_map';
	exception when invalid_parameter_value then
		if sqlerrm <> 'Company formation transition is invalid' then raise; end if; end;
	begin
		perform pg_temp.formation_write('formation-skip-revision',
			pg_temp.formation_document('responsibility_map','active',7));
		raise exception 'Formation skipped a revision';
	exception when invalid_parameter_value then
		if sqlerrm <> 'Company formation transition is invalid' then raise; end if; end;
	perform pg_temp.formation_expect('goals_ratified','active',5);
end
$$;

select pg_temp.formation_write('formation-responsibility-map',
	pg_temp.formation_document('responsibility_map','active',6));
select pg_temp.formation_expect('responsibility_map','active',6);

select pg_temp.formation_write('formation-operating',
	pg_temp.formation_document('operating','completed',7));
select pg_temp.formation_expect('operating','completed',7);

-- An operating formation cannot step back, and a completed one stays completed.
do $$
begin
	begin
		perform pg_temp.formation_write('formation-back-to-map',
			pg_temp.formation_document('responsibility_map','completed',8));
		raise exception 'Formation moved backward from operating';
	exception when invalid_parameter_value then
		if sqlerrm <> 'Company formation transition is invalid' then raise; end if; end;
	begin
		perform pg_temp.formation_write('formation-reopened',
			pg_temp.formation_document('operating','active',8));
		raise exception 'A completed formation became active again';
	exception when invalid_parameter_value then
		if sqlerrm <> 'Company formation transition is invalid' then raise; end if; end;
	perform pg_temp.formation_expect('operating','completed',7);
end
$$;

-- Clients read the stage from the organization read model.
select pg_temp.org_claims('authenticated','31000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.formation_organization',public.qorpera_company_organization_json(
	(current_setting('qorpera_test.org_company')::jsonb ->> 'profile_id')::uuid)::text,true);
reset role;
do $$
declare v_org jsonb := current_setting('qorpera_test.formation_organization')::jsonb;
begin
	if v_org #>> '{formation,state}' is distinct from 'operating'
		or v_org #>> '{formation,status}' is distinct from 'completed'
		or v_org #>> '{formation,revision}' is distinct from '7' then
		raise exception 'Organization read model does not report the operating formation: %',v_org -> 'formation'; end if;
end
$$;

rollback;
