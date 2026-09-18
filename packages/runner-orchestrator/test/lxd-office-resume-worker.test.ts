import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { companyComputerStopHistoryDirectory } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeResumeWorkerFixture } from "./fixtures/office-resume-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = (action: "reboot" | "power_off" = "power_off") => officeResumeWorkerFixture(roots, action);
describe("explicit VM resume", () => {
	it("cannot restart a retained VM without fresh node admission", async () => {
		const f = await fixture(),
			call = f.registry.getMockImplementation()!;
		f.registry.mockImplementation(async (method, args, checked) => {
			if (method === "qorpera_reserve_runtime_node_machine")
				return { state: "refused", reason: "NODE_OBSERVATION_UNAVAILABLE" };
			return call(method, args, checked);
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
		f.registry.mockImplementation(call);
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("rechecks physical authority after read-only history outlives a physical sample", async () => {
		const f = await fixture(),
			gates: AbortController[] = [],
			hostBootId = JSON.parse(await readFile(f.powerOff.paths.seed, "utf8")).hostBootId;
		f.check.mockImplementation(async () => {
			const gate = new AbortController();
			gates.push(gate);
			return { signal: gate.signal, hostBootId, validForMs: 5000 };
		});
		const read = f.file.getMockImplementation()!;
		let expired = false;
		f.file.mockImplementation(async (...args) => {
			if (!expired && args[2].endsWith("/manifest.json")) {
				expired = true;
				gates.at(-1)!.abort();
			}
			return read(...args);
		});
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		expect(gates.length).toBeGreaterThanOrEqual(3);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("refuses a boot change during history reads even when completion was already retained", async () => {
		const f = await fixture();
		await f.run();
		const read = f.file.getMockImplementation()!;
		f.file.mockImplementation(async (...args) => {
			if (args[2].endsWith("/manifest.json"))
				f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(111));
			return read(...args);
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it.each(["power_off", "reboot"] as const)(
		"starts once after %s and retains the observed new boot through handoff",
		async (action) => {
			const f = await fixture(action),
				original = await readFile(f.activation.names.completion),
				shutdown = await readFile(f.powerOff.paths.done);
			const result = await f.run();
			expect(result).toMatchObject({ state: "awaiting_configuration", bootId: id(103), activationId: id(102) });
			expect(await f.run()).toEqual(result);
			f.intent.state = "admitted";
			expect(await f.run()).toEqual(result);
			expect(f.submit).toHaveBeenCalledOnce();
			expect(await readFile(f.activation.names.completion)).toEqual(original);
			expect(await readFile(f.powerOff.paths.done)).toEqual(shutdown);
		},
	);
	it.each([true, false])("does not retry a lost start reply (physical boot %s)", async (physical) => {
		const f = await fixture();
		f.state.physical = physical;
		const submit = f.submit.getMockImplementation()!;
		f.submit.mockImplementationOnce(async (...args) => {
			await submit(...args);
			throw new Error("lost acceptance");
		});
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.poll).not.toHaveBeenCalled();
		await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("waits for exact restored history after an accepted start without starting the VM again", async () => {
		const f = await fixture(),
			path = `${companyComputerStopHistoryDirectory(f.request.predecessor.startup.bootId, f.request.predecessor.activationId)}/manifest.json`,
			original = f.guest.get(path)!,
			shutdown = await readFile(f.powerOff.paths.done);
		f.guest.delete(path);
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
		await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
		const seed = await readFile(f.names.seed);
		f.guest.set(path, { ...original, content: Buffer.from("{}") });
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
		await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
		f.guest.set(path, original);
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_configuration", bootId: id(103) });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(await readFile(f.names.seed)).toEqual(seed);
		expect(await readFile(f.powerOff.paths.done)).toEqual(shutdown);
	});
	it("recovers lost preparation and accepted polling replies without another command", async () => {
		const f = await fixture();
		f.registry.mockRejectedValueOnce(new Error("lost committed prepare"));
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
		f.poll.mockRejectedValueOnce(new Error("lost poll"));
		await expect(f.run()).resolves.toMatchObject({ state: "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it.each([
		"stop-proof",
		"archive-proof",
		"stop-journal",
		"running",
		"state",
		"missing",
		"host",
		"kernel",
		"authority",
		"admitted",
	])("refuses %s before physical dispatch", async (fault) => {
		const f = await fixture();
		if (fault === "stop-proof") await writeFile(f.powerOff.paths.done, "{}");
		if (fault === "archive-proof")
			await writeFile(
				join(f.root, `power-off-history-${f.binding.allocationId}-${f.request.predecessor.transitionId}.json`),
				"{}",
			);
		if (fault === "stop-journal") await rm(join(f.paths.journal, "000008.json"));
		if (fault === "running") {
			f.state.status = "Running";
			f.state.statusCode = 103;
		}
		if (fault === "state") f.vmState.mockResolvedValue({ status: "Running", statusCode: 103, network: {} });
		if (fault === "missing") f.state.absent = true;
		if (fault === "host") f.check.mockResolvedValue({ signal: signal(), hostBootId: id(110), validForMs: 5000 });
		if (fault === "kernel") f.kernelLock.mockRejectedValue(new Error("lost lock"));
		if (fault === "authority")
			f.registry.mockImplementation(async (method) => {
				if (method === "qorpera_check_runtime_office_boot_intent") throw new Error("paused");
				return structuredClone(f.intent);
			});
		if (fault === "admitted") f.intent.state = "admitted";
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).not.toHaveBeenCalled();
	});
	it.each(["old-boot", "stopped", "archive", "boot-changed"])("refuses %s after a successful start", async (fault) => {
		const f = await fixture(),
			submit = f.submit.getMockImplementation()!;
		f.submit.mockImplementationOnce(async (...args) => {
			const result = await submit(...args);
			if (fault === "old-boot")
				f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(f.request.predecessor.startup.bootId);
			if (fault === "stopped") {
				f.state.status = "Stopped";
				f.state.statusCode = 102;
			}
			if (fault === "archive")
				f.guest.delete(
					`${companyComputerStopHistoryDirectory(f.request.predecessor.startup.bootId, f.request.predecessor.activationId)}/manifest.json`,
				);
			if (fault === "boot-changed") {
				const read = f.file.getMockImplementation()!;
				let n = 0;
				f.file.mockImplementation(async (...args) => {
					if (args[2] === "/proc/sys/kernel/random/boot_id" && ++n === 3)
						f.guest.get(args[2])!.content = Buffer.from(id(111));
					return read(...args);
				});
			}
			return result;
		});
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
		await expect(readFile(f.names.done)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(["seed", "prepared", "observation", "boot", "intent"])(
		"refuses lost or changed %s after completion",
		async (fault) => {
			const f = await fixture();
			await f.run();
			if (fault === "seed" || fault === "prepared" || fault === "observation") await rm(f.names[fault]);
			if (fault === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(111));
			if (fault === "intent") f.intent.privacyVersion++;
			await expect(f.run()).rejects.toThrow("OFFICE_RESUME_UNCONFIRMED");
			expect(f.submit).toHaveBeenCalledOnce();
		},
	);
	it("retains cancellation ownership through late registry settlement", async () => {
		const f = await fixture();
		let enter!: () => void, release!: () => void;
		const ready = new Promise<void>((r) => {
				enter = r;
			}),
			blocked = new Promise<void>((r) => {
				release = r;
			});
		f.registry.mockImplementationOnce(async () => {
			enter();
			await blocked;
			return structuredClone(f.intent);
		});
		const controller = new AbortController(),
			rejected = expect(f.run(controller.signal)).rejects.toThrow();
		await ready;
		controller.abort();
		await rejected;
		await expect(f.run()).rejects.toThrow("OFFICE_RESUME_PENDING");
		expect(f.submit).not.toHaveBeenCalled();
		release();
		await new Promise((r) => setTimeout(r, 20));
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_configuration" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
});
