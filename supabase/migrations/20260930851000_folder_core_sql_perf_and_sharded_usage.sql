set local lock_timeout = '3s';

create index if not exists qorpera_folder_journal_authority_seq
	on public.qorpera_folder_journal (environment_id, seq desc)
	where kind = 'authority';

-- WHY: Resolve an actor's covering resource permissions and read receipts once per query instead of per row.
create or replace function public.qorpera_folder_actor_rules(
	p_environment_id uuid,
	p_profile_id uuid,
	p_actor jsonb,
	p_permission text
)
returns table(
	rkey text,
	rkey_prefix text,
	rkey_len integer,
	resource_id uuid,
	path_match text,
	scope text,
	owner_user_id uuid,
	is_shared boolean,
	allowed boolean,
	receipt jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
	with resources as materialized (
		select r,
			public.qorpera_folder_key(r.path) collate "C" as rkey,
			count(*) over (partition by public.qorpera_folder_key(r.path) collate "C") > 1 as is_shared
		from public.qorpera_company_path_resources r
		where r.environment_id = p_environment_id
	)
	select res.rkey,
		(res.rkey || '/') collate "C" as rkey_prefix,
		length(res.rkey)::integer as rkey_len,
		(res.r).id as resource_id,
		(res.r).path_match,
		(res.r).scope,
		(res.r).owner_user_id,
		res.is_shared,
		case when res.is_shared then false
			else coalesce(public.qorpera_folder_actor_resource_allowed(p_profile_id, p_actor, res.r, p_permission), false)
		end as allowed,
		case when p_permission = 'read' and not res.is_shared and p_actor ->> 'kind' = 'staff_agent' then
			jsonb_build_object(
				'resourceId', (res.r).id,
				'resourceRevision', (res.r).authority_revision,
				'grantId', (g.grant_row).id,
				'grantRevision', (g.grant_row).revision
			)
		end as receipt
	from resources res
	left join lateral (
		select public.qorpera_folder_agent_grant(res.r, (p_actor ->> 'staffAgentId')::uuid, 'read') as grant_row
		where p_permission = 'read' and not res.is_shared and p_actor ->> 'kind' = 'staff_agent'
	) g on true
$$;

revoke all on function public.qorpera_folder_actor_rules(uuid, uuid, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_folder_list(
	p_environment_id uuid,
	p_actor jsonb,
	p_parent text,
	p_after text,
	p_limit integer,
	p_recursive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_kind text := p_actor ->> 'kind';
	v_auth jsonb;
	v_profile uuid;
	v_last_seq bigint;
	v_parent_key text;
	v_parent_sha bytea;
	v_prefix_lo text;
	v_prefix_hi text;
	v_after text;
	v_code_host boolean;
	v_is_agent boolean;
	v_entries jsonb;
	v_next text;
begin
	if not public.qorpera_folder_caller_allowed(p_actor) then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if p_limit is null or p_limit not between 1 and 1000 or not public.qorpera_company_path_valid(coalesce(p_parent, ''), true)
		or (p_after is not null and not public.qorpera_company_path_valid(p_after)) then
		raise exception 'Listing is invalid' using errcode = '22023';
	end if;
	select f.profile_id, k.last_seq
	into v_profile, v_last_seq
	from public.qorpera_folder_clocks k
	join public.qorpera_company_files f on f.environment_id = k.environment_id
	where k.environment_id = p_environment_id and f.core = 'folder-v2';
	if not found then
		raise exception 'Company folder is unavailable' using errcode = '42501';
	end if;

	v_parent_key := public.qorpera_folder_key(coalesce(p_parent, ''));
	v_parent_sha := extensions.digest(v_parent_key, 'sha256');
	v_prefix_lo := v_parent_key || '/';
	v_prefix_hi := v_parent_key || '0';
	v_after := case when p_after is not null then public.qorpera_folder_key(p_after) end;
	v_code_host := coalesce(v_auth -> 'view' ->> 'kind' = 'code_host', false);
	v_is_agent := coalesce(v_auth ->> 'kind' = 'staff_agent', false);

	if v_kind = 'platform' then
		if not p_recursive then
			with page as materialized (
				select e.path, e.key_text, e.kind, e.version, c.seq as commit_seq,
					e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at, e.target
				from public.qorpera_folder_entries e
				join public.qorpera_folder_commits c on c.id = e.commit_id
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.parent_key_sha256 = v_parent_sha
					and (v_after is null or e.key_text > v_after collate "C")
				order by e.key_text
				limit p_limit
			)
			select coalesce((
					select jsonb_agg(
						public.qorpera_folder_entry_json(p.path, p.kind, p.version, p.commit_seq,
							p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
						|| case when p.kind = 'symlink' then jsonb_build_object('target', p.target) else '{}'::jsonb end
						order by p.key_text)
					from page p), '[]'::jsonb),
				case when (select count(*) from page) = p_limit
					then (select p.path from page p order by p.key_text desc limit 1) end
			into v_entries, v_next;
		else
			with page as materialized (
				select e.path, e.key_text, e.kind, e.version, c.seq as commit_seq,
					e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at, e.target
				from public.qorpera_folder_entries e
				join public.qorpera_folder_commits c on c.id = e.commit_id
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and (v_parent_key = '' or (e.key_text >= v_prefix_lo collate "C" and e.key_text < v_prefix_hi collate "C"))
					and (v_after is null or e.key_text > v_after collate "C")
				order by e.key_text
				limit p_limit
			)
			select coalesce((
					select jsonb_agg(
						public.qorpera_folder_entry_json(p.path, p.kind, p.version, p.commit_seq,
							p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
						|| case when p.kind = 'symlink' then jsonb_build_object('target', p.target) else '{}'::jsonb end
						order by p.key_text)
					from page p), '[]'::jsonb),
				case when (select count(*) from page) = p_limit
					then (select p.path from page p order by p.key_text desc limit 1) end
			into v_entries, v_next;
		end if;
	elsif not p_recursive then
		with rules as materialized (
			select r.rkey collate "C" as rkey,
				r.rkey_prefix collate "C" as rkey_prefix,
				r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
			from public.qorpera_folder_actor_rules(p_environment_id, v_profile, v_auth, 'read') r
		),
		page as materialized (
			select e.path, e.key_text, e.kind, e.version, c.seq as commit_seq,
				e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at, e.target,
				cov.receipt
			from public.qorpera_folder_entries e
			join public.qorpera_folder_commits c on c.id = e.commit_id
			cross join lateral (
				select r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
				from rules r
				where r.rkey = e.key_text
					or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
				order by r.rkey_len desc, r.resource_id
				limit 1
			) cov
			where e.environment_id = p_environment_id and e.kind <> 'claim'
				and e.parent_key_sha256 = v_parent_sha
				and (v_after is null or e.key_text > v_after collate "C")
				and (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
				and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
				and cov.allowed and not cov.is_shared
				and not (
					split_part(e.key_text, '/', 1) = 'members'
					and split_part(e.key_text, '/', 3) = 'private'
					and (cov.scope is distinct from 'member_private'
						or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
				)
			order by e.key_text
			limit p_limit
		)
		select coalesce((
				select jsonb_agg(
					public.qorpera_folder_entry_json(p.path, p.kind, p.version, p.commit_seq,
						p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
					|| case when p.kind = 'symlink' then jsonb_build_object('target', p.target) else '{}'::jsonb end
					|| case when v_is_agent then jsonb_build_object('authority', p.receipt) else '{}'::jsonb end
					order by p.key_text)
				from page p), '[]'::jsonb),
			case when (select count(*) from page) = p_limit
				then (select p.path from page p order by p.key_text desc limit 1) end
		into v_entries, v_next;
	else
		with rules as materialized (
			select r.rkey collate "C" as rkey,
				r.rkey_prefix collate "C" as rkey_prefix,
				r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
			from public.qorpera_folder_actor_rules(p_environment_id, v_profile, v_auth, 'read') r
		),
		root_ok as materialized (
			select exists (
				select 1 from rules r where r.rkey = '' and r.path_match = 'subtree' and r.allowed and not r.is_shared
			) as ok
		),
		top_allowed as materialized (
			select a.rkey, a.rkey_prefix, a.path_match
			from rules a
			where not (select ok from root_ok)
				and a.allowed and not a.is_shared and a.rkey <> ''
				and not exists (
					select 1 from rules b
					where b.allowed and not b.is_shared and b.path_match = 'subtree' and b.rkey <> ''
						and b.rkey <> a.rkey and starts_with(a.rkey, b.rkey_prefix)
				)
				and (v_after is null
					or (a.path_match = 'exact' and a.rkey > v_after collate "C")
					or (a.path_match = 'subtree' and (a.rkey || '0') collate "C" > v_after collate "C"))
				and (v_parent_key = ''
					or starts_with(a.rkey, v_prefix_lo)
					or (a.path_match = 'subtree' and (a.rkey = v_parent_key collate "C" or starts_with(v_parent_key, a.rkey_prefix))))
			order by a.rkey
		),
		candidates as (
			select e.path, e.key_text, e.kind, e.version, c.seq as commit_seq,
				e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at, e.target,
				cov.receipt
			from root_ok rk
			join public.qorpera_folder_entries e on rk.ok and e.environment_id = p_environment_id and e.kind <> 'claim'
			join public.qorpera_folder_commits c on c.id = e.commit_id
			cross join lateral (
				select r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
				from rules r
				where r.rkey = e.key_text
					or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
				order by r.rkey_len desc, r.resource_id
				limit 1
			) cov
			where (v_parent_key = '' or (e.key_text >= v_prefix_lo collate "C" and e.key_text < v_prefix_hi collate "C"))
				and (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
				and (v_after is null or e.key_text > v_after collate "C")
				and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
				and cov.allowed and not cov.is_shared
				and not (
					split_part(e.key_text, '/', 1) = 'members'
					and split_part(e.key_text, '/', 3) = 'private'
					and (cov.scope is distinct from 'member_private'
						or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
				)
			union all
			select sub.path, sub.key_text, sub.kind, sub.version, sub.commit_seq,
				sub.manifest_sha256, sub.file_sha256, sub.bytes, sub.media_type, sub.executable, sub.updated_at, sub.target,
				sub.receipt
			from top_allowed ta
			cross join lateral (
				select e.path, e.key_text, e.kind, e.version, c.seq as commit_seq,
					e.manifest_sha256, e.file_sha256, e.bytes, e.media_type, e.executable, e.updated_at, e.target,
					cov.receipt
				from public.qorpera_folder_entries e
				join public.qorpera_folder_commits c on c.id = e.commit_id
				cross join lateral (
					select r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
					from rules r
					where r.rkey = e.key_text
						or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
					order by r.rkey_len desc, r.resource_id
					limit 1
				) cov
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_text >= ta.rkey
					and e.key_text < (ta.rkey || '0') collate "C"
					and (e.key_text = ta.rkey or (ta.path_match = 'subtree' and starts_with(e.key_text, ta.rkey_prefix)))
					and (v_parent_key = '' or (e.key_text >= v_prefix_lo collate "C" and e.key_text < v_prefix_hi collate "C"))
					and (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
					and (v_after is null or e.key_text > v_after collate "C")
					and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
					and cov.allowed and not cov.is_shared
					and not (
						split_part(e.key_text, '/', 1) = 'members'
						and split_part(e.key_text, '/', 3) = 'private'
						and (cov.scope is distinct from 'member_private'
							or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
					)
				order by e.key_text
				limit p_limit
			) sub
		),
		page as materialized (
			select * from candidates order by key_text limit p_limit
		)
		select coalesce((
				select jsonb_agg(
					public.qorpera_folder_entry_json(p.path, p.kind, p.version, p.commit_seq,
						p.manifest_sha256, p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
					|| case when p.kind = 'symlink' then jsonb_build_object('target', p.target) else '{}'::jsonb end
					|| case when v_is_agent then jsonb_build_object('authority', p.receipt) else '{}'::jsonb end
					order by p.key_text)
				from page p), '[]'::jsonb),
			case when (select count(*) from page) = p_limit
				then (select p.path from page p order by p.key_text desc limit 1) end
		into v_entries, v_next;
	end if;

	return jsonb_build_object(
		'schema', 'qorpera.folder-list/v1',
		'asOfSeq', v_last_seq,
		'entries', v_entries,
		'next', v_next
	);
end $$;

create or replace function public.qorpera_folder_view_fingerprint(
	p_environment_id uuid,
	p_actor jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_kind text := p_actor ->> 'kind';
	v_auth jsonb;
	v_profile uuid;
	v_seq bigint;
	v_authority_seq bigint;
	v_code_host boolean;
	v_is_agent boolean;
	v_entry_count bigint;
	v_entries_digest text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	select f.profile_id, k.last_seq
	into v_profile, v_seq
	from public.qorpera_folder_clocks k
	join public.qorpera_company_files f on f.environment_id = k.environment_id
	where k.environment_id = p_environment_id and f.core = 'folder-v2';
	if not found then
		raise exception 'Company folder is unavailable' using errcode = '42501';
	end if;

	select coalesce(max(j.seq), 0) into v_authority_seq
	from public.qorpera_folder_journal j
	where j.environment_id = p_environment_id and j.kind = 'authority';

	v_code_host := coalesce(v_auth -> 'view' ->> 'kind' = 'code_host', false);
	v_is_agent := coalesce(v_auth ->> 'kind' = 'staff_agent', false);

	if v_kind = 'platform' then
		select count(*)::bigint,
			coalesce(
				lpad(to_hex(bit_xor(('x' || encode(substring(h.d from 1 for 8), 'hex'))::bit(64)::bigint)), 16, '0')
				|| lpad(to_hex(bit_xor(('x' || encode(substring(h.d from 9 for 8), 'hex'))::bit(64)::bigint)), 16, '0'),
				repeat('0', 32)
			)
		into v_entry_count, v_entries_digest
		from (
			select sha256(convert_to(e.path || ':' || e.version::text, 'utf8')) as d
			from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.kind <> 'claim'
		) h;
	else
		with rules as materialized (
			select r.rkey collate "C" as rkey,
				r.rkey_prefix collate "C" as rkey_prefix,
				r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
			from public.qorpera_folder_actor_rules(p_environment_id, v_profile, v_auth, 'read') r
		),
		root_ok as materialized (
			select exists (
				select 1 from rules r where r.rkey = '' and r.path_match = 'subtree' and r.allowed and not r.is_shared
			) as ok
		),
		top_allowed as materialized (
			select a.rkey, a.rkey_prefix, a.path_match
			from rules a
			where not (select ok from root_ok)
				and a.allowed and not a.is_shared and a.rkey <> ''
				and not exists (
					select 1 from rules b
					where b.allowed and not b.is_shared and b.path_match = 'subtree' and b.rkey <> ''
						and b.rkey <> a.rkey and starts_with(a.rkey, b.rkey_prefix)
				)
		),
		readable as (
			select e.path, e.version, cov.receipt
			from root_ok rk
			join public.qorpera_folder_entries e on rk.ok and e.environment_id = p_environment_id and e.kind <> 'claim'
			cross join lateral (
				select r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
				from rules r
				where r.rkey = e.key_text
					or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
				order by r.rkey_len desc, r.resource_id
				limit 1
			) cov
			where (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
				and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
				and cov.allowed and not cov.is_shared
				and not (
					split_part(e.key_text, '/', 1) = 'members'
					and split_part(e.key_text, '/', 3) = 'private'
					and (cov.scope is distinct from 'member_private'
						or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
				)
			union all
			select e.path, e.version, cov.receipt
			from top_allowed ta
			join public.qorpera_folder_entries e
				on e.environment_id = p_environment_id and e.kind <> 'claim'
				and e.key_text >= ta.rkey
				and e.key_text < (ta.rkey || '0') collate "C"
				and (e.key_text = ta.rkey or (ta.path_match = 'subtree' and starts_with(e.key_text, ta.rkey_prefix)))
			cross join lateral (
				select r.scope, r.owner_user_id, r.is_shared, r.allowed, r.receipt
				from rules r
				where r.rkey = e.key_text
					or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
				order by r.rkey_len desc, r.resource_id
				limit 1
			) cov
			where (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
				and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
				and cov.allowed and not cov.is_shared
				and not (
					split_part(e.key_text, '/', 1) = 'members'
					and split_part(e.key_text, '/', 3) = 'private'
					and (cov.scope is distinct from 'member_private'
						or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
				)
		)
		select count(*)::bigint,
			coalesce(
				lpad(to_hex(bit_xor(('x' || encode(substring(h.d from 1 for 8), 'hex'))::bit(64)::bigint)), 16, '0')
				|| lpad(to_hex(bit_xor(('x' || encode(substring(h.d from 9 for 8), 'hex'))::bit(64)::bigint)), 16, '0'),
				repeat('0', 32)
			)
		into v_entry_count, v_entries_digest
		from (
			select sha256(convert_to(
				case when v_is_agent then
					r.path || ':' || r.version::text || ':' || coalesce(r.receipt ->> 'resourceId', '')
					|| ':' || coalesce(r.receipt ->> 'resourceRevision', '')
					|| ':' || coalesce(r.receipt ->> 'grantId', '')
					|| ':' || coalesce(r.receipt ->> 'grantRevision', '')
				else
					r.path || ':' || r.version::text
				end,
				'utf8'
			)) as d
			from readable r
		) h;
	end if;

	return jsonb_build_object(
		'schema', 'qorpera.folder-view-fingerprint/v1',
		'seq', v_seq,
		'authoritySeq', v_authority_seq,
		'entryCount', v_entry_count,
		'entriesDigest', v_entries_digest
	);
end $$;

revoke all on function public.qorpera_folder_view_fingerprint(uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_view_fingerprint(uuid, jsonb) to service_role;

-- WHY: Short-circuit object readability on active entries before ever scanning historical path versions.
create or replace function public.qorpera_folder_object_readable_state(
	p_environment_id uuid,
	p_profile_id uuid,
	p_auth jsonb,
	p_sha256 text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_code_host boolean := coalesce(p_auth -> 'view' ->> 'kind' = 'code_host', false);
	v_state text;
begin
	with rules as materialized (
		select r.rkey collate "C" as rkey,
			r.rkey_prefix collate "C" as rkey_prefix,
			r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed
		from public.qorpera_folder_actor_rules(p_environment_id, p_profile_id, p_auth, 'read') r
	),
	has_allowed as materialized (
		select exists (select 1 from rules r where r.allowed and not r.is_shared) as ok
	),
	manifests as materialized (
		select p_sha256 as manifest
		union
		select c.manifest_sha256
		from public.qorpera_folder_file_chunks c
		where c.profile_id = p_profile_id and c.chunk_sha256 = p_sha256
	)
	select case
		when not (select ok from has_allowed) then 'none'
		else coalesce(
			(
				select case
					when cov.scope in ('company_shared', 'company_rules', 'member_private')
						and not (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C" and position('/repo.git/objects/' in e.key_text) > 0)
					then 'active_fenceable'
					else 'active'
				end
				from manifests m
				join public.qorpera_folder_entries e
					on e.environment_id = p_environment_id and e.kind = 'file' and e.manifest_sha256 = m.manifest
				cross join lateral (
					select r.scope, r.owner_user_id, r.is_shared, r.allowed
					from rules r
					where r.rkey = e.key_text
						or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(e.key_text, r.rkey_prefix)))
					order by r.rkey_len desc, r.resource_id
					limit 1
				) cov
				where (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
					and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
					and cov.allowed and not cov.is_shared
					and not (
						split_part(e.key_text, '/', 1) = 'members'
						and split_part(e.key_text, '/', 3) = 'private'
						and (cov.scope is distinct from 'member_private'
							or cov.owner_user_id::text is distinct from split_part(e.key_text, '/', 2))
					)
				limit 1
			),
			case
				when exists (
					select 1
					from manifests m
					join public.qorpera_folder_path_versions v
						on v.environment_id = p_environment_id and v.manifest_sha256 is not null and v.manifest_sha256 = m.manifest
					cross join lateral (select public.qorpera_folder_key(v.path) collate "C" as k) vk
					cross join lateral (
						select r.scope, r.owner_user_id, r.is_shared, r.allowed
						from rules r
						where r.rkey = vk.k
							or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(vk.k, r.rkey_prefix)))
						order by r.rkey_len desc, r.resource_id
						limit 1
					) cov
					where (not v_code_host or vk.k = 'code' or (vk.k >= 'code/' collate "C" and vk.k < 'code0' collate "C"))
						and split_part(vk.k, '/', 1) not in ('credentials', 'secrets')
						and cov.allowed and not cov.is_shared
						and not (
							split_part(vk.k, '/', 1) = 'members'
							and split_part(vk.k, '/', 3) = 'private'
							and (cov.scope is distinct from 'member_private'
								or cov.owner_user_id::text is distinct from split_part(vk.k, '/', 2))
						)
				) then 'historical'
				when exists (
					select 1
					from manifests m
					join public.qorpera_folder_conflict_copies k
						on k.environment_id = p_environment_id and k.manifest_sha256 = m.manifest
					cross join lateral (
						select r.scope, r.owner_user_id, r.is_shared, r.allowed
						from rules r
						where r.rkey = k.key_text
							or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(k.key_text, r.rkey_prefix)))
						order by r.rkey_len desc, r.resource_id
						limit 1
					) cov
					where (not v_code_host or k.key_text = 'code' or (k.key_text >= 'code/' collate "C" and k.key_text < 'code0' collate "C"))
						and split_part(k.key_text, '/', 1) not in ('credentials', 'secrets')
						and cov.allowed and not cov.is_shared
						and not (
							split_part(k.key_text, '/', 1) = 'members'
							and split_part(k.key_text, '/', 3) = 'private'
							and (cov.scope is distinct from 'member_private'
								or cov.owner_user_id::text is distinct from split_part(k.key_text, '/', 2))
						)
				) then 'historical'
				else 'none'
			end
		)
	end
	into v_state;
	return coalesce(v_state, 'none');
end $$;

revoke all on function public.qorpera_folder_object_readable_state(uuid, uuid, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_folder_object_readable(
	p_environment_id uuid,
	p_profile_id uuid,
	p_auth jsonb,
	p_sha256 text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_folder_object_readable_state(p_environment_id, p_profile_id, p_auth, p_sha256) <> 'none'
$$;

create or replace function public.qorpera_folder_authorize_object_download(
	p_environment_id uuid,
	p_actor jsonb,
	p_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_actor jsonb;
	v_profile uuid;
	v_bytes bigint;
	v_state text;
	v_authority_seq bigint;
	v_checked_at timestamptz := least(now(), clock_timestamp());
begin
	if not public.qorpera_folder_caller_allowed(p_actor) then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then
		raise exception 'Object hash is invalid' using errcode = '22023';
	end if;
	v_actor := public.qorpera_folder_upload_actor(p_environment_id, p_actor, false);
	v_profile := (v_actor ->> 'profileId')::uuid;
	select o.bytes into v_bytes
	from public.qorpera_profile_objects o
	where o.profile_id = v_profile and o.sha256 = p_sha256;
	if v_bytes is null or public.qorpera_folder_object_marked(v_profile, p_sha256) then
		raise exception 'Object is unavailable' using errcode = '42501';
	end if;
	select coalesce(max(j.seq), 0) into v_authority_seq
	from public.qorpera_folder_journal j
	where j.environment_id = p_environment_id and j.kind = 'authority';
	if v_actor ->> 'kind' = 'platform' then
		v_state := 'active_fenceable';
	else
		v_state := public.qorpera_folder_object_readable_state(p_environment_id, v_profile, v_actor -> 'auth', p_sha256);
		if v_state = 'none' then
			raise exception 'Object is unavailable' using errcode = '42501';
		end if;
	end if;
	return jsonb_build_object(
		'schema', 'qorpera.folder-object-download/v1',
		'profileId', v_profile,
		'bytes', v_bytes,
		'authoritySeq', v_authority_seq,
		'checkedAt', v_checked_at,
		'viaActive', v_state = 'active_fenceable'
	);
end $$;

create or replace function public.qorpera_member_folder_object(p_environment_id uuid, p_sha256 text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_folder_authorize_object_download(
		p_environment_id,
		public.qorpera_member_folder_actor(p_environment_id),
		p_sha256
	) - array['authoritySeq', 'checkedAt', 'viaActive']
$$;

-- WHY: Re-validate actor, catalog, GC, and authority clock after NAS I/O without re-running full readability
-- scans unless authority_seq advanced, a timed grant expired, or an erasure/historical path requires it.
create or replace function public.qorpera_folder_download_fence(
	p_environment_id uuid,
	p_actor jsonb,
	p_sha256 text,
	p_authority_seq bigint,
	p_checked_at timestamptz,
	p_via_active boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_actor jsonb;
	v_profile uuid;
	v_bytes bigint;
	v_authority_seq bigint;
	v_recheck boolean;
	v_state text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or p_authority_seq is null or p_authority_seq < 0 or p_checked_at is null then
		raise exception 'Object download fence is invalid' using errcode = '22023';
	end if;
	v_actor := public.qorpera_folder_upload_actor(p_environment_id, p_actor, false);
	v_profile := (v_actor ->> 'profileId')::uuid;
	select o.bytes into v_bytes
	from public.qorpera_profile_objects o
	where o.profile_id = v_profile and o.sha256 = p_sha256;
	if v_bytes is null or public.qorpera_folder_object_marked(v_profile, p_sha256) then
		raise exception 'Object is unavailable' using errcode = '42501';
	end if;
	select coalesce(max(j.seq), 0) into v_authority_seq
	from public.qorpera_folder_journal j
	where j.environment_id = p_environment_id and j.kind = 'authority';

	v_recheck := false;
	if v_actor ->> 'kind' <> 'platform' then
		v_recheck := not coalesce(p_via_active, false)
			or v_authority_seq <> p_authority_seq
			or exists (
				select 1
				from public.qorpera_company_path_resources r
				where r.environment_id = p_environment_id
					and r.revoked_at is not null
					and r.revoked_at >= p_checked_at
			)
			or exists (
				select 1
				from public.qorpera_company_path_grants g
				join public.qorpera_company_path_resources r on r.id = g.resource_id
				where r.environment_id = p_environment_id
					and (
						(g.revoked_at is null and g.expires_at is not null
							and g.expires_at >= p_checked_at
							and g.expires_at <= greatest(now(), clock_timestamp()))
						or (g.revoked_at is not null and g.revoked_at >= p_checked_at)
					)
			)
			or exists (
				select 1
				from public.qorpera_folder_erasures er
				where er.environment_id = p_environment_id
					and (er.done_at is null or er.done_at >= p_checked_at - interval '1 second')
			)
			or exists (
				select 1
				from public.qorpera_folder_object_gc gc
				where gc.profile_id = v_profile and gc.sha256 = p_sha256
			);
		if v_recheck then
			v_state := public.qorpera_folder_object_readable_state(p_environment_id, v_profile, v_actor -> 'auth', p_sha256);
			if v_state = 'none' then
				raise exception 'Object is unavailable' using errcode = '42501';
			end if;
		end if;
	end if;

	return jsonb_build_object(
		'schema', 'qorpera.folder-object-download/v1',
		'profileId', v_profile,
		'bytes', v_bytes,
		'authoritySeq', v_authority_seq,
		'rechecked', v_recheck
	);
end $$;

revoke all on function public.qorpera_folder_download_fence(uuid, jsonb, text, bigint, timestamptz, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_download_fence(uuid, jsonb, text, bigint, timestamptz, boolean)
	to service_role;

-- WHY: Shard storage usage counters across 16 deterministic hash buckets to remove single-row lock contention
-- on concurrent chunk confirmations while keeping exact summed quota enforcement.
alter table public.qorpera_folder_storage_usage
	add column if not exists bucket smallint not null default 0 check (bucket between 0 and 15);
alter table public.qorpera_folder_storage_usage
	drop constraint qorpera_folder_storage_usage_pkey,
	add primary key (profile_id, bucket);

create or replace function public.qorpera_folder_storage_usage_changed(
	p_op text,
	p_old public.qorpera_profile_objects,
	p_new public.qorpera_profile_objects
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile uuid := case when p_op = 'DELETE' then p_old.profile_id else p_new.profile_id end;
	v_sha256 text := case when p_op = 'DELETE' then p_old.sha256 else p_new.sha256 end;
	v_bytes bigint;
	v_objects bigint;
	v_bucket smallint;
begin
	if not public.qorpera_company_is_folder_v2(v_profile)
		or (p_op = 'UPDATE' and p_old.profile_id is distinct from p_new.profile_id) then
		return false;
	end if;
	v_bytes := case p_op when 'INSERT' then p_new.bytes when 'DELETE' then -p_old.bytes else p_new.bytes - p_old.bytes end;
	v_objects := case p_op when 'INSERT' then 1 when 'DELETE' then -1 else 0 end;
	if v_bytes <> 0 or v_objects <> 0 then
		v_bucket := case when v_sha256 ~ '^[0-9a-f]{2}'
			then (get_byte(decode(left(v_sha256, 2), 'hex'), 0) & 15)::smallint
			else (abs(hashtext(coalesce(v_sha256, ''))) % 16)::smallint end;
		if not exists (select 1 from public.qorpera_folder_storage_usage where profile_id = v_profile) then
			insert into public.qorpera_folder_storage_usage(profile_id, bucket, bytes, objects)
			select v_profile, 0::smallint, coalesce(sum(o.bytes), 0) - v_bytes, count(*) - v_objects
			from public.qorpera_profile_objects o where o.profile_id = v_profile
			on conflict (profile_id, bucket) do nothing;
		end if;
		insert into public.qorpera_folder_storage_usage(profile_id, bucket, bytes, objects, updated_at)
		values (v_profile, v_bucket, v_bytes, v_objects, clock_timestamp())
		on conflict (profile_id, bucket) do update
		set bytes = public.qorpera_folder_storage_usage.bytes + excluded.bytes,
			objects = public.qorpera_folder_storage_usage.objects + excluded.objects,
			updated_at = excluded.updated_at;
	end if;
	return true;
end $$;

create or replace function public.qorpera_folder_storage_quota_check(p_profile_id uuid, p_bytes bigint)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_limit bigint;
begin
	if public.qorpera_profile_storage_is_unlimited(p_profile_id) then return; end if;
	select min(storage_limit_bytes) into v_limit from public.qorpera_company_files where profile_id = p_profile_id;
	if v_limit is not null
		and coalesce((select sum(bytes)::bigint from public.qorpera_folder_storage_usage where profile_id = p_profile_id), 0)
			+ p_bytes > v_limit then
		raise exception 'company storage allowance exceeded' using errcode = '23514';
	end if;
end $$;

create function pg_temp.w6d_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930851000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930851000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.w6d_patch('public.qorpera_company_file_json(public.qorpera_company_files)'::regprocedure, array[
$old$			(select usage.bytes from public.qorpera_folder_storage_usage as usage where usage.profile_id = p_file.profile_id),$old$,
$new$			(select sum(usage.bytes)::bigint from public.qorpera_folder_storage_usage as usage where usage.profile_id = p_file.profile_id),$new$
]);

select pg_temp.w6d_patch('public.qorpera_set_account_entitlement(uuid,text,text,text,text,text,text)'::regprocedure, array[
$old$	if p_storage_allocation = 'metered' and exists (
		select 1
		from public.qorpera_profile_members as member
		join public.qorpera_folder_storage_usage as usage on usage.profile_id = member.profile_id
		where member.user_id = p_user_id and member.role = 'owner'
			and usage.bytes > (select min(file.storage_limit_bytes) from public.qorpera_company_files as file
				where file.profile_id = member.profile_id)
	) then$old$,
$new$	if p_storage_allocation = 'metered' and exists (
		select 1
		from public.qorpera_profile_members as member
		where member.user_id = p_user_id and member.role = 'owner'
			and (select sum(usage.bytes)::bigint from public.qorpera_folder_storage_usage as usage
				where usage.profile_id = member.profile_id)
				> (select min(file.storage_limit_bytes) from public.qorpera_company_files as file
					where file.profile_id = member.profile_id)
	) then$new$
]);

-- WHY: Eliminate O(U^2) JSONB rebuilds, bulk-lock contiguous same-mode path runs in strict C key order,
-- and bulk-verify write manifests and write authority once per commit instead of per unit.
select pg_temp.w6d_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure, array[
$old$	v_outcomes jsonb := '[]'::jsonb; v_saved integer := 0; v_seq bigint; v_version uuid;$old$,
$new$	v_outcomes jsonb := '[]'::jsonb; v_outcome_list jsonb[] := '{}'::jsonb[]; v_saved integer := 0; v_seq bigint; v_version uuid;$new$,
$old$	v_locks jsonb := '{}'::jsonb; v_claims text[] := '{}'; v_lock record; v_invalid boolean; v_objects text[];$old$,
$new$	v_lock_keys text[] := '{}'; v_lock_paths text[] := '{}'; v_lock_modes text[] := '{}';
	v_claims text[] := '{}'; v_lock record; v_sub record; v_locked_shas bytea[]; v_inserted_shas bytea[]; v_inserted_keys text[];
	v_lock_subxids integer := 0; v_short boolean := false;
	v_write_proofs jsonb := '{}'::jsonb; v_write_status text; v_write_allowed boolean[]; v_can_precheck_write boolean := false;
	v_git_other_unsaved boolean := false; v_invalid boolean; v_objects text[];$new$,
$old$	v_parked jsonb := '[]'::jsonb; v_proposal_id uuid := extensions.gen_random_uuid();$old$,
$new$	v_parked jsonb := '[]'::jsonb; v_parked_list jsonb[] := '{}'::jsonb[]; v_proposal_id uuid := extensions.gen_random_uuid();$new$,
$old$	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		foreach v_ancestor in array public.qorpera_folder_ancestors(v_path) || coalesce(public.qorpera_folder_ancestors(v_to), '{}') loop
			v_key := public.qorpera_folder_key(v_ancestor);
			if octet_length(v_key) <= c_key_bound and not v_locks ? v_key then
				v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_ancestor, 'mode', 'keyshare'));
			end if;
		end loop;
		v_key := public.qorpera_folder_key(v_path);
		if octet_length(v_key) <= c_key_bound then
			v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_path, 'mode', 'update'));
		end if;
		v_key := public.qorpera_folder_key(v_to);
		if octet_length(v_key) <= c_key_bound then
			v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_to, 'mode', 'update'));
		end if;
	end loop;$old$,
$new$	with unit_paths as (
		select u.ord::integer as ord,
			case when u.val ->> 'op' in ('move','copy') then u.val ->> 'from' else u.val ->> 'path' end as src_path,
			u.val ->> 'to' as dst_path
		from jsonb_array_elements(p_units) with ordinality as u(val, ord)
	),
	raw_locks as (
		select public.qorpera_folder_key(anc.path) collate "C" as k, anc.path, 'keyshare'::text as mode, 0 as prio, up.ord
		from unit_paths up
		cross join lateral unnest(public.qorpera_folder_ancestors(up.src_path)
			|| coalesce(public.qorpera_folder_ancestors(up.dst_path), '{}')) as anc(path)
		union all
		select public.qorpera_folder_key(up.src_path) collate "C", up.src_path, 'update'::text, 1, up.ord
		from unit_paths up
		where up.src_path is not null
		union all
		select public.qorpera_folder_key(up.dst_path) collate "C", up.dst_path, 'update'::text, 2, up.ord
		from unit_paths up
		where up.dst_path is not null
	),
	merged as (
		select distinct on (rl.k) rl.k, rl.path, rl.mode
		from raw_locks rl
		where octet_length(rl.k) <= c_key_bound
		order by rl.k, (rl.mode = 'update') desc, rl.ord desc, rl.prio desc
	)
	select coalesce(array_agg(m.k order by m.k), '{}'),
		coalesce(array_agg(m.path order by m.k), '{}'),
		coalesce(array_agg(m.mode order by m.k), '{}')
	into v_lock_keys, v_lock_paths, v_lock_modes
	from merged m;$new$,
$old$	for v_lock in select l.key collate "C" as key, l.value ->> 'path' as path, l.value ->> 'mode' as mode
		from jsonb_each(v_locks) l order by l.key collate "C" loop
		if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_lock.mode) then
			v_claims := v_claims || v_lock.key;
		end if;
	end loop;$old$,
$new$	if cardinality(v_lock_keys) > 0 then
		for v_sub in
			with req as (
				select u.ord,
					u.k collate "C" as k,
					u.p as path,
					u.m as mode,
					extensions.digest(u.k, 'sha256') as key_sha256,
					exists (
						select 1 from public.qorpera_folder_entries e
						where e.environment_id = p_environment_id and e.key_sha256 = extensions.digest(u.k, 'sha256')
					) as exists_now
				from unnest(v_lock_keys, v_lock_paths, v_lock_modes) with ordinality as u(k, p, m, ord)
			),
			marked as (
				select req.*,
					case when lag(req.mode) over (order by req.ord) is distinct from req.mode
						or lag(req.exists_now) over (order by req.ord) is distinct from req.exists_now
						then 1 else 0 end as step_break
				from req
			),
			grouped as (
				select marked.*, sum(step_break) over (order by marked.ord) as grp
				from marked
			)
			select g.grp,
				(array_agg(g.mode order by g.ord))[1] as mode,
				(array_agg(g.exists_now order by g.ord))[1] as exists_now,
				array_agg(g.k order by g.ord) as keys,
				array_agg(g.path order by g.ord) as paths,
				array_agg(g.key_sha256 order by g.ord) as key_shas
			from grouped g
			group by g.grp
			order by g.grp
		loop
			if cardinality(v_sub.keys) = 1 or v_lock_subxids >= 32 then
				for v_lock in
					select u.k, u.p as path
					from unnest(v_sub.keys, v_sub.paths) with ordinality as u(k, p, ord)
					order by u.ord
				loop
					if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_sub.mode) then
						v_claims := array_append(v_claims, v_lock.k);
					end if;
				end loop;
			else
				v_lock_subxids := v_lock_subxids + 1;
				v_short := false;
				begin
					if v_sub.exists_now then
						if v_sub.mode = 'update' then
							select coalesce(array_agg(s.key_sha256), '{}') into v_locked_shas
							from (
								select e.key_sha256 from public.qorpera_folder_entries e
								where e.environment_id = p_environment_id and e.key_sha256 = any (v_sub.key_shas)
								order by e.key_text collate "C"
								for update
							) s;
						else
							select coalesce(array_agg(s.key_sha256), '{}') into v_locked_shas
							from (
								select e.key_sha256 from public.qorpera_folder_entries e
								where e.environment_id = p_environment_id and e.key_sha256 = any (v_sub.key_shas)
								order by e.key_text collate "C"
								for key share
							) s;
						end if;
						if cardinality(v_locked_shas) < cardinality(v_sub.keys) then
							raise exception using errcode = 'Q6D01';
						end if;
					else
						with inserted as (
							insert into public.qorpera_folder_entries(environment_id, path, kind)
							select p_environment_id, u.p, 'claim'
							from unnest(v_sub.paths) with ordinality as u(p, ord)
							order by u.ord
							on conflict (environment_id, key_sha256) do nothing
							returning key_text, key_sha256
						)
						select coalesce(array_agg(key_text), '{}'), coalesce(array_agg(key_sha256), '{}')
						into v_inserted_keys, v_inserted_shas
						from inserted;
						if cardinality(v_inserted_shas) < cardinality(v_sub.keys) then
							raise exception using errcode = 'Q6D01';
						end if;
						v_claims := v_claims || v_inserted_keys;
					end if;
				exception when sqlstate 'Q6D01' then
					v_short := true;
				end;
				if v_short then
					for v_lock in
						select u.k, u.p as path
						from unnest(v_sub.keys, v_sub.paths) with ordinality as u(k, p, ord)
						order by u.ord
					loop
						if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_sub.mode) then
							v_claims := array_append(v_claims, v_lock.k);
						end if;
					end loop;
				end if;
			end if;
		end loop;
	end if;$new$,
$old$	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is
	-- decided. Failures are outcomes, not exceptions.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop$old$,
$new$	with write_units as materialized (
		select u.ord::integer as unit_no,
			u.val -> 'file' ->> 'manifestSha256' as manifest_sha256,
			u.val -> 'file' ->> 'fileSha256' as file_sha256,
			(u.val -> 'file' ->> 'bytes')::bigint as bytes,
			u.val -> 'file' ->> 'mediaType' as media_type,
			(u.val -> 'file' ->> 'executable')::boolean as executable
		from jsonb_array_elements(p_units) with ordinality as u(val, ord)
		where u.val ->> 'op' = 'write'
			and jsonb_typeof(u.val -> 'file' -> 'executable') = 'boolean'
			and coalesce(u.val -> 'file' ->> 'mediaType', '') ~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
			and coalesce(u.val -> 'file' ->> 'bytes', '') ~ '^[0-9]{1,15}$'
	),
	distinct_specs as materialized (
		select distinct manifest_sha256, file_sha256, bytes
		from write_units
		where manifest_sha256 is not null and file_sha256 is not null
	),
	proofs as materialized (
		select distinct on (ds.manifest_sha256, ds.file_sha256, ds.bytes)
			ds.manifest_sha256, ds.file_sha256, ds.bytes,
			v.verifier_version, v.objects, v.media_type, v.executable
		from distinct_specs ds
		join public.qorpera_verified_company_file_objects v
			on v.profile_id = v_file.profile_id
			and v.manifest_sha256 = ds.manifest_sha256
			and v.file_sha256 = ds.file_sha256
			and v.bytes = ds.bytes
		order by ds.manifest_sha256, ds.file_sha256, ds.bytes, v.verifier_version desc
	),
	locked_set as materialized (
		select distinct sha256 from unnest(v_objects) as t(sha256)
	),
	proof_objs_ok as materialized (
		select p.manifest_sha256, p.file_sha256, p.bytes,
			not exists (
				select 1
				from jsonb_array_elements(p.objects) as o
				left join locked_set ls on ls.sha256 = o ->> 'sha256'
				left join public.qorpera_profile_objects po
					on po.profile_id = v_file.profile_id
					and po.sha256 = o ->> 'sha256'
					and po.bytes = (o ->> 'bytes')::bigint
				where ls.sha256 is null or po.sha256 is null
			) as objs_ok
		from proofs p
	),
	v2_manifests as materialized (
		select distinct p.manifest_sha256
		from proofs p
		join proof_objs_ok ok using (manifest_sha256, file_sha256, bytes)
		where ok.objs_ok
			and p.verifier_version = 2
			and v_bytes_actor ->> 'kind' is distinct from 'platform'
	),
	sealed_manifests as materialized (
		select distinct vm.manifest_sha256
		from v2_manifests vm
		join public.qorpera_folder_upload_intents i
			on i.environment_id = p_environment_id
			and i.manifest_sha256 = vm.manifest_sha256
			and i.state = 'sealed'
			and i.expires_at > clock_timestamp()
			and i.actor_kind = v_bytes_actor ->> 'kind'
			and i.scope_id = public.qorpera_folder_upload_scope(v_bytes_actor)
	),
	readable_manifests as materialized (
		select vm.manifest_sha256
		from v2_manifests vm
		where not exists (select 1 from sealed_manifests sm where sm.manifest_sha256 = vm.manifest_sha256)
			and public.qorpera_folder_object_readable(p_environment_id, v_file.profile_id, v_auth_actor, vm.manifest_sha256)
	)
	select coalesce(jsonb_object_agg(wu.unit_no::text,
		case
			when p.manifest_sha256 is null then 'bytes_unverified'
			when p.verifier_version = 2 and (p.media_type is distinct from wu.media_type
				or p.executable is distinct from wu.executable) then 'mismatch'
			when not coalesce(ok.objs_ok, false) then 'bytes_unverified'
			when p.verifier_version = 2 and v_bytes_actor ->> 'kind' is distinct from 'platform'
				and sm.manifest_sha256 is null and rm.manifest_sha256 is null then 'bytes_unverified'
			else 'ok'
		end), '{}'::jsonb)
	into v_write_proofs
	from write_units wu
	left join proofs p using (manifest_sha256, file_sha256, bytes)
	left join proof_objs_ok ok using (manifest_sha256, file_sha256, bytes)
	left join sealed_manifests sm on sm.manifest_sha256 = p.manifest_sha256
	left join readable_manifests rm on rm.manifest_sha256 = p.manifest_sha256;

	v_can_precheck_write := v_actor_kind in ('member','run','view')
		and v_credits_unit is null
		and jsonb_array_length(p_units) > 1
		and not exists (
			select 1 from unnest(v_lock_keys) k
			where split_part(k, '/', 1) in ('qorperaos', 'rules')
		);
	if v_can_precheck_write then
		with rules as materialized (
			select r.rkey collate "C" as rkey,
				r.rkey_prefix collate "C" as rkey_prefix,
				r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed
			from public.qorpera_folder_actor_rules(p_environment_id, v_file.profile_id, v_auth_actor, 'write') r
		),
		simple_units as (
			select u.ord::integer as unit_no,
				u.val ->> 'op' as op,
				case when u.val ->> 'op' in ('write','mkdir','symlink')
					then public.qorpera_folder_key(u.val ->> 'path') collate "C" end as k,
				case when u.val ->> 'op' in ('write','mkdir','symlink')
					then u.val ->> 'path' end as p
			from jsonb_array_elements(p_units) with ordinality as u(val, ord)
		)
		select array_agg(
			case when su.op not in ('write','mkdir','symlink') then null
				when v_auth_actor ->> 'sessionKind' = 'coding' and public.qorpera_folder_coding_protected(su.k) then false
				when public.qorpera_folder_code_host_outside(v_auth_actor, su.p) then false
				when split_part(su.k, '/', 1) in ('credentials', 'secrets') then false
				when cov.allowed is true and not cov.is_shared and not (
					split_part(su.k, '/', 1) = 'members'
					and split_part(su.k, '/', 3) = 'private'
					and (cov.scope is distinct from 'member_private'
						or cov.owner_user_id::text is distinct from split_part(su.k, '/', 2))
				) then true
				else false
			end
			order by su.unit_no
		)
		into v_write_allowed
		from simple_units su
		left join lateral (
			select r.scope, r.owner_user_id, r.is_shared, r.allowed
			from rules r
			where su.k is not null
				and (r.rkey = su.k
					or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(su.k, r.rkey_prefix))))
			order by r.rkey_len desc, r.resource_id
			limit 1
		) cov on true;
	end if;

	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is
	-- decided. Failures are outcomes, not exceptions.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop$new$,
$old$		if v_git_group is not null and v_ok and v_key = any(v_git_group) and exists (select 1 from jsonb_array_elements(v_outcomes) o
			where o ->> 'outcome' <> 'saved' and public.qorpera_folder_key(o ->> 'path') <> all(v_git_group)) then
			v_ok := false; v_reason := 'git_objects_unsaved'; end if;$old$,
$new$		if v_git_group is not null and v_ok and v_key = any(v_git_group) and v_git_other_unsaved then
			v_ok := false; v_reason := 'git_objects_unsaved'; end if;$new$,
$old$			if v_op in ('write','mkdir','symlink') then
				v_ok := public.qorpera_folder_actor_allowed(p_environment_id, v_file.profile_id, v_auth_actor, v_path, 'write');$old$,
$new$			if v_op in ('write','mkdir','symlink') then
				if v_can_precheck_write then
					v_ok := coalesce(v_write_allowed[v_no], false);
				else
					v_ok := public.qorpera_folder_actor_allowed(p_environment_id, v_file.profile_id, v_auth_actor, v_path, 'write');
				end if;$new$,
$old$			elsif public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, v_bytes_actor, v_auth_actor,
				v_file_json, v_objects) is not null then
				v_ok := false; v_reason := 'bytes_unverified';
			end if;$old$,
$new$			else
				v_write_status := v_write_proofs ->> v_no::text;
				if v_write_status = 'mismatch' then
					raise exception 'File reference does not match its manifest' using errcode = '22023';
				elsif v_write_status is distinct from 'ok' then
					v_ok := false; v_reason := 'bytes_unverified';
				end if;
			end if;$new$,
$old$					v_parked := v_parked || jsonb_build_array(jsonb_build_object('no', v_no, 'unit', v_unit - 'credits', -- 20260930421000
						'path', v_eff_path,
						'to', v_eff_to));$old$,
$new$					v_parked_list := array_append(v_parked_list, jsonb_build_object('no', v_no, 'unit', v_unit - 'credits', -- 20260930421000
						'path', v_eff_path,
						'to', v_eff_to));$new$,
$old$		v_outcomes := v_outcomes || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('unit', v_no, 'op', v_op,
			'path', case when v_ok and v_op not in ('move','copy') then v_eff_path else v_path end,
			'to', case when v_ok then v_eff_to else v_to end, 'version', v_version,
			'outcome', case when v_ok then 'saved' when v_reason in ('denied','review_required','review_denied') then 'denied'
				when v_reason in ('waiting_for_review','parked') then 'waiting_for_review'
				when v_reason in ('version_changed','exists','unseen_change','missing') then 'conflict' else 'refused' end,
			'reason', v_reason, 'problems', v_problems)));
	end loop;$old$,
$new$		if not v_ok and v_git_group is not null and v_key <> all(v_git_group) then
			v_git_other_unsaved := true;
		end if;
		v_outcome_list := array_append(v_outcome_list, jsonb_strip_nulls(jsonb_build_object('unit', v_no, 'op', v_op,
			'path', case when v_ok and v_op not in ('move','copy') then v_eff_path else v_path end,
			'to', case when v_ok then v_eff_to else v_to end, 'version', v_version,
			'outcome', case when v_ok then 'saved' when v_reason in ('denied','review_required','review_denied') then 'denied'
				when v_reason in ('waiting_for_review','parked') then 'waiting_for_review'
				when v_reason in ('version_changed','exists','unseen_change','missing') then 'conflict' else 'refused' end,
			'reason', v_reason, 'problems', v_problems)));
	end loop;
	v_outcomes := to_jsonb(v_outcome_list);
	v_parked := to_jsonb(v_parked_list);$new$,
$old$	delete from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'claim'
		and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));$old$,
$new$	if cardinality(v_claims) > 0 then
		delete from public.qorpera_folder_entries e
		where e.environment_id = p_environment_id and e.kind = 'claim'
			and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));
	end if;$new$
]);

drop function pg_temp.w6d_patch(regprocedure, text[]);
