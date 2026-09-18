-- Test-only synthetic host publisher for pre-existing capacity/provider proofs.
-- Installed explicitly by disposable database drivers, never by a migration.
-- Empty inventory represents pre-create/absent fixture VMs, NOT measured LXD.
create function public.qorpera_test_observe_runtime_node(p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_node public.qorpera_runtime_nodes%rowtype; v_context jsonb; v_prior public.qorpera_runtime_node_inventory_receipts%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Fixture publisher requires service authority' using errcode='42501'; end if;
 select * into strict v_node from public.qorpera_runtime_nodes where id=(p_observation->>'nodeId')::uuid;
 select * into v_prior from public.qorpera_runtime_node_inventory_receipts where node_id=v_node.id and observation_id=(p_observation->>'observationId')::uuid;
 if found then return public.qorpera_observe_runtime_node_inventory(p_observation,v_prior.context_sha256,v_prior.inventory); end if;
 if not exists(select 1 from public.qorpera_runtime_node_inventory_policies where node_id=v_node.id) then
  perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1','nodeId',v_node.id,
   'host',jsonb_build_object('machineIdSha256',v_node.machine_id_sha256,'socketPath','/fixture/lxd.socket','socketGid',2000,
    'certificateSha256',repeat('a',64),'serverName','fixture','serverVersion','6.9','architecture','x86_64'),
   'operatingCpuMillis',1,'operatingMemoryBytes',1,'infrastructure','[]'::jsonb));
 end if;
 v_context:=public.qorpera_runtime_node_inventory_context(v_node.id);
 return public.qorpera_observe_runtime_node_inventory(p_observation,v_context->>'contextSha256',jsonb_build_object(
  'schema','qorpera.runtime-node-inventory/v1','bootId','36000000-0000-4000-8000-000000000099','entries','[]'::jsonb));
end
$$;
revoke all on function public.qorpera_test_observe_runtime_node(jsonb) from public,anon,authenticated;
grant execute on function public.qorpera_test_observe_runtime_node(jsonb) to service_role;
