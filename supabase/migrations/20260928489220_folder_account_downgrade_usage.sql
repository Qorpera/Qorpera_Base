-- An account's downgrade to the metered allocation counts its folder-v2 companies' stored bytes (found by A1's legacy
-- sweep, 4 October). qorpera_set_account_entitlement refused a downgrade only when qorpera_company_files.storage_used_bytes
-- was over a company's limit, a column folder-v2 never fills: an owner whose folder-v2 company held more than the metered
-- allowance could be downgraded. The check now reads qorpera_folder_storage_usage, the count the folder quota itself
-- keeps (20260928279520 §5), against the same allowance that quota uses (the smallest limit of the company's files). The
-- snapshot-v1 count goes: there is no snapshot-v1 company (folder-v2 only since 3 October). Nothing else changes.
-- SQL test 920; 240 loses its snapshot-v1 downgrade case.

set local lock_timeout = '3s';

create or replace function public.qorpera_set_account_entitlement(
	p_user_id uuid,
	p_plan_key text,
	p_billing_mode text,
	p_feature_set text,
	p_storage_allocation text,
	p_operator_reference text,
	p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_previous jsonb;
	v_current jsonb;
	v_operator_reference text := btrim(p_operator_reference);
	v_reason text := btrim(p_reason);
begin
	if auth.role() <> 'service_role' then
		raise exception 'account entitlement authority is invalid' using errcode = '42501';
	end if;
	if not exists (select 1 from auth.users as account where account.id = p_user_id)
		or char_length(v_operator_reference) not between 1 and 256
		or char_length(v_reason) not between 1 and 512
		or not (
			(p_plan_key = 'freemium' and p_billing_mode = 'free' and p_feature_set = 'standard'
				and p_storage_allocation = 'metered')
			or (p_plan_key = 'internal' and p_billing_mode = 'complimentary' and p_feature_set = 'all'
				and p_storage_allocation = 'unlimited')
		) then
		raise exception 'account entitlement contract is invalid' using errcode = '22023';
	end if;
	-- 20260930068000: a company the account owns that stores more than its metered allowance refuses the downgrade. Its
	-- stored bytes are the folder quota's count; its allowance is the smallest limit of its files, as that quota reads it.
	if p_storage_allocation = 'metered' and exists (
		select 1
		from public.qorpera_profile_members as member
		join public.qorpera_folder_storage_usage as usage on usage.profile_id = member.profile_id
		where member.user_id = p_user_id and member.role = 'owner'
			and usage.bytes > (select min(file.storage_limit_bytes) from public.qorpera_company_files as file
				where file.profile_id = member.profile_id)
	) then
		raise exception 'account storage exceeds the requested metered allocation' using errcode = '23514';
	end if;

	v_previous := public.qorpera_account_entitlement_json(p_user_id);
	insert into public.qorpera_account_entitlements (
		user_id, plan_key, billing_mode, feature_set, storage_allocation,
		operator_reference, reason
	) values (
		p_user_id, p_plan_key, p_billing_mode, p_feature_set, p_storage_allocation,
		v_operator_reference, v_reason
	)
	on conflict (user_id) do update
	set plan_key = excluded.plan_key,
		billing_mode = excluded.billing_mode,
		feature_set = excluded.feature_set,
		storage_allocation = excluded.storage_allocation,
		operator_reference = excluded.operator_reference,
		reason = excluded.reason,
		updated_at = statement_timestamp();
	v_current := public.qorpera_account_entitlement_json(p_user_id);
	insert into public.qorpera_account_entitlement_changes (
		user_id, previous_entitlement, current_entitlement, operator_reference, reason
	) values (
		p_user_id, v_previous, v_current, v_operator_reference, v_reason
	);
	return v_current;
end
$$;
