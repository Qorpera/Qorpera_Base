import { createHash } from "node:crypto";
import {
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
} from "@qorpera/contracts";
import { serviceStartId as id, officeServiceStartFixture } from "./office-service-start.ts";

export function officeServiceRestartFixture() {
	const initial = officeServiceStartFixture();
	const predecessor = {
		schema: "qorpera.office-lifecycle-request/v1",
		transitionId: id(10),
		action: "service_restart",
		activationId: initial.completion.activationId,
		providerId: id(11),
		providerPolicySha256: "2".repeat(64),
		startup: {
			scope: { companyId: id(12), environmentId: id(13), companyComputerId: id(14), logicalComputerId: id(15) },
			computerGeneration: 1,
			allocationId: id(16),
			bootId: initial.command.bootId,
			instanceSha256: "3".repeat(64),
			imageSha256: "4".repeat(64),
			bootstrapSha256: "5".repeat(64),
			configurationSha256: initial.completion.configurationSha256,
			serviceInvocationId: initial.completion.serviceInvocationId,
		},
	};
	const stop = {
		schema: "qorpera.office-service-stop-request/v1",
		startCompletionSha256: "6".repeat(64),
		revocation: {
			schema: "qorpera.office-lifecycle-transition/v1",
			state: "draining",
			revocationRevision: 2,
			requestedAtMs: 1000,
			drains: [],
			request: predecessor,
		},
	};
	const stopped = {
		schema: "qorpera.office-service-stop-completion/v1",
		command: { commandId: id(17), bootId: initial.command.bootId, requestSha256: "7".repeat(64) },
		transitionId: predecessor.transitionId,
		activationId: predecessor.activationId,
		revocationRevision: 2,
		configurationSha256: initial.completion.configurationSha256,
		startCompletionSha256: stop.startCompletionSha256,
		fromServiceInvocationId: initial.completion.serviceInvocationId,
		observedInvocationId: "b".repeat(32),
		stoppedInvocationId: "b".repeat(32),
		controlGroup: "/system.slice/qorpera-company-computer.service",
		cgroupState: "absent",
	};
	const attestation = { ...initial.request.attestation, activationId: id(18) };
	const request = parseCompanyComputerServiceRestartRequest({
		schema: "qorpera.office-service-restart-request/v1",
		start: { ...initial.request, attestation },
		stop,
		stopCompletionSha256: "8".repeat(64),
		acknowledgement: {
			schema: "qorpera.office-service-stop-acknowledgement/v1",
			state: "stopped",
			request: predecessor,
			inspection: {
				schema: "qorpera.office-service-stop-inspection/v1",
				inspectionId: id(19),
				stop: stopped,
				cgroupState: "absent",
			},
			acknowledgedAtMs: 1500,
		},
		successor: {
			schema: "qorpera.office-service-successor/v1",
			request: { schema: "qorpera.office-service-successor-request/v1", predecessor, attestation },
			state: "prepared",
			serviceInvocationId: null,
			readinessFresh: false,
			stopAcknowledgedAtMs: 1500,
			officeRevision: 3,
			privacyVersion: 11,
			validForMs: 5000,
		},
	});
	const command = {
		commandId: id(20),
		bootId: initial.command.bootId,
		requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
	};
	const completion = parseCompanyComputerServiceRestartCompletion(
		{
			...initial.completion,
			command,
			activationId: attestation.activationId,
			serviceInvocationId: "c".repeat(32),
			mainPid: 600,
		},
		command,
		request,
	);
	return { initial, request, command, completion };
}
