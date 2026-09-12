import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerResetConfigurationRequest,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { readRecord } from "../src/lxd-office-journal-files.ts";
import { readLxdOfficeResetActivationHistory } from "../src/lxd-office-reset-activation-history.ts";
import { readLxdOfficeResetVmHistory } from "../src/lxd-office-reset-vm-history.ts";
import { LxdOfficeResetWorker } from "../src/lxd-office-reset-worker.ts";
import { createOfficeBootActivationWorkerFixture } from "./fixtures/office-boot-activation-worker.ts";
import { createOfficeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";
import { createOfficePowerOffWorkerFixture } from "./fixtures/office-power-off-worker.ts";
import { createOfficeResetServiceSuccessorFixture } from "./fixtures/office-reset-service-successor.ts";
import { officeResetRegistryFixture, officeResetWorkerFixture } from "./fixtures/office-reset-worker.ts";
import { createOfficeResumeWorkerFixture } from "./fixtures/office-resume-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";
import { createOfficeStopWorkerFixture } from "./fixtures/office-stop-worker.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const RUN = "/run/qorpera-office-preparation";
const CGROUP = "/system.slice/qorpera-company-computer.service";
type GuestFile = { content: Buffer; uid: number; gid: number; mode: number };
/** The composed production lane against a synthetic root: the LXD control
 * transport is mocked at the client boundary and the two protected guest
 * helpers are simulated by what they publish on the recreated root. */
async function fixture() {
	const f = await officeResetWorkerFixture(roots);
	let selectedRegistry = f.registry;
	let invocation = "c".repeat(32);
	const guest = f.guest as Map<string, GuestFile>;
	const staged = new Map<string, Buffer>();
	const lost = { configuration: false, start: false };
	const operations = { configuration: "succeeded" as "succeeded" | "pending" | "failed" };
	for (const purpose of ["reset-configuration", "reset-service-start"] as const) {
		const push =
				purpose === "reset-configuration"
					? "pushOfficeResetConfigurationRequest"
					: "pushOfficeResetServiceStartRequest",
			read =
				purpose === "reset-configuration"
					? "readOfficeResetConfigurationRequest"
					: "readOfficeResetServiceStartRequest";
		vi.spyOn(f.client, push).mockImplementation(async (_project, _name, sha256, bytes) => {
			if (guest.get(`${RUN}/control.lock`)?.content.length !== 0) throw new Error("guest lock");
			expect(hash(bytes)).toBe(sha256);
			staged.set(`${purpose}-incoming-${sha256}`, Buffer.from(bytes));
			guest.set(`${RUN}/${purpose}-incoming-${sha256}.json`, {
				content: Buffer.from(bytes),
				uid: 0,
				gid: 0,
				mode: 0o400,
			});
		});
		vi.spyOn(f.client, read).mockImplementation(async (_project, _name, sha256, length) => {
			const bytes = staged.get(`${purpose}-incoming-${sha256}`);
			if (!bytes || bytes.length !== length) throw new Error(`LXD_OFFICE_${purpose}_READBACK_UNCONFIRMED`);
			return { content: Buffer.from(bytes), uid: 0, gid: 0, mode: 0o400 };
		});
	}
	const configure = vi
		.spyOn(f.client, "submitOfficeResetConfiguration")
		.mockImplementation(async (project, instanceName, command) => {
			const packet = staged.get(`reset-configuration-incoming-${command.requestSha256}`)!;
			expect(hash(packet)).toBe(command.requestSha256);
			expect(command.bootId).toBe(f.vm.freshBootId);
			const body = parseCompanyComputerResetConfigurationRequest(JSON.parse(packet.toString()));
			expect(
				JSON.parse(
					await readFile(
						join(f.root, `reset-configuration-${f.binding.allocationId}-${body.activationId}`, "000000.json"),
						"utf8",
					),
				).kind,
			).toBe("dispatch");
			// The root helper's bindings: exact original bytes, restored receipt,
			// restored predecessor history and no historical credential.
			expect(hash(body.originPreparation)).toBe(body.originPreparationSha256);
			const receipt = encode(companyComputerPreparationAdoptionReceipt(JSON.parse(body.originPreparation)));
			expect(guest.get("/etc/qorpera-office/adoption.json")!.content.equals(receipt)).toBe(true);
			expect(hash(receipt)).toBe(body.adoptionReceiptSha256);
			expect(guest.has("/etc/qorpera-office/credentials/config.json")).toBe(false);
			expect(
				guest.has(
					`/etc/qorpera-office/history/${body.predecessor.startup.bootId}/${body.predecessor.activationId}/manifest.json`,
				),
			).toBe(true);
			expect(JSON.parse(body.material.configuration).linux.attestation.bootId).toBe(command.bootId);
			const directory = companyComputerBootDirectory(command.bootId);
			const files = Object.fromEntries(
				Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
					const content = Buffer.from(body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
					guest.set(`${directory}/credentials/${file}`, { content, uid: 0, gid: 0, mode: 0o400 });
					return [file, { bytes: content.length, sha256: hash(content) }];
				}),
			);
			guest.set("/etc/qorpera-office/preparation.json", {
				content: Buffer.from(body.originPreparation),
				uid: 0,
				gid: 0,
				mode: 0o444,
			});
			const identity = {
				resetId: body.resetId,
				rootIncarnationId: body.rootIncarnationId,
				activationId: body.activationId,
			};
			guest.set(`${directory}/reset-configuration-claim.json`, {
				content: encode({ schema: "qorpera.office-reset-configuration-claim/v1", command, ...identity }),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			guest.set(`${directory}/reset-configuration-completion.json`, {
				content: encode({
					schema: "qorpera.office-reset-configuration-completion/v1",
					command,
					...identity,
					originPreparationSha256: body.originPreparationSha256,
					adoptionReceiptSha256: body.adoptionReceiptSha256,
					files,
				}),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			if (lost.configuration) {
				lost.configuration = false;
				throw new Error("lost provider reply");
			}
			return { project, instanceName, operationId: id(500) };
		});
	const configurationState = vi
		.spyOn(f.client, "inspectOfficeResetConfiguration")
		.mockImplementation(async () => operations.configuration);
	const start = vi
		.spyOn(f.client, "submitOfficeResetServiceStart")
		.mockImplementation(async (project, instanceName, command) => {
			const packet = staged.get(`reset-service-start-incoming-${command.requestSha256}`)!;
			expect(hash(packet)).toBe(command.requestSha256);
			const request = parseCompanyComputerResetServiceStartRequest(JSON.parse(packet.toString()));
			const { attestation } = request.request;
			expect(
				JSON.parse(
					await readFile(
						join(
							f.root,
							`reset-service-start-${f.binding.allocationId}-${attestation.activationId}`,
							"000000.json",
						),
						"utf8",
					),
				).kind,
			).toBe("dispatch");
			expect(attestation.bootId).toBe(command.bootId);
			const directory = companyComputerBootDirectory(command.bootId),
				configured = guest.get(`${directory}/reset-configuration-completion.json`)!.content;
			expect(JSON.parse(configured.toString()).files["config.json"].sha256).toBe(attestation.configurationSha256);
			expect(guest.has(`${RUN}/reset-service-start-claim.json`)).toBe(false);
			expect(selectedRegistry.state.successor?.state).toBe("prepared");
			const completion = {
				schema: "qorpera.office-reset-service-start-completion/v1",
				command,
				resetId: request.request.resetId,
				activationId: attestation.activationId,
				configurationCompletionSha256: hash(configured),
				configurationSha256: attestation.configurationSha256,
				serviceInvocationId: invocation,
				mainPid: 700,
				controlGroup: CGROUP,
			};
			guest.set(`${RUN}/reset-service-start-claim.json`, {
				content: encode({
					schema: "qorpera.office-reset-service-start-claim/v1",
					command,
					resetId: completion.resetId,
					activationId: completion.activationId,
					configurationCompletionSha256: completion.configurationCompletionSha256,
				}),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			guest.set(`${RUN}/reset-service-start-completion.json`, {
				content: encode(completion),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			Object.assign(selectedRegistry.state.successor!, {
				state: "ready",
				serviceInvocationId: completion.serviceInvocationId,
				readinessFresh: true,
			});
			if (lost.start) {
				lost.start = false;
				throw new Error("lost provider reply");
			}
			return { project, instanceName, operationId: id(501) };
		});
	vi.spyOn(f.client, "inspectOfficeResetServiceStart").mockResolvedValue("succeeded");
	const inspect = vi
		.spyOn(f.client, "submitOfficeResetServiceInspection")
		.mockImplementation(async (project, instanceName, _command, inspectionId) => {
			const completion = guest.get(`${RUN}/reset-service-start-completion.json`);
			if (!completion) throw new Error("completion missing");
			guest.set(`${RUN}/reset-service-inspection-${inspectionId}.json`, {
				content: encode({
					schema: "qorpera.office-reset-service-inspection/v1",
					inspectionId,
					start: JSON.parse(completion.content.toString()),
				}),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			return { project, instanceName, operationId: id(502) };
		});
	const run = () => f.run({ successorLane: null });
	const until = async (target: string, limit = 12) => {
		let result = await run();
		for (let tick = 0; tick < limit && result.state !== target && result.state === "progressed"; tick++)
			result = await run();
		return result;
	};
	return {
		...f,
		guest,
		staged,
		lost,
		operations,
		configure,
		configurationState,
		start,
		inspect,
		run,
		until,
		useRegistry(registry: typeof selectedRegistry, nextInvocation: string) {
			selectedRegistry = registry;
			invocation = nextInvocation;
		},
	};
}
describe("composed office reset successor lane", () => {
	it("completes a second reset from the first recreated root without replacing original preparation pins", async () => {
		const f = await fixture();
		await f.until("active");
		const stop = await createOfficeStopWorkerFixture(
			{ ...f, request: f.input, completionPath: `${RUN}/reset-service-start-completion.json` },
			"replace",
			`${companyComputerBootDirectory(f.vm.freshBootId)}/credentials/config.json`,
			false,
			id(910),
		);
		await stop.worker.reconcile(f.input.intentId, stop.request, new AbortController().signal);
		const plan = {
			...f.plan,
			resetId: id(920),
			rootIncarnationId: id(921),
			successorActivationId: id(922),
			predecessorRootIncarnationId: f.plan.rootIncarnationId,
			predecessor: stop.request,
			commands: {
				stopCommandId: id(930),
				deleteCommandId: id(931),
				createCommandId: id(932),
				startCommandId: id(933),
			},
		};
		const planSha256 = officeDigest(plan),
			registry = officeResetRegistryFixture(plan, planSha256);
		f.vm.freshBootId = id(950);
		f.useRegistry(registry, "e".repeat(32));
		const input = { ...f.input, plan, planSha256 };
		const run = () =>
			new LxdOfficeResetWorker(
				{ policy: f.policy, check: f.check },
				{ call: registry.call },
				{
					client: f.client,
					kernelLock: f.kernelLock,
					readProtected: f.readProtected,
					readCredential: f.readCredential,
					nasCustody: f.nasCustody,
				},
			).reconcile(input, new AbortController().signal);
		let result = await run();
		for (let n = 0; n < 12 && result.state === "progressed"; n++) result = await run();
		expect(result).toMatchObject({
			state: "active",
			activationId: plan.successorActivationId,
			serviceInvocationId: "e".repeat(32),
		});
		const history = await readLxdOfficeResetActivationHistory(
			f.root,
			input.intentId,
			f.binding,
			plan.successorActivationId,
			async (name) => (await readRecord(join(f.root, name))).value,
			f.client,
			new AbortController().signal,
		);
		expect(history.seed.schema).toBe("qorpera.lxd-office-reset-seed/v2");
		expect(history.commands.map((command) => command.action)).toEqual([
			"create",
			"start",
			"stop",
			"delete",
			"create",
			"start",
			"stop",
			"delete",
			"create",
			"start",
		]);
		expect(history.originalBootId).toBe(f.request.startup.bootId);
		expect(f.configure).toHaveBeenCalledTimes(2);
		expect(f.start).toHaveBeenCalledTimes(2);
	}, 120_000);
	it("stops the recreated-root activation through the ordinary lifecycle worker", async () => {
		const f = await fixture();
		await f.until("active");
		const originalVm = {
			get: f.get.getMockImplementation()!,
			state: f.vmState.getMockImplementation()!,
			submit: f.submit.getMockImplementation()!,
		};
		const stop = await createOfficeStopWorkerFixture(
			{ ...f, request: f.input, completionPath: `${RUN}/reset-service-start-completion.json` },
			"service_restart",
			`${companyComputerBootDirectory(f.vm.freshBootId)}/credentials/config.json`,
			false,
			id(810),
		);
		stop.exec.mockClear();
		await expect(
			stop.worker.reconcile(f.input.intentId, stop.request, new AbortController().signal),
		).resolves.toMatchObject({ state: "stopped" });
		expect(stop.exec).toHaveBeenCalledOnce();
		expect(f.start).toHaveBeenCalledOnce();
		const successor = await createOfficeResetServiceSuccessorFixture(stop);
		await expect(
			successor.worker.reconcile(f.input.intentId, stop.request, new AbortController().signal),
		).resolves.toMatchObject({ state: "active" });
		expect(successor.exec).toHaveBeenCalledOnce();
		const nextActivation = successor.state.current!.request.attestation.activationId;
		const next = await createOfficeStopWorkerFixture(
			{ ...f, request: f.input, completionPath: `${RUN}/reset-service-restart-completion-${nextActivation}.json` },
			"reboot",
			`${companyComputerBootDirectory(f.vm.freshBootId)}/credentials/config.json`,
			false,
			id(811),
		);
		await expect(
			next.worker.reconcile(f.input.intentId, next.request, new AbortController().signal),
		).resolves.toMatchObject({ state: "stopped" });
		const power = await createOfficePowerOffWorkerFixture({ ...f.stop, ...next, activation: f.stop.activation });
		await expect(power.run()).resolves.toMatchObject({ state: "powered_off" });
		expect(JSON.parse(await readFile(power.paths.seed, "utf8")).schema).toBe(
			"qorpera.lxd-office-power-off-request/v4",
		);
		const resume = await createOfficeResumeWorkerFixture(power, {
			bootIntentId: id(850),
			activationId: id(851),
			bootId: id(852),
			operationId: id(853),
		});
		await expect(resume.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		const configured = await createOfficeBootConfigurationWorkerFixture(resume);
		await configured.run();
		const activated = await createOfficeBootActivationWorkerFixture(configured);
		await expect(activated.run()).resolves.toMatchObject({ state: "active" });
		const replacing = await createOfficeStopWorkerFixture(
			{ ...f, request: f.input, completionPath: `${RUN}/boot-service-start-completion.json` },
			"replace",
			`${companyComputerBootDirectory(id(852))}/credentials/config.json`,
			false,
			id(860),
		);
		await replacing.worker.reconcile(f.input.intentId, replacing.request, new AbortController().signal);
		f.get.mockImplementation(originalVm.get);
		f.vmState.mockImplementation(originalVm.state);
		f.submit.mockImplementation(async (...args) => ({
			...(await originalVm.submit(...args)),
			operationId: id(1200 + f.submit.mock.calls.length),
		}));
		f.vm.bootId = id(852);
		f.vm.freshBootId = id(870);
		f.vm.state = "running";
		const plan = {
			...f.plan,
			resetId: id(880),
			rootIncarnationId: id(881),
			successorActivationId: id(882),
			predecessorRootIncarnationId: f.plan.rootIncarnationId,
			predecessor: replacing.request,
			commands: {
				stopCommandId: id(890),
				deleteCommandId: id(891),
				createCommandId: id(892),
				startCommandId: id(893),
			},
		};
		const planSha256 = officeDigest(plan),
			registry = officeResetRegistryFixture(plan, planSha256);
		f.useRegistry(registry, "e".repeat(32));
		const run = () =>
			new LxdOfficeResetWorker(
				{ policy: f.policy, check: f.check },
				{ call: registry.call },
				{
					client: f.client,
					kernelLock: f.kernelLock,
					readProtected: f.readProtected,
					readCredential: f.readCredential,
					nasCustody: f.nasCustody,
				},
			).reconcile({ ...f.input, plan, planSha256 }, new AbortController().signal);
		let result = await run();
		for (let n = 0; n < 12 && result.state === "progressed"; n++) result = await run();
		expect(result).toMatchObject({ state: "active", serviceInvocationId: "e".repeat(32) });
	}, 120_000);
	it("retains an immutable reset activation history without reopening guest files or current authority", async () => {
		const f = await fixture();
		await f.until("active");
		const calls = f.registry.state.calls.length;
		f.guest.clear();
		const history = await readLxdOfficeResetActivationHistory(
			f.root,
			f.input.intentId,
			f.binding,
			f.plan.successorActivationId,
			async (name) => (await readRecord(join(f.root, name))).value,
			f.client,
			new AbortController().signal,
		);
		expect(history).toMatchObject({
			kind: "reset",
			initial: false,
			plan: f.plan,
			bootObservationSha256: f.registry.state.restoreSha256,
			originalBootId: f.request.startup.bootId,
			completion: { activationId: f.plan.successorActivationId, serviceInvocationId: "c".repeat(32) },
		});
		expect(history.commands.map((command) => command.action)).toEqual([
			"create",
			"start",
			"stop",
			"delete",
			"create",
			"start",
		]);
		const creation = (await readRecord(join(f.root, `intent-${f.input.intentId}.json`))).value as Parameters<
			typeof readLxdOfficeResetVmHistory
		>[1];
		const vm = await readLxdOfficeResetVmHistory(
			f.root,
			creation,
			f.plan.successorActivationId,
			async (name) => (await readRecord(join(f.root, name))).value,
			new AbortController().signal,
		);
		expect(vm.commands).toEqual(history.commands);
		expect(vm.observation).toMatchObject({
			bootId: f.vm.freshBootId,
			startCommandId: f.plan.commands.startCommandId,
		});
		expect(f.registry.state.calls).toHaveLength(calls);
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.configure).toHaveBeenCalledOnce();
	});
	it.each([
		"index",
		"origin",
		"restore",
		"configured",
		"completion",
		"phase",
		"custody_binding",
		"custody_digest",
	] as const)("rejects changed retained reset %s history", async (part) => {
		const f = await fixture();
		await f.until("active");
		const path =
			part === "index"
				? join(f.root, `reset-activation-${f.binding.allocationId}-${f.plan.successorActivationId}.json`)
				: part.startsWith("custody_")
					? f.paths.custody
					: part === "origin"
						? f.paths.seed
						: part === "restore"
							? f.paths.restore
							: part === "configured"
								? f.paths.configuration
								: part === "completion"
									? f.paths.started
									: f.paths.phase(9);
		const value = JSON.parse(await readFile(path, "utf8"));
		if (part === "custody_binding") value.binding.rootIncarnationId = id(905);
		else if (part === "custody_digest") value.manifestSha256 = "f".repeat(64);
		else if (part === "index") value.plan.rootIncarnationId = id(901);
		else if (part === "origin") value.originalBootId = id(902);
		else if (part === "restore") value.bootId = id(903);
		else if (part === "configured") value.serviceBootstrapSha256 = "f".repeat(64);
		else if (part === "completion") value.completion.serviceInvocationId = "e".repeat(32);
		else value.previousSha256 = "f".repeat(64);
		await writeFile(path, encode(value));
		await expect(
			readLxdOfficeResetActivationHistory(
				f.root,
				f.input.intentId,
				f.binding,
				f.plan.successorActivationId,
				async (name) => (await readRecord(join(f.root, name))).value,
				f.client,
				new AbortController().signal,
			),
		).rejects.toThrow();
		if (part !== "configured" && part !== "completion") {
			const creation = (await readRecord(join(f.root, `intent-${f.input.intentId}.json`))).value as Parameters<
				typeof readLxdOfficeResetVmHistory
			>[1];
			await expect(
				readLxdOfficeResetVmHistory(
					f.root,
					creation,
					f.plan.successorActivationId,
					async (name) => (await readRecord(join(f.root, name))).value,
					new AbortController().signal,
				),
			).rejects.toThrow();
		}
		expect(f.start).toHaveBeenCalledOnce();
	});
	it("installs fresh credentials under the new boot directory with one configuration dispatch and activates with one start", async () => {
		const f = await fixture();
		await expect(f.until("active")).resolves.toMatchObject({
			state: "active",
			phase: "active",
			serviceInvocationId: "c".repeat(32),
		});
		expect(f.configure).toHaveBeenCalledOnce();
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
		expect(f.registry.state.phase).toBe("active");
		const directory = companyComputerBootDirectory(f.vm.freshBootId);
		for (const file of Object.values(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
			const installed = f.guest.get(`${directory}/credentials/${file}`)!;
			expect([installed.uid, installed.gid, installed.mode]).toEqual([0, 0, 0o400]);
		}
		expect(f.guest.get("/etc/qorpera-office/credentials/config.json")).toBeUndefined();
		expect(f.guest.get("/etc/qorpera-office/preparation.json")!.mode).toBe(0o444);
		// Both guest dispatches are journaled once, with the retained commands.
		for (const purpose of ["reset-configuration", "reset-service-start"] as const) {
			const events = (await readdir(f.paths.journalRoot(purpose))).filter((entry) => entry !== "authority.json");
			expect(events.sort()).toEqual(["000000.json", "000001.json", "000002.json"]);
			const authority = JSON.parse(await readFile(join(f.paths.journalRoot(purpose), "authority.json"), "utf8"));
			expect(authority.schema).toBe(`qorpera.lxd-office-${purpose}-journal/v1`);
			expect(authority.resetId).toBe(f.plan.resetId);
			expect(authority.activationId).toBe(f.plan.successorActivationId);
			expect(authority.bootObservationSha256).toBe(f.registry.state.restoreSha256);
		}
		const configuration = JSON.parse(await readFile(f.paths.configuration, "utf8")),
			started = JSON.parse(await readFile(f.paths.started, "utf8"));
		expect(configuration.command.bootId).toBe(f.vm.freshBootId);
		expect(hash(f.staged.get(`reset-configuration-incoming-${configuration.command.requestSha256}`)!)).toBe(
			configuration.command.requestSha256,
		);
		expect(started.completion.configurationCompletionSha256).toBe(
			hash(f.guest.get(`${directory}/reset-configuration-completion.json`)!.content),
		);
		expect(
			(await readdir(f.root)).filter((entry) => /^reset-service-inspection-.*-accepted\.json$/.test(entry)),
		).toHaveLength(1);
		// A later tick observes the completed reset without any guest command.
		await expect(f.run()).resolves.toMatchObject({ state: "active", phase: "active" });
		expect(f.configure).toHaveBeenCalledOnce();
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
	});
	it("recovers a start whose reply was lost by observing the root completion, never dispatching a second start", async () => {
		const f = await fixture();
		expect(await f.ticks(6)).toMatchObject({ state: "progressed", phase: "restored" });
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "prepared" });
		f.lost.start = true;
		// The journal retains the dispatch without acceptance; the root's own
		// completion is the evidence that the single start happened.
		await expect(f.run()).resolves.toMatchObject({ state: "active", serviceInvocationId: "c".repeat(32) });
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
		const events = (await readdir(f.paths.journalRoot("reset-service-start"))).filter(
			(entry) => entry !== "authority.json",
		);
		expect(events).toEqual(["000000.json"]);
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(f.start).toHaveBeenCalledOnce();
	});
	it("observes a prior start when SQL already records the invocation instead of starting again", async () => {
		const f = await fixture();
		expect(await f.ticks(6)).toMatchObject({ state: "progressed", phase: "restored" });
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "prepared" });
		// The guest started and SQL recorded readiness, but the provider lost the
		// completion readback before its started record: the next tick sees a
		// claimed invocation and only observes the settled dispatch.
		const read = vi.spyOn(f.client, "readInstanceFile"),
			original = read.getMockImplementation()!;
		let lostReads = 1;
		read.mockImplementation(async (...args) => {
			if (args[2] === `${RUN}/reset-service-start-completion.json` && lostReads-- > 0)
				throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
			return original(...args);
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.registry.state.successor?.state).toBe("ready");
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.inspect).not.toHaveBeenCalled();
		await expect(f.run()).resolves.toMatchObject({ state: "active", serviceInvocationId: "c".repeat(32) });
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
		const events = (await readdir(f.paths.journalRoot("reset-service-start"))).filter(
			(entry) => entry !== "authority.json",
		);
		expect(events.sort()).toEqual(["000000.json", "000001.json", "000002.json"]);
	});
	it("holds a pending or lost configuration operation under its single command identity", async () => {
		const f = await fixture();
		expect(await f.ticks(6)).toMatchObject({ state: "progressed", phase: "restored" });
		f.operations.configuration = "pending";
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.configure).toHaveBeenCalledOnce();
		expect(f.registry.state.phase).toBe("restored");
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.configure).toHaveBeenCalledOnce();
		f.operations.configuration = "succeeded";
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "prepared" });
		expect(f.configure).toHaveBeenCalledOnce();
		const configuration = JSON.parse(await readFile(f.paths.configuration, "utf8"));
		expect(f.staged.size).toBe(1);
		expect(f.staged.has(`reset-configuration-incoming-${configuration.command.requestSha256}`)).toBe(true);
	});
	it("refuses to start when the installed credentials or the acknowledged completion differ from the retained digests", async () => {
		const f = await fixture();
		expect(await f.ticks(6)).toMatchObject({ state: "progressed", phase: "restored" });
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "prepared" });
		const directory = companyComputerBootDirectory(f.vm.freshBootId),
			path = `${directory}/credentials/config.json`,
			original = f.guest.get(path)!;
		f.guest.set(path, { ...original, content: Buffer.concat([original.content, Buffer.from(" ")]) });
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.guest.set(path, { ...original, mode: 0o600 });
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.guest.set(path, original);
		const completionPath = `${directory}/reset-configuration-completion.json`,
			completion = f.guest.get(completionPath)!;
		f.guest.set(completionPath, {
			...completion,
			content: encode({ ...JSON.parse(completion.content.toString()), activationId: f.plan.resetId }),
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.guest.set(completionPath, completion);
		expect(f.start).not.toHaveBeenCalled();
		expect(f.staged.size).toBe(1);
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(f.start).toHaveBeenCalledOnce();
	});
});
