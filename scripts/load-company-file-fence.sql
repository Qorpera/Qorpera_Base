-- Workers for scripts/load-company-file-fence.mjs. Run after 602's committed fixture (the path gateway company,
-- its agent's native binding, a coding worker with its machine, node and storage); each procedure commits
-- after every call, as separate API requests would, and records each call's latency and error.
create schema loadtest;
create table loadtest.config as select current_setting('qorpera_test.parent_binding')::jsonb as binding,
	'30000000-0000-4000-8000-000000000010'::uuid as profile_id, '30000000-0000-4000-8000-000000000020'::uuid as environment_id;
create table loadtest.latency (kind text, ms double precision, error text, at timestamptz default clock_timestamp());
-- An agent's tool call: company_path_actor (fence, then the Company File row) inside a list read.
create procedure loadtest.agent(p_n integer) language plpgsql as $$
declare t0 timestamptz; v_err text; c loadtest.config;
begin
	select * into c from loadtest.config;
	perform set_config('request.jwt.claims','{"role":"service_role"}',false);
	for i in 1..p_n loop
		t0 := clock_timestamp(); v_err := null;
		begin perform public.qorpera_list_company_paths_v2(c.environment_id,'',null,null,10,c.binding);
		exception when others then v_err := sqlstate || ' ' || left(sqlerrm, 80); end;
		insert into loadtest.latency(kind,ms,error) values ('agent',extract(epoch from clock_timestamp()-t0)*1000,v_err);
		commit;
	end loop;
end $$;
-- Supabase Storage's upload of a new object: the permission test (insert, rolled back), then the final
-- insert under the object's advisory lock, each its own transaction.
create procedure loadtest.storage(p_worker integer, p_n integer) language plpgsql as $$
declare t0 timestamptz; v_err text; v_name text; c loadtest.config;
begin
	select * into c from loadtest.config;
	perform set_config('request.jwt.claims','{"role":"service_role"}',false);
	for i in 1..p_n loop
		v_name := c.profile_id || '/' || encode(extensions.digest(p_worker || ':' || i || ':' || random()::text,'sha256'),'hex');
		t0 := clock_timestamp(); v_err := null;
		begin
			insert into storage.objects(bucket_id,name,metadata) values ('qorpera-profile-objects',v_name,'{"size":64}');
			raise exception using errcode = 'P0001', message = 'permission test';
		exception when sqlstate 'P0001' then null; when others then v_err := sqlstate || ' ' || left(sqlerrm, 80);
		end;
		commit;
		begin
			perform pg_advisory_xact_lock(hashtext('qorpera-profile-objects/' || v_name));
			insert into storage.objects(bucket_id,name,metadata) values ('qorpera-profile-objects',v_name,'{"size":64}');
		exception when others then v_err := coalesce(v_err, sqlstate || ' ' || left(sqlerrm, 80));
		end;
		commit;
		insert into loadtest.latency(kind,ms,error) values ('storage',extract(epoch from clock_timestamp()-t0)*1000,v_err);
		commit;
	end loop;
end $$;
-- The object gateway: confirm an object on the NAS (fence first), then copy it into Storage (replica).
create procedure loadtest.replica(p_n integer) language plpgsql as $$
declare t0 timestamptz; v_err text; v_sha text; c loadtest.config;
begin
	select * into c from loadtest.config;
	perform set_config('request.jwt.claims','{"role":"service_role"}',false);
	for i in 1..p_n loop
		v_sha := encode(extensions.digest('replica:' || i || ':' || random()::text,'sha256'),'hex');
		t0 := clock_timestamp(); v_err := null;
		begin perform public.qorpera_confirm_profile_object_upload(c.profile_id,v_sha,64,'nas-object-gateway');
		exception when others then v_err := sqlstate || ' ' || left(sqlerrm, 80); end;
		commit;
		begin
			perform pg_advisory_xact_lock(hashtext('qorpera-profile-objects/' || v_sha));
			insert into storage.objects(bucket_id,name,metadata,user_metadata) values ('qorpera-profile-objects',c.profile_id || '/' || v_sha,
				'{"size":"64"}','{"qorpera_nas_replica":true,"qorpera_nas_replica_bytes":64}');
		exception when others then v_err := coalesce(v_err, sqlstate || ' ' || left(sqlerrm, 80));
		end;
		commit;
		insert into loadtest.latency(kind,ms,error) values ('replica',extract(epoch from clock_timestamp()-t0)*1000,v_err);
		commit;
	end loop;
end $$;
-- A node agent's inventory observation.
create procedure loadtest.observer(p_n integer) language plpgsql as $$
declare t0 timestamptz; v_err text;
begin
	perform set_config('request.jwt.claims','{"role":"service_role"}',false);
	for i in 1..p_n loop
		t0 := clock_timestamp(); v_err := null;
		begin
			perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
				'nodeId','30000000-0000-4000-8000-000000000310','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
				'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'cpuMillis',6000,'memoryBytes',8589934592,'state','ready'),
				public.qorpera_runtime_node_inventory_context('30000000-0000-4000-8000-000000000310') ->> 'contextSha256',
				jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries','[]'::jsonb));
		exception when others then v_err := sqlstate || ' ' || left(sqlerrm, 80); end;
		insert into loadtest.latency(kind,ms,error) values ('observer',extract(epoch from clock_timestamp()-t0)*1000,v_err);
		commit;
		perform pg_sleep(0.3);
	end loop;
end $$;
create table loadtest.coding as select (select id from public.qorpera_runtime_workers where worker_key = 'fix-send') as worker_id,
	current_setting('qorpera_test.coding_claim')::jsonb ->> 'leaseToken' as first_lease, current_setting('qorpera_test.coding_binding') as binding,
	current_setting('qorpera_test.coding_storage')::jsonb as storage, current_setting('qorpera_test.coding_vm') as vm;
-- A coding session's turns, as the executor and the owner drive them: answer, claim, machine admission (fence first),
-- begin (the profile row NOWAIT; the executor begins again), complete.
create procedure loadtest.coding(p_n integer) language plpgsql as $$
declare c loadtest.coding; t0 timestamptz; v_err text; v_lease uuid; v_step text; v_claim jsonb; v_seq integer; v_tries integer;
begin
	select * into c from loadtest.coding;
	perform set_config('request.jwt.claims','{"role":"service_role"}',false);
	begin perform public.qorpera_complete_coding_turn(c.worker_id, c.first_lease::uuid, 'succeeded', 'Fixture turn done.');
	exception when others then insert into loadtest.latency(kind,ms,error) values ('coding-first',0,sqlstate || ' ' || left(sqlerrm,80)); end;
	commit;
	for i in 1..p_n loop
		t0 := clock_timestamp(); v_err := null;
		begin
			v_step := 'answer';
			perform set_config('request.jwt.claims','{"role":"authenticated","sub":"30000000-0000-4000-8000-000000000001"}',false);
			perform public.qorpera_answer_coding_session(c.worker_id, 'Next change ' || i, extensions.gen_random_uuid());
		exception when others then v_err := v_step || ' ' || sqlstate || ' ' || left(sqlerrm,80); end;
		perform set_config('request.jwt.claims','{"role":"service_role"}',false);
		commit;
		if v_err is null then begin
			v_step := 'claim';
			v_claim := public.qorpera_claim_coding_session('exec-test', 300);
			v_lease := (v_claim ->> 'leaseToken')::uuid;
			if v_lease is null then raise exception 'nothing to claim: %', v_claim; end if;
		exception when others then v_err := v_step || ' ' || sqlstate || ' ' || left(sqlerrm,80); end; commit; end if;
		if v_err is null then begin
			v_step := 'admit';
			perform public.qorpera_authorize_coding_machine_run(c.worker_id, v_lease, c.binding,
				c.storage || jsonb_build_object('volumeId', c.worker_id, 'workerId', c.worker_id), repeat('c',64));
		exception when others then v_err := v_step || ' ' || sqlstate || ' ' || left(sqlerrm,80); end; commit; end if;
		if v_err is null then
			v_tries := 0;
			loop
				v_tries := v_tries + 1; v_err := null;
				begin
					v_step := 'begin';
					select sequence into v_seq from public.qorpera_runtime_workers where id = c.worker_id;
					perform public.qorpera_begin_coding_turn(c.worker_id, v_lease,
						jsonb_build_object('vmId', c.vm, 'turnId', public.qorpera_coding_turn_id(c.worker_id, v_seq)));
				exception when others then v_err := v_step || ' ' || sqlstate || ' ' || left(sqlerrm,80); end;
				commit;
				exit when v_err is null or v_err not like '%55P03%' or v_tries >= 40;
				perform pg_sleep(0.05);
			end loop;
			insert into loadtest.latency(kind,ms,error) values ('coding-begin-tries',v_tries,null); commit;
		end if;
		if v_err is null or v_step = 'begin' then begin
			v_step := 'complete';
			perform public.qorpera_complete_coding_turn(c.worker_id, v_lease, 'succeeded', 'Change ' || i || ' done.');
		exception when others then v_err := v_step || ' ' || sqlstate || ' ' || left(sqlerrm,80); end; commit; end if;
		insert into loadtest.latency(kind,ms,error) values ('coding',extract(epoch from clock_timestamp()-t0)*1000,v_err);
		commit;
	end loop;
end $$;
