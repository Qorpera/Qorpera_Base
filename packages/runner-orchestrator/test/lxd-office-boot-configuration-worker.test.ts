import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_GUEST_LAYOUT_KEYS,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { LxdOfficePowerOffWorker } from "../src/lxd-office-power-off-worker.ts";
import { LxdOfficeResumeWorker } from "../src/lxd-office-resume-worker.ts";
import { officeStopHash as hash } from "../src/lxd-office-stop-evidence.ts";
import { nodeAdmissionFixture } from "./fixtures/node-admission.ts";
import {
	createOfficeBootConfigurationWorkerFixture,
	officeBootConfigurationWorkerFixture,
} from "./fixtures/office-boot-configuration-worker.ts";
import { officeFixtureLayout } from "./fixtures/office-boot-worker.ts";
import { officeOutageLifecycleFixture } from "./fixtures/office-outage-lifecycle.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	officeFixtureLayout.version = 1;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = (resumed = true) => officeBootConfigurationWorkerFixture(roots, resumed);

async function outageResumeFixture() {
	const f = await officeOutageLifecycleFixture(roots),
		{ allocationId } = f.binding,
		read = async (name: string) => JSON.parse(await readFile(join(f.root, name), "utf8")),
		retain = async (name: string, value: unknown) =>
			writeFile(join(f.root, name), JSON.stringify(value), { mode: 0o600 }),
		original = parseCompanyComputerPreparationRequest(await read(`preparation-request-${allocationId}.json`)),
		preparation = await read(`preparation-observation-${allocationId}.json`),
		creation = await read(`intent-${f.intentId}.json`);
	// The outage-only fixture needs no original preparation completion. Ordinary
	// resume does; supply its retained public metadata before the graceful stop.
	const observation = {
		schema: "qorpera.lxd-office-preparation-observation/v1",
		intentId: f.intentId,
		allocationId,
		...preparation,
		operationId: randomUUID(),
		bootObservationSha256: "9".repeat(64),
		copySha256: original.copy.outputInventorySha256,
		completionSha256: "8".repeat(64),
		adoptionReceiptPath: "/etc/qorpera-office/adoption.json",
		adoptionReceiptSha256: hash(
			Buffer.from(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
		),
		completion: {},
	};
	await retain(`preparation-observation-${allocationId}.json`, observation);
	await retain(`preparation-completed-${allocationId}.json`, {
		schema: "qorpera.lxd-office-preparation-completion/v1",
		allocationId,
		commandId: preparation.commandId,
		observationSha256: officeDigest(observation),
	});
	await retain(`configuration-intent-${allocationId}.json`, {
		schema: "qorpera.lxd-office-configuration-intent/v1",
		intentId: f.intentId,
		allocationId,
		...(await read(`configuration-intent-${allocationId}.json`)),
		bootObservationSha256: "9".repeat(64),
		preparationObservationSha256: officeDigest(observation),
		requestSha256: "7".repeat(64),
		requestBytes: 1,
		commandId: randomUUID(),
	});
	await retain(`boot-observation-${allocationId}.json`, {
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
	});
	await f.stop.worker.reconcile(f.intentId, f.stop.request, signal());
	const powerRegistry = {
		call: async (...args: Parameters<typeof f.stop.registry>) =>
			args[0] === "qorpera_suspend_runtime_node_machine"
				? {
						state: "suspended",
						allocationId,
						nodeId: "36000000-0000-4000-8000-000000000010",
						suspendedAt: "2026-09-23T15:00:00.000000+00:00",
					}
				: f.stop.registry(...args),
	};
	const kernelLock = vi.fn(async () => {}),
		gate = { policy: f.policy, check: f.check };
	await expect(
		new LxdOfficePowerOffWorker(gate, powerRegistry, { client: f.client, kernelLock }).reconcile(
			f.intentId,
			f.stop.request,
			signal(),
		),
	).resolves.toMatchObject({ state: "powered_off" });
	const suffix = `${allocationId}-${f.stop.request.transitionId}`,
		power = await read(`power-off-request-${suffix}.json`),
		request = parseCompanyComputerBootIntentRequest({
			schema: "qorpera.office-boot-intent-request/v1",
			bootIntentId: randomUUID(),
			activationId: randomUUID(),
			predecessor: f.stop.request,
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
		new LxdOfficeResumeWorker(gate, { call: registry }, { client: f.client, kernelLock }).reconcile(
			f.intentId,
			request,
			signal(),
		),
	).resolves.toMatchObject({ state: "awaiting_configuration" });
	Object.assign(f.client, {
		pushOfficeBootConfigurationRequest: vi.fn(),
		readOfficeBootConfigurationRequest: vi.fn(),
		submitOfficeBootConfiguration: vi.fn(),
		inspectOfficeBootConfiguration: vi.fn(),
	});
	return createOfficeBootConfigurationWorkerFixture({
		...f,
		request,
		registry,
		kernelLock,
		guest: f.files,
		activation: { request: { intentId: f.intentId, serviceBootstrapPath: f.serviceBootstrapPath } },
		readProtected: vi.fn(f.sources.readProtected),
		readCredential: vi.fn(f.sources.readCredential),
	});
}

describe("resumed boot configuration", () => {
	it("configures an ordinary resume after an admitted outage boot without replacing its origin", async () => {
		const f = await outageResumeFixture();
		const original = await readFile(join(f.root, `configuration-intent-${f.binding.allocationId}.json`));
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.exec).toHaveBeenCalledOnce();
		expect(await readFile(join(f.root, `configuration-intent-${f.binding.allocationId}.json`))).toEqual(original);
	}, 60000);
	it("refuses missing, malformed, mismatched or ambiguous outage configuration evidence before staging", async () => {
		const f = await outageResumeFixture(),
			prefix = `outage-configuration-intent-${f.binding.allocationId}-`,
			indexPath = join(f.root, `${prefix}${f.admitted.activationId}.json`),
			completionPath = join(
				f.root,
				`outage-configuration-completed-${f.binding.allocationId}-${f.admitted.activationId}.json`,
			),
			index = await readFile(indexPath),
			completion = await readFile(completionPath),
			extraPath = join(f.root, `${prefix}${randomUUID()}.json`);
		for (const kind of [
			"missing",
			"malformed",
			"binding",
			"boot",
			"recovery",
			"digest",
			"completion",
			"ambiguous",
		] as const) {
			const changed = JSON.parse(index.toString());
			if (kind === "missing") await rm(indexPath);
			else if (kind === "completion") await rm(completionPath);
			else if (kind === "ambiguous") await writeFile(extraPath, index, { mode: 0o600 });
			else {
				if (kind === "binding") changed.allocationId = randomUUID();
				if (kind === "boot") changed.bootId = randomUUID();
				if (kind === "recovery") changed.recoveryId = randomUUID();
				if (kind === "digest") changed.serviceBootstrapSha256 = "0".repeat(64);
				await writeFile(indexPath, JSON.stringify(kind === "malformed" ? {} : changed));
			}
			await expect(f.run(), kind).rejects.toThrow("UNCONFIRMED");
			expect(f.stage, kind).not.toHaveBeenCalled();
			expect(f.exec, kind).not.toHaveBeenCalled();
			await writeFile(indexPath, index, { mode: 0o600 });
			await writeFile(completionPath, completion, { mode: 0o600 });
			await rm(extraPath, { force: true });
		}
		const readProtected = f.readProtected.getMockImplementation()!,
			plan = JSON.parse((await readProtected(f.serviceBootstrapPath)).toString());
		plan.registryUrl = "https://replacement.invalid";
		f.readProtected.mockImplementation(async () => Buffer.from(JSON.stringify(plan)));
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(f.stage).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
	}, 60000);
	it("refuses changed accepted outage history after staging without dispatch", async () => {
		const f = await outageResumeFixture(),
			stage = f.stage.getMockImplementation()!;
		f.stage.mockImplementation(async (...args) => {
			await stage(...args);
			await writeFile(
				join(f.root, `outage-configuration-intent-${f.binding.allocationId}-${f.admitted.activationId}.json`),
				"{}",
			);
		});
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.exec).not.toHaveBeenCalled();
	}, 60000);
	// The production office (layout version 2, five roots) went down at its first
	// power-off/resume: the whole chain below ran only on version 1 before.
	it.each([1, 2] as const)(
		"layout version %i: power-off, resume, then preserves original files and commands, installs one new boot and recovers after process restart",
		async (layoutVersion) => {
			officeFixtureLayout.version = layoutVersion;
			const f = await fixture(),
				originals = new Map([...f.guest].map(([path, file]) => [path, Buffer.from(file.content)]));
			const result = await f.run();
			expect(result).toMatchObject({ state: "awaiting_boot_admission", bootId: id(103), activationId: id(102) });
			expect(await f.run()).toEqual(result);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.stage).toHaveBeenCalledOnce();
			expect(f.resume.submit).toHaveBeenCalledOnce();
			for (const [path, bytes] of originals) expect(f.guest.get(path)!.content).toEqual(bytes);
			const configured = JSON.parse(f.staged()!.toString());
			const admitted = [...COMPANY_COMPUTER_GUEST_LAYOUT_KEYS[layoutVersion]].sort();
			expect(Object.keys(JSON.parse(configured.material.configuration).linux.layout).sort()).toEqual(admitted);
			expect(
				Object.keys(
					JSON.parse(f.guest.get(companyComputerBootAdoptionReceiptPath(id(103)))!.content.toString()).layout,
				).sort(),
			).toEqual(admitted);
			expect(admitted.includes("companyRoot")).toBe(layoutVersion === 2);
			expect(JSON.parse(configured.material.configuration).linux.attestation).toMatchObject({
				bootId: id(103),
				adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(id(103)),
			});
			const retained = (
				await Promise.all(
					(
						await readdir(f.root)
					)
						.filter((name) => name.endsWith(".json"))
						.map((name) => readFile(join(f.root, name), "utf8")),
				)
			).join("\n");
			for (const secret of [f.secrets.registry, f.secrets.native, f.secrets.objects, f.secrets.tlsKey])
				expect(retained).not.toContain(secret);
			expect(f.credentialBuffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
			expect(f.stage.mock.calls[0][3].every((byte) => byte === 0)).toBe(true);
		},
	);
	it.each(["recorded", "unrecorded"])(
		"takes a plan with replaced TLS credentials only through the %s revision chain",
		async (kind) => {
			const f = await fixture();
			const path = f.input.serviceBootstrapPath,
				original = (await f.readProtected(path)).toString("utf8"),
				material = { tlsCert: `${f.secrets.tlsCert}\n`, tlsKey: `${f.secrets.tlsKey}\n` };
			const plan = JSON.parse(original);
			for (const [key, text] of Object.entries(material))
				plan.credentials[key] = {
					path: `${plan.credentials[key].path}-r1`,
					bytes: Buffer.byteLength(text),
					sha256: hash(Buffer.from(text)),
				};
			const next = JSON.stringify(plan);
			const chain = {
				schema: "qorpera.lxd-office-service-bootstrap-revisions/v1",
				allocationId: f.binding.allocationId,
				revisions: [
					{
						revision: 1,
						previousSha256: hash(Buffer.from(original)),
						nextSha256: hash(Buffer.from(next)),
						previousPlan: original,
						changed: ["tlsCert", "tlsKey"],
						reason: "tailnet certificate renewed",
						at: "2026-09-17T12:00:00Z",
					},
				],
			};
			const readProtected = f.readProtected.getMockImplementation()!,
				readCredential = f.readCredential.getMockImplementation()!;
			f.readProtected.mockImplementation(async (file: string) => {
				if (file === path) return Buffer.from(next);
				if (file.endsWith("/service-bootstrap-revisions.json")) {
					if (kind === "unrecorded") throw Object.assign(new Error("missing"), { code: "ENOENT" });
					return Buffer.from(JSON.stringify(chain));
				}
				return readProtected(file);
			});
			f.readCredential.mockImplementation(async (file: string) => {
				const name = Object.keys(material).find((key) => file === plan.credentials[key].path);
				return name ? Buffer.from(material[name as keyof typeof material]) : readCredential(file);
			});
			if (kind === "unrecorded") {
				await expect(f.run()).rejects.toThrow("OFFICE_BOOT_CONFIGURATION_UNCONFIRMED");
				expect(f.stage).not.toHaveBeenCalled();
				expect(f.exec).not.toHaveBeenCalled();
				return;
			}
			const result = await f.run();
			expect(result).toMatchObject({ state: "awaiting_boot_admission", bootId: id(103) });
			expect(JSON.parse(await readFile(f.names.index, "utf8")).serviceBootstrapSha256).toBe(hash(Buffer.from(next)));
			const staged = JSON.parse(f.staged()!.toString());
			expect(staged.material.tlsCert).toBe(material.tlsCert);
			expect(
				f.guest.get(`${companyComputerBootDirectory(id(103))}/credentials/tls-cert.pem`)?.content.toString(),
			).toBe(material.tlsCert);
		},
	);
	it("cannot initiate a missing VM resume", async () => {
		const f = await fixture(false);
		await expect(f.run()).rejects.toThrow("OFFICE_BOOT_CONFIGURATION_UNCONFIRMED");
		expect(f.resume.submit).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
		expect(f.stage).not.toHaveBeenCalled();
	});
	it.each(["seed", "prepared", "observation", "done"] as const)(
		"refuses lost resume %s before invoking the verifier",
		async (name) => {
			const f = await fixture();
			await rm(f.resume.names[name]);
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).not.toHaveBeenCalled();
			expect(f.stage).not.toHaveBeenCalled();
			expect(f.resume.submit).toHaveBeenCalledOnce();
		},
	);
	it.each([true, false])("never retries a lost dispatch reply (installed %s)", async (installed) => {
		const f = await fixture();
		f.state.install = installed;
		const submit = f.exec.getMockImplementation()!;
		f.exec.mockImplementationOnce(async (...args) => {
			await submit(...args);
			throw new Error("lost reply");
		});
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.poll).not.toHaveBeenCalled();
		await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("recovers an accepted operation after a lost poll without another dispatch", async () => {
		const f = await fixture();
		f.poll.mockRejectedValueOnce(new Error("lost poll"));
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it.each(["index", "observation", "journal"] as const)("refuses deleted acknowledged %s", async (name) => {
		const f = await fixture();
		await f.run();
		await rm(f.names[name], { recursive: true });
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it("refuses a lost index after dispatch even without an acknowledged completion", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("pending");
		await f.run();
		await rm(f.names.index);
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("recovers an intact command before dispatch after lost staging confirmation", async () => {
		const f = await fixture();
		f.readStage.mockRejectedValueOnce(new Error("lost staging"));
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		const identity = await readFile(f.names.index);
		await rm(f.names.index);
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		expect(await readFile(f.names.index)).toEqual(identity);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each(["registry", "native", "objects", "tlsCert", "tlsKey", "configuration"] as const)(
		"independently refuses missing installed %s after acknowledged configuration",
		async (key) => {
			const f = await fixture();
			await f.run();
			f.guest.delete(
				`${companyComputerBootDirectory(id(103))}/credentials/${COMPANY_COMPUTER_CONFIGURATION_FILES[key]}`,
			);
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.stage).toHaveBeenCalledOnce();
		},
	);
	it.each(["receipt", "completion", "mode", "bytes", "second-pass"])(
		"refuses altered %s during independent verification",
		async (kind) => {
			const f = await fixture(),
				submit = f.exec.getMockImplementation()!;
			f.exec.mockImplementation(async (...args) => {
				const result = await submit(...args),
					directory = companyComputerBootDirectory(id(103));
				if (kind === "receipt")
					f.guest.get(companyComputerBootAdoptionReceiptPath(id(103)))!.content = Buffer.from("{}");
				if (kind === "completion") f.guest.delete(`${directory}/configuration-completion.json`);
				if (kind === "mode") f.guest.get(`${directory}/credentials/native`)!.mode = 0o444;
				if (kind === "bytes") f.guest.get(`${directory}/credentials/native`)!.content = Buffer.from("changed");
				return result;
			});
			if (kind === "second-pass") {
				const read = f.file.getMockImplementation()!;
				let count = 0;
				f.file.mockImplementation(async (...args) => {
					if (args[2] === `${companyComputerBootDirectory(id(103))}/credentials/native` && ++count === 2)
						f.guest.get(args[2])!.content = Buffer.from("changed");
					return read(...args);
				});
			}
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
	it.each(["sql", "host", "boot", "credential", "history", "index"])(
		"rechecks %s after staging before dispatch",
		async (kind) => {
			const f = await fixture(),
				stage = f.stage.getMockImplementation()!;
			f.stage.mockImplementation(async (...args) => {
				await stage(...args);
				if (kind === "sql") f.intent.state = "admitted";
				if (kind === "host")
					f.check.mockImplementation(async () => ({ hostBootId: id(119), signal: signal(), validForMs: 5000 }));
				if (kind === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(119));
				if (kind === "credential") f.readCredential.mockRejectedValue(new Error("credential changed"));
				if (kind === "history") await writeFile(f.resume.powerOff.paths.done, "{}");
				if (kind === "index") await writeFile(f.names.index, "{}");
			});
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it("retains cancellation ownership across replacement workers until registry IO settles", async () => {
		const f = await fixture(),
			original = f.registry.getMockImplementation()!;
		let release!: () => void, enter!: () => void;
		const blocked = new Promise<void>((r) => {
				release = r;
			}),
			entered = new Promise<void>((r) => {
				enter = r;
			});
		f.registry.mockImplementation(async (...args) => {
			if (args[0] === "qorpera_check_runtime_office_boot_intent") {
				enter();
				await blocked;
			}
			return original(...args);
		});
		const abort = new AbortController(),
			operation = f.run(abort.signal);
		await entered;
		abort.abort();
		await expect(operation).rejects.toThrow("ABORTED");
		await expect(f.run()).rejects.toThrow("PENDING");
		release();
		await vi.waitFor(() => expect(f.credentialBuffers.every((bytes) => bytes.every((b) => b === 0))).toBe(true));
		f.registry.mockImplementation(original);
		await vi.waitFor(async () => {
			await expect(f.run()).resolves.toMatchObject({ state: "awaiting_boot_admission" });
		});
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
