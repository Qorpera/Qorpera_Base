import { companyComputerBootDirectory, parseCompanyComputerServiceStopRequest } from "@qorpera/contracts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { bootServiceStartFixture } from "./company-computer-boot-service-start.ts";

export function bootServiceStopFixture(options: Parameters<typeof bootServiceStartFixture>[0] = {}) {
	const f = bootServiceStartFixture(options),
		root = "/run/qorpera-office-preparation",
		directory = companyComputerBootDirectory(f.startCommand.bootId),
		activationId = f.startCompletion.activationId;
	const files = new Map<string, { bytes: Buffer; mode: number }>([
		[`${root}/boot-service-start-completion.json`, { bytes: encode(f.startCompletion), mode: 0o600 }],
		[
			`${root}/boot-service-start-incoming-${f.startCommand.requestSha256}.json`,
			{ bytes: encode(f.request), mode: 0o400 },
		],
		[
			`${root}/boot-service-start-claim.json`,
			{
				bytes: encode({
					schema: "qorpera.office-boot-service-start-claim/v1",
					command: f.startCommand,
					bootIntentId: f.completion.bootIntentId,
					activationId,
					configurationCompletionSha256: f.request.configurationCompletionSha256,
				}),
				mode: 0o600,
			},
		],
		[`${directory}/adoption.json`, { bytes: encode(f.receipt), mode: 0o444 }],
		[`${directory}/configuration-completion.json`, { bytes: encode(f.completion), mode: 0o600 }],
		[
			`${directory}/configuration-claim.json`,
			{
				bytes: encode({
					schema: "qorpera.office-boot-configuration-claim/v1",
					command: f.command,
					bootIntentId: f.completion.bootIntentId,
					activationId,
				}),
				mode: 0o600,
			},
		],
		[`${directory}/credentials/config.json`, { bytes: Buffer.from(f.input.material.configuration), mode: 0o400 }],
	]);
	const stopRequest = parseCompanyComputerServiceStopRequest({
		schema: "qorpera.office-service-stop-request/v1",
		startCompletionSha256: hash(encode(f.startCompletion)),
		revocation: {
			schema: "qorpera.office-lifecycle-transition/v1",
			state: "draining",
			revocationRevision: 6,
			requestedAtMs: 2000,
			drains: [],
			request: {
				schema: "qorpera.office-lifecycle-request/v1",
				action: "service_restart",
				transitionId: id(301),
				activationId,
				providerId: f.input.bootIntent.request.predecessor.providerId,
				providerPolicySha256: f.input.bootIntent.request.predecessor.providerPolicySha256,
				startup: {
					...f.input.bootIntent.request.predecessor.startup,
					bootId: f.startCommand.bootId,
					configurationSha256: f.startCompletion.configurationSha256,
					serviceInvocationId: f.startCompletion.serviceInvocationId,
				},
			},
		},
	});
	const stopCommand = { commandId: id(302), requestSha256: hash(encode(stopRequest)), bootId: f.startCommand.bootId };
	return { ...f, files, directory, stopRequest, stopCommand };
}
