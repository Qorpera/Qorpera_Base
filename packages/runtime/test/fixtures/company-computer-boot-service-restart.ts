import {
	type CompanyComputerBootServiceRestartCompletion,
	type CompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceRestartCompletion,
	parseCompanyComputerBootServiceRestartRequest,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import {
	companyComputerBootServiceRestartCompletionPath,
	companyComputerBootSuccessorClaim,
} from "../../src/cloud-company-computer-boot-invocation-evidence.ts";
import { companyComputerSuccessorClaimPath } from "../../src/cloud-company-computer-service-invocation-evidence.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { bootServiceStopFixture } from "./company-computer-boot-service-stop.ts";

const root = "/run/qorpera-office-preparation";
/** Synthetic SQL/physical facts for parser and custody tests. The Linux and
 * systemd probes independently execute the actual root stop/start controls. */
export function appendBootServiceRestartFixture(
	f: ReturnType<typeof bootServiceStopFixture>,
	prior: CompanyComputerBootServiceStartCompletion | CompanyComputerBootServiceRestartCompletion = f.startCompletion,
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
		request = parseCompanyComputerBootServiceRestartRequest({
			schema: "qorpera.office-boot-service-restart-request/v1",
			origin: f.request,
			stop,
			acknowledgement,
			stopCompletionSha256: hash(encode(stopped)),
			successor: {
				schema: "qorpera.office-service-successor/v1",
				request: {
					schema: "qorpera.office-service-successor-request/v1",
					predecessor: stop.revocation.request,
					attestation: { ...f.request.successor.request.attestation, activationId },
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
		completion = parseCompanyComputerBootServiceRestartCompletion(
			{
				schema: "qorpera.office-boot-service-restart-completion/v1",
				command,
				bootIntentId: prior.bootIntentId,
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
		completionPath = companyComputerBootServiceRestartCompletionPath(activationId),
		claimPath = companyComputerSuccessorClaimPath(prior.activationId),
		stagePath = `${root}/boot-service-restart-incoming-${command.requestSha256}.json`;
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
	put(claimPath, companyComputerBootSuccessorClaim(command, request));
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
export function bootServiceRestartFixture(options: Parameters<typeof bootServiceStopFixture>[0] = {}) {
	const f = bootServiceStopFixture(options);
	return { ...f, restart: appendBootServiceRestartFixture(f) };
}
