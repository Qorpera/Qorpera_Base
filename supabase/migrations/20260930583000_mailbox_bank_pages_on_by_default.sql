-- Mailbox and Bank show from the start (Jonas, 7 November 2026: "I would also want the email interface and the bank
-- interface seeded by default instead of having them be invisible"). A page with no row of its own is on for these two,
-- and off for Members, as before. An owner or admin who switched one off keeps it off: their row says so. No row is
-- written and no data changes; each page draws its own empty state until there is mail or a bank.

set local lock_timeout = '3s';

create or replace function public.qorpera_interface_pages_json(p_environment_id uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	-- 20260930583000 (Mailbox and Bank on by default), 20260930520000 (Bank page)
	select jsonb_build_object('schema', 'qorpera.member-interface-pages/v1',
		'pages', (select jsonb_agg(jsonb_build_object('page', listed.page, 'on', coalesce(kept.enabled, listed.page in ('mailbox', 'bank')))
				order by listed.place)
			from unnest(array['mailbox', 'members', 'bank']) with ordinality as listed(page, place)
			left join public.qorpera_interface_pages as kept
				on kept.environment_id = p_environment_id and kept.page = listed.page),
		'mayChange', exists (select 1 from public.qorpera_company_files as file
			join public.qorpera_profile_members as member on member.profile_id = file.profile_id
			where file.environment_id = p_environment_id and member.user_id = p_user
				and member.role::text in ('owner', 'admin')))
$$;
revoke all on function public.qorpera_interface_pages_json(uuid, uuid) from public, anon, authenticated, service_role;
