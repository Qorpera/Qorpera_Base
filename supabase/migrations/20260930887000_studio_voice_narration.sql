set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_resolve_member_voice_preference(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_surface_turn_member_initiated(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)') is null
		or to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_member_gemini_key_open(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_native_tool_locked_run(jsonb)') is null then
		raise exception '20260930887000: prerequisite voice, Gemini, or surface functions are missing';
	end if;
end $$;

create temporary table studio_voice_narration_before as
select oid, prosecdef, proconfig, provolatile, proacl from pg_proc
where oid in (
	'public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)'::regprocedure,
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure
);

create function pg_temp.svn_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930887000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930887000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create function public.qorpera_gemini_tts_microdollars(
	p_model text,
	p_input bigint,
	p_cached bigint,
	p_output bigint
)
returns bigint language sql immutable set search_path = '' as $$
	select ((greatest(0::bigint, coalesce(p_input, 0) - least(greatest(0::bigint, coalesce(p_cached, 0)), greatest(0::bigint, coalesce(p_input, 0)))) + 1) / 2)
		+ greatest(0::bigint, coalesce(p_output, 0))
			* case p_model
				when 'gemini-3.8-flash-lite-tts' then 6::bigint
				else 9::bigint
			end
$$;

create function public.qorpera_run_voice_gemini_key(p_run public.qorpera_execution_runs)
returns public.qorpera_gemini_keys language plpgsql stable security definer set search_path = '' as $$
declare
	v_user uuid := coalesce(p_run.requested_by_user_id, p_run.created_by_user_id);
	v_voice jsonb;
	v_key public.qorpera_gemini_keys%rowtype;
begin
	if p_run.id is null or p_run.source_kind <> 'wake' or v_user is null then
		return null;
	end if;
	if not exists (
		select 1
		from public.qorpera_wake_occurrences as wake
		join public.qorpera_surface_sessions as sess
			on sess.id = wake.source_id and sess.profile_id = wake.profile_id
		join public.qorpera_surfaces as surf
			on surf.id = sess.surface_id and surf.profile_id = wake.profile_id
		where wake.id = p_run.source_id
			and wake.profile_id = p_run.profile_id
			and wake.source_kind = 'surface-session'
			and surf.source_kind = 'folder'
			and public.qorpera_surface_turn_member_initiated(sess)
			and public.qorpera_surface_turn_requester(sess) = v_user
	) then
		return null;
	end if;
	v_voice := public.qorpera_resolve_member_voice_preference(p_run.profile_id, v_user);
	if coalesce(v_voice ->> 'voiceModel', '') not in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then
		return null;
	end if;
	v_key := public.qorpera_member_gemini_key_open(p_run.profile_id, v_user);
	if v_key.id is null then
		return null;
	end if;
	return v_key;
end $$;

revoke all on function
	public.qorpera_gemini_tts_microdollars(text, bigint, bigint, bigint),
	public.qorpera_run_voice_gemini_key(public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_open_gemini_key_for_run(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_spend bigint;
	v_run_authorized boolean := false;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_lease.run_id;
	select principal.* into v_principal from public.qorpera_cloud_secret_broker_principals as principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	if v_run.id is not null and v_run.gemini_model is not null and v_run.gemini_key_id is not null
		and (
			v_run.source_kind in ('session_turn', 'room_delivery')
			or (v_run.source_kind = 'wake' and exists (
				select 1 from public.qorpera_wake_occurrences as wake
				where wake.id = v_run.source_id
					and wake.source_kind in ('worker-completion', 'machine-event', 'machine-checkin', 'office-activation')
			))
		) then
		select key.* into v_key from public.qorpera_gemini_keys as key where key.id = v_run.gemini_key_id;
		v_run_authorized := true;
	elsif v_run.id is not null and v_run.source_kind = 'wake' then
		v_key := public.qorpera_run_voice_gemini_key(v_run);
		v_run_authorized := v_key.id is not null;
	end if;
	if v_run.id is null or not v_run_authorized
		or v_run.profile_id is distinct from v_authority.profile_id
		or v_principal.id is null or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_principal.id
		or v_key.id is null or v_key.principal_id is distinct from v_principal.id
		or v_key.owner_user_id is distinct from coalesce(v_run.requested_by_user_id, v_run.created_by_user_id) then
		raise exception 'Gemini key is unavailable to this run' using errcode = '42501'; end if;
	if v_key.status <> 'active' then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key-for-run/v1',
			'state', 'refused',
			'reason', 'REVOKED'
		);
	end if;
	v_spend := public.qorpera_gemini_key_month_spend(v_key);
	if public.qorpera_gemini_key_cap_reached(v_key) then
		return jsonb_build_object(
			'schema', 'qorpera.gemini-key-for-run/v1',
			'state', 'refused',
			'reason', 'CAP_REACHED',
			'spendMonth', v_month,
			'monthSpendMicrodollars', v_spend,
			'monthlyCapCents', v_key.monthly_cap_cents
		);
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-key-for-run/v1',
		'state', 'open',
		'geminiKeyId', v_key.id,
		'ownerUserId', v_key.owner_user_id,
		'keyId', v_key.key_id,
		'version', v_key.version,
		'envelopeSha256', v_key.envelope_sha256,
		'encryptedEnvelopeBase64', encode(v_key.encrypted_envelope, 'base64'),
		'spendMonth', v_month,
		'monthSpendMicrodollars', v_spend,
		'monthlyCapCents', v_key.monthly_cap_cents
	);
end $$;
revoke all on function public.qorpera_open_gemini_key_for_run(uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_open_gemini_key_for_run(uuid, text, jsonb)
	to qorpera_secret_broker;

create function public.qorpera_record_gemini_voice_usage(
	p_binding jsonb,
	p_model text,
	p_usage jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_voice_key public.qorpera_gemini_keys%rowtype;
	v_key public.qorpera_gemini_keys%rowtype;
	v_month text := public.qorpera_gemini_current_month();
	v_input bigint;
	v_cached bigint;
	v_output bigint;
	v_delta_spend bigint;
	v_cap_reached boolean;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Gemini voice usage is the runtime''s' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_model is null or p_model not in ('gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts') then
		raise exception 'Gemini voice model is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_usage) <> 'object'
		or (select count(*) from jsonb_object_keys(p_usage)) <> 3
		or not (p_usage ? 'inputTokens' and p_usage ? 'cachedTokens' and p_usage ? 'outputTokens')
		or jsonb_typeof(p_usage -> 'inputTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'cachedTokens') <> 'number'
		or jsonb_typeof(p_usage -> 'outputTokens') <> 'number'
		or (p_usage ->> 'inputTokens') !~ '^\d{1,7}$'
		or (p_usage ->> 'cachedTokens') !~ '^\d{1,7}$'
		or (p_usage ->> 'outputTokens') !~ '^\d{1,7}$' then
		raise exception 'Gemini voice usage is invalid' using errcode = '22023'; end if;
	v_input := (p_usage ->> 'inputTokens')::bigint;
	v_cached := (p_usage ->> 'cachedTokens')::bigint;
	v_output := (p_usage ->> 'outputTokens')::bigint;
	if v_input > 1000000 or v_cached > v_input or v_output > 1000000 then
		raise exception 'Gemini voice usage is invalid' using errcode = '22023'; end if;
	v_voice_key := public.qorpera_run_voice_gemini_key(v_run);
	if v_voice_key.id is null then
		raise exception 'Gemini voice usage is unavailable to this run' using errcode = '42501'; end if;
	select key.* into v_key from public.qorpera_gemini_keys as key
	where key.id = v_voice_key.id for update;
	if v_key.id is null or v_key.status <> 'active' then
		raise exception 'Gemini key is unavailable' using errcode = '42501'; end if;
	if v_key.spend_month <> v_month then
		v_key.spend_month := v_month;
		v_key.month_spend_microdollars := 0;
		v_key.month_input_tokens := 0;
		v_key.month_cached_tokens := 0;
		v_key.month_output_tokens := 0;
	end if;
	v_delta_spend := public.qorpera_gemini_tts_microdollars(p_model, v_input, v_cached, v_output);
	update public.qorpera_gemini_keys
	set spend_month = v_month,
		month_spend_microdollars = v_key.month_spend_microdollars + v_delta_spend,
		month_input_tokens = v_key.month_input_tokens + v_input,
		month_cached_tokens = v_key.month_cached_tokens + v_cached,
		month_output_tokens = v_key.month_output_tokens + v_output,
		last_error_code = null,
		last_error_at = null,
		last_checked_at = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = v_key.id
	returning * into v_key;
	v_cap_reached := public.qorpera_gemini_key_cap_reached(v_key);
	if v_cap_reached and v_key.monthly_cap_cents is not null then
		insert into public.qorpera_member_notifications (profile_id, user_id, kind, subject, dedupe_key)
		values (
			v_run.profile_id,
			v_key.owner_user_id,
			'gemini_cap_reached',
			jsonb_build_object(
				'schema', 'qorpera.member-notification.gemini-cap-reached/v1',
				'month', v_month,
				'spendMicrodollars', v_key.month_spend_microdollars,
				'monthlyCapCents', v_key.monthly_cap_cents,
				'runId', v_run.id,
				'sessionId', v_run.session_id
			),
			'gemini-cap:' || v_key.id::text || ':' || v_month || ':' || v_key.monthly_cap_cents::text
		)
		on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.gemini-voice-usage/v1',
		'spendMonth', v_key.spend_month,
		'monthSpendMicrodollars', v_key.month_spend_microdollars,
		'monthlyCapCents', v_key.monthly_cap_cents,
		'capReached', v_cap_reached
	);
end $$;
revoke all on function public.qorpera_record_gemini_voice_usage(jsonb, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_record_gemini_voice_usage(jsonb, text, jsonb)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_record_gemini_voice_usage', 'binding');

select pg_temp.svn_patch('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure, array[
$old$	v_conflict_paths text[];$old$,
$new$	v_conflict_paths text[];
	v_voice jsonb;
	v_open_scenes_ops jsonb := '[]'::jsonb;$new$,
$old$	if v_surface.id is null then
		raise exception 'Surface not found for profile' using errcode = 'P0002';
	end if;$old$,
$new$	if v_surface.id is null then
		raise exception 'Surface not found for profile' using errcode = 'P0002';
	end if;
	v_voice := public.qorpera_resolve_member_voice_preference(
		p_profile_id,
		public.qorpera_surface_turn_requester(v_session)
	);
	if v_surface.source_kind = 'folder' then
		select coalesce(jsonb_agg(item.op_obj order by item.seq, item.op_idx), '[]'::jsonb)
		into v_open_scenes_ops
		from (
			select latest.seq, latest.op_idx, latest.op_obj
			from (
				select distinct on (trim(both '/' from coalesce(x.op_obj ->> 'path', '')))
					c.seq,
					x.op_idx,
					x.op_obj ->> 'op' as op_kind,
					octet_length(coalesce(x.op_obj ->> 'content', '')) as content_bytes,
					case
						when x.op_obj ->> 'op' = 'write_text' then jsonb_build_object(
							'op', 'write_text',
							'path', x.op_obj ->> 'path',
							'content', x.op_obj ->> 'content'
						)
						else jsonb_build_object(
							'op', 'delete',
							'path', x.op_obj ->> 'path'
						)
					end as op_obj
				from public.qorpera_surface_changes as c
				cross join lateral jsonb_array_elements(
					case
						when jsonb_typeof(c.patch_manifest) = 'array' then c.patch_manifest
						when jsonb_typeof(c.patch_manifest -> 'ops') = 'array' then c.patch_manifest -> 'ops'
						else '[]'::jsonb
					end
				) with ordinality as x(op_obj, op_idx)
				where c.session_id = v_session.id
					and c.kind = 'folder_patch'
					and c.status in ('staged', 'conflicted')
					and x.op_obj ->> 'op' in ('write_text', 'delete')
					and (
						lower(trim(both '/' from coalesce(x.op_obj ->> 'path', ''))) ~ '(^|/)scenes\.js$'
						or lower(trim(both '/' from coalesce(x.op_obj ->> 'path', ''))) ~ '(^|/)voice/clips\.json$'
					)
				order by trim(both '/' from coalesce(x.op_obj ->> 'path', '')), c.seq desc, x.op_idx desc
			) as latest
			where latest.op_kind = 'delete' or latest.content_bytes <= 262144
			order by latest.seq desc, latest.op_idx desc
			limit 64
		) as item;
	end if;$new$,
$old$		'briefSummary', v_surface.brief_summary,$old$,
$new$		'briefSummary', v_surface.brief_summary,
		'voiceModel', v_voice ->> 'voiceModel',
		'voiceName', v_voice ->> 'voiceName',
		'openScenesOps', v_open_scenes_ops,$new$
]);

select pg_temp.svn_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure, array[
$old$'surface_reply','surface_ask',$old$,
$new$'surface_reply','surface_ask',/* 20260930887000 */'narrate_explainer',$new$
]);

drop function pg_temp.svn_patch(regprocedure, text[]);

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid in (
			'public.qorpera_open_gemini_key_for_run(uuid,text,jsonb)'::regprocedure,
			'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure
		)
	loop
		execute format(
			'grant execute on function public.qorpera_resolve_member_voice_preference(uuid,uuid), public.qorpera_surface_turn_requester(public.qorpera_surface_sessions), public.qorpera_run_voice_gemini_key(public.qorpera_execution_runs), public.qorpera_gemini_tts_microdollars(text,bigint,bigint,bigint) to %I',
			v_owner
		);
	end loop;
end $$;

do $$ begin
	if exists (
		select 1 from pg_temp.studio_voice_narration_before as prior
		join pg_proc as patched on patched.oid = prior.oid
		where patched.prosecdef is distinct from prior.prosecdef
			or patched.proconfig is distinct from prior.proconfig
			or patched.provolatile is distinct from prior.provolatile
			or patched.proacl::text is distinct from prior.proacl::text
	) or (select count(*) from pg_temp.studio_voice_narration_before) <> 3 then
		raise exception '20260930887000: patched function attributes or grants drifted';
	end if;
end $$;
