-- 20260930495000: F3 4f-2a, a desktop view's commits for its report (deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md,
-- "The report" and "How 4f-2 carries the report").
-- 1. qorpera_folder_view_commits(view, pass, after, limit): a desktop view's commits in the order they were made, after
--    the one its caller showed last, each with who made it and its units' outcomes. The office service holds the view's
--    pass: it puts the commits into the holder run's next tool result, and a drain's into the next tool result of the
--    run that held the desktop, so a closed view still answers.
-- 2. An index on the commits' view, for it.

set local lock_timeout = '3s';

create index qorpera_folder_commits_view on public.qorpera_folder_commits(view_id, created_at, id) where view_id is not null;

-- A view's commits are made one at a time: the folder service that serves a view chains its publishes, each answered
-- before the next starts, so they are made in created_at order and a cursor misses none. A commit that saved nothing
-- (a null seq) is listed too, and its units say why; a change set refused whole made no commit, and the office service
-- has that refusal from the folder service. Each commit carries all its units, in unit order, as the commit recorded
-- them, so every changed path's outcome reaches the report and an erasure's redactions show. A page carries at most
-- p_limit units (a commit's most, 1000, by default) and never splits a commit: it ends before the commit that would go
-- over, and its first commit comes whole whatever its size.
create function public.qorpera_folder_view_commits(p_view_id uuid, p_pass text, p_after_commit_id uuid default null,
	p_limit integer default 1000)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype; v_after public.qorpera_folder_commits%rowtype; v_items jsonb;
	v_more boolean;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_view from public.qorpera_folder_views where id = p_view_id;
	if not found or v_view.pass_sha256 <> extensions.digest(coalesce(p_pass, ''), 'sha256') then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	-- The report is a desktop's; a command's report is its boundary's answer, and a coding session's is its folder
	-- service's.
	if v_view.kind <> 'computer_desktop' or p_limit is null or p_limit not between 1 and 1000 then
		raise exception 'View commits request is invalid' using errcode = '22023'; end if;
	if p_after_commit_id is not null then
		select * into v_after from public.qorpera_folder_commits where id = p_after_commit_id and view_id = v_view.id;
		if not found then raise exception 'View commits request is invalid' using errcode = '22023'; end if;
	end if;
	-- Each commit weighs its units (one at least), so p_limit + 1 commits are enough to fill a page and to see whether
	-- more follow; only the page's commits are built.
	select coalesce(jsonb_agg(jsonb_build_object('commitId', c.id, 'seq', c.seq, 'at', c.created_at,
			'by', public.qorpera_folder_commit_by(c), 'runId', c.run_id, 'units', c.units) order by page.n)
			filter (where page.n = 1 or page.weight <= p_limit), '[]'::jsonb),
		count(*) > count(*) filter (where page.n = 1 or page.weight <= p_limit)
		into v_items, v_more
	from (
		select f.id, row_number() over w as n, sum(f.weight) over w as weight
		from (
			select c.id, c.created_at, greatest(jsonb_array_length(c.units), 1) as weight
			from public.qorpera_folder_commits as c
			where c.view_id = v_view.id
				and (p_after_commit_id is null or (c.created_at, c.id) > (v_after.created_at, v_after.id))
			order by c.created_at, c.id
			limit p_limit + 1
		) as f
		window w as (order by f.created_at, f.id rows between unbounded preceding and current row)
	) as page
	join public.qorpera_folder_commits as c on c.id = page.id;
	return jsonb_build_object('schema', 'qorpera.folder-view-commits/v1', 'viewId', v_view.id, 'state', v_view.state,
		'closeReason', v_view.close_reason, 'commits', v_items, 'more', v_more);
end $$;

revoke all on function public.qorpera_folder_view_commits(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.qorpera_folder_view_commits(uuid, text, uuid, integer) to service_role;
