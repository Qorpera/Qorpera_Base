-- Wake arbitration (20260819012000): one deterministic key per wake
-- occurrence, claimed exactly once; expired leases are dead executors,
-- completed claims never run again, and the surface is members-only.

insert into auth.users (id, email, email_confirmed_at)
values
	('b0000000-0000-4000-8000-0000000000ba', 'wake-owner@example.test', statement_timestamp()),
	('b0000000-0000-4000-8000-0000000000bb', 'wake-contributor@example.test', statement_timestamp()),
	('b0000000-0000-4000-8000-0000000000bc', 'wake-outsider@example.test', statement_timestamp());

select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000ba","email":"wake-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.wk_profile',
	public.qorpera_create_hosted_profile('Wake Arbiter QA', 'main', 1) ->> 'profile_id', false);
reset role;
select set_config('request.jwt.claims', '', false);

select set_config('qorpera_test.wk_environment',
	(select environment.id::text from public.qorpera_company_environments as environment
	where environment.profile_id = current_setting('qorpera_test.wk_profile')::uuid limit 1), false);

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (current_setting('qorpera_test.wk_profile')::uuid,
	'b0000000-0000-4000-8000-0000000000bb', 'wake-contributor@example.test', 'Contributor', 'contributor');

-- A non-member must not reach the wake surface at all.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000bc","email":"wake-outsider@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare v_ok boolean := false;
begin
	begin
		perform public.qorpera_claim_wake(
			current_setting('qorpera_test.wk_environment')::uuid,
			'job:demo:slot:1', 'c1000000-0000-4000-8000-000000000001', 300);
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'non-member claimed a wake'; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- The race: machine A (owner) and machine B (contributor) both find the same
-- occurrence due. Exactly one claim succeeds; the loser sees in-flight.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000ba","email":"wake-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.wk_claim_a',
	public.qorpera_claim_wake(
		current_setting('qorpera_test.wk_environment')::uuid,
		'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000a', 300)::text, false);
reset role;

select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000bb","email":"wake-contributor@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.wk_claim_b',
	public.qorpera_claim_wake(
		current_setting('qorpera_test.wk_environment')::uuid,
		'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000b', 300)::text, false);
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare
	v_a jsonb := current_setting('qorpera_test.wk_claim_a')::jsonb;
	v_b jsonb := current_setting('qorpera_test.wk_claim_b')::jsonb;
begin
	if (v_a ->> 'claimed')::boolean is distinct from true then
		raise exception 'first machine did not win the claim';
	end if;
	if (v_b ->> 'claimed')::boolean is distinct from false or v_b ->> 'reason' is distinct from 'in-flight' then
		raise exception 'second machine did not lose as in-flight: %', v_b;
	end if;
end
$$;

-- The holder re-claims idempotently (retry after a failed spawn), completes,
-- and from then on every machine loses as already-run — renewal included.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000ba","email":"wake-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare
	v_env uuid := current_setting('qorpera_test.wk_environment')::uuid;
	v_result jsonb;
begin
	v_result := public.qorpera_claim_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000a', 300);
	if (v_result ->> 'claimed')::boolean is distinct from true then
		raise exception 'holder re-claim was not idempotent: %', v_result;
	end if;
	v_result := public.qorpera_renew_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000a', 300);
	if (v_result ->> 'renewed')::integer <> 1 then
		raise exception 'holder renewal did not renew: %', v_result;
	end if;
	v_result := public.qorpera_renew_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000b', 300);
	if (v_result ->> 'renewed')::integer <> 0 then
		raise exception 'a non-holder renewed the lease: %', v_result;
	end if;
	v_result := public.qorpera_complete_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000b');
	if (v_result ->> 'completed')::integer <> 0 then
		raise exception 'a non-holder completed the wake: %', v_result;
	end if;
	v_result := public.qorpera_complete_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000a');
	if (v_result ->> 'completed')::integer <> 1 then
		raise exception 'holder completion did not complete: %', v_result;
	end if;
	v_result := public.qorpera_claim_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000b', 300);
	if (v_result ->> 'claimed')::boolean is distinct from false or v_result ->> 'reason' is distinct from 'already-run' then
		raise exception 'completed wake was claimable again: %', v_result;
	end if;
	v_result := public.qorpera_renew_wake(v_env, 'job:demo:slot:1', 'c1000000-0000-4000-8000-00000000000a', 300);
	if (v_result ->> 'renewed')::integer <> 0 then
		raise exception 'completed wake lease was renewable: %', v_result;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

-- Dead executor: machine A claims a second occurrence and dies (the lease is
-- forced into the past); machine B's claim takes the occurrence over.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000ba","email":"wake-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_claim_wake(
	current_setting('qorpera_test.wk_environment')::uuid,
	'job:demo:slot:2', 'c1000000-0000-4000-8000-00000000000a', 300);
reset role;
select set_config('request.jwt.claims', '', false);

update public.qorpera_wake_claims
set claim_expires_at = statement_timestamp() - interval '1 second'
where profile_id = current_setting('qorpera_test.wk_profile')::uuid
	and wake_key = 'job:demo:slot:2';

select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000bb","email":"wake-contributor@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare v_result jsonb;
begin
	v_result := public.qorpera_claim_wake(
		current_setting('qorpera_test.wk_environment')::uuid,
		'job:demo:slot:2', 'c1000000-0000-4000-8000-00000000000b', 300);
	if (v_result ->> 'claimed')::boolean is distinct from true then
		raise exception 'expired claim was not taken over: %', v_result;
	end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare v_claimant uuid;
begin
	select claimant_id into v_claimant from public.qorpera_wake_claims
	where profile_id = current_setting('qorpera_test.wk_profile')::uuid
		and wake_key = 'job:demo:slot:2';
	if v_claimant is distinct from 'c1000000-0000-4000-8000-00000000000b' then
		raise exception 'takeover did not transfer the claim';
	end if;
end
$$;

-- Retention: a claim completed long ago is swept by the next claim call.
insert into public.qorpera_wake_claims (profile_id, wake_key, claimant_id, claimed_at, claim_expires_at, completed_at)
values (current_setting('qorpera_test.wk_profile')::uuid, 'job:demo:ancient',
	'c1000000-0000-4000-8000-00000000000a',
	statement_timestamp() - interval '40 days',
	statement_timestamp() - interval '40 days',
	statement_timestamp() - interval '40 days');

select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-0000000000ba","email":"wake-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select public.qorpera_claim_wake(
	current_setting('qorpera_test.wk_environment')::uuid,
	'job:demo:slot:3', 'c1000000-0000-4000-8000-00000000000a', 300);
reset role;
select set_config('request.jwt.claims', '', false);

do $$
declare v_seen integer;
begin
	select count(*) into v_seen from public.qorpera_wake_claims
	where profile_id = current_setting('qorpera_test.wk_profile')::uuid
		and wake_key = 'job:demo:ancient';
	if v_seen <> 0 then raise exception 'ancient completed claim survived retention'; end if;
end
$$;
