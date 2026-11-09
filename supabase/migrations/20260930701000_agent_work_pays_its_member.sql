-- 20260930701000: work handed to an agent runs on the login of the member it works for (Jonas, 9 Nov 2026).
--
-- 20260930700000 records who each agent works for. Jonas said yes to the rule behind the Members page: the member an
-- agent works for carries the agent's own work on their subscription. Until now every hand-off copied the requester of
-- the run that sent it, so the member whose message started a chain paid for every agent the chain reached: in a
-- two-founder company, all six hired agents ran on one founder's login.
--
-- * A coworker wake (one agent hands work to another, qorpera_pin_wake_occurrence's agent branch) is now requested by
--   the member the receiving agent works for, when that member has a login that may pay for it
--   (qorpera_starter_sponsor finds one for them). Its payer is then that member's own login, by the existing rule that
--   a member's login serves only that member's work; every follow-up of the receiver's run copies that requester, as
--   before. The hand-off's run is new work, so nothing running changes payer.
-- * With nobody, the same member, or no login of theirs that may pay (none connected, or only a ChatGPT plan login,
--   which pays only for follow-ups of runs it pays for, 20260928359950), the wake keeps the sender's requester: the
--   chain starter's login, as before.
-- * A member's own message to an agent (a room wake), a routine (its saver), a human task, a first run, a worker or a
--   machine event of the same run are unchanged.
-- Locks: none new; the changed trigger body only reads more. Every changed body carries 20260930701000.

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
	$old$  new.requested_by_user_id:=v_run.requested_by_user_id;$old$,
	$new$  new.requested_by_user_id:=v_run.requested_by_user_id;
		-- 20260930701000: work handed to an agent is requested by the member it works for, when a login of theirs may pay.
		if new.source_kind = 'coworker'
			and public.qorpera_agent_works_for_user(new.profile_id, new.staff_agent_id) <> v_run.requested_by_user_id
			and exists (select 1 from public.qorpera_starter_sponsor(new.profile_id,
					public.qorpera_agent_works_for_user(new.profile_id, new.staff_agent_id), new.staff_agent_id, null) as payer
				where payer.binding_id is not null) then
			new.requested_by_user_id := public.qorpera_agent_works_for_user(new.profile_id, new.staff_agent_id);
		end if;$new$);

drop function pg_temp.wf701_patch(regprocedure, text, text);
