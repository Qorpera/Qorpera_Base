-- @fixture 164_native_account_usage_wall_identity.test.sql until "set constraints all immediate;"
-- Recovery from a usage wall on folder-v2 (ported from snapshot-v1 in the legacy sweep; 20260920016000). The original
-- credential has rotated to account B. Its old account A wall must still cover duplicate A, and only current, scoped
-- evidence can clear it.
do $$
declare original_id uuid := (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid;
	duplicate_id uuid; observed timestamptz := statement_timestamp(); usage jsonb; invalid_usage jsonb;
begin
	select m.connection_id into strict duplicate_id
	from public.qorpera_native_provider_account_metadata m
	join public.qorpera_provider_connections c on c.id = m.connection_id
	where c.profile_id = '92400000-0000-4000-8000-000000000010'
	  and c.owner_user_id = '92400000-0000-4000-8000-000000000001'
	  and m.provider_account_identity = repeat('a',64) and m.connection_id <> original_id;
	update public.qorpera_provider_connection_usage_signals
	set resets_at = null,observed_at = observed - interval '2 minutes'
	where provider_connection_id = original_id;
	usage := jsonb_build_object('observedAt',observed - interval '1 second','windows',jsonb_build_array(
		jsonb_build_object('id','primary','label','5 hours','usedPercent',20)));
	-- This positive historical version is no longer authoritative, even though
	-- its account hash still matches A. Other members/companies also have A.
	update public.qorpera_native_provider_account_metadata set provider_account_usage = usage
	where connection_id = original_id and connection_version = 2;
	for invalid_usage in select value from jsonb_array_elements(jsonb_build_array(
		null,
		jsonb_set(usage,'{observedAt}',to_jsonb(observed - interval '6 minutes')),
		jsonb_set(usage,'{observedAt}',to_jsonb(observed - interval '3 minutes')),
		jsonb_set(usage,'{observedAt}',to_jsonb(observed + interval '1 second')),
		jsonb_set(usage,'{windows}','[]'),
		jsonb_set(usage,'{windows,0,usedPercent}','100'),
		jsonb_set(usage,'{windows,0,resetAt}',to_jsonb(observed - interval '1 second')),
		jsonb_set(usage,'{windows}',(usage -> 'windows') || jsonb_build_array(
			jsonb_build_object('id','secondary','label','Week','usedPercent',100)))
	)) loop
		update public.qorpera_native_provider_account_metadata
		set provider_account_usage = nullif(invalid_usage,'null'::jsonb) where connection_id = duplicate_id;
		if public.qorpera_native_account_usage_limit_reset(duplicate_id) is null then
			raise exception 'Insufficient, stale, future or exhausted metadata cleared the wall: %',invalid_usage; end if;
	end loop;
	update public.qorpera_native_provider_account_metadata set provider_account_usage = usage where connection_id = duplicate_id;
	if public.qorpera_native_account_usage_limit_reset(duplicate_id) is not null
	  or public.qorpera_native_account_remaining(duplicate_id,1) <> 80 then
		raise exception 'Fresh same-account quota failed to supersede the fallback wall'; end if;
	update public.qorpera_provider_connection_usage_signals set resets_at = observed + interval '1 hour'
	where provider_connection_id = original_id;
	-- 20260930575000: a reading with room after the limit ends the wall also before a reset the provider named (the
	-- daily usage check reads it so waiting work goes on).
	if public.qorpera_native_account_remaining(duplicate_id,1) <> 80 then
		raise exception 'Positive metadata after the limit did not end a wall with a provider reset'; end if;
	update public.qorpera_provider_connection_usage_signals set resets_at = observed - interval '1 second'
	where provider_connection_id = original_id;
	if public.qorpera_native_account_remaining(duplicate_id,1) <> 80 then
		raise exception 'Expired provider reset continued blocking the account'; end if;
	update public.qorpera_provider_connection_usage_signals set resets_at = null,observed_at = observed
	where provider_connection_id = original_id;
	if public.qorpera_native_account_remaining(duplicate_id,1) <> 0 then
		raise exception 'A new usage wall was bypassed by an earlier positive observation'; end if;
end $$;
set constraints all immediate;
rollback;
