import {
	type CompanyComputerResetServiceRestartCompletion,
	type CompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartRequest,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import {
	companyComputerResetServiceRestartCompletionPath,
	companyComputerResetSuccessorClaim,
} from "../../src/cloud-company-computer-reset-invocation-evidence.ts";
import { companyComputerSuccessorClaimPath } from "../../src/cloud-company-computer-service-invocation-evidence.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { resetInvocationFixture } from "./company-computer-reset-invocation.ts";

function resetServiceStopFixture(options: Parameters<typeof resetInvocationFixture>[0] = {}) {
	const f = resetInvocationFixture(options);
	const stopRequest = parseCompanyComputerServiceStopRequest({
		schema: "qorpera.office-service-stop-request/v1",
		startCompletionSha256: hash(encode(f.start)),
		revocation: {
			schema: "qorpera.office-lifecycle-transition/v1",
			state: "draining",
			revocationRevision: 6,
			requestedAtMs: 2000,
			drains: [],
			request: {
				...f.request.request.predecessor,
				action: "service_restart",
				transitionId: id(801),
				activationId: f.activationId,
				startup: {
					...f.request.request.predecessor.startup,
					bootId: f.bootId,
					configurationSha256: f.start.configurationSha256,
					serviceInvocationId: f.start.serviceInvocationId,
				},
			},
		},
	});
	return {
		...f,
		startCompletion: f.start,
		startCommand: f.command,
		stopRequest,
		stopCommand: { commandId: id(802), bootId: f.bootId, requestSha256: hash(encode(stopRequest)) },
		receipt: f.receipt,
	};
}

const root = "/run/qorpera-office-preparation";
/** Synthetic SQL/physical facts for parser and custody tests. The Linux and
 * systemd probes independently execute the actual root stop/start controls. */
export function appendResetServiceRestartFixture(
	f: ReturnType<typeof resetServiceStopFixture>,
	prior: CompanyComputerResetServiceStartCompletion | CompanyComputerResetServiceRestartCompletion = f.startCompletion,
	serial = 1,
) {
	const base = 400 + serial * 10,
		activationId = id(base),
		stop = parseCompanyComputerServiceStopRequest({
			...f.stopRequest,
			startCompletionSha256: hash(encode(prior)),
			revocation: {
				...f.stopRequest.revocation,
				request: {
					...f.stopRequest.revocation.request,
					transitionId: id(base + 1),
					activationId: prior.activationId,
					startup: { ...f.stopRequest.revocation.request.startup, serviceInvocationId: prior.serviceInvocationId },
				},
			},
		}),
		stopCommand = { commandId: id(base + 2), requestSha256: hash(encode(stop)), bootId: prior.command.bootId },
		stopped = parseCompanyComputerServiceStopCompletion(
			{
				schema: "qorpera.office-service-stop-completion/v1",
				command: stopCommand,
				transitionId: stop.revocation.request.transitionId,
				activationId: prior.activationId,
				revocationRevision: stop.revocation.revocationRevision,
				configurationSha256: prior.configurationSha256,
				startCompletionSha256: stop.startCompletionSha256,
				fromServiceInvocationId: prior.serviceInvocationId,
				observedInvocationId: prior.serviceInvocationId,
				stoppedInvocationId: prior.serviceInvocationId,
				controlGroup: prior.controlGroup,
				cgroupState: "absent",
			},
			stopCommand,
			stop,
		),
		inspection = {
			schema: "qorpera.office-service-stop-inspection/v1",
			inspectionId: id(base + 3),
			stop: stopped,
			cgroupState: "absent",
		},
		acknowledgement = {
			schema: "qorpera.office-service-stop-acknowledgement/v1",
			state: "stopped",
			request: stop.revocation.request,
			inspection,
			acknowledgedAtMs: 3000,
		},
		request = parseCompanyComputerResetServiceRestartRequest({
			schema: "qorpera.office-reset-service-restart-request/v1",
			origin: f.request,
			stop,
			acknowledgement,
			stopCompletionSha256: hash(encode(stopped)),
			configurationCompletionSha256: f.startCompletion.configurationCompletionSha256,
			successor: {
				schema: "qorpera.office-service-successor/v1",
				request: {
					schema: "qorpera.office-service-successor-request/v1",
					predecessor: stop.revocation.request,
					attestation: { ...f.request.request.attestation, activationId },
				},
				state: "prepared",
				serviceInvocationId: null,
				readinessFresh: false,
				stopAcknowledgedAtMs: acknowledgement.acknowledgedAtMs,
				officeRevision: 9,
				privacyVersion: 0,
				validForMs: 5000,
			},
		}),
		command = { commandId: id(base + 4), requestSha256: hash(encode(request)), bootId: prior.command.bootId },
		completion = parseCompanyComputerResetServiceRestartCompletion(
			{
				schema: "qorpera.office-reset-service-restart-completion/v1",
				command,
				resetId: f.request.request.resetId,
				rootIncarnationId: f.request.request.rootIncarnationId,
				originActivationId: f.startCompletion.activationId,
				activationId,
				configurationCompletionSha256: prior.configurationCompletionSha256,
				configurationSha256: prior.configurationSha256,
				serviceInvocationId: serial.toString(16).padStart(32, "c"),
				mainPid: 50 + serial,
				controlGroup: prior.controlGroup,
			},
			command,
			request,
		),
		stopCompletionPath = `${root}/service-stop-completion-${prior.activationId}.json`,
		completionPath = companyComputerResetServiceRestartCompletionPath(activationId),
		claimPath = companyComputerSuccessorClaimPath(prior.activationId),
		stagePath = `${root}/reset-service-restart-incoming-${command.requestSha256}.json`;
	const put = (path: string, value: unknown, mode = 0o600) => f.files.set(path, { bytes: encode(value), mode });
	put(`${root}/service-stop-incoming-${stopCommand.requestSha256}.json`, stop, 0o400);
	put(stopCompletionPath, stopped);
	put(`${root}/service-stop-claim-${prior.activationId}.json`, {
		schema: "qorpera.office-service-stop-claim/v1",
		command: stopCommand,
		transitionId: stopped.transitionId,
		observedInvocationId: stopped.observedInvocationId,
		observedRestarts: 0,
	});
	put(`${root}/service-stop-inspection-${inspection.inspectionId}.json`, inspection);
	put(stagePath, request, 0o400);
	put(claimPath, companyComputerResetSuccessorClaim(command, request));
	put(completionPath, completion);
	return {
		request,
		command,
		completion,
		stagePath,
		claimPath,
		completionPath,
		stopCompletionPath,
		stop,
		stopCommand,
		stopped,
		inspection,
	};
}
export function resetServiceRestartFixture(options: Parameters<typeof resetInvocationFixture>[0] = {}) {
	const f = resetServiceStopFixture(options);
	return { ...f, restart: appendResetServiceRestartFixture(f) };
}
