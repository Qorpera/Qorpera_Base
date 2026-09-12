-- A privacy barrier proves isolation, not owner viewer admission. Preserve
-- exact cleanup even when no ticket was redeemed. Prepared requires a redeemed
-- owner viewer for this profile version followed by completed private exit;
-- it does not attest a completed display connection or third-party sign-in.
create index qorpera_runtime_office_redeemed_private_viewers
on public.qorpera_runtime_office_viewers(office_id,member_id,privacy_version)
where redeemed_at is not null and private_sign_in is not null;

alter function public.qorpera_ack_runtime_office_privacy(jsonb) rename to qorpera_ack_runtime_office_privacy_v2;
revoke all on function public.qorpera_ack_runtime_office_privacy_v2(jsonb) from public,anon,authenticated,service_role;
create function public.qorpera_ack_runtime_office_privacy(p_challenge jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
	-- The prior implementation validates the exact current challenge and owns
	-- office/screen locks through this transaction, including replay and exit.
	v_result:=public.qorpera_ack_runtime_office_privacy_v2(p_challenge);
	if v_result->>'state'='shared' then
		update public.qorpera_runtime_browser_profiles p set prepared=p.prepared and exists (
			select 1 from public.qorpera_runtime_office_viewers v
			join public.qorpera_runtime_office_privacy_events e on e.office_id=v.office_id
				and e.version=v.privacy_version and e.state='private'
			where v.office_id=p.office_id and v.member_id=p.owner_user_id
				and v.screen_id=(p_challenge->>'screenId')::uuid
				and (v.binding->>'computerGeneration')::bigint=(p_challenge->>'computerGeneration')::bigint
				and v.privacy_version=(p_challenge->>'version')::bigint-1
				and v.redeemed_at is not null
				and v.private_sign_in=jsonb_build_object('challengeId',e.challenge->'challengeId',
					'profileId',p.id,'profileVersion',p.version)
		) where p.id=(p_challenge->>'profileId')::uuid
			and p.office_id=(p_challenge#>>'{scope,companyComputerId}')::uuid
			and p.version=(p_challenge->>'profileVersion')::bigint;
	end if;
	return v_result;
end
$$;
revoke all on function public.qorpera_ack_runtime_office_privacy(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_ack_runtime_office_privacy(jsonb) to service_role;

-- Previously cancelled sessions may already have been labelled prepared.
-- Existing consent cannot make an unvisited profile version prepared. Retain
-- cookies and all historical grant/viewer records for recovery and review.
update public.qorpera_runtime_browser_profiles p set prepared=false
where p.prepared and not exists (
	select 1 from public.qorpera_runtime_office_viewers v
	join public.qorpera_runtime_office_privacy_events e on e.office_id=v.office_id
		and e.version=v.privacy_version and e.state='private'
	where v.office_id=p.office_id and v.member_id=p.owner_user_id and v.redeemed_at is not null
		and v.private_sign_in=jsonb_build_object('challengeId',e.challenge->'challengeId',
			'profileId',p.id,'profileVersion',p.version)
);
