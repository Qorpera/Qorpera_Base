-- The founding switch (folder core P39). Founder decision, 3 October 2026: production's companies were wiped and only
-- the folder-v2 architecture is built. New companies start at a founding table (the lobby) and are created on
-- folder-v2 by the object gateway's creation worker (P14b, live since v171).
--
-- Until now this answered false, so the web's "Create company" took the old snapshot-v1 bootstrap chain, and since
-- P28 nothing materializes that chain's runs. The lobby's own checks are unchanged: every founder must be Ready with
-- their own ChatGPT account, and the launcher's login pays for the kickoff.
create or replace function public.qorpera_company_founding_available()
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930031000 (P39): new companies start at a founding table, on folder-v2.
	select true
$$;
