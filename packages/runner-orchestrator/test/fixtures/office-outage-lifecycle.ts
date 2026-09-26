import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { companyComputerBootDirectory, parseCompanyComputerServiceStartRequest } from "@qorpera/contracts";
import { vi } from "vitest";
import type { LxdUnixClient } from "../../src/lxd-client.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import { publish } from "../../src/lxd-office-journal-files.ts";
import { LxdOfficeServiceStartJournal } from "../../src/lxd-office-service-start-journal.ts";
import { officeOutageWorkerFixture } from "./office-outage-worker.ts";
import { officeServiceStartFixture } from "./office-service-start.ts";
import { createOfficeStopWorkerFixture } from "./office-stop-worker.ts";

const signal = (): AbortSignal => new AbortController().signal;

function transientAuthority(error: unknown, depth = 0): boolean {
	if (!(error instanceof Error) || depth > 4) return false;
	return (
		error.message === "RUNTIME_COMPUTER_RUNNING_PERMIT_REQUIRED" ||
		error.name === "TimeoutError" ||
		transientAuthority(error.cause, depth + 1)
	);
}

/** Real protected provider journals and ordinary stop worker, with guest root
 * effects simulated through the same protocol as the focused worker tests. */
export async function officeOutageLifecycleFixture(roots: string[]) {
	const f = await officeOutageWorkerFixture(roots);
	const client = Object.assign(f.client, {
		submitOfficeServiceStart: vi.fn(async (project: string, instanceName: string) => ({
			project,
			instanceName,
			operationId: randomUUID(),
		})),
		inspectOfficeServiceStart: vi.fn(async () => "succeeded" as const),
		pushOfficeServiceStopRequest: vi.fn(),
		readOfficeServiceStopRequest: vi.fn(),
		submitOfficeServiceStop: vi.fn(),
		inspectOfficeServiceStop: vi.fn(),
		submitOfficeServiceStopInspection: vi.fn(),
	}) as unknown as LxdUnixClient;
	const preparation = JSON.parse(
		await readFile(join(f.root, `preparation-request-${f.binding.allocationId}.json`), "utf8"),
	);
	const preparationObservation = JSON.parse(
		await readFile(join(f.root, `preparation-observation-${f.binding.allocationId}.json`), "utf8"),
	);
	const sample = officeServiceStartFixture();
	const request = parseCompanyComputerServiceStartRequest({
		...sample.request,
		configuration: {
			...sample.request.configuration,
			command: { ...sample.request.configuration.command, bootId: preparation.bootId },
			preparation: {
				commandId: preparationObservation.commandId,
				bootId: preparation.bootId,
				requestSha256: preparationObservation.requestSha256,
			},
		},
		attestation: {
			...sample.request.attestation,
			bootId: preparation.bootId,
			activationId: f.activation.activationId,
		},
	});
	const command = { commandId: randomUUID(), bootId: preparation.bootId, requestSha256: officeDigest(request) };
	const identity = {
		intentId: f.intentId,
		binding: f.binding,
		bootObservationSha256: "9".repeat(64),
		configurationObservationSha256: request.attestation.configurationObservationSha256,
		command,
	};
	const packet = {
		schema: "qorpera.lxd-office-activation-request/v1",
		intentId: f.intentId,
		binding: f.binding,
		command,
		request,
	};
	const retain = async (name: string, value: unknown) => publish(f.root, name, Buffer.from(officeCanonical(value)));
	await retain(`activation-request-${f.binding.allocationId}.json`, packet);
	await retain(`activation-intent-${f.binding.allocationId}.json`, {
		schema: "qorpera.lxd-office-activation-intent/v1",
		requestSha256: officeDigest(packet),
		identity,
	});
	const started = await (await LxdOfficeServiceStartJournal.open(f.root, identity, client, false)).reconcile(signal());
	if (started.state !== "succeeded") throw new Error("initial start fixture failed");
	await retain(`activation-completed-${f.binding.allocationId}.json`, {
		schema: "qorpera.lxd-office-activation-completion/v1",
		intentId: f.intentId,
		allocationId: f.binding.allocationId,
		activationId: request.attestation.activationId,
		commandId: command.commandId,
		operationId: started.operationId,
		requestSha256: command.requestSha256,
		completion: { ...sample.completion, command, activationId: request.attestation.activationId },
	});
	await f.configureSources();
	await f.stop();
	await f.adapter().reconcileStopped(f.binding, f.registry, signal());
	const original = await f.guard().status(f.permitId);
	const admit = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await f.admission().reconcile(f.intentId, original, f.serviceBootstrapPath, signal());
			} catch (error) {
				if (attempt >= 3 || !transientAuthority(error)) throw error;
				// Exercise durable replay after a bounded authority expires under
				// host contention. Every attempt obtains real fresh authority; no
				// production timeout is extended or physical dispatch reset.
				await f.guard().sweep();
				await f.sampleUsage();
				await f.controller().maintain(signal());
			}
		}
	};
	const admitted = await admit();
	if (admitted.state !== "active") throw new Error("outage admission incomplete");
	const completionPath = "/run/qorpera-office-preparation/outage-service-start-completion.json";
	const completion = JSON.parse(f.files.get(completionPath)!.content.toString());
	const startPacket = JSON.parse(
		await readFile(
			join(f.root, `outage-service-start-request-${f.binding.allocationId}-${admitted.activationId}.json`),
			"utf8",
		),
	);
	f.files.set("/run/qorpera-office-preparation/outage-service-start-claim.json", {
		content: Buffer.from(
			JSON.stringify({
				schema: "qorpera.office-outage-service-start-claim/v1",
				command: completion.command,
				recoveryId: startPacket.request.successor.request.recovery.recoveryId,
				activationId: admitted.activationId,
				configurationCompletionSha256: startPacket.request.configurationCompletionSha256,
			}),
		),
		uid: 0,
		gid: 0,
		mode: 0o600,
	});
	const check = vi.fn(async () => ({ hostBootId: f.clock.hostBootId, signal: signal(), validForMs: 5000 }));
	const stop = await createOfficeStopWorkerFixture(
		{
			root: f.root,
			binding: f.binding,
			guest: f.files,
			client,
			check,
			kernelLock: vi.fn(async () => {}),
			policy: f.policy,
			completionPath,
			request: { intentId: f.intentId },
		},
		"power_off",
		`${companyComputerBootDirectory(completion.command.bootId)}/credentials/config.json`,
		false,
		randomUUID(),
	);
	return { ...f, client, admitted, original, stop, completion, startPacket, check };
}
