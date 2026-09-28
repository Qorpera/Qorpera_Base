-- Inventory lock order (re-cut of closed draft #326's 20260927013200 on the current function body).
--
-- Admission (qorpera_reserve_runtime_node_machine) locks the machine allocation, then the node.
-- qorpera_observe_runtime_node_inventory locked the node first; recording a new instance binding then
-- needed KEY SHARE on the allocation for its foreign key. That inverted the order: a first inventory
-- binding and an admission of the same machine could deadlock, and PostgreSQL killed one of them.
-- A new observation now takes exactly those foreign-key locks first, in UUID order, then the node.
-- An exact historical receipt replays without them (it never inserts a binding). A managed entry that
-- names an allocation that does not exist takes no lock and is refused by the existing checks, as
-- before: it cannot match the context, and an allocation created after the observer read its context
-- changes the context digest, which refuses the report with 409 before any binding is inserted.
-- Admission, the node lock and every check after it are unchanged.

do $guard$ begin
	if encode(extensions.digest(pg_get_functiondef('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)'::regprocedure), 'sha256'), 'hex') <> '06ab808a35dad39a1b435bde92a1671e6b9e9f2118f25a3e3d3c5837e50aef91' then
		raise exception 'Reviewed function definition changed: qorpera_observe_runtime_node_inventory';
	end if;
end $guard$;

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
  -- Admission's order: allocation, then node. Take the binding foreign key's lock first, in UUID order.
  for v_binding in select to_jsonb(allocation_id) from (
      select distinct (item#>>'{allocation,allocationId}')::uuid allocation_id
      from jsonb_array_elements(p_inventory->'entries') item where item->>'category'='managed'
  ) allocations order by allocation_id loop
   perform 1 from public.qorpera_runtime_machine_allocations
       where id=(v_binding#>>'{}')::uuid for key share;
  end loop;
 end if;
 perform 1 from public.qorpera_runtime_nodes where id=v_id for update;$patch$;
begin
	if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
		raise exception 'Reviewed inventory allocation lock source changed'; end if;
	execute replace(definition,anchor,replacement);
end $migration$;
