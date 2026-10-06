-- Agent memory tree, W1a: block-history requests (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10 step 3 and §16).
-- A message erase or a step erase deletes a tree or log block and rewrites it, then asks P18 to erase the block's
-- earlier versions, one request per block, through qorpera_folder_erase_block_history:
-- * The request is the platform's, for the member who asked: no role is asked (the member may have left since), it
--   erases with owner authority through the platform actor, and another member's private paths do not stop it.
-- * Its operation key is fixed: memtree: and the hex SHA-256 of the erase row's table, its id and the block's folded
--   key. The prefix is reserved: P18 refuses it on every other request. The digest covers the block, its cutoff and
--   the erase row, not the partners, and is kept after done, with the copies and what the request was for, so a
--   carrier that asks again after done finds them.
-- * With a cutoff, the block is cut at the delete it names, live again or not, and the delete and all after it stay.
--   A delete already erased (by a later cutoff's request or a member's erasure) leaves nothing before it once that
--   erasure is past its versions phase: the request answers nothing left, or is asked again (55006) while that phase
--   runs. It is never refused for good (§10.1).
-- * With none, the block must not be live, and every life of it is erased; a block live again, or renamed to a live
--   path since step 1, is refused (55000 'Block is live again'), naming the live path, the key's newest life and the
--   newest delete before that life. That life is the tree built again by the next run (a member's restore leaves out
--   every path under a tree root: contract, 2026-10-06 amendment, item 2), or another tree's block at a name reused
--   since the delete. The carrier asks again with that delete as its cutoff and that life, or, with no delete (an
--   erasure took it and every version before it), has nothing left at the name.
-- * A cutoff request that names a life is refused the same way, under the path lock, when the key has had a newer life
--   since (that life deleted and a new one begun); the carrier goes round again.
-- * While an erasure over the key is in its versions phase and no delete is left, both refusals ask again (55006).
-- * Moves are followed: the wrapper adds each partner P18 names and asks again. In a request with a cutoff, or for an
--   older life, a life that moved on to a live path is another tree's block and is left alone, not refused. There is
--   no limit of 20 paths, and every copy is named.
-- * Nothing left to erase answers erasureId null, with no row (asking again erases nothing more).
-- * Its P18 row notes no run in phases 1 to 3: the run-log row (W1d) reaches only the steps that showed its blocks.
-- * qorpera_folder_erasure_past_versions tells a carrier when a request is past P18's versions phase (§10.1: a row
--   waits only for that phase, never for the request's done).
-- Every patched body carries the marker 20260930120000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.w1a_replace(p_function regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'W1a anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The request on the erasure row ----------------------------------------------------------------------------------

alter table public.qorpera_folder_erasures
	add column block_history jsonb check (block_history is null or jsonb_typeof(block_history) = 'object');
comment on column public.qorpera_folder_erasures.block_history is
	'A block-history request (RUNTIME-AGENT-MEMORY-TREE.md §10 step 3): {path, cutoffSeq, cutoffUnit, lifeSeq, lifeUnit, for: {table, id}}, the cutoff and the life each optional; null for a member''s erasure.';

-- The live path a key's newest life moved on to, through renames, when that path's life began with those moves; else
-- null. For a block that is not live, that is the tree built again and renamed since step 1 deleted it, or a reused
-- name's block renamed since (§10 step 3). An older life that moved on is left alone: the key's newest row is then not
-- that move.
create function public.qorpera_folder_erasure_moved_live(p_environment_id uuid, p_key text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_key text := p_key; v_last record; v_to record; v_start record; v_path text;
begin
	-- Each hop's newest row is later than the last, so the chain ends; the bound only guards it.
	for i in 1..1000 loop
		select v.op, v.commit_id, v.unit_no, v.prior_version into v_last
		from public.qorpera_folder_path_versions v join public.qorpera_folder_commits c on c.id = v.commit_id
		where v.environment_id = p_environment_id and v.key_sha256 = extensions.digest(v_key, 'sha256') and c.seq is not null
		order by c.seq desc, v.unit_no desc, (v.op = 'move_in') desc
		limit 1;
		if not found or v_last.op <> 'move_out' then return null; end if;
		select p.path, p.version into v_to from public.qorpera_folder_path_versions p
		where p.commit_id = v_last.commit_id and p.unit_no = v_last.unit_no and p.prior_version = v_last.prior_version
			and p.op = 'move_in';
		if not found or public.qorpera_folder_key(v_to.path) = v_key then return null; end if;
		v_key := public.qorpera_folder_key(v_to.path);
		select * into v_start from public.qorpera_folder_erasure_life_start(p_environment_id, v_key);
		if v_start.version is distinct from v_to.version then return null; end if;
		select e.path into v_path from public.qorpera_folder_entries e where e.environment_id = p_environment_id
			and e.key_sha256 = extensions.digest(v_key, 'sha256') and e.kind <> 'claim';
		if found then return v_path; end if;
	end loop;
	return null;
end $$;
revoke all on function public.qorpera_folder_erasure_moved_live(uuid, text) from public, anon, authenticated, service_role;

-- What a block-history request refused as live again names (55000's detail): the live path (null only when a named
-- life has ended since), the key's newest life's start ({seq, unit}), and the newest delete at the key before that life
-- began ({seq, unit}, or null when none is left). That life, the tree built again by the next run or another tree's
-- block at a name reused since the delete, holds nothing the request is for and is left alone: the carrier asks again
-- with that delete as its cutoff and that life; with no delete, the erasure that took it took every version before it,
-- is past its versions phase (else 55006), and nothing of the block is left at the name (§10 step 3).
create function public.qorpera_folder_erasure_live_again(p_environment_id uuid, p_key text, p_live text)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('live', p_live,
		'life', (select jsonb_build_object('seq', s.seq, 'unit', s.unit_no)
			from public.qorpera_folder_erasure_life_start(p_environment_id, p_key) s),
		'delete', (
		select jsonb_build_object('seq', c.seq, 'unit', v.unit_no)
		from public.qorpera_folder_path_versions v join public.qorpera_folder_commits c on c.id = v.commit_id
		cross join public.qorpera_folder_erasure_life_start(p_environment_id, p_key) s
		where v.environment_id = p_environment_id and v.key_sha256 = extensions.digest(p_key, 'sha256') and c.seq is not null
			and v.op = 'delete' and (c.seq, v.unit_no) < (s.seq, s.unit_no)
		order by c.seq desc, v.unit_no desc
		limit 1))
$$;
revoke all on function public.qorpera_folder_erasure_live_again(uuid, text, text) from public, anon, authenticated, service_role;

-- Refuses a block-history request as live again, with that detail. With no delete left, an erasure took it with every
-- version before it; while one over the key is in its versions phase, some may still be here: asked again (55006)
-- instead, so that a null delete in the detail always means nothing is left. Both refusals raise it.
create function public.qorpera_folder_erasure_refuse_live_again(p_environment_id uuid, p_key text, p_live text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_detail jsonb := public.qorpera_folder_erasure_live_again(p_environment_id, p_key, p_live);
begin
	if jsonb_typeof(v_detail -> 'delete') = 'null' and exists (select 1 from public.qorpera_folder_erasures e
			cross join jsonb_array_elements(e.roots) r
			where e.environment_id = p_environment_id and e.done_at is null and e.phase = 1
				and public.qorpera_folder_erasure_covers(r ->> 'key', p_key)) then
		raise exception 'Block history is being erased; ask again' using errcode = '55006'; end if;
	raise exception 'Block is live again' using errcode = '55000', detail = v_detail::text;
end $$;
revoke all on function public.qorpera_folder_erasure_refuse_live_again(uuid, text, text)
	from public, anon, authenticated, service_role;

-- 2. The request: qorpera_folder_erase with a memtree actor -----------------------------------------------------------

select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	v_proposals uuid[]; -- 20260930074000 (P40)
$old$,
	$new$	v_proposals uuid[]; -- 20260930074000 (P40)
	v_memtree jsonb; v_block_key text; v_cut_at timestamptz; v_total bigint := 0; -- 20260930120000 (W1a)
	v_cut_op text; v_cut_gone boolean := false; v_cut_busy boolean := false; v_live_path text; -- 20260930120000 (W1a)
	v_life_now record; -- 20260930120000 (W1a)
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	if p_actor ->> 'kind' is distinct from 'member' or p_actor - array['kind','userId'] <> '{}'::jsonb
		or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Only a member erases' using errcode = '22023'; end if;
$old$,
	$new$	-- 20260930120000 (W1a): a block-history request is the platform's, for the member who asked:
	-- {"kind":"memtree","userId":…,"block":{"path":…,"cutoffSeq":…,"cutoffUnit":…,"lifeSeq":…,"lifeUnit":…,
	-- "for":{"table":…,"id":…}}}, the cutoff both parts or neither, the life both or neither and only with a cutoff.
	-- Its operation keys are memtree:<sha256>, a prefix no other request may use.
	if p_actor ->> 'kind' = 'memtree' then
		v_memtree := p_actor -> 'block';
		if p_actor - array['kind','userId','block'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or jsonb_typeof(v_memtree) is distinct from 'object' then
			raise exception 'Block-history request is invalid' using errcode = '22023'; end if;
		if (v_memtree ->> 'lifeSeq' is null) <> (v_memtree ->> 'lifeUnit' is null)
			or (v_memtree ->> 'lifeSeq' is not null and (v_memtree ->> 'cutoffSeq' is null
				or jsonb_typeof(v_memtree -> 'lifeSeq') <> 'number' or jsonb_typeof(v_memtree -> 'lifeUnit') <> 'number'
				or (v_memtree ->> 'lifeSeq') !~ '^[1-9][0-9]{0,17}$' or (v_memtree ->> 'lifeUnit') !~ '^[1-9][0-9]{0,8}$')) then
			raise exception 'Block-history request is invalid' using errcode = '22023'; end if;
		if v_memtree - array['path','cutoffSeq','cutoffUnit','lifeSeq','lifeUnit','for'] <> '{}'::jsonb
			or jsonb_typeof(v_memtree -> 'path') is distinct from 'string' or jsonb_typeof(v_memtree -> 'for') is distinct from 'object' then
			raise exception 'Block-history request is invalid' using errcode = '22023'; end if;
		if (v_memtree -> 'for') - array['table','id'] <> '{}'::jsonb
			or coalesce(v_memtree -> 'for' ->> 'table', '') not in ('qorpera_memory_message_erases','qorpera_memory_step_erases')
			or jsonb_typeof(v_memtree -> 'for' -> 'id') is distinct from 'string'
			or (v_memtree -> 'for' ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or (v_memtree ->> 'cutoffSeq' is null) <> (v_memtree ->> 'cutoffUnit' is null) then
			raise exception 'Block-history request is invalid' using errcode = '22023'; end if;
		if v_memtree ->> 'cutoffSeq' is not null and (jsonb_typeof(v_memtree -> 'cutoffSeq') <> 'number'
				or jsonb_typeof(v_memtree -> 'cutoffUnit') <> 'number' or (v_memtree ->> 'cutoffSeq') !~ '^[1-9][0-9]{0,17}$'
				or (v_memtree ->> 'cutoffUnit') !~ '^[1-9][0-9]{0,8}$') then
			raise exception 'Block-history request is invalid' using errcode = '22023'; end if;
	elsif p_actor ->> 'kind' is distinct from 'member' or p_actor - array['kind','userId'] <> '{}'::jsonb
		or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Only a member erases' using errcode = '22023';
	elsif p_operation_key like 'memtree:%' then
		raise exception 'Operation key is reserved for block-history requests' using errcode = '22023';
	end if;
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	if jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths) not between 1 and 20 then
$old$,
	$new$	-- 20260930120000 (W1a): a block-history request names its block and every partner P18 named, with no limit.
	if jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths) < 1
		or (v_memtree is null and jsonb_array_length(p_paths) > 20) then
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$				and split_part(v_key, '/', 3) in ('', 'private') then
$old$,
	$new$				and split_part(v_key, '/', 3) in ('', 'private')
				and v_memtree is null then -- 20260930120000 (W1a): not for the platform's block-history request
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	select role into v_role from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user;
	if v_role is null or v_role not in ('owner','admin') then
		raise exception 'Only owners and admins erase' using errcode = '42501'; end if;
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object('userId', v_user, 'roots', to_jsonb(v_keys))::text, 'utf8'),
		'sha256'), 'hex');
$old$,
	$new$	-- 20260930120000 (W1a): a block-history request asks no role. Its key is fixed by the erase row and the block, and
	-- its digest covers the block, its cutoff and the erase row, not the partners: a request the wrapper widened replays
	-- as the first.
	if v_memtree is null then
		select role into v_role from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user;
		if v_role is null or v_role not in ('owner','admin') then
			raise exception 'Only owners and admins erase' using errcode = '42501'; end if;
		v_digest := encode(extensions.digest(convert_to(jsonb_build_object('userId', v_user, 'roots', to_jsonb(v_keys))::text, 'utf8'),
			'sha256'), 'hex');
	else
		v_block_key := public.qorpera_folder_key(v_memtree ->> 'path');
		if not v_spellings ? v_block_key then
			raise exception 'Block-history request is invalid' using errcode = '22023'; end if;
		if p_operation_key <> 'memtree:' || encode(extensions.digest(convert_to((v_memtree -> 'for' ->> 'table') || ':'
				|| (v_memtree -> 'for' ->> 'id') || ':' || v_block_key, 'utf8'), 'sha256'), 'hex') then
			raise exception 'Operation key does not match the block-history request' using errcode = '22023'; end if;
		v_digest := encode(extensions.digest(convert_to(jsonb_build_object('block', v_block_key,
			'cutoffSeq', (v_memtree ->> 'cutoffSeq')::bigint, 'cutoffUnit', (v_memtree ->> 'cutoffUnit')::integer,
			'for', v_memtree -> 'for')::text, 'utf8'), 'sha256'), 'hex');
	end if;
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	v_role := public.qorpera_folder_mutator_role(v_profile, p_actor);
$old$,
	$new$	-- 20260930120000 (W1a): a block-history request erases with the platform's authority.
	v_role := public.qorpera_folder_mutator_role(v_profile,
		case when v_memtree is null then p_actor else '{"kind":"platform"}'::jsonb end);
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		v_roots := v_roots || jsonb_build_array(public.qorpera_folder_erasure_cutoff(p_environment_id, v_key, v_as_of, v_as_of_at));
$old$,
	$new$		-- 20260930120000 (W1a): a block-history request's block is cut at the delete it names, whatever came after it
		-- (its partners at their own cutoffs); with none named the block must not be live, and every life of it goes.
		if v_key = v_block_key and v_memtree ->> 'cutoffSeq' is not null then
			select c.created_at into v_cut_at from public.qorpera_folder_commits c
			where c.environment_id = p_environment_id and c.seq = (v_memtree ->> 'cutoffSeq')::bigint;
			if v_cut_at is null or (v_memtree ->> 'cutoffSeq')::bigint > v_as_of then
				raise exception 'Block-history cutoff is not the block''s delete' using errcode = '22023'; end if;
			v_roots := v_roots || jsonb_build_array(jsonb_build_object('key', v_key, 'live', true,
				'cutoffSeq', (v_memtree ->> 'cutoffSeq')::bigint, 'cutoffUnit', (v_memtree ->> 'cutoffUnit')::integer,
				'cutoffAt', v_cut_at));
			select v.op into v_cut_op from public.qorpera_folder_path_versions v
			join public.qorpera_folder_commits c on c.id = v.commit_id
			where v.environment_id = p_environment_id and v.key_sha256 = extensions.digest(v_key, 'sha256')
				and c.seq = (v_memtree ->> 'cutoffSeq')::bigint and v.unit_no = (v_memtree ->> 'cutoffUnit')::integer
			order by (v.op = 'delete') desc limit 1;
			if v_cut_op <> 'delete' then
				raise exception 'Block-history cutoff is not the block''s delete' using errcode = '22023'; end if;
			-- The life a carrier keeps, as a 55000 named it: refused again, under the path lock, when the key has had a newer
			-- life since (that life deleted and a new one begun).
			if v_memtree ->> 'lifeSeq' is not null then
				select * into v_life_now from public.qorpera_folder_erasure_life_start(p_environment_id, v_key);
				if (v_life_now.seq, v_life_now.unit_no) is distinct from
						((v_memtree ->> 'lifeSeq')::bigint, (v_memtree ->> 'lifeUnit')::integer) then
					perform public.qorpera_folder_erasure_refuse_live_again(p_environment_id, v_key,
						coalesce((select e.path from public.qorpera_folder_entries e where e.environment_id = p_environment_id
							and e.key_sha256 = extensions.digest(v_key, 'sha256') and e.kind <> 'claim'),
							public.qorpera_folder_erasure_moved_live(p_environment_id, v_key)));
				end if;
			end if;
			-- No version there: an erasure with a later cutoff over the key (a later request for the block, or a member's
			-- erasure) has erased the delete. Once it is past its versions phase nothing before the cutoff is left, and the
			-- request answers nothing left; while that phase runs it is asked again (the count below decides). Read before
			-- the count, so an erasure done in between has left nothing to count.
			v_cut_gone := v_cut_op is null;
			v_cut_busy := v_cut_gone and exists (select 1 from public.qorpera_folder_erasures e
				cross join jsonb_array_elements(e.roots) r
				where e.environment_id = p_environment_id and e.done_at is null
					and public.qorpera_folder_erasure_covers(r ->> 'key', v_key)
					and public.qorpera_folder_erasure_before(r, (v_memtree ->> 'cutoffSeq')::bigint,
						(v_memtree ->> 'cutoffUnit')::integer));
		else
			v_roots := v_roots || jsonb_build_array(public.qorpera_folder_erasure_cutoff(p_environment_id, v_key, v_as_of, v_as_of_at));
			-- Live again, or renamed to a live path since step 1 deleted it: the tree built again, or another tree's block
			-- at a reused name. The detail names the live path, its life and the delete before.
			if v_key = v_block_key then
				v_live_path := case when (v_roots -> -1 ->> 'live')::boolean
					then (select e.path from public.qorpera_folder_entries e where e.environment_id = p_environment_id
						and e.key_sha256 = extensions.digest(v_key, 'sha256'))
					else public.qorpera_folder_erasure_moved_live(p_environment_id, v_key) end;
				if v_live_path is not null then
					perform public.qorpera_folder_erasure_refuse_live_again(p_environment_id, v_key, v_live_path); end if;
			end if;
		end if;
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		if (v_root ->> 'live')::boolean and v_versions = 0 and v_conflict = 0 then
$old$,
	$new$		v_total := v_total + v_versions + v_conflict; -- 20260930120000 (W1a)
		-- 20260930120000 (W1a): the block's delete erased already, with versions or copies before it still here: asked
		-- again while the erasure that took the delete runs its versions phase, else the cutoff was never the delete.
		if v_cut_gone and v_root ->> 'key' = v_block_key and v_versions + v_conflict > 0 then
			if v_cut_busy then
				raise exception 'Block history is being erased; ask again' using errcode = '55006'; end if;
			raise exception 'Block-history cutoff is not the block''s delete' using errcode = '22023';
		end if;
		if v_memtree is null and (v_root ->> 'live')::boolean and v_versions = 0 and v_conflict = 0 then
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	-- §2.4: an unrevoked path resource at or under a deleted root is revoked first (a live root's governs its current file).
$old$,
	$new$	-- 20260930120000 (W1a): a block-history request with nothing left to erase is accepted with no erasure, as asking
	-- again erases nothing more. It is raised, so that what step 5 claimed rolls back; the wrapper answers its detail.
	if v_memtree is not null and v_total = 0 then
		raise exception 'Nothing to erase at the block' using errcode = '22023', detail = jsonb_build_object(
			'schema', 'qorpera.folder-erasure/v1', 'kind', 'block-history', 'erasureId', null, 'asOfSeq', v_as_of,
			'roots', v_counts, 'copies', '[]'::jsonb,
			'for', (v_memtree -> 'for') || jsonb_build_object('path', v_memtree -> 'path'))::text;
	end if;
	-- §2.4: an unrevoked path resource at or under a deleted root is revoked first (a live root's governs its current file).
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	if jsonb_array_length(v_added) > 0 or jsonb_array_length(v_live) > 0 then
$old$,
	$new$	-- 20260930120000 (W1a): a block-history request leaves a life that moved on to a live path alone (another tree's
	-- block, §10 step 3 there), and its wrapper adds every partner named here and asks again.
	if jsonb_array_length(v_added) > 0 or (v_memtree is null and jsonb_array_length(v_live) > 0) then
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$					limit 20) t),
$old$,
	$new$					limit case when v_memtree is null then 20 end) t), -- 20260930120000 (W1a)
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		limit 20) t;
$old$,
	$new$		limit case when v_memtree is null then 20 end) t; -- 20260930120000 (W1a): a block-history request names every copy
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		'roots', v_counts, 'copies', v_copies, 'erased', v_erased);
$old$,
	$new$		'roots', v_counts, 'copies', v_copies, 'erased', v_erased);
	-- 20260930120000 (W1a): a block-history request's reply names what it was for, kept after done with its copies.
	if v_memtree is not null then
		v_reply := v_reply || jsonb_build_object('kind', 'block-history',
			'for', (v_memtree -> 'for') || jsonb_build_object('path', v_memtree -> 'path'));
	end if;
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		requested_by_user_id, as_of_seq, as_of_at, roots, reply)
$old$,
	$new$		requested_by_user_id, as_of_seq, as_of_at, roots, reply, block_history) -- 20260930120000 (W1a)
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		(select jsonb_agg(r - 'live') from jsonb_array_elements(v_roots) r), v_reply)
$old$,
	$new$		(select jsonb_agg(r - 'live') from jsonb_array_elements(v_roots) r), v_reply, v_memtree)
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$	where p.id = any(v_proposals) and c.run_id is not null
$old$,
	$new$	where p.id = any(v_proposals) and c.run_id is not null and v_memtree is null -- 20260930120000 (W1a): no run noted
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erase(uuid,jsonb,jsonb,text)'::regprocedure,
	$old$		perform public.qorpera_folder_authority_journal(v_env, p_actor, true, v_changes);
$old$,
	$new$		perform public.qorpera_folder_authority_journal(v_env, case when v_memtree is null then p_actor
			else '{"kind":"platform"}'::jsonb end, true, v_changes); -- 20260930120000 (W1a)
$new$);

-- 3. The drain: no run noted for a block-history request; its digest and copies kept after done ----------------------

select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$		if v_erasure.phase = 1 then
$old$,
	$new$		-- 20260930120000 (W1a): a block-history request notes no run here or in phases 2 and 3: its run-log row reaches
		-- only the steps that showed its blocks, never a whole run (RUNTIME-AGENT-MEMORY-TREE.md §10.1).
		if v_erasure.phase = 1 then
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$			select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_batch) b
			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
$old$,
	$new$			select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_batch) b
			join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid
			where c.run_id is not null and v_erasure.block_history is null
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$			where w.run_id is not null
$old$,
	$new$			where w.run_id is not null and v_erasure.block_history is null
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$				select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_copy_batch) b
				join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid where c.run_id is not null
$old$,
	$new$				select distinct v_erasure.id, c.run_id from jsonb_array_elements(v_copy_batch) b
				join public.qorpera_folder_commits c on c.id = (b ->> 'commitId')::uuid
				where c.run_id is not null and v_erasure.block_history is null
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$						where w.source_kind = 'company-file' and w.source_id = v_commit.id and w.run_id is not null
$old$,
	$new$						where w.source_kind = 'company-file' and w.source_id = v_commit.id and w.run_id is not null
							and v_erasure.block_history is null
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$if v_commit.run_id is not null then
$old$,
	$new$if v_commit.run_id is not null and v_erasure.block_history is null then
$new$, 2);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$				where v_erasure.first_erased_at is not null and rr.environment_id = v_erasure.environment_id
$old$,
	$new$				where v_erasure.first_erased_at is not null and v_erasure.block_history is null
					and rr.environment_id = v_erasure.environment_id
$new$);
select pg_temp.w1a_replace('public.qorpera_folder_erasure_step(integer,integer,integer)'::regprocedure,
	$old$				roots = null, request_sha256 = null, cursor = '{}'::jsonb, agents = null, reply = reply - 'roots' - 'copies'
$old$,
	$new$				roots = null, cursor = '{}'::jsonb, agents = null,
				-- 20260930120000 (W1a): a block-history request keeps its digest, its copies and what it was for, so a
				-- carrier that asks again after done finds them (RUNTIME-AGENT-MEMORY-TREE.md §10 step 3).
				request_sha256 = case when block_history is not null then request_sha256 end,
				reply = case when block_history is null then reply - 'roots' - 'copies' else reply - 'roots' end
$new$);

-- 4. The wrapper: one block, its partners added as P18 names them ------------------------------------------------------

-- p_block: {"path", "cutoffSeq", "cutoffUnit", "lifeSeq", "lifeUnit", "for": {"table", "id"}}; the key is memtree: and
-- the hex SHA-256 of <table>:<id>:<the block's folded key>. Each call runs in the caller's transaction, at read
-- committed. The answer is P18's reply (kind block-history, its for, every copy), or erasureId null when nothing is left
-- to erase. P18's other refusals pass through: 55000 'Block is live again', whose detail is {"live": <path> or null,
-- "life": {seq, unit}, "delete": {seq, unit} or null} (the life is the tree built again or another tree's block at a
-- reused name: on a request with no cutoff, the carrier asks again with that delete as the cutoff and that life, or,
-- with no delete, has nothing left at the name; on a request with a life, it goes round again with no cutoff), 55000
-- 'The company is being deleted' (no detail), 55006 'Block history is being erased; ask again', 22023, and the 409 to
-- retry when the company folder changed while the erasure began. The life is not in the digest: a request asked again
-- after it was accepted replays.
create function public.qorpera_folder_erase_block_history(p_environment_id uuid, p_user_id uuid, p_operation_key text,
	p_block jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_paths jsonb := jsonb_build_array(p_block -> 'path'); v_add jsonb; v_message text; v_detail text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	loop
		begin
			return public.qorpera_folder_erase(p_environment_id,
				jsonb_build_object('kind', 'memtree', 'userId', p_user_id, 'block', p_block), v_paths, p_operation_key);
		exception when sqlstate '22023' then
			get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail;
			if v_message = 'Nothing to erase at the block' then return v_detail::jsonb; end if;
			if v_message <> 'This history continues at other paths' then raise; end if;
			-- Each round adds at least one path, or the refusal stands: the loop ends.
			select coalesce(jsonb_agg(a.value order by a.ordinality), '[]'::jsonb) into v_add
			from jsonb_array_elements(v_detail::jsonb -> 'add') with ordinality a
			where not v_paths @> jsonb_build_array(a.value);
			if jsonb_array_length(v_add) = 0 then raise; end if;
			v_paths := v_paths || v_add;
		end;
	end loop;
end $$;
revoke all on function public.qorpera_folder_erase_block_history(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_erase_block_history(uuid, uuid, text, jsonb) to service_role;

-- Whether a request is past P18's versions phase (phase 1 deletes the versions and the conflict copies): true once
-- done or in a later phase, and for no erasure (erasureId null: nothing was left to erase).
create function public.qorpera_folder_erasure_past_versions(p_erasure_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select e.done_at is not null or e.phase > 1 from public.qorpera_folder_erasures e where e.id = p_erasure_id),
		true)
$$;
revoke all on function public.qorpera_folder_erasure_past_versions(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_folder_erasure_past_versions(uuid) to service_role;

-- 5. The deploy guard: every patched body carries the marker ----------------------------------------------------------

do $guard$
declare v_fn regprocedure;
begin
	foreach v_fn in array array['public.qorpera_folder_erase(uuid,jsonb,jsonb,text)',
			'public.qorpera_folder_erasure_step(integer,integer,integer)']::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_fn), '20260930120000') = 0 then
			raise exception 'W1a did not reach %', v_fn; end if;
	end loop;
end $guard$;
