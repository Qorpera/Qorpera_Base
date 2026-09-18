-- Health producers pin officeDigest(parsed policy), while inventory custody
-- pins sha256(policy::text). Bridge those encodings of the SAME immutable
-- enrolled policy; never rewrite enrollment pins or historical observations.
-- This private serializer is scoped to inventory-policy/v1: named ASCII keys,
-- strings, arrays and nonnegative safe integers. It is not a general JCS or
-- JavaScript-number serializer. C ordering matches JavaScript for these keys.
create function public.qorpera_node_health_policy_json(p_value jsonb)
returns text language plpgsql immutable strict set search_path = '' as $$
declare v_kind text:=jsonb_typeof(p_value); v_result text; v_item record; v_child text;
begin
 if v_kind='string' then return p_value::text;
 elsif v_kind='number' then
  if p_value::text !~ '^(0|[1-9][0-9]{0,15})$' or (p_value::text)::numeric>9007199254740991 then return null; end if;
  return p_value::text;
 elsif v_kind='array' then
  v_result:='';
  for v_item in select value from jsonb_array_elements(p_value) with ordinality e(value,ordinal) order by ordinal loop
   v_child:=public.qorpera_node_health_policy_json(v_item.value);
   if v_child is null then return null; end if;
   v_result:=v_result||case when v_result='' then '' else ',' end||v_child;
  end loop;
  return '['||v_result||']';
 elsif v_kind='object' then
  v_result:='';
  for v_item in select key,value from jsonb_each(p_value) order by key collate "C" loop
   if v_item.key !~ '^[A-Za-z][A-Za-z0-9]*$' then return null; end if;
   v_child:=public.qorpera_node_health_policy_json(v_item.value);
   if v_child is null then return null; end if;
   v_result:=v_result||case when v_result='' then '' else ',' end||to_jsonb(v_item.key)::text||':'||v_child;
  end loop;
  return '{'||v_result||'}';
 end if;
 return null;
end
$$;

create function public.qorpera_node_health_policy_matches(p_policy jsonb,p_inventory_sha256 text,p_observed_sha256 text)
returns boolean language sql immutable set search_path = '' as $$
 select coalesce(p_policy->>'schema'='qorpera.runtime-node-inventory-policy/v1'
  and p_inventory_sha256=encode(extensions.digest(p_policy::text,'sha256'),'hex')
  and case when p_observed_sha256=p_inventory_sha256 then true
   else p_observed_sha256=encode(extensions.digest(public.qorpera_node_health_policy_json(p_policy),'sha256'),'hex') end,false)
$$;
revoke all on function public.qorpera_node_health_policy_json(jsonb),
 public.qorpera_node_health_policy_matches(jsonb,text,text) from public,anon,authenticated,service_role;

-- Only the two policy comparisons change. Guard exact source sites so a
-- divergent predecessor cannot silently discard a newer authorization fence.
do $migration$
declare v_function regprocedure; v_source text; v_old text; v_new text;
begin
 for v_function,v_old,v_new in select * from (values
  ('public.qorpera_observe_runtime_node_health(jsonb)'::regprocedure,
   'p.policy_sha256=p_observation->>''policySha256''',
   'public.qorpera_node_health_policy_matches(p.policy,p.policy_sha256,p_observation->>''policySha256'')'),
  ('public.qorpera_runtime_node_health(uuid)'::regprocedure,
   'p.policy_sha256=r.observation->>''policySha256''',
   'public.qorpera_node_health_policy_matches(p.policy,p.policy_sha256,r.observation->>''policySha256'')')
 ) s(signature,old_text,new_text) loop
  v_source:=pg_get_functiondef(v_function);
  if (length(v_source)-length(replace(v_source,v_old,'')))/length(v_old)<>1 then
   raise exception 'Node health policy bridge source differs: %',v_function;
  end if;
  execute replace(v_source,v_old,v_new);
 end loop;
end
$migration$;
