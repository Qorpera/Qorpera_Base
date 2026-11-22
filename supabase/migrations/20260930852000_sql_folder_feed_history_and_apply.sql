-- WHY: Batch folder feed/history authority checks and replace generic-plan-defeated LIKE scans with C-collated range bounds.

create function pg_temp.folder_perf_patch(p_target regprocedure, p_pairs text[])
returns void
language plpgsql
as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer := 1;
	v_old text;
	v_new text;
	v_hits integer;
begin
	while v_index <= cardinality(p_pairs) loop
		v_old := p_pairs[v_index];
		v_new := p_pairs[v_index + 1];
		v_hits := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
		if v_hits <> 1 then
			raise exception '20260930852000 anchor found % time(s) in %, expected 1: %',
				v_hits, p_target, left(v_old, 90);
		end if;
		v_definition := replace(v_definition, v_old, v_new);
		v_index := v_index + 2;
	end loop;
	execute v_definition;
end $$;

-- WHY: Batch path and move_in prior-path authority checks in qorpera_folder_feed once per change set instead of row-by-row.
select pg_temp.folder_perf_patch(
	'public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)'::regprocedure,
	array[
		$old$		), shown as materialized (
			select p.* from page p
			where v_kind = 'platform' or public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth, p.path, 'read')
		)
		select (select count(*) from page)::integer,
			(select p.unit_no from page p order by p.unit_no desc, p.version desc limit 1),
			(select p.version from page p order by p.unit_no desc, p.version desc limit 1),
			(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('unitNo', s.unit_no, 'op', s.op,
					'kind', s.kind, 'path', s.path, 'version', s.version,
					'priorVersion', case when s.op <> 'move_in' or v_kind = 'platform'
						or public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_auth,
							(select w.path from public.qorpera_folder_path_versions w where w.version = s.prior_version), 'read')
						then s.prior_version end,
					'manifestSha256', s.manifest_sha256, 'fileSha256', s.file_sha256, 'bytes', s.bytes,
					'mediaType', s.media_type, 'executable', s.executable, 'target', s.target, 'updatedAt', e.updated_at))
					order by s.unit_no, s.version), '[]'::jsonb)
				from shown s left join public.qorpera_folder_entries e on e.environment_id = p_environment_id
					and e.key_sha256 = s.key_sha256 and e.version = s.version)
		into v_fetched, v_last_unit, v_last_version, v_changes;$old$,
		$new$		), priors as materialized (
			-- WHY: Resolve move_in prior paths once for the bounded page and check them in the same set-based authority pass.
			select p.version, w.path as prior_path
			from page p
			join public.qorpera_folder_path_versions w on w.version = p.prior_version
			where v_kind <> 'platform' and p.op = 'move_in' and p.prior_version is not null
		), auth as materialized (
			select a.path, a.ok
			from public.qorpera_folder_paths_authority(
				p_environment_id,
				v_profile,
				v_auth,
				array(
					select p.path from page p
					union
					select pr.prior_path from priors pr
				)
			) a
			where v_kind <> 'platform'
		), shown as materialized (
			select p.*,
				(v_kind = 'platform' or p.op <> 'move_in' or coalesce(ap.ok, false)) as show_prior
			from page p
			left join priors pr on pr.version = p.version
			left join auth a on v_kind <> 'platform' and a.path collate "C" = p.path
			left join auth ap on v_kind <> 'platform' and p.op = 'move_in' and ap.path collate "C" = pr.prior_path
			where v_kind = 'platform' or coalesce(a.ok, false)
		)
		select (select count(*) from page)::integer,
			(select p.unit_no from page p order by p.unit_no desc, p.version desc limit 1),
			(select p.version from page p order by p.unit_no desc, p.version desc limit 1),
			(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('unitNo', s.unit_no, 'op', s.op,
					'kind', s.kind, 'path', s.path, 'version', s.version,
					'priorVersion', case when s.show_prior then s.prior_version end,
					'manifestSha256', s.manifest_sha256, 'fileSha256', s.file_sha256, 'bytes', s.bytes,
					'mediaType', s.media_type, 'executable', s.executable, 'target', s.target, 'updatedAt', e.updated_at))
					order by s.unit_no, s.version), '[]'::jsonb)
				from shown s left join public.qorpera_folder_entries e on e.environment_id = p_environment_id
					and e.key_sha256 = s.key_sha256 and e.version = s.version)
		into v_fetched, v_last_unit, v_last_version, v_changes;$new$
	]
);

-- WHY: Batch member history path authority checks in 64-row keyset chunks to preserve the 10,000-version work bound while avoiding per-row scans.
select pg_temp.folder_perf_patch(
	'public.qorpera_member_folder_history(uuid,bigint,integer)'::regprocedure,
	array[
		$old$	v_repo text; v_repos text[]; v_repo_path text; -- 20260930446400$old$,
		$new$	v_repo text; v_repos text[]; v_repo_path text; -- 20260930446400
	v_chunk_unit integer; v_chunk_version uuid; v_chunk_limit integer; v_chunk_rows integer;$new$,
		$old$		v_seen := 0; v_found := 0; v_paths := '[]'; v_repos := '{}';$old$,
		$new$		v_seen := 0; v_found := 0; v_paths := '[]'; v_repos := '{}';
		v_chunk_unit := 0; v_chunk_version := '00000000-0000-0000-0000-000000000000';$new$,
		$old$		for v_version in select version.path, version.op, version.kind, version.version
			from public.qorpera_folder_path_versions as version
			where version.commit_id = (v_journal.commit_row).id
			order by version.unit_no, version.version$old$,
		$new$		<<chunks>>
		loop
			v_chunk_limit := least(64, v_cap + 1 - v_seen);
			exit chunks when v_chunk_limit <= 0;
			v_chunk_rows := 0;
			for v_version in
				-- WHY: Resolve covering resources and read authority per 64-row keyset chunk so readable commits stop near row 21.
				with rows as materialized (
					select version.unit_no, version.path, version.op, version.kind, version.version
					from public.qorpera_folder_path_versions as version
					where version.commit_id = (v_journal.commit_row).id
						and (version.unit_no, version.version) > (v_chunk_unit, v_chunk_version)
					order by version.unit_no, version.version$new$,
		$old$			limit v_cap + 1
		loop
			v_seen := v_seen + 1;
			exit when v_seen > v_cap;$old$,
		$new$					limit v_chunk_limit
				), auth as materialized (
					select a.path, a.ok
					from public.qorpera_folder_paths_authority(
						p_environment_id,
						v_profile,
						v_actor,
						array(select r.path from rows r)
					) a
				)
				select r.unit_no, r.path, r.op, r.kind, r.version, coalesce(a.ok, false) as allowed
				from rows r
				left join auth a on a.path collate "C" = r.path
				order by r.unit_no, r.version
			loop
				v_chunk_rows := v_chunk_rows + 1;
				v_chunk_unit := v_version.unit_no;
				v_chunk_version := v_version.version;
				v_seen := v_seen + 1;
				exit chunks when v_seen > v_cap;$new$,
		$old$			if (v_repo is null or not v_repo = any(v_repos))
					and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, v_version.path, 'read') then
				v_found := v_found + 1;
				exit when v_found > 20;$old$,
		$new$			if (v_repo is null or not v_repo = any(v_repos)) and v_version.allowed then
				v_found := v_found + 1;
				exit chunks when v_found > 20;$new$,
		$old$			end if;
		end loop;
		-- The budget ran out inside this change set: it goes whole to the next page.$old$,
		$new$			end if;
			end loop;
			exit chunks when v_chunk_rows < v_chunk_limit;
		end loop chunks;
		-- The budget ran out inside this change set: it goes whole to the next page.$new$
	]
);

-- WHY: Combine delete version logging and removal into one pass and replace LIKE with C-collated range bounds for generic plans.
select pg_temp.folder_perf_patch(
	'public.qorpera_folder_apply_unit(uuid,uuid,integer,text,text,text,jsonb)'::regprocedure,
	array[
		$old$		insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
			commit_id, unit_no)
		select case when e.key_sha256 = v_row.key_sha256 then v_version else extensions.gen_random_uuid() end,
			p_environment_id, e.path, e.key_sha256, e.version, 'delete', e.kind, p_commit_id, p_unit_no
		from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
			and (e.key_sha256 = v_row.key_sha256 or (v_row.kind = 'folder' and e.key_text like public.qorpera_folder_under(v_row.key_text)));
		get diagnostics v_expected = row_count;
		delete from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
			and (e.key_sha256 = v_row.key_sha256 or (v_row.kind = 'folder' and e.key_text like public.qorpera_folder_under(v_row.key_text)));
		get diagnostics v_placed = row_count;$old$,
		$new$		-- WHY: Single-pass DELETE ... RETURNING avoids scanning the subtree twice and keeps qorpera_folder_entries_key_text usable in generic plans.
		if v_row.kind = 'folder' then
			with removed as (
				delete from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and (e.key_sha256 = v_row.key_sha256
						or (e.key_text >= (v_row.key_text || '/') collate "C"
							and e.key_text < (v_row.key_text || '0') collate "C"))
				returning e.path, e.key_sha256, e.version, e.kind
			), logged as (
				insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
					commit_id, unit_no)
				select case when r.key_sha256 = v_row.key_sha256 then v_version else extensions.gen_random_uuid() end,
					p_environment_id, r.path, r.key_sha256, r.version, 'delete', r.kind, p_commit_id, p_unit_no
				from removed r
				returning 1
			)
			select (select count(*) from removed), (select count(*) from logged) into v_expected, v_placed;
		else
			with removed as (
				delete from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_sha256 = v_row.key_sha256
				returning e.path, e.key_sha256, e.version, e.kind
			), logged as (
				insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, prior_version, op, kind,
					commit_id, unit_no)
				select v_version, p_environment_id, r.path, r.key_sha256, r.version, 'delete', r.kind, p_commit_id, p_unit_no
				from removed r
				returning 1
			)
			select (select count(*) from removed), (select count(*) from logged) into v_expected, v_placed;
		end if;$new$,
		$old$			from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
				and (e.key_sha256 = v_row.key_sha256 or (v_row.kind = 'folder' and e.key_text like public.qorpera_folder_under(v_row.key_text)))
		), moved_out as ($old$,
		$new$			from public.qorpera_folder_entries e where e.environment_id = p_environment_id and e.kind <> 'claim'
				and (e.key_sha256 = v_row.key_sha256
					or (v_row.kind = 'folder'
						and e.key_text >= (v_row.key_text || '/') collate "C"
						and e.key_text < (v_row.key_text || '0') collate "C"))
		), moved_out as ($new$
	]
);

-- WHY: Replace LIKE qorpera_folder_under with C-collated range bounds so subtree authority and git rule checks keep using qorpera_folder_entries_key_text under generic plans.
select pg_temp.folder_perf_patch(
	'public.qorpera_folder_actor_subtree_allowed(uuid,uuid,jsonb,text,text,text)'::regprocedure,
	array[
		$old$			where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(p_from_key)),$old$,
		$new$			where e.environment_id = p_environment_id and e.kind <> 'claim'
				and e.key_text >= (p_from_key || '/') collate "C"
				and e.key_text < (p_from_key || '0') collate "C"),$new$
	]
);

select pg_temp.folder_perf_patch(
	'public.qorpera_folder_git_unit_refusal(uuid,jsonb,text,text,text,uuid)'::regprocedure,
	array[
		$old$			and (e.key_text = p_key or e.key_text like public.qorpera_folder_under(p_key))$old$,
		$new$			and (e.key_text = p_key collate "C"
				or (e.key_text >= (p_key || '/') collate "C" and e.key_text < (p_key || '0') collate "C"))$new$,
		$old$				and e.key_text like public.qorpera_folder_under(p_key)) t$old$,
		$new$				and e.key_text >= (p_key || '/') collate "C" and e.key_text < (p_key || '0') collate "C") t$new$
	]
);

drop function pg_temp.folder_perf_patch(regprocedure, text[]);
