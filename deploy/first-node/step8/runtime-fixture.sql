-- Loaded ONLY by the disposable harness after the pinned Step 3 fixture
-- prefix, before Step 3 installs its Company File-only listener activation.
-- No production helper is replaced or security trigger disabled.
create table step8_test.saved (key text primary key,value jsonb not null);
insert into step8_test.saved(key,value) values
	('binding',current_setting('qorpera_test.wake_binding')::jsonb),
	('sponsor',current_setting('qorpera_test.wake_sponsor')::jsonb),
	('policy',current_setting('qorpera_test.step8_policy')::jsonb);

create function step8_test.restore()
returns void language plpgsql as $$
begin
	perform step8_test.path_claims('service_role');
	perform set_config('qorpera_test.wake_binding',(select value::text from step8_test.saved where key = 'binding'),true);
	perform set_config('qorpera_test.wake_sponsor',(select value::text from step8_test.saved where key = 'sponsor'),true);
end $$;

create function step8_test.definition(p_routine uuid)
returns jsonb language sql as $$
	select jsonb_build_object('staff_agent_id',v.staff_agent_id,'title',v.title,'prompt',v.prompt,'triggers',v.triggers,
		'effort',v.effort,'sponsor_binding_id',v.sponsor_binding_id,'sponsor_version',v.sponsor_version,'logical_computer_id',v.logical_computer_id,
		'required_capability',v.required_capability,'job_type',v.job_type,'publication_mode',v.publication_mode,
		'review_policy_key',v.review_policy_key,'reviewer_staff_ids',to_jsonb(v.reviewer_staff_ids))
	from public.qorpera_cloud_routine_versions v join public.qorpera_cloud_routines r on r.id = v.routine_id and r.current_version = v.version
	where r.id = p_routine
$$;

create function step8_test.instant(p_at timestamptz)
returns text language sql as $$
	select to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- The existing routine writer/Step 3 activation does not yet accept GitHub.
-- Seed that FUTURE compiled-version shape before the activation trigger exists
-- to test the independently installable receipt ledger and its CLOSED gates.
-- This is NOT an end-to-end external-listener authoring or admission claim.
do $$
declare r jsonb; id uuid;
	t jsonb := '{"id":"github-pr","kind":"listener","source":"github","timeZone":"UTC", "connectionId":"80000000-0000-4000-8000-000000000002",
		"installationId":"987654","repositoryId":"1296269","events":["pull_request.opened"],"actors":{"mode":"allowlist","ids":["123456"]},
		"delivery":{"maxAgeSeconds":86400,"maxFutureSkewSeconds":60,"reordered":"drop-older"}}';
begin
	r := step8_test.wake_routine('30000000-0000-4000-8000-000000000030','{"id":"github-pr","kind":"schedule","intervalMinutes":5}');
	id := (r ->> 'routine_id')::uuid;
	update public.qorpera_cloud_routine_versions set triggers = jsonb_build_array(t) where routine_id = id;
	update public.qorpera_cloud_routine_versions set content_sha256 = encode(extensions.digest(convert_to(step8_test.definition(id)::text,'utf8'),'sha256'),'hex') where routine_id = id;
	delete from public.qorpera_cloud_routine_schedule_cursors where routine_id = id;
	insert into step8_test.saved(key,value) values('external-routine',r),('external-trigger',t);
end $$;
commit;
