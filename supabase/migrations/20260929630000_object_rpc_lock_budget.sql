-- Object gateway RPCs wait at most 2 s for a lock, below the gateway's 5 s deadline.
--
-- The object gateway gives each database call 5 s. When a call runs out, its circuit counts that as the database
-- being down and refuses every company for its cooldown (~5 s). The native and member object RPCs and the NAS
-- replication RPCs take the company's profile fence exclusively; they are not readers. Their lock waits were bounded
-- only by the role's 8 s, or by the lease validator's 25 s, so one company's held fence ran the gateway out of time
-- and turned away every other company. Now a wait ends after 2 s with lock_not_available (55P03), which the gateway
-- reads as that company's lock conflict (packages/object-gateway, dependency.ts): 409 for the native and member
-- object RPCs, 503 for replication, where the reconciler must keep the object pending, not block it. Neither opens
-- the circuit.
--
-- The entry point decides, not the called function, as for the shared fence readers (20260929380000): these
-- functions are also called inside others (office capture and file export, shared file export, the NAS replica
-- insert guard on storage.objects, which Supabase Storage reaches with its own request.path). Those callers keep
-- their budgets. PostgREST sets request.path to the RPC it runs, one RPC per transaction, so the budget holds for
-- that whole transaction and is set before its first lock.
--
-- - lock_timeout covers every wait outside a function with its own lock_timeout.
-- - qorpera.company_fence_wait covers the fence wait inside the lease validator (lock_timeout 25s), where the native
--   object RPCs first take the fence: the fence honours it once 20260929380000 is applied (company fence shared
--   readers). Until then the setting is inert and those waits keep the validator's budget.
--
-- The 2 s matches the Company File write path's budget (20260929380000). A call that used to wait 2-5 s for another
-- call of its own company now ends with 409 (a retryable conflict: nothing was committed) instead of succeeding late;
-- a call that used to wait past 5 s ended with the gateway's 503 and refused every company, and now refuses nobody.

set local lock_timeout = '3s';

create function public.qorpera_object_rpc_lock_budget()
returns void
language plpgsql
set search_path = ''
as $$
begin
	if substring(coalesce(pg_catalog.current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$') = any (array[
		'qorpera_authorize_native_company_object_upload',
		'qorpera_confirm_native_company_object_upload',
		'qorpera_authorize_native_company_object_download',
		'qorpera_authorize_member_company_path_object',
		'qorpera_authorize_member_company_snapshot_object',
		'qorpera_authorize_profile_object_replication',
		'qorpera_confirm_profile_object_replica'
	]) then
		-- Transaction-local, and this function sets neither, so both outlive this call for the rest of the RPC.
		perform pg_catalog.set_config('lock_timeout', '2s', true);
		perform pg_catalog.set_config('qorpera.company_fence_wait', '2s', true);
	end if;
end
$$;
comment on function public.qorpera_object_rpc_lock_budget() is
	'Sets a 2 s lock budget for the rest of the transaction when it entered through an object gateway RPC (PostgREST request.path). 20260929630000.';
-- Internal: only the functions below call it. Supabase's default privileges would grant EXECUTE to the API roles.
revoke all on function public.qorpera_object_rpc_lock_budget() from public, anon, authenticated, service_role;

-- Each RPC sets the budget first, before any lock: the call goes right after its body's top-level begin (the only
-- unindented one). The live text is patched, so later changes to these bodies are kept.
create function pg_temp.object_rpc_lock_budget_patch(p_target regprocedure)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, E'\nbegin\n', ''))) / length(E'\nbegin\n') <> 1
		or v_definition like '%qorpera_object_rpc_lock_budget%' then
		raise exception 'Object RPC lock budget: % differs', p_target; end if;
	execute replace(v_definition, E'\nbegin\n', E'\nbegin\n\tperform public.qorpera_object_rpc_lock_budget();\n');
end
$$;

select pg_temp.object_rpc_lock_budget_patch(target) from unnest(array[
	'public.qorpera_authorize_native_company_object_upload(jsonb,uuid,text,bigint)',
	'public.qorpera_confirm_native_company_object_upload(jsonb,uuid,text,bigint)',
	'public.qorpera_authorize_native_company_object_download(jsonb,uuid,text)',
	'public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text)',
	'public.qorpera_authorize_member_company_snapshot_object(uuid,text,uuid,text)',
	'public.qorpera_authorize_profile_object_replication(uuid,text,bigint)',
	'public.qorpera_confirm_profile_object_replica(uuid,text,bigint)'
]::regprocedure[]) target;
