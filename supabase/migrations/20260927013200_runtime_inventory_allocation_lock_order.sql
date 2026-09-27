-- Admission locks allocation, then node. A new inventory binding's foreign
-- key needs KEY SHARE on that allocation; taking it after the node inverted
-- that order and could kill either real call with a deadlock. Acquire exactly
-- that FK lock first, in UUID order, without weakening admission/node locks.
do $migration$
declare definition text:=pg_get_functiondef('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)'::regprocedure);
    anchor text:=E' perform 1 from public.qorpera_runtime_nodes where id=v_id for update;';
    replacement text:=$patch$
 -- An immutable historical receipt returns or rejects in the existing replay
 -- branch below; it can never insert a new binding and needs no allocation.
 if not exists(select 1 from public.qorpera_runtime_node_inventory_receipts
     where node_id=v_id and observation_id=v_observation) then
  if exists(select 1 from jsonb_array_elements(p_inventory->'entries') item
      where jsonb_typeof(item) is distinct from 'object'
      or (item->>'category'='managed' and (jsonb_typeof(item->'allocation') is distinct from 'object'
          or coalesce(item#>>'{allocation,allocationId}','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))) then
   raise exception 'Invalid node inventory allocation identity' using errcode='42501'; end if;
  for v_binding in select to_jsonb(allocation_id) from (
      select distinct (item#>>'{allocation,allocationId}')::uuid allocation_id
      from jsonb_array_elements(p_inventory->'entries') item where item->>'category'='managed'
  ) allocations order by allocation_id loop
   perform 1 from public.qorpera_runtime_machine_allocations
       where id=(v_binding#>>'{}')::uuid for key share;
   if not found then
    raise sqlstate 'PGRST' using message='{"code":"QRC01","message":"Node inventory ledger changed","details":null,"hint":null}',
        detail='{"status":409,"headers":{}}'; end if;
  end loop;
 end if;
 perform 1 from public.qorpera_runtime_nodes where id=v_id for update;$patch$;
begin
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
        raise exception 'Reviewed inventory allocation lock source changed'; end if;
    execute replace(definition,anchor,replacement);
end $migration$;
