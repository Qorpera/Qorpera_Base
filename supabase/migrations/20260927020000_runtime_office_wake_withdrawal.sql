-- A member who closes the computer before it is up withdraws the wake they
-- asked for. The wake itself stands: the provider may already be booting, and
-- only its own evidence can stop a VM. Once every member who asked for this
-- wake has withdrawn and nothing has needed the computer since it came up,
-- idle stops it after one minute instead of the full idle window.
create table public.qorpera_runtime_office_wake_requests (
	transition_id uuid not null references public.qorpera_runtime_office_idle_cycles(transition_id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete cascade,
	request_id uuid not null,
	requested_at timestamptz not null default clock_timestamp(),
	withdrawn_at timestamptz,
	primary key(transition_id,user_id)
);
alter table public.qorpera_runtime_office_wake_requests enable row level security;
revoke all on public.qorpera_runtime_office_wake_requests from public,anon,authenticated,service_role;
-- The first demand after a wake's activation makes it a used computer again.
alter table public.qorpera_runtime_office_idle_cycles add column demand_seen_at timestamptz;

create function public.qorpera_runtime_office_wake_withdrawn(p_cycle public.qorpera_runtime_office_idle_cycles)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_cycle.transition_id is not null and p_cycle.activated_at is not null and p_cycle.demand_seen_at is null
		and exists(select 1 from public.qorpera_runtime_office_wake_requests r where r.transition_id=p_cycle.transition_id)
		and not exists(select 1 from public.qorpera_runtime_office_wake_requests r
			where r.transition_id=p_cycle.transition_id and r.withdrawn_at is null)
$$;

create function pg_temp.office_wake_withdrawal_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office wake withdrawal integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
-- Each member's latest request for a pending wake; asking again takes back a withdrawal.
select pg_temp.office_wake_withdrawal_patch('public.qorpera_request_runtime_office_start(jsonb,bigint,uuid)'::regprocedure,
	$old$and activated_at is null and superseded_at is null;
		insert into public.qorpera_runtime_office_idle_policies$old$,
	$new$and activated_at is null and superseded_at is null;
		insert into public.qorpera_runtime_office_wake_requests(transition_id,user_id,request_id)
			select c.transition_id,auth.uid(),p_request_id from public.qorpera_runtime_office_idle_cycles c
			where c.office_id=o.id and c.computer_generation=o.generation and c.activated_at is null and c.superseded_at is null
		on conflict(transition_id,user_id) do update set request_id=excluded.request_id,requested_at=excluded.requested_at,withdrawn_at=null;
		insert into public.qorpera_runtime_office_idle_policies$new$);
select pg_temp.office_wake_withdrawal_patch('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure,
	$old$		update public.qorpera_runtime_office_idle_policies set idle_since=null where office_id=o.id;$old$,
	$new$		update public.qorpera_runtime_office_idle_policies set idle_since=null where office_id=o.id;
		if c.transition_id is not null and c.activated_at is not null and c.demand_seen_at is null then
			update public.qorpera_runtime_office_idle_cycles set demand_seen_at=v_at where transition_id=c.transition_id returning * into c;
		end if;$new$);
select pg_temp.office_wake_withdrawal_patch('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)'::regprocedure,
	$old$	elsif v_at>=p.idle_since+p_idle_ms*interval '1 millisecond' then$old$,
	$new$	elsif v_at>=p.idle_since+(case when public.qorpera_runtime_office_wake_withdrawn(c) then interval '1 minute'
		else p_idle_ms*interval '1 millisecond' end) then$new$);

-- Only the member's own request for this computer generation. Withdrawing
-- never cancels the wake or reports physical state; status stays the truth.
create function public.qorpera_withdraw_runtime_office_wake(p_scope jsonb,p_computer_generation bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.qorpera_runtime_offices%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_request_id is null
		or p_computer_generation is null then
		raise exception 'Office member required' using errcode='42501'; end if;
	select * into o from public.qorpera_runtime_offices where id=(p_scope->>'companyComputerId')::uuid;
	if not found then raise exception 'Office start scope differs' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(o.profile_id);
	select * into strict o from public.qorpera_runtime_offices where id=o.id for update;
	if p_scope is distinct from public.qorpera_runtime_office_scope(o) or o.generation is distinct from p_computer_generation then
		raise exception 'Office start scope differs' using errcode='42501'; end if;
	update public.qorpera_runtime_office_wake_requests r set withdrawn_at=coalesce(r.withdrawn_at,clock_timestamp())
		from public.qorpera_runtime_office_idle_cycles c
		where c.transition_id=r.transition_id and c.office_id=o.id and c.computer_generation=o.generation
		and c.superseded_at is null and r.user_id=auth.uid() and r.request_id=p_request_id;
	if not found then return '{"state":"unavailable"}'::jsonb; end if;
	return '{"state":"withdrawn"}'::jsonb;
end $$;

revoke all on function public.qorpera_runtime_office_wake_withdrawn(public.qorpera_runtime_office_idle_cycles),
	public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid) to authenticated;
