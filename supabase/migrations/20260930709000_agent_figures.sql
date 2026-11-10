-- 20260930709000: six more agent figures (Jonas, 10 November 2026; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
-- §2 "agent.md"). star, cloud, bolt, mushroom, moon and puzzle join the figures an agent.md may name.
--
-- The ghost is retired: no client offers it and the hiring tool no longer takes it, and every client draws the moon in
-- its place. A saved agent.md that names it stays valid, so it stays in this list: a company's files are never rewritten
-- to follow the picker.
--
-- One text patch of the parse's shape check (qorpera_company_state_parse_problems). No table changes, and the colour
-- names are untouched (only their hex in the web client moved).
--
-- Deploy order: this migration first, then the object gateway and the runtime (their shared parser reads the new
-- names, and the runtime's hiring tool offers them), then the web (its picker offers them). Before the gateway is
-- redeployed its parser refuses a new name ("figure must be one of: ..."), so nothing is saved that it cannot read.

set local lock_timeout = '3s';

create function pg_temp.agent_figures_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930709000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.agent_figures_replace('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure,
	$old$			('planet','acorn','flame','rocket','crown','heart','ghost') then v_bad := array_append(v_bad, 'figure'); end if;$old$,
	$new$			-- 20260930709000: six more figures; the ghost is retired, and only a saved file still names it.
			('planet','acorn','flame','rocket','crown','heart','star','cloud','bolt','mushroom','moon','puzzle','ghost') then
			v_bad := array_append(v_bad, 'figure'); end if;$new$);
