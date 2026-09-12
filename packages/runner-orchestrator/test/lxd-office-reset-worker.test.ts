import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPANY_COMPUTER_RESET_PHASES } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeOperationJournal } from "../src/lxd-office-operations.ts";
import { officeResetWorkerFixture } from "./fixtures/office-reset-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => officeResetWorkerFixture(roots);
const OUTBOX = "/var/lib/qorpera-office-events";
describe("serialized office root reset worker", () => {
	it("advances one phase per tick through the full chain with one planned command per physical action", async () => {
		const f = await fixture();
		const phases: string[] = [];
		let result = await f.run();
		phases.push(result.phase);
		while (result.state === "progressed") {
			result = await f.run();
			phases.push(result.phase);
		}
		expect(result).toMatchObject({ state: "active", phase: "active", serviceInvocationId: "c".repeat(32) });
		expect(phases).toEqual(COMPANY_COMPUTER_RESET_PHASES.slice(1));
		expect(f.registry.state.phase).toBe("active");
		expect(f.submit.mock.calls.map(([, action]) => action.action)).toEqual(["stop", "delete", "create", "start"]);
		const history = await LxdOfficeOperationJournal.readHistory(f.root, f.binding.allocationId);
		const suffix = history.events.slice(-12);
		expect(suffix.map((event) => `${event.action}:${event.kind}`)).toEqual(
			["stop", "delete", "create", "start"].flatMap((action) => [
				`${action}:dispatch`,
				`${action}:accepted`,
				`${action}:settled`,
			]),
		);
		expect(new Set(suffix.map((event) => event.commandId))).toEqual(
			new Set([
				f.plan.commands.stopCommandId,
				f.plan.commands.deleteCommandId,
				f.plan.commands.createCommandId,
				f.plan.commands.startCommandId,
			]),
		);
		// Restored bytes are exact, with the original ownership and modes.
		for (const [name, bytes] of f.outbox) {
			const file = f.guest.get(`${OUTBOX}/${name}`)!;
			expect(file.content.equals(bytes)).toBe(true);
			expect([file.uid, file.gid, file.mode]).toEqual([f.outboxUid, f.outboxGid, 0o600]);
		}
		const adoption = f.guest.get("/etc/qorpera-office/adoption.json")!;
		expect(adoption.mode).toBe(0o444);
		expect(f.guest.get("/etc/qorpera-office/credentials/config.json")).toBeUndefined();
		expect(f.guest.get("/proc/sys/kernel/random/boot_id")!.content.toString()).toBe(`${f.vm.freshBootId}\n`);
		const historyRoot = `/etc/qorpera-office/history/${f.request.startup.bootId}/${f.request.activationId}`;
		expect(f.guest.has(`${historyRoot}/manifest.json`)).toBe(true);
		expect(f.guest.has(`${historyRoot}/claim.json`)).toBe(true);
		expect([...f.guest.keys()].some((path) => path.startsWith("/run/qorpera-office-preparation/service-"))).toBe(
			false,
		);
		// The provider archive is sealed and independent of the deleted root.
		expect((await readdir(f.paths.archive)).sort()).toEqual([
			"history",
			"manifest.json",
			"outbox",
			"outbox-manifest.json",
		]);
		expect((await readdir(join(f.paths.archive, "outbox"))).sort()).toEqual([...f.outbox.keys()].sort());
		const done = JSON.parse(await readFile(f.paths.done, "utf8"));
		expect(done.activationId).toBe(f.plan.successorActivationId);
		for (let n = 1; n <= 9; n++) expect(JSON.parse(await readFile(f.paths.phase(n), "utf8")).sequence).toBe(n);
		expect(f.lane.configure).toHaveBeenCalledOnce();
		expect(f.lane.start).toHaveBeenCalledOnce();
		expect(f.nas.verifications).toBeGreaterThan(4);
		// A later tick observes the completed reset without any new dispatch.
		await expect(f.run()).resolves.toMatchObject({ state: "active", phase: "active" });
		expect(f.submit).toHaveBeenCalledTimes(4);
		expect(f.lane.start).toHaveBeenCalledOnce();
	});
	it("holds at restored with a stable reason when no guest successor lane is composed", async () => {
		const f = await fixture();
		expect(await f.ticks(6)).toMatchObject({ state: "progressed", phase: "restored" });
		await expect(f.run({ successorLane: null })).resolves.toMatchObject({
			state: "held",
			phase: "restored",
			reason: "OFFICE_RESET_GUEST_LANE_UNAVAILABLE",
		});
		expect(f.registry.state.phase).toBe("restored");
		expect(f.lane.configure).not.toHaveBeenCalled();
		expect(f.submit).toHaveBeenCalledTimes(4);
	});
	it.each(COMPANY_COMPUTER_RESET_PHASES.slice(1, 7))(
		"recovers a lost committed %s acknowledgement without redispatch",
		async (phase) => {
			const f = await fixture();
			f.registry.state.loseAck.add(phase);
			let caught: unknown;
			for (let tick = 0; tick < 12 && !caught; tick++) {
				try {
					await f.run();
				} catch (error) {
					caught = error;
				}
			}
			expect(caught).toMatchObject({ message: "OFFICE_RESET_UNCONFIRMED" });
			expect(f.registry.state.phase).toBe(phase);
			const submits = f.submit.mock.calls.length;
			await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase });
			expect(f.registry.state.phase).toBe(phase);
			expect(f.submit).toHaveBeenCalledTimes(submits);
			const record = JSON.parse(
				await readFile(f.paths.phase(COMPANY_COMPUTER_RESET_PHASES.indexOf(phase) + 1), "utf8"),
			);
			expect(record.phase).toBe(phase);
			await expect(f.until("active")).resolves.toMatchObject({ state: "active" });
			expect(f.submit).toHaveBeenCalledTimes(4);
		},
	);
	it("recovers lost committed successor preparation and activation replies", async () => {
		const f = await fixture();
		f.registry.state.losePrepare = true;
		f.registry.state.loseActivate = true;
		expect(await f.ticks(6)).toMatchObject({ state: "progressed", phase: "restored" });
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.registry.state.phase).toBe("prepared");
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "prepared" });
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.registry.state.phase).toBe("active");
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(f.lane.start).toHaveBeenCalledOnce();
		expect(
			f.registry.state.calls.filter((m) => m === "qorpera_activate_runtime_office_reset_successor"),
		).toHaveLength(1);
	});
	it.each(["stop", "delete", "create", "start"] as const)(
		"keeps an unknown %s dispatch unconfirmed forever without a second command",
		async (action) => {
			const f = await fixture();
			const original = f.submit.getMockImplementation()!;
			f.submit.mockImplementation(async (...args) => {
				if (args[1].action !== action) return original(...args);
				await original(...args);
				throw new Error("lost provider reply");
			});
			let result = await f.run();
			while (result.state === "progressed") result = await f.run();
			expect(result.state).toBe("unknown");
			const submits = f.submit.mock.calls.length;
			for (let n = 0; n < 3; n++) await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
			expect(f.submit).toHaveBeenCalledTimes(submits);
			const history = await LxdOfficeOperationJournal.readHistory(f.root, f.binding.allocationId);
			const dispatched = history.events.filter((event) => event.commandId === f.plan.commands[`${action}CommandId`]);
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]).toMatchObject({ kind: "dispatch", commandId: f.plan.commands[`${action}CommandId`] });
			expect(f.registry.state.phase).not.toBe("active");
		},
	);
	it("refuses a stale dispatch window and never submits", async () => {
		const f = await fixture();
		await f.ticks(2);
		expect(f.registry.state.phase).toBe("custodied");
		f.registry.state.challengeValidForMs = 1;
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
		f.registry.state.challengeValidForMs = 5000;
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "powered_off" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("holds custody on an unresolved outbox temporary and refuses foreign or noncanonical records", async () => {
		const f = await fixture();
		await f.run();
		f.guest.set(`${OUTBOX}/.write-${id(90)}`, {
			content: Buffer.from("{}"),
			uid: f.outboxUid,
			gid: f.outboxGid,
			mode: 0o600,
		});
		await expect(f.run()).resolves.toMatchObject({
			state: "held",
			phase: "stopped",
			reason: "OFFICE_RESET_OUTBOX_REMNANT",
		});
		f.guest.delete(`${OUTBOX}/.write-${id(90)}`);
		const name = `${id(70)}-0000000000000002.json`,
			original = f.guest.get(`${OUTBOX}/${name}`)!;
		f.guest.set(`${OUTBOX}/${name}`, {
			...original,
			content: Buffer.from(`${JSON.stringify(JSON.parse(original.content.toString()), null, 1)}\n`),
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.guest.set(`${OUTBOX}/${name}`, { ...original, uid: 0 });
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.guest.set(`${OUTBOX}/${name}`, original);
		f.guest.set(`${OUTBOX}/credentials.json`, { ...original });
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.guest.delete(`${OUTBOX}/credentials.json`);
		expect(await readdir(f.paths.archive).catch(() => [])).not.toContain("manifest.json");
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "custodied" });
		expect(f.registry.state.custodySha256).toMatch(/^[0-9a-f]{64}$/);
	});
	it("refuses destruction when the sealed archive or NAS custody changed", async () => {
		const f = await fixture();
		await f.ticks(2);
		expect(f.registry.state.phase).toBe("custodied");
		const manifest = join(f.paths.archive, "manifest.json"),
			bytes = await readFile(manifest);
		await writeFile(manifest, Buffer.concat([bytes, Buffer.from(" ")]));
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		await writeFile(manifest, bytes);
		f.nas.fail = true;
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.nas.fail = false;
		expect(f.submit).not.toHaveBeenCalled();
		await expect(f.run()).resolves.toMatchObject({ state: "progressed", phase: "powered_off" });
	});
	it("refuses a shared workbench device, a changed plan, a foreign boot and node refusal", async () => {
		const f = await fixture();
		await f.run();
		f.inventory.instances.push({
			...structuredClone(f.inventory.instances[0]),
			name: "other-office",
			expandedDevices: {
				workbench: { type: "disk", source: f.binding.workbenchSource, path: "/var/lib/qorpera-office" },
			},
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		f.inventory.instances.pop();
		await expect(
			f
				.create()
				.reconcile(
					{ ...f.input, plan: { ...f.plan, providerBindingSha256: "9".repeat(64) }, planSha256: "8".repeat(64) },
					new AbortController().signal,
				),
		).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		await f.ticks(4);
		expect(f.registry.state.phase).toBe("root_created");
		f.registry.state.nodeRefused = true;
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledTimes(3);
		f.registry.state.nodeRefused = false;
		const original = f.submit.getMockImplementation()!;
		f.submit.mockImplementation(async (...args) => {
			const reference = await original(...args);
			// The recreated root reports the predecessor's boot identity again.
			f.guest.set("/proc/sys/kernel/random/boot_id", {
				content: Buffer.from(`${f.request.startup.bootId}\n`),
				uid: 0,
				gid: 0,
				mode: 0o444,
			});
			return reference;
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESET_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledTimes(4);
		expect(f.registry.state.phase).toBe("root_created");
	});
	it("does not reprepare, reuse an old credential or admit the predecessor identity", async () => {
		const f = await fixture();
		const preparations = f.activation.preparation.exec.mock.calls.length,
			configurations = f.activation.configuration.exec.mock.calls.length;
		const result = await f.until("active");
		expect(result.state).toBe("active");
		expect(f.activation.preparation.exec).toHaveBeenCalledTimes(preparations);
		expect(f.activation.configuration.exec).toHaveBeenCalledTimes(configurations);
		const request = JSON.parse(await readFile(f.paths.successor, "utf8"));
		expect(request.attestation.bootId).toBe(f.vm.freshBootId);
		expect(request.attestation.activationId).toBe(f.plan.successorActivationId);
		expect(request.attestation.preparationObservationSha256).toBe(f.plan.preparationObservationSha256);
		expect(request.attestation.configurationSha256).not.toBe(f.request.startup.configurationSha256);
		expect(request.attestation.adoptionReceiptSha256).toBe(
			JSON.parse(await readFile(f.paths.seed, "utf8")).adoptionReceiptSha256,
		);
		const material = f.lane.configure.mock.calls[0][0];
		expect(material.bootId).toBe(f.vm.freshBootId);
		expect(f.registry.state.calls).not.toContain("qorpera_prepare_runtime_office_successor");
	});
});
