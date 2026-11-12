-- 20260930737000: the executor's list of machines also says who a machine was started by, with the two saved fields
-- every client draws that agent's figure from (Jonas, 12 November 2026, on the first desktop computers: "what happened to
-- the agent wallpapers?"). A machine's desktop shows a backdrop for the figure named in the machine's
-- /etc/qorpera-machine/desktop-figure, one word, and the neutral backdrop without it (the machine image's part,
-- deploy/machine/desktop-look). Nothing wrote that word: a machine cannot read who it belongs to (its guest reads no LXD
-- configuration, and its binding holds ids and sizes only). The machine's executor writes it, and this is where it
-- learns what to write.
--
-- * qorpera_list_executor_machines(owner, machine id sha-256), the list every executor reads on every pass, gains one
--   key in each placement's entry: `starter`, {staffAgentId, figure, templateId} of the agent in
--   started_by_staff_agent_id. That column is never null: an agent's own machine_start sets the agent of its run, and a
--   member's "Start one" (20260930730000, a machine no run started) sets the agent the computer is for. `figure` is the
--   agent.md's `figure` as it was saved (qorpera_profile_staff.appearance_creature, kept by the folder's index since
--   20260928249020): null for an agent nobody dressed, and still `ghost` where a saved file names the retired figure.
--   `templateId` is the row's template (`co-founder` for the Co-Founder, null for every other folder hire). The clients'
--   rule is not repeated in SQL: the saved figure (a retired one's replacement), else the template's, else a stable one
--   from the agent's id (the web client's figureFor; the executor resolves it the same way, from cloud-client's tables).
--   `starter` is null when the agent's row is gone.
-- * Nothing else in the entry changes, and nothing about custody: the key is read, never written, by the executor; an
--   executor that does not know it ignores it (its entry check names the keys it needs), and one that knows it but
--   meets an SQL without it writes no word. So the migration and the executor may land in either order; the release
--   lands the migration first.
-- * No time zone: the product keeps one per routine only, none for a company or a machine, so a desktop's clock stays on
--   UTC unless `desktop start --tz` says otherwise.
-- * The body is patched by one exact anchor and keeps the markers of what patched it before (20260929730000,
--   20260930055000); it names this migration, for the deploy guards.

do $$ begin
	if position('20260930737000' in pg_get_functiondef('public.qorpera_list_executor_machines(text,text)'::regprocedure)) > 0 then
		raise exception '20260930737000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_start_agent_computer(uuid,uuid)') is null then
		raise exception '20260930737000 needs a member''s start of an agent''s computer (20260930730000)'; end if;
end $$;

-- Replacing the function takes its lock: never queue behind a long transaction.
set local lock_timeout = '3s';

-- (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs left it,
-- and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_desktop_figure_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930737000' in v_definition) > 0 then
		raise exception '20260930737000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930737000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930737000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

do $$ begin execute pg_temp.machine_desktop_figure_patched(
	'public.qorpera_list_executor_machines(text,text)'::regprocedure,
	array[$old$			'lastUsedAt',machine.last_used_at,'createdAt',placement.created_at,'lastError',machine.last_error,
$old$,
	$new$			'lastUsedAt',machine.last_used_at,'createdAt',placement.created_at,'lastError',machine.last_error,
			-- 20260930737000: who the machine was started by, with what every client draws that agent's figure from (the
			-- saved figure and the template, as saved; null when the agent's row is gone). The executor writes the figure
			-- into the machine, where its desktop reads it.
			'starter',(select jsonb_build_object('staffAgentId',staff.staff_agent_id,'figure',staff.appearance_creature,
					'templateId',staff.template_id)
				from public.qorpera_profile_staff staff
				where staff.profile_id = machine.profile_id and staff.staff_agent_id = machine.started_by_staff_agent_id),
$new$]); end $$;

-- The function may have a private owner in production: it reaches what its new text reads.
do $$
declare v_owner name := (select pg_get_userbyid(proowner) from pg_proc
	where oid = 'public.qorpera_list_executor_machines(text,text)'::regprocedure);
begin
	if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
		raise exception '20260930737000: the executor''s machine list has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_profile_staff to %I', v_owner);
	end if;
end $$;

-- The deploy guard: the patched body carries the marker, keeps the earlier ones, and stays the service role's alone.
do $guard$
declare v_source text := (select prosrc from pg_proc where oid = 'public.qorpera_list_executor_machines(text,text)'::regprocedure);
begin
	if strpos(v_source, '20260930737000') = 0 then
		raise exception '20260930737000 marker is missing in qorpera_list_executor_machines'; end if;
	if exists (select 1 from unnest(array['20260929730000', '20260930055000']) marker where strpos(v_source, marker) = 0) then
		raise exception '20260930737000: the patched body lost its earlier marker'; end if;
	if has_function_privilege('anon', 'public.qorpera_list_executor_machines(text,text)', 'execute')
		or has_function_privilege('authenticated', 'public.qorpera_list_executor_machines(text,text)', 'execute')
		or not has_function_privilege('service_role', 'public.qorpera_list_executor_machines(text,text)', 'execute') then
		raise exception '20260930737000: the executor''s machine list changed hands'; end if;
end $guard$;

drop function pg_temp.machine_desktop_figure_patched(regprocedure, text[]);
