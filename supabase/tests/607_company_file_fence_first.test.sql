-- @fixture 602_runtime_coding_lock_order.test.sql until "-- 1. The owner answers"
-- The company's profile fence before its Company File row (20260927090000_company_file_fence_first). An
-- agent tool call takes the fence (the profile row, then the company's wake admission fence) and then locks
-- the Company File row; so do the object gateway's upload confirmation and a session's first coding machine
-- admission. A member saving, proposing or accepting, and the object gateway copying an object into the
-- company's bucket, locked the Company File row first and then waited for the profile row. Each race below makes the two meet in that order: a third connection holds
-- the company's wake admission fence row, the fence-first call starts, takes the profile row and waits
-- there, the other call starts and waits too, and the holder lets go. On the previous function text each
-- race ends in "deadlock detected" (40P01): the other call held the Company File row the fence-first call
-- needed next. Now it waits for the profile row before it locks anything, and both land. Races 1-2 use the
-- path gateway company of 602's committed fixture and an agent listing a folder; races 3-5 use a company
-- that is not on the path gateway (publishing a revision needs one), created here and removed with the
-- fixture at the end.

-- A company that is not on the path gateway: its owner, the company, and the stored objects its revisions
-- and proposals name (fixture bytes only, as in 300).
insert into auth.users(id,email) values
	('60700000-0000-4000-8000-000000000001','fence-owner@example.test'),
	('60700000-0000-4000-8000-000000000002','fence-viewer@example.test');
do $$
declare v_company jsonb;
begin
	perform set_config('request.jwt.claims','{"role":"authenticated","sub":"60700000-0000-4000-8000-000000000001","email":"fence-owner@example.test"}',true);
	v_company := public.qorpera_create_cloud_company('60700000-0000-4000-8000-000000000010','Fence company',2);
	perform set_config('qorpera_test.fence_profile',v_company ->> 'profile_id',false);
	perform set_config('qorpera_test.fence_environment',v_company ->> 'environment_id',false);
end $$;
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	(current_setting('qorpera_test.fence_profile')::uuid,'60700000-0000-4000-8000-000000000002','fence-viewer@example.test','Viewer','viewer');
insert into storage.objects(bucket_id,name,metadata)
select 'qorpera-profile-objects',profile_id || '/' || repeat(sha,64),'{"size":128}'
from unnest(array[current_setting('qorpera_test.fence_profile'),'30000000-0000-4000-8000-000000000010']) profile_id,
	unnest(array['a','b','c','d','e']) sha;
-- The company's wake admission fence row exists before a race holds it.
select public.qorpera_lock_profile_gc_fence(profile_id)
from unnest(array[current_setting('qorpera_test.fence_profile')::uuid,'30000000-0000-4000-8000-000000000010'::uuid]) profile_id;

-- A revision or proposal snapshot of the plain company, verified reachable and restorable as in 140.
create function pg_temp.fence_verify(p_snapshot uuid,p_sha text,p_client uuid) returns void language plpgsql as $$
declare v_graph uuid; v_content text := encode(extensions.digest(convert_to(repeat(p_sha,64) || ':128','utf8'),'sha256'),'hex');
begin
	perform pg_temp.path_claims('authenticated','60700000-0000-4000-8000-000000000001');
	v_graph := (public.qorpera_begin_object_reachability_graph('company_snapshot',p_snapshot,p_client,repeat(p_sha,64),1,
		v_content,1,128) ->> 'graph_id')::uuid;
	perform public.qorpera_append_object_reachability_entries(v_graph,jsonb_build_array(jsonb_build_object('sha256',repeat(p_sha,64),'bytes',128)));
	perform public.qorpera_complete_object_reachability_graph(v_graph);
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_verify_company_snapshot_closure(p_snapshot,v_graph,'60700000-0000-4000-8000-000000000001',v_content,1,128,
		repeat(p_sha,64),4,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	perform pg_temp.path_claims('authenticated','60700000-0000-4000-8000-000000000001');
	perform public.qorpera_create_object_restore_proof(v_graph,extensions.gen_random_uuid(),repeat(p_sha,64),4);
end
$$;
create function pg_temp.fence_head(p_environment uuid) returns uuid language sql as $$
	select head_snapshot_id from public.qorpera_company_files where environment_id = p_environment
$$;
create function pg_temp.fence_hold(p_profile uuid) returns text language sql as $$
	select format('select 1 from public.qorpera_company_wake_admission_fences where profile_id = %L for update', p_profile)
$$;
-- The object gateway confirms an upload: the fence, then the Company File row (the allowance), then the object.
create function pg_temp.fence_confirm(p_sha text) returns text language sql as $$
	select format('select public.qorpera_confirm_profile_object_upload(%L, %L, 64, ''nas-object-gateway'')',
		current_setting('qorpera_test.fence_profile'), repeat(p_sha,64))
$$;
create function pg_temp.fence_owner() returns jsonb language sql as $$
	select '{"role":"authenticated","sub":"60700000-0000-4000-8000-000000000001"}'::jsonb
$$;
create function pg_temp.fence_path_owner() returns jsonb language sql as $$
	select '{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}'::jsonb
$$;

-- The plain company's first revision is its head; the second is prepared and verified for race 3.
do $$
declare v_first jsonb; v_second jsonb;
begin
	perform pg_temp.path_claims('authenticated','60700000-0000-4000-8000-000000000001');
	v_first := public.qorpera_prepare_company_file_revision(current_setting('qorpera_test.fence_environment')::uuid,
		'60700000-0000-4000-8000-000000000020',null,repeat('a',64),128,3,1,4);
	perform pg_temp.fence_verify((v_first ->> 'snapshot_id')::uuid,'a','60700000-0000-4000-8000-000000000021');
	perform pg_temp.path_claims('authenticated','60700000-0000-4000-8000-000000000001');
	perform public.qorpera_publish_company_file_revision(current_setting('qorpera_test.fence_environment')::uuid,
		(v_first ->> 'snapshot_id')::uuid,null);
	v_second := public.qorpera_prepare_company_file_revision(current_setting('qorpera_test.fence_environment')::uuid,
		'60700000-0000-4000-8000-000000000022',(v_first ->> 'snapshot_id')::uuid,repeat('b',64),128,3,1,4);
	perform pg_temp.fence_verify((v_second ->> 'snapshot_id')::uuid,'b','60700000-0000-4000-8000-000000000023');
	perform set_config('qorpera_test.fence_first',v_first ->> 'snapshot_id',false);
	perform set_config('qorpera_test.fence_second',v_second ->> 'snapshot_id',false);
end $$;

-- 1. An agent lists a Company File folder while the owner saves the Company File. The save used to lock
--    the Company File row and then wait for the fence in its snapshot insert.
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.fence_hold('30000000-0000-4000-8000-000000000010'),
		format($q$select public.qorpera_list_company_paths_v2('30000000-0000-4000-8000-000000000020', '', null, null, 10, %L::jsonb)$q$,
			current_setting('qorpera_test.parent_binding')),
		'{"role":"service_role"}',
		format($q$select public.qorpera_prepare_company_file_revision('30000000-0000-4000-8000-000000000020',
			'60700000-0000-4000-8000-000000000030', %L, repeat('a', 64), 128, 3, 1, 4)$q$,
			pg_temp.fence_head('30000000-0000-4000-8000-000000000020')),
		pg_temp.fence_path_owner());
	perform pg_temp.lock_race_ok(v_outcome, 'An agent read and a save of the Company File');
	perform pg_temp.wake_assert(v_outcome #> '{first,result,readObservationId}' is not null
		and v_outcome #>> '{second,result,parent_snapshot_id}' = pg_temp.fence_head('30000000-0000-4000-8000-000000000020')::text,
		'The read and the prepared revision both land: ' || v_outcome::text);
end $$;

-- 2. An agent lists a folder while the owner prepares a proposal: the proposal pins the head FOR SHARE, which
--    the agent's FOR UPDATE waits for, and then waited for the fence in its snapshot insert.
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.fence_hold('30000000-0000-4000-8000-000000000010'),
		format($q$select public.qorpera_list_company_paths_v2('30000000-0000-4000-8000-000000000020', '', null, null, 10, %L::jsonb)$q$,
			current_setting('qorpera_test.parent_binding')),
		'{"role":"service_role"}',
		format($q$select public.qorpera_prepare_company_file_proposal('30000000-0000-4000-8000-000000000020',
			'60700000-0000-4000-8000-000000000031', %L, repeat('b', 64), 128, 3, 1, 4)$q$,
			pg_temp.fence_head('30000000-0000-4000-8000-000000000020')),
		pg_temp.fence_path_owner());
	perform pg_temp.lock_race_ok(v_outcome, 'An agent read and a proposal');
	perform pg_temp.wake_assert(v_outcome #> '{first,result,readObservationId}' is not null
		and v_outcome #> '{second,result,snapshot_id}' is not null, 'The read and the proposal both land: ' || v_outcome::text);
end $$;

-- 3. The object gateway confirms an upload while the owner publishes a revision. Moving the head records a
--    substrate version, whose insert took the fence after the Company File row.
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.fence_hold(current_setting('qorpera_test.fence_profile')::uuid),
		pg_temp.fence_confirm('1'), '{"role":"service_role"}',
		format($q$select public.qorpera_publish_company_file_revision(%L, %L, %L)$q$,
			current_setting('qorpera_test.fence_environment'), current_setting('qorpera_test.fence_second'),
			current_setting('qorpera_test.fence_first')),
		pg_temp.fence_owner());
	perform pg_temp.lock_race_ok(v_outcome, 'An upload confirmation and a publish');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,sha256}' = repeat('1',64)
		and pg_temp.fence_head(current_setting('qorpera_test.fence_environment')::uuid)::text = current_setting('qorpera_test.fence_second'),
		'The object is confirmed and the revision is the head: ' || v_outcome::text);
end $$;

-- An open proposal against the older head, and a replacement prepared on the current head.
do $$
declare v_proposal jsonb; v_replacement jsonb; v_id uuid;
begin
	perform pg_temp.path_claims('authenticated','60700000-0000-4000-8000-000000000001');
	v_proposal := public.qorpera_prepare_company_file_proposal(current_setting('qorpera_test.fence_environment')::uuid,
		'60700000-0000-4000-8000-000000000040',current_setting('qorpera_test.fence_first')::uuid,repeat('c',64),128,3,1,4);
	v_replacement := public.qorpera_prepare_company_file_proposal(current_setting('qorpera_test.fence_environment')::uuid,
		'60700000-0000-4000-8000-000000000041',current_setting('qorpera_test.fence_second')::uuid,repeat('d',64),128,3,1,4);
	perform pg_temp.fence_verify((v_replacement ->> 'snapshot_id')::uuid,'d','60700000-0000-4000-8000-000000000042');
	-- A member's reviewed turn would submit it; the row is what that leaves.
	insert into public.qorpera_company_proposals(profile_id,environment_id,client_proposal_id,base_snapshot_id,proposal_snapshot_id,
		execution_kind,execution_id,execution_claimant_id,trail_end_sequence,reason,title,created_by_user_id)
	values (current_setting('qorpera_test.fence_profile')::uuid,current_setting('qorpera_test.fence_environment')::uuid,
		'60700000-0000-4000-8000-000000000043',current_setting('qorpera_test.fence_first')::uuid,(v_proposal ->> 'snapshot_id')::uuid,
		'turn','60700000-0000-4000-8000-000000000044','60700000-0000-4000-8000-000000000045',0,'conflict','Fence proposal',
		'60700000-0000-4000-8000-000000000001')
	returning id into v_id;
	perform set_config('qorpera_test.fence_proposal',v_id::text,false);
	perform set_config('qorpera_test.fence_proposed',v_proposal ->> 'snapshot_id',false);
	perform set_config('qorpera_test.fence_replacement',v_replacement ->> 'snapshot_id',false);
end $$;

-- 4. A rebase takes the fence after its proposal and before the Company File row (its new revision seeds the
--    proposal's review assignments, which need the profile row): while another connection holds the
--    company's profile row, it waits, where it used to go straight to the Company File row. Then it lands.
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_single(pg_temp.lock_row('qorpera_profiles', 'id', current_setting('qorpera_test.fence_profile')::uuid),
		format($q$select public.qorpera_rebase_company_proposal(%L, %L, %L, %L)$q$, current_setting('qorpera_test.fence_proposal'),
			current_setting('qorpera_test.fence_proposed'), current_setting('qorpera_test.fence_second'),
			current_setting('qorpera_test.fence_replacement')),
		pg_temp.fence_owner());
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true'
		and v_outcome #>> '{result,proposal_snapshot,snapshot_id}' = current_setting('qorpera_test.fence_replacement')
		and v_outcome #>> '{result,base_snapshot_id}' = current_setting('qorpera_test.fence_second'),
		'The rebase waits for the company''s profile row, then lands on the current head: ' || v_outcome::text);
end $$;

-- 5. The object gateway confirms an upload while the owner accepts the proposal: acceptance publishes it,
--    which locked the Company File row before the fence.
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.fence_hold(current_setting('qorpera_test.fence_profile')::uuid),
		pg_temp.fence_confirm('2'), '{"role":"service_role"}',
		format($q$select public.qorpera_accept_company_proposal(%L, %L)$q$, current_setting('qorpera_test.fence_proposal'),
			current_setting('qorpera_test.fence_replacement')),
		pg_temp.fence_owner());
	perform pg_temp.lock_race_ok(v_outcome, 'An upload confirmation and an accepted proposal');
	perform pg_temp.wake_assert(v_outcome #>> '{second,result,status}' = 'accepted'
		and pg_temp.fence_head(current_setting('qorpera_test.fence_environment')::uuid)::text = current_setting('qorpera_test.fence_replacement'),
		'The proposal is accepted and its revision is the head: ' || v_outcome::text);
end $$;

-- 6. The object gateway confirms one upload while it copies another, already confirmed, into the company's
--    Storage bucket. The quota trigger locked the Company File row; the replica guard, the next trigger,
--    then took the fence.
do $$
begin
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_confirm_profile_object_upload(current_setting('qorpera_test.fence_profile')::uuid,repeat('4',64),64,'nas-object-gateway');
end $$;
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_race(pg_temp.fence_hold(current_setting('qorpera_test.fence_profile')::uuid),
		pg_temp.fence_confirm('3'), '{"role":"service_role"}',
		format($q$insert into storage.objects(bucket_id, name, metadata, user_metadata) values ('qorpera-profile-objects', %L,
			'{"size":"64"}', '{"qorpera_nas_replica":true,"qorpera_nas_replica_bytes":64}') returning jsonb_build_object('name', name)$q$,
			current_setting('qorpera_test.fence_profile') || '/' || repeat('4', 64)),
		'{"role":"service_role"}');
	perform pg_temp.lock_race_ok(v_outcome, 'An upload confirmation and a replica copy');
	perform pg_temp.wake_assert(v_outcome #>> '{first,result,sha256}' = repeat('3',64)
		and exists (select 1 from storage.objects where bucket_id = 'qorpera-profile-objects'
			and name = current_setting('qorpera_test.fence_profile') || '/' || repeat('4', 64)),
		'The object is confirmed and the copy is stored: ' || v_outcome::text);
end $$;

-- 7. The fence waits until the caller may write: a viewer's save is refused without waiting for the
--    company's profile row, which another connection holds.
do $$
declare v_outcome jsonb;
begin
	v_outcome := pg_temp.lock_single(pg_temp.lock_row('qorpera_profiles', 'id', current_setting('qorpera_test.fence_profile')::uuid),
		format($q$select public.qorpera_prepare_company_file_revision(%L, '60700000-0000-4000-8000-000000000050', %L,
			repeat('e', 64), 128, 3, 1, 4)$q$, current_setting('qorpera_test.fence_environment'),
			pg_temp.fence_head(current_setting('qorpera_test.fence_environment')::uuid)),
		'{"role":"authenticated","sub":"60700000-0000-4000-8000-000000000002"}');
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = '42501',
		'A viewer is refused without taking the fence: ' || v_outcome::text);
end $$;

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
