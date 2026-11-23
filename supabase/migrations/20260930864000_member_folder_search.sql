create function public.qorpera_member_folder_search(p_environment_id uuid, p_query text, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id);
	v_auth jsonb;
	v_profile uuid;
	v_last_seq bigint;
	v_words text[];
	v_code_host boolean;
	v_entries jsonb;
	v_more boolean;
begin
	v_auth := public.qorpera_folder_read_actor(p_environment_id, v_actor);
	v_words := array(select distinct word from regexp_split_to_table(lower(btrim(coalesce(p_query, ''))), '\s+') as word
		where word <> '');
	if p_query is null or char_length(p_query) > 200 or cardinality(v_words) not between 1 and 8
		or p_limit is null or p_limit not between 1 and 50 then
		raise exception 'Search is invalid' using errcode = '22023'; end if;
	select f.profile_id, k.last_seq into v_profile, v_last_seq
	from public.qorpera_folder_clocks k
	join public.qorpera_company_files f on f.environment_id = k.environment_id
	where k.environment_id = p_environment_id and f.core = 'folder-v2';
	if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_code_host := coalesce(v_auth -> 'view' ->> 'kind' = 'code_host', false);

	with rules as materialized (
		select r.rkey collate "C" as rkey, r.rkey_prefix collate "C" as rkey_prefix,
			r.rkey_len, r.resource_id, r.path_match, r.scope, r.owner_user_id, r.is_shared, r.allowed
		from public.qorpera_folder_actor_rules(p_environment_id, v_profile, v_auth, 'read') r
	),
	named as materialized (
		select e.path, e.key_text, e.kind, e.version, e.commit_id, e.manifest_sha256, e.file_sha256, e.bytes,
			e.media_type, e.executable, e.updated_at,
			case when starts_with(lower(regexp_replace(e.path, '^.*/', '')), v_words[1]) then 0
				when not exists (select 1 from unnest(v_words) as w(word)
					where strpos(lower(regexp_replace(e.path, '^.*/', '')), w.word) = 0) then 1
				else 2 end as rank
		from public.qorpera_folder_entries e
		where e.environment_id = p_environment_id and e.kind <> 'claim'
			and not exists (select 1 from unnest(v_words) as w(word) where strpos(lower(e.path), w.word) = 0)
			and split_part(e.key_text, '/', 1) not in ('credentials', 'secrets')
			and (not v_code_host or e.key_text = 'code' or (e.key_text >= 'code/' collate "C" and e.key_text < 'code0' collate "C"))
	),
	readable as materialized (
		select n.*
		from named n
		cross join lateral (
			select r.scope, r.owner_user_id, r.is_shared, r.allowed
			from rules r
			where r.rkey = n.key_text
				or (r.path_match = 'subtree' and (r.rkey = '' or starts_with(n.key_text, r.rkey_prefix)))
			order by r.rkey_len desc, r.resource_id
			limit 1
		) cov
		where cov.allowed and not cov.is_shared
			and not (
				split_part(n.key_text, '/', 1) = 'members'
				and split_part(n.key_text, '/', 3) = 'private'
				and (cov.scope is distinct from 'member_private'
					or cov.owner_user_id::text is distinct from split_part(n.key_text, '/', 2))
			)
		order by n.rank, char_length(n.path), n.key_text collate "C"
		limit p_limit + 1
	)
	select coalesce((
			select jsonb_agg(public.qorpera_folder_entry_json(p.path, p.kind, p.version, c.seq, p.manifest_sha256,
				p.file_sha256, p.bytes, p.media_type, p.executable, p.updated_at)
				order by p.rank, char_length(p.path), p.key_text collate "C")
			from (select * from readable order by rank, char_length(path), key_text collate "C" limit p_limit) p
			join public.qorpera_folder_commits c on c.id = p.commit_id), '[]'::jsonb),
		(select count(*) from readable) > p_limit
	into v_entries, v_more;

	return jsonb_build_object('schema', 'qorpera.folder-search/v1', 'asOfSeq', v_last_seq, 'entries', v_entries,
		'more', v_more);
end $$;

revoke all on function public.qorpera_member_folder_search(uuid, text, integer) from public, anon;
grant execute on function public.qorpera_member_folder_search(uuid, text, integer) to authenticated;
