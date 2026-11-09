-- 20260930701000: work handed to an agent runs on the login of the member it works for (Jonas, 9 Nov 2026).
--
-- 20260930700000 records who each agent works for. Jonas said yes to the rule behind the Members page: the member an
-- agent works for carries the agent's own work on their subscription. Until now every hand-off copied the requester of
-- the run that sent it, so the member whose message started a chain paid for every agent the chain reached: in a
-- two-founder company, all six hired agents ran on one founder's login.
--
-- * A coworker wake (one agent hands work to another, qorpera_pin_wake_occurrence's agent branch) is now requested by
--   the member the receiving agent works for and paid by that member's own login: the login qorpera_starter_sponsor
--   picks for new work of theirs (most room first), only when it is theirs (never a company account) and not a ChatGPT
--   plan login (a plan pays only for work its member starts and for follow-ups of runs it pays for, 20260928359950).
--   Every follow-up of the receiver's run copies that requester and login, as before. The hand-off's run is new work,
--   so nothing running changes payer.
-- * With nobody, the same member, or no such login of theirs, the wake is paid as before: the chain starter's.
-- * A member's own message to an agent (a room wake), a routine (its saver), a human task, a first run, a worker or a
--   machine event of the same run are unchanged.
-- Locks: none new; the changed trigger body only reads more. Every changed body carries 20260930701000.

-- The member a hand-off to the agent now belongs to, and the login of theirs that pays for it; no row when the
-- hand-off stays with the chain starter (see the header).
create function public.qorpera_works_for_hand_off(p_profile_id uuid, p_staff_agent_id uuid, p_starter uuid)
returns table(user_id uuid, binding_id uuid, version bigint)
language sql stable security definer set search_path = '' as $$
	-- 20260930701000
	with works as (select public.qorpera_agent_works_for_user(p_profile_id, p_staff_agent_id) as user_id)
	select works.user_id, payer.binding_id, payer.version
	from works
	cross join lateral public.qorpera_starter_sponsor(p_profile_id, works.user_id, p_staff_agent_id, null) as payer
	join public.qorpera_provider_connections as connection
		on connection.id = public.qorpera_sponsor_binding_connection(payer.binding_id)
	where works.user_id is not null and works.user_id <> p_starter
		and connection.owner_user_id = works.user_id
		and not public.qorpera_sponsor_version_is_chatgpt_plan(payer.binding_id, payer.version)
	limit 1
$$;
revoke all on function public.qorpera_works_for_hand_off(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function pg_temp.wf701_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930701000' in v_definition) > 0 then
		raise exception '20260930701000 is already in %', p_target; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930701000 anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.wf701_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_starter_sponsor(new.profile_id, new.requested_by_user_id, new.staff_agent_id,
			v_run.sponsor_binding_id) as payer;
$old$,
	$new$		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_starter_sponsor(new.profile_id, new.requested_by_user_id, new.staff_agent_id,
			v_run.sponsor_binding_id) as payer;
		-- 20260930701000: work handed to an agent belongs to the member it works for, on their own login, when they have
		-- one that may pay for it (qorpera_works_for_hand_off).
		if new.source_kind = 'coworker' and exists (select 1 from public.qorpera_works_for_hand_off(new.profile_id,
				new.staff_agent_id, v_run.requested_by_user_id)) then
			select hand.user_id, hand.binding_id, hand.version
			into new.requested_by_user_id, new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_works_for_hand_off(new.profile_id, new.staff_agent_id, v_run.requested_by_user_id) as hand;
		end if;
$new$);

drop function pg_temp.wf701_patch(regprocedure, text, text);
