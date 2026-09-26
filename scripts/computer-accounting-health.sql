-- This query only reads a single operator snapshot. No deadline authorizes a
-- refund, physical stop, reconstructed usage or guest drain.
with current_permits as (
 select p.id,p.state,p.generation,p.physical_id,p.guest_boot_id,p.last_sample,w.deadline,w.reservation_id
 from public.qorpera_coding_computer_permits p
 left join public.qorpera_coding_computer_windows w on w.permit_id=p.id and w.generation=p.generation
), findings as (
 select 'permit_window_missing' code,id::text id from current_permits where reservation_id is null
 union all select 'permit_expired_open',id::text from current_permits
 where state<>'closed' and deadline<statement_timestamp()-make_interval(secs=>:grace_seconds)
 union all select 'bound_identity_missing',id::text from current_permits
 where state='bound' and (physical_id is null or guest_boot_id is null)
 union all select 'bound_observation_unconfirmed',id::text from current_permits
 where state='bound' and (last_sample is null or last_sample->>'state' is distinct from 'running' or last_sample->>'observedAt' is null
  or (last_sample->>'observedAt')::timestamptz<statement_timestamp()-make_interval(secs=>:sample_seconds))
 union all select 'permit_generation_chain_invalid',p.id::text from current_permits p
 left join lateral (select count(*) n,min(generation) lo,max(generation) hi from public.qorpera_coding_computer_windows where permit_id=p.id) chain on true
 where chain.n<>p.generation or chain.lo<>1 or chain.hi<>p.generation
 union all select 'reservation_expired_unsettled',r.id::text from public.qorpera_computer_allowance_reservations r
 where r.settled_at is null and r.deadline<statement_timestamp()-make_interval(secs=>:grace_seconds)
 union all select 'closed_permit_unsettled',p.id::text from current_permits p
 join public.qorpera_coding_computer_windows w on w.permit_id=p.id
 join public.qorpera_computer_allowance_reservations r on r.id=w.reservation_id
 where p.state='closed' and r.settled_at is null
 union all select 'prior_generation_unsettled',p.id::text from current_permits p
 join public.qorpera_coding_computer_windows w on w.permit_id=p.id and w.generation<p.generation
 join public.qorpera_computer_allowance_reservations r on r.id=w.reservation_id where r.settled_at is null
 union all select 'hold_missing_prestart_custody',r.id::text from public.qorpera_computer_allowance_reservations r
 left join public.qorpera_coding_computer_windows w on w.reservation_id=r.id
 left join public.qorpera_computer_prestart_attempts a on a.permit_id=w.permit_id
 where r.settled_at is null and a.permit_id is null
 union all select 'held_meter_shape_unknown',r.id::text from public.qorpera_computer_allowance_reservations r
 join public.qorpera_computer_usage_streams s using(allocation_id,epoch)
 where r.settled_at is null and (s.resource_shape is null or s.resource_shape->>'cpuMillis' is null or s.resource_shape->>'memoryBytes' is null)
 union all select 'reservation_holds_mismatch',r.id::text from public.qorpera_computer_allowance_reservations r
 left join lateral (select sum(amount_us) n from public.qorpera_computer_allowance_holds h where h.reservation_id=r.id) held on true
 where r.reserved_us<>coalesce(held.n,0)
 union all select 'bucket_conservation_mismatch',b.id::text from public.qorpera_computer_allowance_buckets b
 left join lateral (select sum(h.amount_us) n from public.qorpera_computer_allowance_holds h
  join public.qorpera_computer_allowance_reservations r on r.id=h.reservation_id where h.bucket_id=b.id and r.settled_at is null) held on true
 left join lateral (select sum(d.debited_us) n from public.qorpera_computer_allowance_debits d where d.bucket_id=b.id) spent on true
 where b.reserved_us<0 or b.debited_us<0 or b.reserved_us+b.debited_us>b.issued_us
  or b.reserved_us<>coalesce(held.n,0) or b.debited_us<>coalesce(spent.n,0)
 union all select 'billing_command_reconciliation_required',id::text from public.qorpera_computer_billing_commands
 where result is null and not recovered_terminal and created_at<statement_timestamp()-interval '23 hours'
  and (lease_until is null or lease_until<statement_timestamp())
), grouped as (
 select code,count(distinct id)::integer count,(array_agg(distinct id order by id))[1:20] ids from findings group by code
)
select jsonb_build_object('schema','qorpera.computer-accounting-health/v1','observedAt',statement_timestamp(),
 'activePermitCount',(select count(*) from current_permits where state<>'closed'),
 'findings',coalesce((select jsonb_agg(to_jsonb(grouped) order by code) from grouped),'[]'::jsonb),
 'informational',jsonb_build_object('fundingShortfallBuckets',(select count(*) from public.qorpera_computer_allowance_buckets where reserved_us+debited_us>funded_us)));
