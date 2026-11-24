set local lock_timeout = '3s';

-- WHY: Precompute immutable bundle implementation/component validation on insert so qorpera_execution_runtime_manifest skips scanning 2,000+ implementation keys under the run lock on every tool call.
create function public.qorpera_runtime_bundle_implementation_state(p_manifest jsonb)
returns text language sql immutable strict set search_path = '' as $$
	select case
		when jsonb_typeof(p_manifest -> 'implementation') is distinct from 'object'
			or p_manifest -> 'implementation' = '{}'::jsonb then 'bundle'
		when exists (
			select 1
			from jsonb_each_text(p_manifest -> 'implementation') source
			where length(source.value) <> 64 or source.value ~ '[^0-9a-f]'
		) then 'components'
		else 'ok'
	end;
$$;

create function public.qorpera_runtime_bundle_components_valid(p_manifest jsonb)
returns boolean language sql immutable strict set search_path = '' as $$
	select case
		when jsonb_typeof(p_manifest -> 'components') is distinct from 'object' then false
		else (p_manifest -> 'components' ?& array['kernel','constitution','toolCatalog','wakeAndSilence',
			'contextComposer','providerBootstrap','authorization','inboundSafety','outboundSafety',
			'interactionSurfaces','workerLifecycle','memoryAndSkills'])
			and not exists (
				select 1
				from jsonb_each_text(p_manifest -> 'components') component
				where component.value !~ '^[0-9a-f]{64}$'
			)
	end;
$$;

revoke all on function public.qorpera_runtime_bundle_implementation_state(jsonb),
	public.qorpera_runtime_bundle_components_valid(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_runtime_bundles
	add column implementation_state text
		generated always as (public.qorpera_runtime_bundle_implementation_state(manifest)) stored,
	add column components_valid boolean
		generated always as (public.qorpera_runtime_bundle_components_valid(manifest)) stored;

create function pg_temp.rm_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930893000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.rm_replace(
	'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$declare v_manifest jsonb;$old$,
	$new$declare v_manifest jsonb; v_impl_state text; v_components_valid boolean;$new$
);

select pg_temp.rm_replace(
	'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$	select manifest #> '{}'::text[] into v_manifest from public.qorpera_runtime_bundles$old$,
	$new$	select manifest #> '{}'::text[], implementation_state, components_valid into v_manifest, v_impl_state, v_components_valid from public.qorpera_runtime_bundles$new$
);

select pg_temp.rm_replace(
	'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$		or jsonb_typeof(v_manifest -> 'implementation') is distinct from 'object'
		or v_manifest -> 'implementation' = '{}'::jsonb$old$,
	$new$		or v_impl_state = 'bundle'$new$
);

select pg_temp.rm_replace(
	'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$	if not (v_manifest -> 'components' ?& array['kernel','constitution','toolCatalog','wakeAndSilence',
		'contextComposer','providerBootstrap','authorization','inboundSafety','outboundSafety',
		'interactionSurfaces','workerLifecycle','memoryAndSkills'])
		or exists(select 1 from jsonb_each_text(v_manifest -> 'components') component where component.value !~ '^[0-9a-f]{64}$')
		-- 20260930486000: the same test as before without the bounded regex, whose states were built afresh for each value.
		or exists(select 1 from jsonb_each_text(v_manifest -> 'implementation') source where length(source.value) <> 64 or source.value ~ '[^0-9a-f]') then$old$,
	$new$	if not coalesce(v_components_valid, false) or v_impl_state is distinct from 'ok' then$new$
);

do $$
declare v_proc pg_proc;
begin
	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure;
	if position('jsonb_each_text' in v_proc.prosrc) > 0
		or position('implementation_state' in v_proc.prosrc) = 0
		or position('components_valid' in v_proc.prosrc) = 0
		or v_proc.provolatile <> 's' or not v_proc.prosecdef
		or v_proc.proconfig is distinct from array['search_path=""'] then
		raise exception '20260930893000: runtime manifest function did not update as expected'; end if;
end $$;
