-- Member input is admitted per WINDOW, not per packet. One gateway round trip
-- re-validates everything per-packet admission validated and records the
-- audit row of the packets the gateway dispatched since its previous call.
-- A window never exceeds one second, the bound the browser egress relay's
-- re-check already accepts, so a fence still stops input within that second.
-- The per-packet function stays for gateways that predate this migration;
-- both advance the same last_sequence and share one ledger.

-- packet_count is null for a per-packet row. A window row covers the
-- contiguous range sequence .. sequence+packet_count-1 and input_commitment is
-- the per-connection keyed chain over that range's per-packet commitments.
-- Still no raw keys, enumerable digests, pointer positions or pixels.
-- The ledger is live and per-packet admits from older gateways keep inserting.
-- Adding the columns is a catalog change. The constraint is added NOT VALID and
-- validated separately, so the full scan runs without the exclusive lock.
alter table public.qorpera_runtime_office_viewer_inputs
	add column packet_count integer,
	-- True when the call that recorded the row was itself refused: the viewer was
	-- already fenced, expired or released. The packets had been dispatched under
	-- the previous, valid window; the row is audit, never evidence of authority.
	add column recorded_after_refusal boolean not null default false;
alter table public.qorpera_runtime_office_viewer_inputs
	add constraint qorpera_runtime_office_viewer_inputs_packet_count_check
	check(packet_count is null or packet_count between 1 and 4096) not valid;
alter table public.qorpera_runtime_office_viewer_inputs
	validate constraint qorpera_runtime_office_viewer_inputs_packet_count_check;

create function public.qorpera_admit_runtime_office_viewer_input_window(p_grant jsonb,p_first_sequence bigint,p_count integer,p_window_commitment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_grant jsonb; v_viewer public.qorpera_runtime_office_viewers%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Viewer gateway required' using errcode='42501'; end if;
	-- p_count=0 opens the first window (or renews an idle one): pure validation.
	if coalesce(p_grant->>'mode','') not in ('shared','control') or p_first_sequence is null or p_first_sequence<1
		or p_count is null or p_count<0 or p_count>4096 or (p_count=0)<>(p_window_commitment is null)
		or (p_count>0 and coalesce(p_window_commitment,'') !~ '^[0-9a-f]{64}$') then
		raise exception 'Member input unavailable' using errcode='42501'; end if;
	-- Same authority and lock order (office, screen, viewer) as every sibling
	-- viewer function. A refusal must not erase the audit of packets that were
	-- already dispatched under the previous window, so it is caught here: its
	-- locks and expiry renewal roll back, and only the viewer row is locked below.
	begin
		v_grant:=public.qorpera_check_runtime_office_viewer(p_grant);
	exception when insufficient_privilege then v_grant:=null;
	end;
	select * into v_viewer from public.qorpera_runtime_office_viewers where id=(p_grant->>'viewerSessionId')::uuid for update;
	if not found or v_viewer.redeemed_at is null or public.qorpera_runtime_office_viewer_identity(p_grant) is distinct from
		public.qorpera_runtime_office_viewer_identity(public.qorpera_runtime_office_viewer_grant(v_viewer)) then
		raise exception 'Viewer identity differs' using errcode='42501'; end if;
	-- An exact replay of this viewer's last row is a resend after a lost or late
	-- answer: already recorded, so only the validation below is repeated. Any
	-- other replayed, overlapping or skipped range is refused.
	if p_count>0 and p_first_sequence+p_count-1=v_viewer.last_sequence and exists(
		select 1 from public.qorpera_runtime_office_viewer_inputs i where i.viewer_id=v_viewer.id and i.sequence=p_first_sequence
			and i.packet_count=p_count and i.input_commitment=p_window_commitment) then
		null;
	elsif p_first_sequence<>v_viewer.last_sequence+1 then
		raise exception 'Viewer input already consumed or out of order' using errcode='55000';
	elsif p_count>0 then
		-- A window lasts one second and its report follows at once. Long after the
		-- viewer ended or expired nothing is accepted into its ledger any more.
		if v_grant is null and clock_timestamp()>least(coalesce(v_viewer.ended_at,'infinity'::timestamptz),v_viewer.expires_at)+interval '10 seconds' then
			raise exception 'Viewer input ledger closed' using errcode='42501'; end if;
		insert into public.qorpera_runtime_office_viewer_inputs(viewer_id,sequence,input_commitment,packet_count,recorded_after_refusal)
			values(v_viewer.id,p_first_sequence,p_window_commitment,p_count,v_grant is null);
		update public.qorpera_runtime_office_viewers set last_sequence=p_first_sequence+p_count-1 where id=v_viewer.id;
	end if;
	-- Recorded, but no new window: the gateway stops dispatching and drains held input.
	if v_grant is null then return '{"state":"refused"}'::jsonb; end if;
	return jsonb_build_object('state','admitted','validForMs',least(1000,(v_grant->>'validForMs')::bigint));
end
$$;

revoke all on function public.qorpera_admit_runtime_office_viewer_input_window(jsonb,bigint,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_admit_runtime_office_viewer_input_window(jsonb,bigint,integer,text) to service_role;

-- Operator activity counts input packets, not ledger rows: a window row stands
-- for packet_count packets. Patch the current definition, exactly once each.
create function pg_temp.viewer_window_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Viewer input window integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.viewer_window_patch('public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz)'::regprocedure,
	$old$v.redeemed_at at,'viewer_redemption' source$old$,
	$new$v.redeemed_at at,'viewer_redemption' source,1::bigint packets$new$);
select pg_temp.viewer_window_patch('public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz)'::regprocedure,
	$old$i.admitted_at,'admitted_control_input'$old$,
	$new$i.admitted_at,'admitted_control_input',coalesce(i.packet_count,1)::bigint$new$);
select pg_temp.viewer_window_patch('public.qorpera_runtime_compute_users(uuid,timestamptz,timestamptz)'::regprocedure,
	$old$'admittedControlInputs',count(*) filter(where source='admitted_control_input')$old$,
	$new$'admittedControlInputs',coalesce(sum(packets) filter(where source='admitted_control_input'),0)::bigint$new$);
drop function pg_temp.viewer_window_patch(regprocedure,text,text);
