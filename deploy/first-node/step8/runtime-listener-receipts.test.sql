begin;
select step8_test.restore();

-- This metadata shape is the verified ingress output, covered separately by
-- the raw GitHub HMAC/normalization fixture tests. No webhook secret is in SQL.
create function step8_test.external_delivery(p_guid uuid,p_key text,p_action text,p_updated timestamptz,p_received timestamptz)
returns jsonb language plpgsql as $$
declare routine uuid := (select (value ->> 'routine_id')::uuid from step8_test.saved where key='external-routine');
	s public.qorpera_step8_routine_state%rowtype;
begin
	select * into strict s from public.qorpera_step8_routine_state where routine_id=routine;
	return jsonb_build_object('schema','qorpera.github-delivery/v1','routineId',routine,'version',s.routine_version,'epoch',s.epoch,'triggerId','github-pr',
		'connectionId','80000000-0000-4000-8000-000000000002','deliveryId',p_guid,
		'bodySha256',encode(extensions.digest(convert_to(p_key || ':bytes','utf8'),'sha256'),'hex'),
		'eventKey',encode(extensions.digest(convert_to(p_key || ':canonical','utf8'),'sha256'),'hex'),'receivedAt',step8_test.instant(p_received),
		'event',jsonb_build_object('schema','qorpera.github-event/v1','source','github','trust','external','event',
			case p_action when 'edited' then 'pull_request.updated' else 'pull_request.opened' end,'action',p_action,'installationId','987654','repositoryId','1296269',
			'pullRequestId','12000001','number',42,'senderId','123456','updatedAt',step8_test.instant(p_updated),'headSha',repeat('a',40),'reviewTarget',null));
end $$;

create function step8_test.external_state(p_routine uuid)
returns jsonb language sql as $$
	select jsonb_build_object(
		'state',(select to_jsonb(s) from public.qorpera_step8_routine_state s where routine_id=p_routine),
		'events',(select jsonb_agg(to_jsonb(e) order by event_key) from public.qorpera_step8_external_events e where routine_id=p_routine),
		'deliveries',(select jsonb_agg(to_jsonb(d) order by delivery_id) from public.qorpera_step8_external_deliveries d where routine_id=p_routine),
		'watermarks',(select jsonb_agg(to_jsonb(w) order by routine_version,epoch,resource_id) from public.qorpera_step8_external_watermarks w where routine_id=p_routine),
		'wakes',(select jsonb_agg(to_jsonb(w) order by id) from public.qorpera_wake_occurrences w where routine_id=p_routine));
$$;

-- Called in rolled-back transactions before and after the harness restarts
-- PostgreSQL. Only real ignored/duplicate receipts are used; authority stays closed.
create function step8_test.assert_external_envelope(p_instants jsonb)
returns void language plpgsql as $$
declare at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '1 minute';
	routine uuid; known jsonb; fresh jsonb; delivery jsonb; invalid jsonb; value jsonb; field text; path text[];
	before_state jsonb; candidate jsonb;
begin
	known := step8_test.external_delivery(extensions.gen_random_uuid(),'typed-known','edited',at,at);
	fresh := step8_test.external_delivery(extensions.gen_random_uuid(),'typed-fresh','edited',at+interval '1 second',at+interval '1 second');
	-- All-digit hashes remain valid strings. Casting these exact values to JSON
	-- numbers reproduces the old ->> coercion on both new and known event keys.
	known := jsonb_set(known || jsonb_build_object('bodySha256','1' || repeat('0',63),'eventKey','1' || repeat('0',63)),
		'{event,headSha}',to_jsonb('1' || repeat('0',39)));
	fresh := jsonb_set(fresh || jsonb_build_object('bodySha256','2' || repeat('0',63),'eventKey','2' || repeat('0',63)),
		'{event,headSha}',to_jsonb('2' || repeat('0',39)));
	routine := (known ->> 'routineId')::uuid;
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github(known) ->> 'status'='ignored','Valid all-digit string hashes reach a durable policy decision');
	before_state := step8_test.external_state(routine);
	foreach field in array array['bodySha256','eventKey','headSha'] loop
		path := case when field='headSha' then array['event','headSha'] else array[field] end;
		foreach delivery in array array[fresh,known] loop
			for value in select jsonb_array_elements(jsonb_build_array(
				to_jsonb((delivery #>> path)::numeric),'null'::jsonb,'true'::jsonb,'[]'::jsonb,
				jsonb_build_array(delivery #> path),'{}'::jsonb,'""'::jsonb,
				to_jsonb((delivery #>> path) || '0'),to_jsonb(repeat('g',length(delivery #>> path))))) loop
				invalid := jsonb_set(delivery,path,value) || jsonb_build_object('deliveryId',extensions.gen_random_uuid());
				perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',invalid),'22023');
			end loop;
			perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',delivery #- path),'22023');
		end loop;
	end loop;
	-- Run the epoch predecessor first so the lower-bound regression is explicit.
	for value in select item -> 'value' from jsonb_array_elements(p_instants) item
		where not (item ->> 'valid')::boolean order by (item ->> 'name'='before epoch') desc loop
		foreach delivery in array array[fresh,known] loop
			invalid := jsonb_set(delivery,'{receivedAt}',value) || jsonb_build_object('deliveryId',extensions.gen_random_uuid());
			perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',invalid),'22023');
		end loop;
	end loop;
	foreach delivery in array array[fresh,known] loop
		perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',delivery-'receivedAt'),'22023');
		perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',jsonb_set(delivery,'{receivedAt}','false')),'22023');
		invalid := delivery || jsonb_build_object('receivedAt',step8_test.instant(clock_timestamp()+interval '1 hour'));
		perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',invalid),'22023');
	end loop;
	perform step8_test.wake_assert(step8_test.external_state(routine)=before_state,'Malformed envelopes leave all state, clocks, receipt ledgers and queue unchanged');
	for value in select item -> 'value' from jsonb_array_elements(p_instants) item where (item ->> 'valid')::boolean loop
		candidate := jsonb_set(fresh,'{receivedAt}',value) || jsonb_build_object('deliveryId',extensions.gen_random_uuid(),
			'eventKey',encode(extensions.digest(convert_to('valid-clock:' || value::text,'utf8'),'sha256'),'hex'));
		if (value #>> '{}')::timestamptz > clock_timestamp() then
			perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',candidate),'22023');
		else
			perform step8_test.wake_assert(public.qorpera_step8_ingest_github(candidate) ->> 'status'='ignored','Canonical old receipt times, including the exact epoch, receive policy decisions');
			candidate := candidate || jsonb_build_object('deliveryId',extensions.gen_random_uuid());
			perform step8_test.wake_assert(public.qorpera_step8_ingest_github(candidate) ->> 'status'='duplicate','Canonical old receipt times replay their durable decisions');
		end if;
	end loop;
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github(known) ->> 'status'='duplicate','Valid numeric-only string hashes still replay after invalid inputs');
end $$;

savepoint normalized_event_validation;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid := (select (value ->> 'routine_id')::uuid from step8_test.saved where key='external-routine');
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '1 hour'; known jsonb; fresh jsonb; delivery jsonb; invalid jsonb;
	patch jsonb; value jsonb; field text; state_before jsonb; watermark_before jsonb;
begin
	perform step8_test.publish(routine,p,'active',at);
	known := step8_test.external_delivery(extensions.gen_random_uuid(),'validation-known','edited',at+interval '10 minutes',at+interval '11 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github(known) ->> 'status'='ignored','Valid unselected event keeps a durable receipt');
	fresh := step8_test.external_delivery(extensions.gen_random_uuid(),'validation-fresh','opened',at+interval '30 minutes',at+interval '31 minutes');
	select to_jsonb(s) into state_before from public.qorpera_step8_routine_state s where routine_id=routine;
	select to_jsonb(w) into watermark_before from public.qorpera_step8_external_watermarks w where routine_id=routine;
	-- Both null fields used to compare equal through the CASE expression. A
	-- malformed fresh event then poisoned ordering; a malformed duplicate also
	-- advanced the trusted clock. Reject both before either receipt path.
	for patch in select jsonb_array_elements('[
		{"action":null,"event":null},
		{"action":"unknown","event":null},
		{"action":"opened","event":"pull_request.updated"},
		{"action":"closed","event":"pull_request.opened"},
		{"action":"review_requested","event":"pull_request.review_requested","reviewTarget":null}
	]'::jsonb) loop
		foreach delivery in array array[fresh,known] loop
			invalid := jsonb_set(delivery,'{event}',(delivery -> 'event') || patch);
			perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',invalid),'22023');
		end loop;
	end loop;
	foreach field in array array['action','event'] loop
		for value in select jsonb_array_elements('[null,true,1,{},[],["opened"],[["opened"]],["pull_request.opened"],"","unsupported"]'::jsonb) loop
			foreach delivery in array array[fresh,known] loop
				invalid := jsonb_set(delivery,array['event',field],value);
				perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',invalid),'22023');
			end loop;
		end loop;
		foreach delivery in array array[fresh,known] loop
			invalid := jsonb_set(delivery,'{event}',(delivery -> 'event')-field);
			perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',invalid),'22023');
		end loop;
	end loop;
	perform step8_test.wake_assert((select to_jsonb(s)=state_before from public.qorpera_step8_routine_state s where routine_id=routine),'Malformed events leave the complete policy state and trusted clock unchanged');
	perform step8_test.wake_assert((select to_jsonb(w)=watermark_before from public.qorpera_step8_external_watermarks w where routine_id=routine),'Malformed events leave the resource watermark unchanged');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_external_events where routine_id=routine),'Malformed events cannot create terminal event rows');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_external_deliveries where routine_id=routine),'Malformed events cannot create delivery receipts');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'Malformed events cannot create wakes');
	begin
		perform public.qorpera_step8_ingest_github(fresh);
		raise exception 'Valid selected event was discarded after malformed input';
	exception when sqlstate '55000' then
		perform step8_test.wake_assert(sqlerrm='Step 7 GitHub eligibility adapter is unavailable','Valid event still reaches unchanged authority gate');
	end;
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github(known) ->> 'status'='duplicate','Valid receipt replay still works');
end $$;
rollback to normalized_event_validation;

savepoint null_listener_bindings;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid := (select (value ->> 'routine_id')::uuid from step8_test.saved where key='external-routine');
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '2 hours'; d jsonb; field text;
begin
	perform step8_test.publish(routine,p,'active',at);
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'null-binding','edited',at+interval '5 minutes',at+interval '6 minutes');
	perform step8_test.publish(routine,p,'paused',at);
	perform step8_test.publish(routine,p,'active',at);
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',d),'40001');
	foreach field in array array['epoch','version'] loop
		perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',jsonb_set(d,array[field],'null')),'22023');
		perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',d-field),'22023');
	end loop;
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_step8_external_events where routine_id=routine),'Invalid listener binding has no receipt');
	perform step8_test.wake_assert((select epoch=3 and observed_through=at from public.qorpera_step8_routine_state where routine_id=routine),'Invalid listener binding cannot observe a new clock');
end $$;
rollback to null_listener_bindings;

savepoint listener_clock_rollback;
do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid := (select (value ->> 'routine_id')::uuid from step8_test.saved where key='external-routine');
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '2 hours'; d jsonb; first_delivery jsonb; before_count integer;
begin
	perform step8_test.publish(routine,p,'active',at);
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'clock-first','edited',at+interval '40 minutes',at+interval '41 minutes');
	first_delivery := d;
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '41 minutes') ->> 'status'='ignored','Unselected event is a terminal clock observation');
	perform step8_test.wake_assert((select observed_through=at+interval '41 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Listener retains its observed cloud clock');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '42 minutes 0.000999 seconds') ->> 'status'='duplicate','Duplicate delivery also observes the cloud clock');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '41 minutes 30 seconds') ->> 'status'='duplicate','Receipt replay remains valid during clock rollback');
	perform step8_test.wake_assert((select active_since=at and observed_through=at+interval '42 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Duplicate clock observation is monotone and millisecond canonical');
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'clock-future-provider','edited',at+interval '60 minutes',at+interval '43 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '43 minutes') ->> 'status'='ignored','Future provider timestamp is ignored');
	perform step8_test.wake_assert((select observed_through=at+interval '43 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Provider timestamp cannot move the cloud clock fence');
	perform step8_test.wake_assert((select updated_at=at+interval '40 minutes' from public.qorpera_step8_external_watermarks where routine_id=routine),'Future provider timestamp cannot move the resource watermark');
	d := jsonb_set(step8_test.external_delivery(extensions.gen_random_uuid(),'clock-regressed','opened',at+interval '30 minutes',at+interval '31 minutes'),'{event,pullRequestId}','"12000002"');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '31 minutes') ->> 'status'='ignored','Clock regression cannot admit a distinct resource in the same epoch');
	perform step8_test.wake_assert((select observed_through=at+interval '43 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Clock regression cannot rewind the fence');
	perform step8_test.publish(routine,p,'paused',at+interval '10 minutes');
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'clock-paused','edited',at+interval '44 minutes',at+interval '45 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '45 minutes') ->> 'status'='ignored','Paused delivery is still a terminal clock observation');
	perform step8_test.publish(routine,p,'active',at+interval '11 minutes');
	perform step8_test.wake_assert((select epoch=3 and active_since=at+interval '45 minutes' and observed_through=at+interval '45 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Resume stays after the latest durable cloud observation');
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'clock-old-after-resume','opened',at+interval '20 minutes',at+interval '21 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '21 minutes') ->> 'status'='ignored','Older work cannot reopen after rollback and resume');
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'clock-resume-boundary','opened',at+interval '45 minutes',at+interval '45 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '45 minutes') ->> 'status'='ignored','Future-only activation excludes its exact boundary');
	select count(*) into before_count from public.qorpera_step8_external_events where routine_id=routine;
	d := step8_test.external_delivery(extensions.gen_random_uuid(),'clock-after-boundary','opened',at+interval '45 minutes 0.001 seconds',at+interval '45 minutes 0.001 seconds');
	begin
		perform public.qorpera_step8_ingest_github_at(d,at+interval '45 minutes 0.001 seconds');
		raise exception 'Eligible future event did not reach the closed authority gate';
	exception when sqlstate '55000' then
		perform step8_test.wake_assert(sqlerrm='Step 7 GitHub eligibility adapter is unavailable','Future event reaches the real closed authority hook');
	end;
	perform step8_test.wake_assert((select observed_through=at+interval '45 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Missing authority rolls back the new clock observation');
	perform step8_test.wake_assert((select count(*)=before_count from public.qorpera_step8_external_events where routine_id=routine),'Missing authority rolls back the new receipt');
	first_delivery := first_delivery || '{"epoch":3,"receivedAt":null}';
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',first_delivery,at+interval '50 minutes'),'22023');
	perform step8_test.wake_assert((select observed_through=at+interval '45 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Malformed duplicate cannot advance the clock');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'Closed authority is never replaced by a test stub');
end $$;
rollback to listener_clock_rollback;

do $$
declare p jsonb := (select value from step8_test.saved where key='policy'); routine uuid := (select (value ->> 'routine_id')::uuid from step8_test.saved where key='external-routine');
	at timestamptz := date_trunc('milliseconds',clock_timestamp())-interval '1 hour'; d jsonb; first_delivery jsonb; result jsonb; before_count integer;
begin
	p := p || jsonb_build_object('expiresAt',step8_test.instant(at+interval '45 minutes'));
	perform step8_test.publish(routine,p,'active',at);
	-- An unsupported action is a terminal ignored receipt, not a second queue.
	d := step8_test.external_delivery('72d3162e-cc78-11e3-81ab-4c9367dc0958','first','edited',at+interval '10 minutes',at+interval '11 minutes');
	first_delivery := d;
	result := public.qorpera_step8_ingest_github_at(d,at+interval '11 minutes');
	perform step8_test.wake_assert(result ->> 'status'='ignored' and result -> 'occurrenceId'='null'::jsonb,'Unsupported action records a terminal decision');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '12 minutes') ->> 'status'='duplicate','Duplicate GUID and body');
	d := d || jsonb_build_object('deliveryId','72d3162e-cc78-11e3-81ab-4c9367dc0959','bodySha256',repeat('b',64));
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '12 minutes') ->> 'status'='duplicate','New unsigned GUID and serialized bytes retain canonical event identity');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_external_events where routine_id=routine),'One canonical event');
	perform step8_test.wake_assert((select count(*)=2 from public.qorpera_step8_external_deliveries where routine_id=routine),'Distinct delivery receipts refer to same event');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',first_delivery || jsonb_build_object('bodySha256',repeat('f',64)),at+interval '12 minutes'),'23505');
	-- An older eligible action is dropped by the explicit reorder policy.
	d := step8_test.external_delivery('72d3162e-cc78-11e3-81ab-4c9367dc0960','older','opened',at+interval '9 minutes',at+interval '12 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '12 minutes') ->> 'status'='ignored','Out-of-order older delivery cannot advance work');
	select count(*) into before_count from public.qorpera_step8_external_events;
	-- Equal timestamps are not identities. Both equal-time and newer distinct
	-- events reach the missing Step 7 gate and roll back completely.
	d := step8_test.external_delivery('72d3162e-cc78-11e3-81ab-4c9367dc0961','equal','opened',at+interval '10 minutes',at+interval '12 minutes');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',d,at+interval '12 minutes'),'55000');
	d := step8_test.external_delivery('72d3162e-cc78-11e3-81ab-4c9367dc0962','newer','opened',at+interval '11 minutes',at+interval '12 minutes');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',d,at+interval '12 minutes'),'55000');
	perform step8_test.wake_error(format('select public.qorpera_step8_admit_github_wake(%L)',d),'55000');
	perform step8_test.wake_assert((select count(*)=before_count from public.qorpera_step8_external_events),'Missing adapters cannot commit a partial receipt');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'Closed external gate creates no execution');
	perform step8_test.wake_assert((select updated_at=at+interval '10 minutes' from public.qorpera_step8_external_watermarks where routine_id=routine),'Missing adapters cannot advance the watermark');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',jsonb_set(d,'{event,number}','-1'),at+interval '12 minutes'),'22023');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',jsonb_set(d,'{event,reviewTarget}','"user:123"'),at+interval '12 minutes'),'22023');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github_at(%L,%L)',d || '{"epoch":99}',at+interval '12 minutes'),'40001');
	perform step8_test.wake_assert(public.qorpera_step8_expire_at(routine,1,1,at+interval '45 minutes'),'Listener expiry uses existing reconciliation lane');
	d := step8_test.external_delivery('72d3162e-cc78-11e3-81ab-4c9367dc0963','expired','opened',at+interval '44 minutes',at+interval '44 minutes');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,at+interval '44 minutes') ->> 'status'='ignored','Backward clock cannot revive an expired listener');
	-- Identical retired/expired delivery replay is a receipt only, never a wake.
	insert into step8_test.saved(key,value) values('external-replay',first_delivery),('external-concurrent',step8_test.external_delivery(
		'72d3162e-cc78-11e3-81ab-4c9367dc0964','concurrent','edited',at+interval '46 minutes',at+interval '47 minutes'));
	insert into step8_test.saved(key,value) select 'external-clock-before-concurrency',to_jsonb(step8_test.instant(observed_through))
		from public.qorpera_step8_routine_state where routine_id=routine;
end $$;

create function step8_test.concurrent_external(p_clock_offset interval default interval '0 minutes')
returns jsonb language plpgsql as $$
declare d jsonb := (select value from step8_test.saved where key='external-concurrent');
begin return public.qorpera_step8_ingest_github_at(d,(d ->> 'receivedAt')::timestamptz+p_clock_offset); end $$;

create function step8_test.assert_external_crash_rolled_back()
returns void language plpgsql as $$
declare d jsonb := (select value from step8_test.saved where key='external-concurrent');
	observed timestamptz := (select (value #>> '{}')::timestamptz from step8_test.saved where key='external-clock-before-concurrency');
begin
	perform step8_test.wake_assert((select observed_through=observed from public.qorpera_step8_routine_state where routine_id=(d ->> 'routineId')::uuid),'Interrupted ingestion rolls back the cloud clock');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_step8_external_events where routine_id=(d ->> 'routineId')::uuid and event_key=d ->> 'eventKey'),'Interrupted ingestion rolls back the event');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_step8_external_deliveries where routine_id=(d ->> 'routineId')::uuid and delivery_id=(d ->> 'deliveryId')::uuid),'Interrupted ingestion rolls back the delivery receipt');
end $$;

create function step8_test.assert_external_restart()
returns void language plpgsql as $$
declare d jsonb := (select value from step8_test.saved where key='external-replay');
	concurrent jsonb := (select value from step8_test.saved where key='external-concurrent');
	routine uuid := (d ->> 'routineId')::uuid; observed timestamptz; p jsonb;
begin
	perform step8_test.wake_assert((select observed_through=(concurrent ->> 'receivedAt')::timestamptz+interval '10 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Restart retains the maximum concurrent clock sample');
	perform step8_test.wake_assert(step8_test.concurrent_external() ->> 'status'='duplicate','Earlier duplicate clock after restart remains a receipt replay');
	perform step8_test.wake_assert((select observed_through=(concurrent ->> 'receivedAt')::timestamptz+interval '10 minutes' from public.qorpera_step8_routine_state where routine_id=routine),'Earlier duplicate after restart cannot rewind the fence');
	perform step8_test.wake_error(format('select public.qorpera_step8_ingest_github(%L)',d || '{"epoch":null}'),'22023');
	perform step8_test.wake_assert(public.qorpera_step8_ingest_github_at(d,clock_timestamp()) ->> 'status'='duplicate','Delivery dedup survives process restart');
	perform step8_test.wake_assert((select count(*)=1 from public.qorpera_step8_external_deliveries where routine_id=routine and delivery_id=(concurrent ->> 'deliveryId')::uuid),'Concurrent external delivery has one durable receipt');
	select observed_through into strict observed from public.qorpera_step8_routine_state where routine_id=routine;
	select policy into strict p from public.qorpera_step8_routine_policies where routine_id=routine and routine_version=1;
	perform step8_test.restore();
	perform step8_test.publish(routine,p,'paused',observed-interval '20 minutes');
	perform step8_test.publish(routine,p,'active',observed-interval '19 minutes');
	perform step8_test.wake_assert((select epoch=3 and active_since=observed and observed_through=observed from public.qorpera_step8_routine_state where routine_id=routine),'Restart and rollback resume retain the durable clock fence');
	perform step8_test.wake_assert(not exists(select 1 from public.qorpera_wake_occurrences where routine_id=routine),'No closed-gate wake after restart');
end $$;
commit;
