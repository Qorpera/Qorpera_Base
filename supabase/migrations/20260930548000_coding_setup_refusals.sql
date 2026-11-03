-- 20260930548000 (D-B, PR 1): a normal company's coding dispatch fails closed with a precise reason.
--
-- A new company with GitHub connected and an approved private repository asked its agent for a coding session, and
-- the dispatch was refused with 'No coding executor serves this company for codex' (browser test, 30 Oct 05:02Z). The
-- company had no executor row and no repository grant, and both are written only by the service role
-- (qorpera_configure_coding_executor, 20260925120000:8-15; qorpera_set_coding_repository_grant, 20260922230000): no
-- member can set them up in the app. The words named neither that, nor that the member had done nothing wrong, nor that
-- calling again does not help.
--
-- The worker rules (C3a, 20260928489260:208-215) now say it in the words the agent passes on:
-- - no enabled executor for the harness: 'Coding is not set up for this company yet: no coding machine serves it for
--   <harness>. ...';
-- - no grant of the repository to the agent: 'Coding is not set up for <owner>/<name> yet: this agent has no grant for
--   that repository. ...';
-- each with 'Only Qorpera can set this up today; there is no step for it in the app yet.' and the agent's next step.
-- The receipt's own next text (cloud-folder-workers.ts, "Nothing was changed: say why to the member, ...") stays. The
-- path with no operator step (the company's executor, the agent's grant and the node's repository list) is D-B PR 2.
--
-- Unchanged: every check and its order (species; harness, repository and read access; the owner; the executor; the
-- grant; the owner's own login), what a refusal writes (nothing), the function's name, arguments, result, owner and
-- grants, the tables and the data.
-- Rollback: none needed. Only two refusal texts change; an earlier runtime bundle reads them as any refusal's words.

set local lock_timeout = '3s';

create function pg_temp.db548_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930548000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.db548_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$				v_problem := 'No coding executor serves this company for ' || (v_request ->> 'harness');$old$,
	$new$				-- 20260930548000 (D-B): a member cannot set this up in the app, so the words say so.
				v_problem := 'Coding is not set up for this company yet: no coding machine serves it for '
					|| (v_request ->> 'harness') || '. Only Qorpera can set this up today; there is no step for it in the app'
					|| ' yet. Tell the member; calling again will not help.';$new$);

select pg_temp.db548_replace('public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$				v_problem := 'This agent has no grant for that repository';$old$,
	$new$				-- 20260930548000 (D-B): as for the executor.
				v_problem := 'Coding is not set up for ' || (v_request -> 'repository' ->> 'owner') || '/'
					|| (v_request -> 'repository' ->> 'name') || ' yet: this agent has no grant for that repository. Only'
					|| ' Qorpera can set this up today; there is no step for it in the app yet. Tell the member; calling'
					|| ' again for it will not help.';$new$);

drop function pg_temp.db548_replace(regprocedure, text, text);
