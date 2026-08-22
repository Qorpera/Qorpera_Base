-- The hosted project was intentionally reset before real customer use. There
-- is no pre-cloud transcript history to preserve, so retire the temporary
-- import lane rather than carrying a second provenance contract into launch.

do $$
begin
	if exists (select 1 from public.qorpera_legacy_session_imports) then
		raise exception 'legacy session imports exist and must be reviewed before retiring the import lane';
	end if;
end
$$;

drop trigger qorpera_block_session_inputs_during_legacy_import on public.qorpera_session_inputs;
drop trigger qorpera_block_session_execution_during_legacy_import on public.qorpera_execution_runs;
drop trigger qorpera_fence_legacy_session_import on public.qorpera_session_events;
drop trigger qorpera_block_session_close_during_legacy_import on public.qorpera_shared_sessions;

drop function public.qorpera_block_session_inputs_during_legacy_import();
drop function public.qorpera_block_session_execution_during_legacy_import();
drop function public.qorpera_fence_legacy_session_import();
drop function public.qorpera_block_session_close_during_legacy_import();
drop function public.qorpera_begin_legacy_session_import(uuid, uuid, text, integer);
drop function public.qorpera_append_legacy_session_import_event(uuid, uuid, text, jsonb, bigint);
drop function public.qorpera_complete_legacy_session_import(uuid);

drop table public.qorpera_legacy_session_import_events;
drop table public.qorpera_legacy_session_imports;

create or replace function public.qorpera_read_session_events(
	p_session_id uuid,
	p_after_sequence bigint default 0,
	p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
begin
	v_profile_id := public.qorpera_session_profile_id(p_session_id);
	if v_profile_id is null or not public.qorpera_can_read_profile(v_profile_id) then
		raise exception 'profile read access is required' using errcode = '42501';
	end if;
	if p_after_sequence < 0 or p_limit not between 1 and 500 then
		raise exception 'event page is invalid' using errcode = '22023';
	end if;
	return coalesce(
		(
			select jsonb_agg(
				jsonb_build_object(
					'session_id', event.session_id,
					'sequence', event.sequence,
					'event_id', event.event_id,
					'event_type', event.event_type,
					'actor_user_id', event.actor_user_id,
					'body', event.body,
					'previous_hash', event.previous_hash,
					'event_hash', event.event_hash,
					'execution_kind', event.execution_kind,
					'execution_id', event.execution_id,
					'execution_claimant_id', event.execution_claimant_id,
					'runner_assignment_id', event.runner_assignment_id,
					'session_input_id', event.session_input_id,
					'created_at', event.created_at
				)
				order by event.sequence
			)
			from (
				select source.*
				from public.qorpera_session_events as source
				where source.session_id = p_session_id and source.sequence > p_after_sequence
				order by source.sequence
				limit p_limit
			) as event
		),
		'[]'::jsonb
	);
end
$$;

revoke all on function public.qorpera_read_session_events(uuid, bigint, integer) from public, anon;
grant execute on function public.qorpera_read_session_events(uuid, bigint, integer) to authenticated;
