-- C5 (20260930508000): every native host call whose body reaches the tree, found by its body, not its name, and how
-- each stands with a run in Agent notebooks. 687 §3 pins the qorpera_memory_% calls by name; this also finds the folder
-- commits and the worker calls. Each call is in exactly one list, so a new host call that reaches the tree fails here
-- until it is put in one:
-- (a) gated by the run's recorded mode: the C5 marker in its own body, or a call to a gated function;
-- (b) nothing to gate (687 §3): the compaction record only counts compactor calls (a notebook run makes none), the step
--     hashes and the narrow step serve a log a run already writes, a resume needs a live log or reads a notebook
--     run's own receipts (20260930539000), and the action review's begin and record and the agent's email only read
--     whether a resumed attempt recorded its resume (20260930546000);
-- (c) the known exception, not gated: the worker parent's view. The worker commit checks and keeps a dispatch's view
--     reference with the ungated check, and the worker parent run hands it to the worker's run, in either mode. Dormant
--     until W4b; add the run-mode gate before wiring.
begin;

do $$
declare
	v_got text[];
	v_marked text[] := array['qorpera_memory_branches', 'qorpera_memory_events_run', 'qorpera_memory_release',
		'qorpera_memory_run_log_place', 'qorpera_memory_view_record', 'qorpera_memory_view_reference_check_run', 'qorpera_memory_zoom'];
	-- A call and the gated function its body calls, directly or through the next pair.
	v_through text[] := array[
		['qorpera_memory_view', 'qorpera_memory_view_of('],
		['qorpera_folder_memory_commit', 'qorpera_folder_commit('],
		['qorpera_folder_commit', 'qorpera_folder_structured_decide('],
		['qorpera_folder_structured_decide', 'qorpera_memory_run_log_paths('],
		['qorpera_memory_run_log_paths', 'qorpera_memory_run_tree_problem(']];
	v_gated_below text[] := array['qorpera_memory_view_of', 'qorpera_memory_run_log_paths', 'qorpera_memory_run_tree_problem'];
	v_nothing text[] := array['qorpera_memory_compaction_record', 'qorpera_memory_run_resume', 'qorpera_memory_run_resume_receipts',
		'qorpera_memory_run_resume_record', 'qorpera_memory_step_hashes', 'qorpera_memory_step_narrow',
		'qorpera_begin_action_review', 'qorpera_record_action_review', 'qorpera_send_agent_mail'];
	v_exception text[] := array['qorpera_folder_worker_commit', 'qorpera_folder_worker_parent_run'];
	v_name text; i integer;
begin
	-- The host calls whose bodies name a tree table or function, a tree file kind or path, or the worker parent's view.
	-- (qorpera_memory_entry_id only names an erased event's id.)
	select array_agg(c.name::text order by c.name::text collate "C") into v_got
	from public.qorpera_native_host_calls c
	join pg_catalog.pg_proc p on p.pronamespace = 'public'::regnamespace and p.proname = c.name
	where exists (select 1 from regexp_matches(p.prosrc, '(qorpera_(?:folder_)?memory_[a-z0-9_]+|memory-(?:block|tree)|memory/thread'
		|| '|qorpera_folder_worker_parent\M|qorpera_runtime_worker_parents)', 'g') m where m[1] <> 'qorpera_memory_entry_id');
	if v_got is distinct from (select array_agg(n order by n collate "C") from unnest(v_marked || array['qorpera_memory_view',
			'qorpera_folder_memory_commit', 'qorpera_folder_commit'] || v_nothing || v_exception) n) then
		raise exception 'The host calls that reach the tree changed (put each in one list): %', v_got; end if;

	-- (a) The gate's marker, in the call itself or in the function it calls.
	foreach v_name in array v_marked || v_gated_below loop
		if not coalesce((select bool_and(strpos(prosrc, '20260930508000') > 0) from pg_proc
			where pronamespace = 'public'::regnamespace and proname = v_name), false) then
			raise exception 'The gate is missing in %', v_name; end if;
	end loop;
	for i in 1 .. array_length(v_through, 1) loop
		if not coalesce((select bool_and(strpos(prosrc, v_through[i][2]) > 0) from pg_proc
			where pronamespace = 'public'::regnamespace and proname = v_through[i][1]), false) then
			raise exception '% no longer calls %', v_through[i][1], v_through[i][2]; end if;
	end loop;

	-- (b) and (c) carry no gate: a call that gains one moves to (a).
	foreach v_name in array v_nothing || v_exception || array['qorpera_folder_worker_parent'] loop
		if (select bool_or(strpos(prosrc, '20260930508000') > 0) from pg_proc
			where pronamespace = 'public'::regnamespace and proname = v_name) then
			raise exception '% now carries the gate: move it to (a)', v_name; end if;
	end loop;
	-- (c) The worker commit checks a view reference with the ungated check, not the run's (…_check_run), and the worker
	-- parent run answers the worker parent's kept view.
	if strpos((select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_worker_commit'),
			'qorpera_memory_view_reference_check(') = 0
		or strpos((select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_worker_commit'),
			'qorpera_memory_view_reference_check_run(') > 0
		or strpos((select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_worker_parent_run'),
			'qorpera_folder_worker_parent(') = 0 then
		raise exception 'The worker parent''s view changed: update the known exception'; end if;
end $$;

rollback;
