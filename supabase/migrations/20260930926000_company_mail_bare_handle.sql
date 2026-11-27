do $$ begin
	if to_regprocedure('public.qorpera_mail_admit_local_part(uuid,text,uuid)') is null
		or to_regprocedure('public.qorpera_mail_handle_state(uuid,text)') is null then
		raise exception '20260930926000 needs 20260930796000'; end if;
end $$;

set local lock_timeout = '3s';

create or replace function public.qorpera_mail_handle_reserved(p_handle text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(p_handle, '') in (
		'support', 'help', 'helpdesk', 'billing', 'invoices', 'payments', 'info', 'information',
		'contact', 'hello', 'hi', 'hey', 'sales', 'marketing', 'team', 'staff', 'office',
		'service', 'legal', 'privacy', 'compliance', 'trust', 'safety', 'press', 'media',
		'jobs', 'careers', 'hr', 'accounts', 'account', 'auth', 'login', 'verify', 'verification',
		'status', 'system', 'alerts', 'notifications', 'notify', 'feedback', 'official',
		'mail', 'email', 'inbox', 'post', 'reply', 'donotreply', 'do-not-reply', 'bounce', 'bounces'
	)
$$;
revoke all on function public.qorpera_mail_handle_reserved(text) from public, anon, authenticated, service_role;

create or replace function public.qorpera_mail_handle_state(p_profile_id uuid, p_handle text)
returns text language sql stable set search_path = '' as $$
	select case
		when p_handle is null or p_handle !~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$'
			or public.qorpera_mail_name_reserved(p_handle)
			or public.qorpera_mail_handle_reserved(p_handle)
			or public.qorpera_mail_name_reads_as_qorpera(p_handle) then 'invalid'
		when exists (select 1 from public.qorpera_company_mail_handles as owned
			where owned.handle = p_handle and owned.profile_id = p_profile_id) then 'ours'
		when exists (select 1 from public.qorpera_company_mail_handles as owned where owned.handle = p_handle)
			or exists (select 1 from public.qorpera_company_mailboxes as mailbox
				where mailbox.removed_at is null and mailbox.profile_id <> p_profile_id
					and (mailbox.local_part = p_handle or right(mailbox.local_part, char_length(p_handle) + 1) = '.' || p_handle))
			then 'taken'
		else 'free' end
$$;
revoke all on function public.qorpera_mail_handle_state(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.qorpera_mail_admit_local_part(p_profile_id uuid, p_local_part text, p_claim_user_id uuid)
returns void language plpgsql set search_path = '' as $$
declare
	v_bare boolean := p_local_part is not null and p_local_part ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$';
	v_box text;
	v_handle text;
	v_state text;
begin
	if p_claim_user_id is not null and v_bare then
		v_box := null;
		v_handle := p_local_part;
	elsif p_local_part is not null
		and p_local_part ~ '^[a-z0-9]([a-z0-9_-]{0,37}[a-z0-9])?\.[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])$' then
		v_box := split_part(p_local_part, '.', 1);
		v_handle := split_part(p_local_part, '.', 2);
	elsif p_claim_user_id is null then
		raise exception 'A new address is a name, a dot and the company''s handle, like hello.acme' using errcode = '22023';
	else
		raise exception 'A new address is the company''s handle or a name, a dot and the handle, like acme or sales.acme'
			using errcode = '22023';
	end if;
	if (v_box is not null and public.qorpera_mail_name_reserved(v_box))
		or public.qorpera_mail_name_reserved(v_handle)
		or public.qorpera_mail_handle_reserved(v_handle) then
		raise exception 'This mailbox name is reserved' using errcode = '22023'; end if;
	if (v_box is not null and public.qorpera_mail_name_reads_as_qorpera(v_box))
		or public.qorpera_mail_name_reads_as_qorpera(v_handle) then
		raise exception 'A mailbox name that reads as Qorpera is reserved' using errcode = '22023'; end if;
	v_state := public.qorpera_mail_handle_state(p_profile_id, v_handle);
	if v_state = 'ours' then return; end if;
	if v_state <> 'free' then
		raise exception 'This address is taken' using errcode = '23505'; end if;
	if p_claim_user_id is null then
		raise exception 'Only a member can choose the company''s email handle' using errcode = '42501'; end if;
	if (select count(*) from public.qorpera_company_mail_handles as owned where owned.profile_id = p_profile_id) >= 3 then
		raise exception 'A company has at most 3 email handles' using errcode = '54000'; end if;
	insert into public.qorpera_company_mail_handles (handle, profile_id, claimed_by_user_id)
	values (v_handle, p_profile_id, p_claim_user_id)
	on conflict (handle) do nothing;
	if public.qorpera_mail_handle_state(p_profile_id, v_handle) <> 'ours' then
		raise exception 'This address is taken' using errcode = '23505'; end if;
end
$$;
revoke all on function public.qorpera_mail_admit_local_part(uuid, text, uuid) from public, anon, authenticated, service_role;
