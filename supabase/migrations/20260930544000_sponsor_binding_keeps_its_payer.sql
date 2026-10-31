-- F8: a new version of an existing sponsor binding keeps who pays. The body of
-- qorpera_create_execution_sponsor_binding carries the marker 20260930544000.
--
-- An owner or admin may add a version to any binding of the company by its client id (20260820002000). The incoming
-- login is checked: a member's login binds only for its owner (20260928230000). The binding's stored payer never was:
-- an admin could put their own login, or a company account, on another member's binding. Then the binding's newest
-- version names that login, so every reader of the newest login acts on it, and work that follows that member's runs
-- (qorpera_starter_sponsor, 20260928489170) has no payer left. A member's binding could also become a company
-- account's, and a company account's binding a member's.
-- Now, under the binding's lock and after the authorize check, a new version of an existing binding is refused when:
-- * the binding's newest version pays with a member's login and the caller is not that login's owner (42501);
-- * it would change the binding between a member's login and a company account (22023). The two company kinds
--   (company_service_account, company_api_billing) are one side: an owner or admin, also one who did not create the
--   binding, still moves a company binding between company accounts and kinds.
-- A stored newest version the API can't make fails closed (55000): no version, its login missing, a member version on a
-- login with no owner, an unknown kind, or a company version on a member's login. The primary key (binding_id, version)
-- leaves one row at the newest version. The newest version is read first, then its login by its id, so a missing login
-- never falls back to an older version.
-- Unchanged: a first create, the member's own refresh or replay and their move to another login of theirs, company-to-
-- company versions, the grants, qorpera_move_member_login_pins and qorpera_coding_owner_sponsor (which write versions
-- themselves), and the stored rows (no backfill).
--
-- Locks: none new. The checks read under the binding's row lock, which the function already takes, as every writer of a
-- version to an existing binding does first.

set local lock_timeout = '3s';

create function pg_temp.keeps_payer_replace(p_definition text, p_old text, p_new text, p_what text)
returns text language plpgsql as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'sponsor binding keeps its payer: % differs', p_what; end if;
	return replace(p_definition, p_old, p_new);
end $$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_create_execution_sponsor_binding(uuid,uuid,text,uuid,bigint,boolean)'::regprocedure);
begin
	v_definition := pg_temp.keeps_payer_replace(v_definition, $old$	v_version bigint;
begin$old$,
$new$	v_version bigint;
	v_latest_version bigint;
	v_latest public.qorpera_execution_sponsor_versions%rowtype;
	v_latest_connection public.qorpera_provider_connections%rowtype;
begin$new$, 'declarations');
	v_definition := pg_temp.keeps_payer_replace(v_definition, $old$	if not found then
		insert into public.qorpera_execution_sponsor_bindings (
			profile_id, client_binding_id, created_by_user_id
		) values (p_profile_id, p_client_binding_id, v_user_id)
		returning * into v_binding;
	end if;$old$,
$new$	if not found then
		insert into public.qorpera_execution_sponsor_bindings (
			profile_id, client_binding_id, created_by_user_id
		) values (p_profile_id, p_client_binding_id, v_user_id)
		returning * into v_binding;
	else
		-- A new version keeps who pays (20260930544000): never another member's login, and never the other side of a
		-- member's login and a company account. The newest version, then its login, under the binding's lock; a stored
		-- version the API can't make fails closed.
		select max(sponsor.version) into v_latest_version
		from public.qorpera_execution_sponsor_versions as sponsor where sponsor.binding_id = v_binding.id;
		if v_latest_version is null then
			raise exception 'execution sponsor binding has no version' using errcode = '55000';
		end if;
		-- One row: the primary key (binding_id, version).
		select sponsor.* into strict v_latest
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_binding.id and sponsor.version = v_latest_version;
		select connection.* into v_latest_connection
		from public.qorpera_provider_connections as connection where connection.id = v_latest.provider_connection_id;
		if not found then
			raise exception 'execution sponsor binding''s login is missing' using errcode = '55000';
		end if;
		if v_latest.sponsor_kind is null or v_latest.sponsor_kind not in (
			'member_connection', 'company_service_account', 'company_api_billing'
		) then
			raise exception 'execution sponsor binding''s kind is unknown' using errcode = '55000';
		end if;
		if v_latest.sponsor_kind = 'member_connection' and v_latest_connection.owner_user_id is null then
			raise exception 'execution sponsor binding''s member login has no owner' using errcode = '55000';
		end if;
		if v_latest.sponsor_kind <> 'member_connection' and v_latest_connection.owner_user_id is not null then
			raise exception 'execution sponsor binding''s company account has a member owner' using errcode = '55000';
		end if;
		if v_latest.sponsor_kind = 'member_connection' and v_latest_connection.owner_user_id is distinct from v_user_id then
			raise exception 'execution sponsor binding pays with another member''s login' using errcode = '42501';
		end if;
		if (v_latest.sponsor_kind = 'member_connection') is distinct from (p_sponsor_kind = 'member_connection') then
			raise exception 'execution sponsor binding cannot change kind' using errcode = '22023';
		end if;
	end if;$new$, 'existing binding');
	execute v_definition;
end
$$;
