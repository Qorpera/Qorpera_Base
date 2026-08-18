-- Merge-blocker hardening discovered during the hosted-cloud v1 review.
--
-- The earlier migrations were applied through the SQL editor before CLI
-- history existed. Keep this corrective migration safe for both those live
-- environments and fresh ordered migration runs.

create function public.qorpera_object_root_creator(
	p_root_kind text,
	p_root_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
	select root.created_by_user_id
	from (
		select artifact.created_by_user_id
		from public.qorpera_artifacts as artifact
		where p_root_kind = 'artifact' and artifact.id = p_root_id
		union all
		select snapshot.created_by_user_id
		from public.qorpera_company_snapshots as snapshot
		where p_root_kind = 'company_snapshot' and snapshot.id = p_root_id
	) as root
	limit 1
$$;

revoke all on function public.qorpera_object_root_creator(text, uuid) from public;

alter table public.qorpera_object_reachability_graphs
	add column closure_verified boolean not null default false;

-- A writer could previously reserve another member's root with an incomplete
-- graph. Remove any such rows before enforcing root-creator ownership.
delete from public.qorpera_object_reachability_graphs as graph
where graph.created_by_user_id is distinct from
	public.qorpera_object_root_creator(graph.root_kind, graph.root_id);

delete from public.qorpera_object_reachability_graphs as graph
using public.qorpera_artifacts as artifact
where graph.root_kind = 'artifact'
	and graph.root_id = artifact.id
	and artifact.root_contract = 'qorpera.object/v1'
	and (
		graph.object_count <> 1
		or graph.storage_bytes <> artifact.bytes
		or not exists (
			select 1
			from public.qorpera_object_reachability_entries as entry
			where entry.graph_id = graph.id
				and entry.object_sha256 = graph.root_object_sha256
				and entry.bytes = artifact.bytes
		)
	);

update public.qorpera_object_reachability_graphs as graph
set closure_verified = true
from public.qorpera_artifacts as artifact
where graph.root_kind = 'artifact'
	and graph.root_id = artifact.id
	and graph.status = 'complete'
	and artifact.root_contract = 'qorpera.object/v1'
	and graph.object_count = 1
	and graph.storage_bytes = artifact.bytes
	and 1 = (
		select count(*)
		from public.qorpera_object_reachability_entries as entry
		where entry.graph_id = graph.id
			and entry.object_sha256 = graph.root_object_sha256
			and entry.bytes = artifact.bytes
	);

create or replace function public.qorpera_object_root_has_current_proof(p_root_kind text, p_root_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_object_reachability_graphs as graph
		join public.qorpera_object_restore_proofs as proof on proof.graph_id = graph.id
		where graph.root_kind = p_root_kind
			and graph.root_id = p_root_id
			and graph.status = 'complete'
			and graph.closure_verified
			and proof.valid_until > statement_timestamp()
			and public.qorpera_object_graph_objects_available(graph.id)
	)
$$;

revoke all on function public.qorpera_object_root_has_current_proof(text, uuid) from public;

create function public.qorpera_enforce_object_graph_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_root_creator uuid;
	v_direct_artifact_bytes bigint;
	v_entry_count integer;
	v_entry_bytes bigint;
begin
	v_root_creator := public.qorpera_object_root_creator(new.root_kind, new.root_id);
	if v_root_creator is null or new.created_by_user_id is distinct from v_root_creator then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if auth.role() is distinct from 'service_role' and auth.uid() is distinct from v_root_creator then
		raise exception 'object reachability requires root-creator access' using errcode = '42501';
	end if;
	if tg_op = 'UPDATE' then
		if new.profile_id is distinct from old.profile_id
			or new.environment_id is distinct from old.environment_id
			or new.root_kind is distinct from old.root_kind
			or new.root_id is distinct from old.root_id
			or new.client_graph_id is distinct from old.client_graph_id
			or new.root_object_sha256 is distinct from old.root_object_sha256
			or new.contract_version is distinct from old.contract_version
			or new.content_sha256 is distinct from old.content_sha256
			or new.object_count is distinct from old.object_count
			or new.storage_bytes is distinct from old.storage_bytes
			or new.created_by_user_id is distinct from old.created_by_user_id then
			raise exception 'object reachability graph identity is immutable' using errcode = '22023';
		end if;
		if new.status = 'complete' and new.root_kind = 'artifact' then
			select artifact.bytes into v_direct_artifact_bytes
			from public.qorpera_artifacts as artifact
			where artifact.id = new.root_id and artifact.root_contract = 'qorpera.object/v1';
			if found and (old.status <> 'complete' or (new.closure_verified and not old.closure_verified)) then
				select count(*), coalesce(sum(entry.bytes), 0)
				into v_entry_count, v_entry_bytes
				from public.qorpera_object_reachability_entries as entry
				where entry.graph_id = new.id;
				if v_entry_count <> 1 or v_entry_bytes <> v_direct_artifact_bytes or not exists (
					select 1
					from public.qorpera_object_reachability_entries as entry
					where entry.graph_id = new.id
						and entry.object_sha256 = new.root_object_sha256
						and entry.bytes = v_direct_artifact_bytes
				) then
					raise exception 'direct artifact reachability must contain exactly its root object'
						using errcode = '22023';
				end if;
				new.closure_verified := true;
			end if;
		end if;
	end if;
	if new.closure_verified and (
		new.status <> 'complete'
		or new.root_kind <> 'artifact'
		or not exists (
			select 1
			from public.qorpera_artifacts as artifact
			where artifact.id = new.root_id and artifact.root_contract = 'qorpera.object/v1'
		)
	) then
		raise exception 'manifest reachability closure is not server-verified' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_object_graph_owner_guard
before insert or update on public.qorpera_object_reachability_graphs
for each row execute function public.qorpera_enforce_object_graph_owner();

create function public.qorpera_enforce_object_graph_entry_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph_creator uuid;
begin
	select graph.created_by_user_id into v_graph_creator
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = new.graph_id;
	if v_graph_creator is null
		or (auth.role() is distinct from 'service_role' and auth.uid() is distinct from v_graph_creator) then
		raise exception 'object reachability requires graph-creator access' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_object_graph_entry_owner_guard
before insert or update on public.qorpera_object_reachability_entries
for each row execute function public.qorpera_enforce_object_graph_entry_owner();

create function public.qorpera_mark_direct_object_closure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_object_reachability_graphs as graph
	set closure_verified = true
	from public.qorpera_artifacts as artifact
	where graph.id = new.graph_id
		and graph.root_kind = 'artifact'
		and graph.root_id = artifact.id
		and graph.status = 'complete'
		and not graph.closure_verified
		and artifact.root_contract = 'qorpera.object/v1';
	return new;
end
$$;

create trigger qorpera_mark_direct_object_closure
after insert on public.qorpera_object_reachability_entries
for each row execute function public.qorpera_mark_direct_object_closure();

create function public.qorpera_enforce_object_restore_proof_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_graph_creator uuid;
begin
	select graph.created_by_user_id into v_graph_creator
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = new.graph_id and graph.profile_id = new.profile_id;
	if v_graph_creator is null
		or new.verified_by_user_id is distinct from v_graph_creator
		or (auth.role() is distinct from 'service_role' and auth.uid() is distinct from v_graph_creator) then
		raise exception 'object restore proof requires graph-creator access' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_object_restore_proof_owner_guard
before insert or update on public.qorpera_object_restore_proofs
for each row execute function public.qorpera_enforce_object_restore_proof_owner();

revoke all on function public.qorpera_enforce_object_graph_owner() from public;
revoke all on function public.qorpera_enforce_object_graph_entry_owner() from public;
revoke all on function public.qorpera_mark_direct_object_closure() from public;
revoke all on function public.qorpera_enforce_object_restore_proof_owner() from public;

-- Output registrations belong only to the active attempt. Requeue, terminal
-- abandonment, and direct expired-lease recovery all discard prior mappings
-- before a later completion can construct its immutable artifact index.
delete from public.qorpera_runner_job_artifacts as job_artifact
using public.qorpera_runner_jobs as job
where job.id = job_artifact.job_id and job.status <> 'completed';

create function public.qorpera_clear_abandoned_runner_artifacts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.attempt_count > old.attempt_count
		or (old.status = 'leased' and new.status in ('queued', 'failed', 'cancelled')) then
		delete from public.qorpera_runner_job_artifacts as job_artifact
		where job_artifact.job_id = new.id;
	end if;
	return new;
end
$$;

create trigger qorpera_clear_abandoned_runner_artifacts
after update of status, attempt_count on public.qorpera_runner_jobs
for each row execute function public.qorpera_clear_abandoned_runner_artifacts();

revoke all on function public.qorpera_clear_abandoned_runner_artifacts() from public;
