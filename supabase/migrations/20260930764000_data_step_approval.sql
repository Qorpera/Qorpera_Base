-- 20260930764000: a member's yes for a database step that destroys data (deploy/first-node/RUNTIME-COMPANY-DATABASES.md
-- §3 "A step" point 4 and §4; slice 7 part (b); Jonas, 14 November 2026: "Yes, build them"). A step that would drop a
-- table or a column, empty a table or delete rows is held by the data gateway, which answers what it would destroy and
-- an `allow` for exactly that: `<step>.<sha256 of its text>.<sha256 of what it destroys>`. An agent that wants it
-- applied calls data_apply with that `allow`; the runtime always asks a member on a card for such a call, never the
-- reviewer and never a rule (cloud-action-review.ts), and the call's arguments, which the card's review is bound to by
-- their hash, carry the `allow`.
--
-- The gateway holds no service key and trusts no word of the run's for a yes. So the platform says it, in the run's
-- data pass:
--
-- 1. qorpera_data_passes.allow: the `allow` a member said yes to, or null.
-- 2. qorpera_run_data_pass_approved(p_environment_id, p_actor, p_database, p_review_id): a data pass for the database,
--    made as qorpera_run_data_pass makes one (20260930750000, unchanged), which also keeps the `allow` of the review
--    named. The review must be this agent's data_apply, asked on a card, answered Allow by a member, and used by this
--    very run (qorpera_begin_action_review or qorpera_await_action_review marked it so); its arguments must name this
--    database and an `allow`. A reviewer's own allow never counts, nor another run's approval, another tool's, a denial
--    or an unanswered card: 42501. An approval does not carry over to another run, as a site's does not
--    (20260930550000).
-- 3. qorpera_data_pass_redeem answers `allow` beside what it answered, for a pass that carries one; a plain pass
--    answers exactly what it did. A gateway that does not know the key reads the rest as before.
-- 4. The native host's list gains qorpera_run_data_pass_approved (scope folder).
--
-- Locks: the new column is added to a table only this migration's functions and the hourly retention touch; the pass
-- is made and marked in one transaction.

set local lock_timeout = '3s';

alter table public.qorpera_data_passes add column allow text
	check (allow ~ '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*\.[0-9a-f]{64}\.[0-9a-f]{64}$');

create function public.qorpera_run_data_pass_approved(p_environment_id uuid, p_actor jsonb, p_database text,
	p_review_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_auth jsonb; v_run public.qorpera_execution_runs%rowtype; v_text text; v_arguments jsonb; v_made jsonb;
begin
	-- Company databases, slice 7 (20260930764000)
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if p_database is null or p_review_id is null then
		raise exception 'An approved data pass names a database and a review' using errcode = '22023'; end if;
	-- The run as a read resolves it: its job leased to it, its requester a member, its agent active.
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if v_auth ->> 'kind' is distinct from 'staff_agent' or v_auth ->> 'runId' is null then
		raise exception 'A data pass is for a run' using errcode = '22023'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (v_auth ->> 'runId')::uuid;
	if not found then raise exception 'A data pass is for a run' using errcode = '22023'; end if;
	-- A member's Allow on the card of this agent's data_apply, which this run used. The reviewer's own allow and a
	-- company rule never apply a step that destroys data.
	select review.action ->> 'arguments' into v_text from public.qorpera_action_reviews as review
	where review.id = p_review_id and review.profile_id = v_run.profile_id
		and review.staff_agent_id = v_run.staff_agent_id and review.tool_name = 'data_apply'
		and review.decision = 'ask' and review.answer in ('allow_once', 'always_allow')
		and review.answered_by_user_id is not null and review.consumed_run_id = v_run.id;
	if found then
		begin v_arguments := v_text::jsonb;
		exception when others then v_arguments := null; end;
	end if;
	if v_arguments is null or jsonb_typeof(v_arguments) is distinct from 'object'
		or jsonb_typeof(v_arguments -> 'database') is distinct from 'string'
		or v_arguments ->> 'database' is distinct from p_database
		or jsonb_typeof(v_arguments -> 'allow') is distinct from 'string'
		or v_arguments ->> 'allow' !~ '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*\.[0-9a-f]{64}\.[0-9a-f]{64}$' then
		raise exception 'DATA_APPROVAL_REQUIRED: a step that destroys data is applied only after a member approves it on a card'
			using errcode = '42501'; end if;
	v_made := public.qorpera_run_data_pass(p_environment_id, p_actor, p_database);
	update public.qorpera_data_passes set allow = v_arguments ->> 'allow'
	where pass_sha256 = extensions.digest(v_made ->> 'pass', 'sha256');
	if not found then raise exception 'The data pass was not kept' using errcode = 'XX000'; end if;
	return v_made;
end $$;

create or replace function public.qorpera_data_pass_redeem(p_pass text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.qorpera_data_passes%rowtype;
begin
	-- Company databases, slice 5 (20260930750000): once, within its 60 s, while its run's job is leased. Slice 7
	-- (20260930764000): with the held step a member said yes to, when the pass was made for one.
	if p_pass is null or p_pass !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
	update public.qorpera_data_passes set redeemed_at = clock_timestamp()
	where pass_sha256 = extensions.digest(p_pass, 'sha256') and redeemed_at is null and expires_at > clock_timestamp()
	returning * into v_row;
	if not found then return null; end if;
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = v_row.job_id and j.run_id = v_row.run_id
			and j.status = 'leased' and j.lease_expires_at > clock_timestamp()) then
		return null; end if;
	return jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1', 'kind', v_row.kind,
		'environmentId', v_row.environment_id, 'runId', v_row.run_id, 'staffAgentId', v_row.staff_agent_id,
		'requesterUserId', v_row.requester_user_id, 'database', v_row.database, 'files', v_row.files)
		|| case when v_row.allow is null then '{}'::jsonb else jsonb_build_object('allow', v_row.allow) end;
end $$;

revoke all on function public.qorpera_run_data_pass_approved(uuid, jsonb, text, uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_run_data_pass_approved(uuid, jsonb, text, uuid) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_run_data_pass_approved', 'folder');
