-- 20260930516000: MC3c, the core's half (deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md, "Where the cache lives"
-- and decision 1, amended 18 October 2026). The folder program on a company machine keeps its caches on the machine's
-- disk, and serves them without asking the core. A cache made in one view never shows in a view of different
-- authority: a machine's desktops share one cache, `cache/desktop`, and a command's mount uses its owner's,
-- `cache/<owner>`.
-- 1. qorpera_folder_view_open: a command's view answers its owner too, 'agent-<uuid>' (the view's agent, which is the
--    command's), for the office service to pass to the folder helper. Every other answer is unchanged: a desktop's
--    mount uses `cache/desktop` whoever holds it (below), and the coding answer is a closed record
--    (runner-orchestrator coding-folder-views.ts readView).
-- 2. qorpera_folder_view_renew: a company-wide view (a desktop or a command) stands only while its agent and member
--    still read the root, as its open required (20260928259230:394-399, 20260928539120:274). Before, a renewal checked
--    only that the agent was employed and the member still a member: an agent whose root grant was revoked kept its
--    views, and so its caches served, for as long as they were renewed. Now the next renewal closes the view
--    ('ended'), and the next open needs the root read again. A still-entitled view renews as before. A test machine's
--    view already checks this in qorpera_folder_view_valid (20260928549400:84-94); a code host's has no agent or member.
--    The window: the folder service renews a view every 40 s while its machine is connected
--    (packages/object-gateway/src/folder-service/service.ts:128) and tells every connection of it of the closure at
--    once. From then on every read and publish that reaches the core is refused (qorpera_folder_actor_resource_allowed),
--    and only files already in the machine's cache can still be read, until the mount ends. A command's mount ends at
--    the closure: at most 40 s after the loss. A desktop's waits out its 60 s handoff grace first
--    (crates/qorpera-folder/src/link.rs:168 and :654; the service makes only a desktop's view switchable,
--    service.ts:1145), then the folder program exits 3 and its unit unmounts it: at most 40 + 60 s. Nothing is
--    deleted here: the cache stays where it is, and removing old caches is the folder program's (MC3b).
-- Why a machine's desktops may share one cache (coordinator decision 2, 18 October): every desktop view has the same
-- company-wide authority whoever holds it (a run, a member's takeover, or no one once the run ended):
-- - a desktop view opens only while the screen's agent and the view's member (the run's requester or the holder)
--   both read the root resource (20260928259230:335-399, the refusal at 394-399; the root read is
--   qorpera_folder_reads_root's, 20260928549400:40-49), and now renews only while they still do (2);
-- - its actor's view is company-wide (20260928259230:206; commands 20260928539120:215-218, test machines
--   20260928549400:110-111, code hosts 20260928559230:150), and a company-wide actor may use only paths whose covering
--   resource is the shared root, or rules/ for reads, on top of its own authority (20260928259230:258-288, the check
--   at 264-266; 20260928469130:738 only adds a worker report's write, after it);
-- - so whoever holds it reads the root's files and rules/, and never a narrower resource or a member's private folder.
--   supabase/tests/538 pins this for each kind of holder.
-- Exact-text patches: each fails unless its function has the text given exactly once. Each patched function names
-- this migration (20260930516000); the earlier markers stay.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes.
do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)'::regprocedure), '20260930516000') > 0
		then raise exception 'The folder view owner and root renewal (20260930516000) is already applied'; end if;
end $$;

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.folder_view_owner_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '% does not have the text this migration expects (% times): %', p_target, v_found,
				left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. A command's view answers its owner.
select pg_temp.folder_view_owner_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', array[
	$old$		if not found then raise exception 'Folder view command is not current' using errcode = '42501'; end if;
		return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,'leaseUntil',v_view.lease_until);
$old$,
	$new$		if not found then raise exception 'Folder view command is not current' using errcode = '42501'; end if;
		-- 20260930516000 (MC3c): and whose cache its mount uses, the command's agent's.
		return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,'leaseUntil',v_view.lease_until,
			'owner','agent-' || v_view.staff_agent_id);
$new$]);

-- 2. A company-wide view renews only while its agent and member read the root.
select pg_temp.folder_view_owner_patch('public.qorpera_folder_view_renew(uuid,text,timestamptz,uuid)', array[
	$old$			and exists (select 1 from public.qorpera_profile_members where profile_id = v_view.profile_id
				and user_id = v_view.member_user_id)));
$old$,
	$new$			and exists (select 1 from public.qorpera_profile_members where profile_id = v_view.profile_id
				and user_id = v_view.member_user_id)))
		-- 20260930516000 (MC3c): a desktop's or a command's view is company-wide; its folder program serves cached files
		-- without asking the core, so the view stands only while its agent and member still read the root, as its open
		-- required. A test machine's view checks it in qorpera_folder_view_valid.
		and (v_view.kind not in ('computer_desktop','computer_shell_command')
			or public.qorpera_folder_reads_root(v_view.environment_id, v_view.profile_id, v_view.staff_agent_id,
				v_view.member_user_id));
$new$]);
