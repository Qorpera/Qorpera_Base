import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdUnixClient } from "../src/lxd-client.ts";
import { readLxdOfficeBootActivationEvidence } from "../src/lxd-office-boot-activation-evidence.ts";
import { readLxdOfficeBootActivationHistory } from "../src/lxd-office-boot-activation-history.ts";
import { readLxdOfficeRetainedActivationHistory } from "../src/lxd-office-boot-restart-history.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { readRecord } from "../src/lxd-office-journal-files.ts";
import { LxdOfficePowerOffWorker } from "../src/lxd-office-power-off-worker.ts";
import { LxdOfficePreparationJournal } from "../src/lxd-office-preparation-journal.ts";
import { LxdOfficeResumeWorker } from "../src/lxd-office-resume-worker.ts";
import { LxdOfficeServiceStartJournal } from "../src/lxd-office-service-start-journal.ts";
import { officeStopHash as hash } from "../src/lxd-office-stop-evidence.ts";
import { nodeAdmissionFixture } from "./fixtures/node-admission.ts";
import { createOfficeBootActivationWorkerFixture } from "./fixtures/office-boot-activation-worker.ts";
import { createOfficeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";
import { createOfficeBootSuccessorWorkerFixture } from "./fixtures/office-boot-successor-worker.ts";
import { officeOutageWorkerFixture } from "./fixtures/office-outage-worker.ts";
import { officeServiceStartFixture } from "./fixtures/office-service-start.ts";
import { createOfficeStopWorkerFixture } from "./fixtures/office-stop-worker.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Complete original preparation and admitted outage history. All provider
 * workers and protected journals are real; guest effects and SQL are fixtures. */
async function outageFixture() {
	const f = await officeOutageWorkerFixture(roots),
		{ allocationId } = f.binding,
		read = async (name: string) => JSON.parse(await readFile(join(f.root, name), "utf8")),
		retain = async (name: string, value: unknown) =>
			writeFile(join(f.root, name), JSON.stringify(value), { mode: 0o600 }),
		original = parseCompanyComputerPreparationRequest(await read(`preparation-request-${allocationId}.json`)),
		preparation = await read(`preparation-observation-${allocationId}.json`),
		creation = await read(`intent-${f.intentId}.json`),
		operationId = randomUUID();
	const client = Object.assign(f.client, {
		submitOfficePreparation: vi.fn(async (project: string, instanceName: string) => ({
			project,
			instanceName,
			operationId,
		})),
		inspectOfficePreparation: vi.fn(async () => "succeeded" as const),
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
		pushOfficeBootConfigurationRequest: vi.fn(),
		readOfficeBootConfigurationRequest: vi.fn(),
		submitOfficeBootConfiguration: vi.fn(),
		inspectOfficeBootConfiguration: vi.fn(),
		pushOfficeBootServiceStartRequest: vi.fn(),
		readOfficeBootServiceStartRequest: vi.fn(),
		submitOfficeBootServiceStart: vi.fn(),
		inspectOfficeBootServiceStart: vi.fn(),
		submitOfficeBootServiceInspection: vi.fn(),
	}) as unknown as LxdUnixClient;
	const boot = {
		schema: "qorpera.lxd-office-boot-observation/v1",
		intentId: f.intentId,
		allocationId,
		createCommandId: creation.createCommandId,
		startCommandId: f.permitId,
		observationSha256: "9".repeat(64),
		planSha256: original.copy.planSha256,
		copySha256: original.copy.outputInventorySha256,
		reviewSha256: original.copy.reviewSha256,
		bootId: original.bootId,
		instanceSha256: original.instanceSha256,
		hostBootId: f.clock.hostBootId,
	};
	await retain(`boot-observation-${allocationId}.json`, boot);
	const report = {
			schema: "qorpera.office-guest-preparation-result/v1",
			state: "prepared",
			scope: original.scope,
			computerGeneration: original.computerGeneration,
			allocationId,
			instanceSha256: original.instanceSha256,
			imageSha256: original.imageSha256,
			bootstrapSha256: original.bootstrapSha256,
			bootId: original.bootId,
			copy: original.copy,
			workbenchMount: original.workbenchMount,
			requestSha256: preparation.requestSha256,
			contentSha256: hash(Buffer.from(JSON.stringify(original.entries))),
			observationSha256: "a".repeat(64),
			entries: original.entries.length,
			totalBytes: original.entries.reduce((sum, entry) => sum + entry.bytes, 0),
			invocationId: "b".repeat(32),
		},
		reportSha256 = hash(Buffer.from(`${JSON.stringify(report)}\n`)),
		adoptionReceiptSha256 = hash(
			Buffer.from(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
		),
		completion = parseCompanyComputerPreparationCompletion(
			{
				schema: "qorpera.office-preparation-completion/v2",
				command: preparation,
				invocationId: report.invocationId,
				reportSha256,
				adoptionReceiptSha256,
				report,
			},
			original,
			{ ...preparation, contentSha256: report.contentSha256, reportSha256, adoptionReceiptSha256 },
		),
		observation = {
			schema: "qorpera.lxd-office-preparation-observation/v1",
			intentId: f.intentId,
			allocationId,
			...preparation,
			operationId,
			bootObservationSha256: officeDigest(boot),
			copySha256: original.copy.outputInventorySha256,
			completionSha256: hash(Buffer.from(`${JSON.stringify(completion)}\n`)),
			adoptionReceiptPath: "/etc/qorpera-office/adoption.json",
			adoptionReceiptSha256,
			completion,
		},
		originalAnchor = officeDigest(observation);
	await retain(`preparation-observation-${allocationId}.json`, observation);
	await retain(`preparation-completed-${allocationId}.json`, {
		schema: "qorpera.lxd-office-preparation-completion/v1",
		allocationId,
		commandId: preparation.commandId,
		observationSha256: originalAnchor,
	});
	const prepared = await LxdOfficePreparationJournal.open(
		f.root,
		{
			intentId: f.intentId,
			binding: f.binding,
			bootObservationSha256: officeDigest(boot),
			command: preparation,
		},
		client,
		false,
	);
	expect(await prepared.reconcile(signal())).toEqual({ state: "succeeded", operationId });
	const sample = officeServiceStartFixture(),
		request = parseCompanyComputerServiceStartRequest({
			...sample.request,
			configuration: {
				...sample.request.configuration,
				command: { ...sample.request.configuration.command, bootId: original.bootId },
				preparation,
			},
			attestation: {
				...sample.request.attestation,
				bootId: original.bootId,
				activationId: f.activation.activationId,
				preparationObservationSha256: originalAnchor,
			},
		}),
		command = { commandId: randomUUID(), bootId: original.bootId, requestSha256: officeDigest(request) },
		identity = {
			intentId: f.intentId,
			binding: f.binding,
			bootObservationSha256: officeDigest(boot),
			configurationObservationSha256: request.attestation.configurationObservationSha256,
			command,
		},
		packet = {
			schema: "qorpera.lxd-office-activation-request/v1",
			intentId: f.intentId,
			binding: f.binding,
			command,
			request,
		};
	await retain(`activation-request-${allocationId}.json`, packet);
	await retain(`activation-intent-${allocationId}.json`, {
		schema: "qorpera.lxd-office-activation-intent/v1",
		requestSha256: officeDigest(packet),
		identity,
	});
	const started = await (await LxdOfficeServiceStartJournal.open(f.root, identity, client, false)).reconcile(signal());
	expect(started.state).toBe("succeeded");
	await retain(`activation-completed-${allocationId}.json`, {
		schema: "qorpera.lxd-office-activation-completion/v1",
		intentId: f.intentId,
		allocationId,
		activationId: request.attestation.activationId,
		commandId: command.commandId,
		operationId: started.operationId,
		requestSha256: command.requestSha256,
		completion: { ...sample.completion, command, activationId: request.attestation.activationId },
	});
	await f.configureSources();
	await retain(`configuration-intent-${allocationId}.json`, {
		schema: "qorpera.lxd-office-configuration-intent/v1",
		intentId: f.intentId,
		allocationId,
		...(await read(`configuration-intent-${allocationId}.json`)),
		bootObservationSha256: officeDigest(boot),
		preparationObservationSha256: originalAnchor,
		requestSha256: "7".repeat(64),
		requestBytes: 1,
		commandId: randomUUID(),
	});
	await f.stop();
	await f.adapter().reconcileStopped(f.binding, f.registry, signal());
	const stopped = await f.guard().status(f.permitId);
	const admit = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await f.admission().reconcile(f.intentId, stopped, f.serviceBootstrapPath, signal());
			} catch (error) {
				let cause: unknown = error;
				for (let depth = 0; depth < 4 && cause instanceof Error && cause.cause; depth++) cause = cause.cause;
				if (
					attempt >= 3 ||
					!(cause instanceof Error) ||
					!["RUNTIME_COMPUTER_RUNNING_PERMIT_REQUIRED", "TimeoutError"].includes(
						cause.name === "TimeoutError" ? cause.name : cause.message,
					)
				)
					throw error;
				await f.guard().sweep();
				await f.sampleUsage();
				await f.controller().maintain(signal());
			}
		}
	};
	const admitted = await admit();
	if (admitted.state !== "active") throw new Error("outage admission incomplete");
	const startPacket = await read(`outage-service-start-request-${allocationId}-${admitted.activationId}.json`),
		anchor = startPacket.request.successor.request.attestation.preparationObservationSha256 as string,
		check = vi.fn(async () => ({ hostBootId: f.clock.hostBootId, signal: signal(), validForMs: 5000 })),
		kernelLock = vi.fn(async () => {});
	expect(anchor).not.toBe(originalAnchor);
	return {
		...f,
		client,
		guest: f.files,
		creation,
		read,
		retain,
		admitted,
		anchor,
		originalAnchor,
		check,
		kernelLock,
		readProtected: vi.fn(f.sources.readProtected),
		readCredential: vi.fn(f.sources.readCredential),
		completionPath: "/run/qorpera-office-preparation/outage-service-start-completion.json",
	};
}

async function resumeFixture(f: Awaited<ReturnType<typeof outageFixture>>, completionPath = f.completionPath) {
	const completion = JSON.parse(f.guest.get(completionPath)!.content.toString()),
		stop = await createOfficeStopWorkerFixture(
			{ ...f, completionPath, request: { intentId: f.intentId } },
			"power_off",
			`${companyComputerBootDirectory(completion.command.bootId)}/credentials/config.json`,
			false,
			randomUUID(),
		);
	await stop.worker.reconcile(f.intentId, stop.request, signal());
	const powerRegistry = {
			call: async (...args: Parameters<typeof stop.registry>) =>
				args[0] === "qorpera_suspend_runtime_node_machine"
					? {
							state: "suspended",
							allocationId: f.binding.allocationId,
							nodeId: "36000000-0000-4000-8000-000000000010",
							suspendedAt: "2026-09-23T15:00:00.000000+00:00",
						}
					: stop.registry(...args),
		},
		gate = { policy: f.policy, check: f.check };
	await expect(
		new LxdOfficePowerOffWorker(gate, powerRegistry, { client: f.client, kernelLock: f.kernelLock }).reconcile(
			f.intentId,
			stop.request,
			signal(),
		),
	).resolves.toMatchObject({ state: "powered_off" });
	const suffix = `${f.binding.allocationId}-${stop.request.transitionId}`,
		power = await f.read(`power-off-request-${suffix}.json`),
		request = parseCompanyComputerBootIntentRequest({
			schema: "qorpera.office-boot-intent-request/v1",
			bootIntentId: randomUUID(),
			activationId: randomUUID(),
			predecessor: stop.request,
			stopHistorySha256: power.stopHistorySha256,
			powerOffCompletionSha256: hash(await readFile(join(f.root, `power-off-completed-${suffix}.json`))),
		}),
		intent = {
			schema: "qorpera.office-boot-intent/v1",
			request,
			state: "prepared",
			stopAcknowledgedAtMs: 2000,
			officeRevision: 12,
			privacyVersion: 0,
			validForMs: 5000,
		},
		registry = vi.fn<ConstructorParameters<typeof LxdOfficeResumeWorker>[1]["call"]>(async (method, args) => {
			if (method === "qorpera_reserve_runtime_node_machine") return nodeAdmissionFixture(args);
			expect(args.p_request).toEqual(request);
			return structuredClone(intent);
		});
	await expect(
		new LxdOfficeResumeWorker(gate, { call: registry }, { client: f.client, kernelLock: f.kernelLock }).reconcile(
			f.intentId,
			request,
			signal(),
		),
	).resolves.toMatchObject({ state: "awaiting_configuration" });
	const configured = await createOfficeBootConfigurationWorkerFixture({
		...f,
		request,
		registry,
		intent,
		activation: { request: { intentId: f.intentId, serviceBootstrapPath: f.serviceBootstrapPath } },
	});
	await expect(configured.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
	const active = await createOfficeBootActivationWorkerFixture(configured),
		call = active.registry.getMockImplementation()!;
	active.registry.mockImplementation(async (...args) => {
		// This is the SQL equality that rejected the physical ordinary resume.
		expect(
			(args[1].p_request as { attestation: { preparationObservationSha256: string } }).attestation
				.preparationObservationSha256,
		).toBe(f.anchor);
		return call(...args);
	});
	const readEvidence = () =>
		readLxdOfficeBootActivationEvidence(f.root, active.input, f.creation, f.client, signal(), {
			readProtected: f.readProtected,
			readCredential: f.readCredential,
		});
	const readHistory = () =>
		readLxdOfficeBootActivationHistory(
			f.root,
			f.intentId,
			f.binding,
			request.activationId,
			(name, limit) => readRecord(join(f.root, name), limit),
			f.client,
			signal(),
		);
	return { ...active, readEvidence, readHistory };
}

describe("preparation anchor continuity after an admitted outage", () => {
	it("keeps ordinary resume inspection fresh with bounded guest and SQL read latency", async () => {
		const origin = await outageFixture(),
			f = await resumeFixture(origin),
			read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!,
			call = f.registry.getMockImplementation()!,
			lock = f.kernelLock.getMockImplementation()!,
			directory = companyComputerBootDirectory((await f.readEvidence()).bootId),
			currentPaths = [
				`${directory}/configuration-completion.json`,
				`${directory}/configuration-claim.json`,
				`${directory}/adoption.json`,
				...Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES).map((name) => `${directory}/credentials/${name}`),
			],
			currentReads = new Map<string, number>();
		let inspectionStarted = 0,
			guestReads = 0,
			activeGuestReads = 0,
			peakGuestReads = 0,
			authorizationPasses = 0,
			sqlChecks = 0;
		const guestReadMs = 50,
			sqlReadMs = 20;
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (...args) => {
			if (!inspectionStarted) {
				const value = await read(...args);
				if (args[2] === f.completionPath) inspectionStarted = performance.now();
				return value;
			}
			guestReads++;
			if (currentPaths.includes(args[2])) currentReads.set(args[2], (currentReads.get(args[2]) ?? 0) + 1);
			activeGuestReads++;
			peakGuestReads = Math.max(peakGuestReads, activeGuestReads);
			try {
				await delay(guestReadMs, undefined, { signal: args[4] });
				return await read(...args);
			} finally {
				activeGuestReads--;
			}
		});
		f.kernelLock.mockImplementation(async (...args) => {
			if (inspectionStarted) authorizationPasses++;
			return lock(...args);
		});
		f.registry.mockImplementation(async (...args) => {
			if (inspectionStarted) {
				sqlChecks++;
				await delay(sqlReadMs, undefined, { signal: args[2] });
			}
			return call(...args);
		});
		try {
			await expect(f.run()).resolves.toMatchObject({ state: "active" });
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).toHaveBeenCalledOnce();
			expect(f.state.activations).toBe(1);
			expect(f.state.current!.request.attestation.preparationObservationSha256).toBe(origin.anchor);
			expect(activeGuestReads).toBe(0);
			expect(peakGuestReads).toBe(4);
			expect(authorizationPasses).toBe(5);
			expect(currentPaths.map((path) => currentReads.get(path))).toEqual(Array(9).fill(authorizationPasses));
		} finally {
			console.info(
				"BOOT_INSPECTION_LATENCY",
				JSON.stringify({
					guestReadMs,
					sqlReadMs,
					guestReads,
					peakGuestReads,
					authorizationPasses,
					sqlChecks,
					inspectionElapsedMs: inspectionStarted ? Math.round(performance.now() - inspectionStarted) : null,
					inspectionDispatches: f.inspect.mock.calls.length,
					activations: f.state.activations,
					outstandingGuestReads: activeGuestReads,
				}),
			);
		}
	}, 60000);
	it.each(["configuration-claim.json", "credentials/tls-key.pem"])(
		"settles and wipes started guest-read siblings before refusing changed %s",
		async (changed) => {
			const origin = await outageFixture(),
				f = await resumeFixture(origin),
				directory = companyComputerBootDirectory((await f.readEvidence()).bootId),
				paths = [
					"configuration-completion.json",
					"configuration-claim.json",
					"adoption.json",
					...Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES).map((name) => `credentials/${name}`),
				].map((path) => `${directory}/${path}`),
				fault = paths.indexOf(`${directory}/${changed}`),
				read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!,
				started: number[] = [],
				completed: number[] = [],
				buffers: Buffer[] = [];
			let armed = false,
				active = 0,
				peak = 0;
			vi.mocked(f.client.readInstanceFile).mockImplementation(async (...args) => {
				if (!armed) {
					const file = await read(...args);
					if (args[2] === f.completionPath) armed = true;
					return file;
				}
				const index = paths.indexOf(args[2]);
				if (index < 0) return read(...args);
				started.push(index);
				peak = Math.max(peak, ++active);
				try {
					await delay(index === fault ? 5 : 60 + index * 10, undefined, { signal: args[4] });
					const file = await read(...args);
					buffers.push(file.content);
					if (index === fault) file.uid = 1000;
					return file;
				} finally {
					active--;
					completed.push(index);
				}
			});
			await expect(f.run()).rejects.toThrow("OFFICE_BOOT_ACTIVATION_UNCONFIRMED");
			expect(peak).toBe(4);
			expect(active).toBe(0);
			expect(started).toEqual(
				Array.from({ length: Math.min(paths.length, 4 * (Math.floor(fault / 4) + 1)) }, (_, i) => i),
			);
			expect([...completed].sort((a, b) => a - b)).toEqual(started);
			if (fault === 1) expect(completed[0]).toBe(fault);
			expect(buffers).toHaveLength(started.length);
			for (const bytes of buffers) expect(bytes.every((byte) => byte === 0)).toBe(true);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.inspect).not.toHaveBeenCalled();
			expect(f.state.activations).toBe(0);
		},
		60000,
	);
	it("activates and reads retained ordinary resume history using the admitted outage anchor", async () => {
		const origin = await outageFixture(),
			f = await resumeFixture(origin),
			evidence = await f.readEvidence();
		expect(evidence.preparationObservationSha256).toBe(origin.anchor);
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect((await f.readHistory()).request.successor.request.attestation.preparationObservationSha256).toBe(
			origin.anchor,
		);
		expect(f.exec).toHaveBeenCalledOnce();
	}, 60000);
	it("preserves the outage anchor across a second ordinary shutdown and resume", async () => {
		const origin = await outageFixture(),
			first = await resumeFixture(origin);
		await expect(first.run()).resolves.toMatchObject({ state: "active" });
		const second = await resumeFixture(origin, first.completionPath);
		expect((await second.readEvidence()).preparationObservationSha256).toBe(origin.anchor);
		await expect(second.run()).resolves.toMatchObject({ state: "active" });
		expect((await second.readHistory()).request.successor.request.attestation.preparationObservationSha256).toBe(
			origin.anchor,
		);
	}, 60000);
	it("preserves the same anchor through a service restart and another ordinary resume", async () => {
		const origin = await outageFixture(),
			first = await resumeFixture(origin);
		await expect(first.run()).resolves.toMatchObject({ state: "active" });
		Object.assign(origin.client, {
			pushOfficeBootServiceRestartRequest: vi.fn(),
			readOfficeBootServiceRestartRequest: vi.fn(),
			submitOfficeBootServiceRestart: vi.fn(),
			inspectOfficeBootServiceRestart: vi.fn(),
			submitOfficeBootServiceRestartInspection: vi.fn(),
		});
		const stop = await createOfficeStopWorkerFixture(
			{ ...first, request: { intentId: origin.intentId } },
			"service_restart",
			`${companyComputerBootDirectory(first.state.current!.request.attestation.bootId)}/credentials/config.json`,
			false,
			randomUUID(),
		);
		await stop.worker.reconcile(origin.intentId, stop.request, signal());
		const restart = await createOfficeBootSuccessorWorkerFixture({ ...stop, activation: first });
		await expect(restart.worker.reconcile(origin.intentId, stop.request, signal())).resolves.toMatchObject({
			state: "active",
		});
		const activationId = restart.state.current!.request.attestation.activationId;
		expect(restart.state.current!.request.attestation.preparationObservationSha256).toBe(origin.anchor);
		const retained = await readLxdOfficeRetainedActivationHistory(
			origin.root,
			origin.intentId,
			origin.binding,
			activationId,
			(name, limit) => readRecord(join(origin.root, name), limit),
			origin.client,
			signal(),
		);
		expect(retained.kind).toBe("boot_restart");
		expect(retained.request.successor.request.attestation.preparationObservationSha256).toBe(origin.anchor);
		const second = await resumeFixture(
			origin,
			`/run/qorpera-office-preparation/boot-service-restart-completion-${activationId}.json`,
		);
		expect((await second.readEvidence()).preparationObservationSha256).toBe(origin.anchor);
		await expect(second.run()).resolves.toMatchObject({ state: "active" });
		expect((await second.readHistory()).request.successor.request.attestation.preparationObservationSha256).toBe(
			origin.anchor,
		);
		expect(restart.exec).toHaveBeenCalledOnce();
	}, 60000);
	it.each([false, true])(
		"refuses changed or missing admitted outage proof on ordinary resume (later=%s)",
		async (later) => {
			const origin = await outageFixture(),
				first = await resumeFixture(origin);
			if (later) await first.run();
			const f = later ? await resumeFixture(origin, first.completionPath) : first,
				suffix = `${origin.binding.allocationId}-${origin.admitted.activationId}`,
				names = [
					"outage-service-start-request",
					"outage-successor-prepared",
					"outage-activation-completed",
					"outage-configuration-completed",
				].map((prefix) => `${prefix}-${suffix}.json`);
			const evidence = await f.readEvidence(),
				dispatches = f.exec.mock.calls.length;
			for (const name of names) {
				const path = join(origin.root, name),
					bytes = await readFile(path);
				expect(evidence.records[name]).toBe(hash(bytes));
				for (const missing of [false, true]) {
					if (missing) await rm(path);
					else await writeFile(path, "{}");
					await expect(f.readEvidence(), `${name} missing=${missing}`).rejects.toThrow();
					await writeFile(path, bytes, { mode: 0o600 });
				}
			}
			expect(f.exec).toHaveBeenCalledTimes(dispatches);
			expect(f.registry).not.toHaveBeenCalled();
			await f.run();
			const path = join(origin.root, names[0]),
				bytes = await readFile(path);
			await rm(path);
			await expect(f.readHistory()).rejects.toThrow();
			await writeFile(path, bytes, { mode: 0o600 });
			expect((await f.readHistory()).request.successor.request.attestation.preparationObservationSha256).toBe(
				origin.anchor,
			);
		},
		60000,
	);
	it("still fully verifies original preparation rather than treating the outage anchor as a replacement", async () => {
		const origin = await outageFixture(),
			f = await resumeFixture(origin),
			{ allocationId } = origin.binding;
		for (const name of ["request", "observation", "completed"]) {
			const path = join(origin.root, `preparation-${name}-${allocationId}.json`),
				bytes = await readFile(path);
			await writeFile(path, "{}");
			await expect(f.readEvidence(), name).rejects.toThrow();
			await writeFile(path, bytes, { mode: 0o600 });
		}
		const accepted = join(origin.root, `preparation-${allocationId}`, "000001.json"),
			bytes = await readFile(accepted);
		await rm(accepted);
		await expect(f.readEvidence()).rejects.toThrow();
		await writeFile(accepted, bytes, { mode: 0o600 });
		expect((await f.readEvidence()).preparationObservationSha256).toBe(origin.anchor);
		expect(f.exec).not.toHaveBeenCalled();
	}, 60000);
	it("revalidates the admitted lineage after staging and refuses dispatch if its proof disappears", async () => {
		const origin = await outageFixture(),
			f = await resumeFixture(origin),
			stage = f.stage.getMockImplementation()!,
			path = join(
				origin.root,
				`outage-activation-completed-${origin.binding.allocationId}-${origin.admitted.activationId}.json`,
			),
			bytes = await readFile(path);
		f.stage.mockImplementationOnce(async (...args) => {
			await stage(...args);
			await rm(path);
		});
		await expect(f.run()).rejects.toThrow("OFFICE_BOOT_ACTIVATION_UNCONFIRMED");
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.exec).not.toHaveBeenCalled();
		await writeFile(path, bytes, { mode: 0o600 });
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(f.exec).toHaveBeenCalledOnce();
	}, 60000);
});
