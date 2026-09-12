import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerResetConfigurationRequest,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeResetWorkerFixture } from "./fixtures/office-reset-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

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
			expect(JSON.parse(await readFile(f.paths.journal("reset-configuration", "000000.json"), "utf8")).kind).toBe(
				"dispatch",
			);
			const packet = staged.get(`reset-configuration-incoming-${command.requestSha256}`)!;
			expect(hash(packet)).toBe(command.requestSha256);
			expect(command.bootId).toBe(f.vm.freshBootId);
			const body = parseCompanyComputerResetConfigurationRequest(JSON.parse(packet.toString()));
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
			expect(JSON.parse(await readFile(f.paths.journal("reset-service-start", "000000.json"), "utf8")).kind).toBe(
				"dispatch",
			);
			const packet = staged.get(`reset-service-start-incoming-${command.requestSha256}`)!;
			expect(hash(packet)).toBe(command.requestSha256);
			const request = parseCompanyComputerResetServiceStartRequest(JSON.parse(packet.toString()));
			const { attestation } = request.request;
			expect(attestation.bootId).toBe(command.bootId);
			const directory = companyComputerBootDirectory(command.bootId),
				configured = guest.get(`${directory}/reset-configuration-completion.json`)!.content;
			expect(JSON.parse(configured.toString()).files["config.json"].sha256).toBe(attestation.configurationSha256);
			expect(guest.has(`${RUN}/reset-service-start-claim.json`)).toBe(false);
			expect(f.registry.state.successor?.state).toBe("prepared");
			const completion = {
				schema: "qorpera.office-reset-service-start-completion/v1",
				command,
				resetId: request.request.resetId,
				activationId: attestation.activationId,
				configurationCompletionSha256: hash(configured),
				configurationSha256: attestation.configurationSha256,
				serviceInvocationId: "c".repeat(32),
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
			Object.assign(f.registry.state.successor!, {
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
	return { ...f, guest, staged, lost, operations, configure, configurationState, start, inspect, run, until };
}
describe("composed office reset successor lane", () => {
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
