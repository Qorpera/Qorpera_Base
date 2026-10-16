-- A run with no compute identity is assigned to no runner (launch checklist L16.1, contract section 21 item 16: "no
-- agent receives a member-machine capability"; P5 gap test 427, 16 October 2026).
--
-- qorpera_runner_assignment_compute_guard (20260821002000) checks that the runner attests the run's compute identity:
-- a Qorpera computer of the run's company, logical computer, identity, worker class, template and policy. It returned
-- early when the run had no compute identity, so it checked nothing then, not even the runner's kind. A member's own
-- machine, registered and activated as a 'local' runner of the company (qorpera_create_runner_registration,
-- qorpera_activate_runner), could then be assigned such a run by the node host. No folder path makes such a run today:
-- provisioning refuses one, the materializer cancels a native wake without one, and the host's exactRunner checks the
-- runner. Every runner of a Qorpera computer is provisioned for a compute identity, so a run without one has no runner
-- that can attest it. The guard now refuses it, with its usual error, and is otherwise unchanged.

create or replace function public.qorpera_runner_assignment_compute_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_runner public.qorpera_runners%rowtype;
	v_identity public.qorpera_member_compute_identities%rowtype;
	v_computer public.qorpera_logical_computers%rowtype;
	v_template_key text;
	v_template_version text;
	v_policy jsonb;
	v_worker_class text;
begin
	select run.* into strict v_run
	from public.qorpera_execution_runs as run where run.id = new.run_id;
	if v_run.compute_identity_id is null then
		raise exception 'runner does not attest the execution compute identity' using errcode = '42501';
	end if;
	select runner.* into strict v_runner
	from public.qorpera_runners as runner where runner.id = new.runner_id;
	select identity.* into strict v_identity
	from public.qorpera_member_compute_identities as identity
	where identity.id = v_run.compute_identity_id and identity.status = 'active';
	if v_run.logical_computer_id is not null then
		select computer.* into strict v_computer
		from public.qorpera_logical_computers as computer
		where computer.id = v_run.logical_computer_id and computer.status = 'active';
		v_template_key := v_computer.template_key;
		v_template_version := v_computer.template_version;
		v_policy := v_computer.policy;
		v_worker_class := v_computer.computer_class;
	else
		v_template_key := v_identity.template_key;
		v_template_version := v_identity.template_version;
		v_policy := v_identity.policy;
		v_worker_class := v_run.worker_class;
	end if;
	if v_runner.runner_kind <> 'qorpera_computer'
		or v_runner.profile_id <> v_run.profile_id
		or v_runner.logical_computer_id is distinct from v_run.logical_computer_id
		or v_runner.compute_identity_id is distinct from v_run.compute_identity_id
		or v_runner.worker_class is distinct from v_worker_class
		or v_runner.template_key is distinct from v_template_key
		or v_runner.template_version is distinct from v_template_version
		or v_runner.compute_policy_sha256 is distinct from public.qorpera_compute_policy_sha256(v_policy) then
		raise exception 'runner does not attest the execution compute identity' using errcode = '42501';
	end if;
	return new;
end
$$;
