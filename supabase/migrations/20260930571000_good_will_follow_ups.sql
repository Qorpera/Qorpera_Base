-- Good will follow-ups (20260930566000):
-- 1. A card the good will invoice could not charge tells the company's founders, and the member whose card it is, with
--    a line above the composer (member notification good_will_card_failed); the line goes once Stripe's retry pays.
-- 2. The computer-hours zero rule stays off: under good will nothing is switched off for want of sales, and hours can
--    no longer be bought. Its switch is cleared and retired (the runbook no longer sets it at the live switch); the
--    dormant checks stay, so nothing waits while it is null.

-- 1. The notification -------------------------------------------------------------------------------------------------

-- The kinds as they are, and this one (so a kind another change added is kept). Since I9b the check holds one array
-- literal ('{a,b}'::text[]); before it, quoted kinds one by one: both are read.
do $kinds$
declare v_kinds text[]; v_definition text;
begin
	select pg_get_constraintdef(c.oid) into v_definition from pg_constraint c
	where c.conrelid = 'public.qorpera_member_notifications'::regclass and c.conname = 'qorpera_member_notifications_kind';
	select array(select distinct k from unnest(
			coalesce(string_to_array((regexp_match(v_definition, '''\{([a-z_,]+)\}'''))[1], ','), '{}'::text[])
			|| array(select m.parts[1] from regexp_matches(v_definition, '''([a-z_]+)''', 'g') as m(parts))
			|| array['good_will_card_failed']) k order by k)
	into v_kinds;
	if cardinality(v_kinds) < 7 then
		raise exception '20260930571000 could not read the notification kinds'; end if;
	execute format('alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind, '
		'add constraint qorpera_member_notifications_kind check (kind = any (%L::text[]))', v_kinds);
end $kinds$;

-- The month's failed card, told once per invoice to the founders and the card's member (each while a member); a paid
-- invoice takes the line away.
create function public.qorpera_good_will_card_notice(p_month public.qorpera_good_will_months)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	-- 20260930571000
	if p_month.stripe_invoice_id is null then return; end if;
	if p_month.status = 'charged' then
		update public.qorpera_member_notifications as n set acknowledged_at = clock_timestamp()
		where n.profile_id = p_month.profile_id and n.kind = 'good_will_card_failed'
			and n.dedupe_key = p_month.stripe_invoice_id and n.acknowledged_at is null;
		return;
	end if;
	if p_month.status <> 'failed' then return; end if;
	insert into public.qorpera_member_notifications (profile_id, user_id, kind, subject, dedupe_key)
	select p_month.profile_id, member.user_id, 'good_will_card_failed', jsonb_build_object(
		'schema', 'qorpera.member-notification.good-will-card-failed/v1', 'month', to_char(p_month.month, 'YYYY-MM'),
		'dueOre', p_month.due_ore, 'invoiceUrl', p_month.invoice_url, 'mine', member.user_id = p_month.payer_user_id),
		p_month.stripe_invoice_id
	from public.qorpera_profile_members as member
	where member.profile_id = p_month.profile_id
		and (member.role = 'owner' or member.user_id = p_month.payer_user_id)
	on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
end
$$;
revoke all on function public.qorpera_good_will_card_notice(public.qorpera_good_will_months)
	from public, anon, authenticated, service_role;

create function pg_temp.good_will_follow_ups_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930571000' in v_definition) > 0 then
		raise exception '20260930571000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930571000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.good_will_follow_ups_replace('public.qorpera_good_will_billing(text,text,jsonb)'::regprocedure,
	$old$		return jsonb_build_object('outcome', 'applied', 'profileId', v_row.profile_id, 'status', v_row.status);$old$,
	$new$		-- 20260930571000: the founders and the card's member hear of a failed card; a paid one takes it away.
		perform public.qorpera_good_will_card_notice(v_row);
		return jsonb_build_object('outcome', 'applied', 'profileId', v_row.profile_id, 'status', v_row.status);$new$);

drop function pg_temp.good_will_follow_ups_replace(regprocedure, text, text);

-- 2. The zero rule stays off ------------------------------------------------------------------------------------------

update public.qorpera_computer_hour_billing set zero_rule_since = null where zero_rule_since is not null;
update public.qorpera_computer_hour_billing set coding_zero_rule_since = null where coding_zero_rule_since is not null;
delete from public.qorpera_computer_hour_zero_state;
comment on column public.qorpera_computer_hour_billing.zero_rule_since is
	'Retired by good will (20260930571000): leave null. Under good will a company without sales keeps working, and '
	'computer hours can no longer be bought; the live switch sets live_since only.';
comment on column public.qorpera_computer_hour_billing.coding_zero_rule_since is
	'Retired by good will (20260930571000): leave null, as zero_rule_since.';
