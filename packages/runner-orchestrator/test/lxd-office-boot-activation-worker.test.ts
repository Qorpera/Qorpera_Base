import { readFile, rm, writeFile } from "node:fs/promises";
import { companyComputerBootDirectory } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeBootActivationWorkerFixture } from "./fixtures/office-boot-activation-worker.ts";
import { serviceStartId as id } from "./fixtures/office-service-start.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => officeBootActivationWorkerFixture(roots);
describe("provider retained-boot activation", () => {
	it("admits and activates one invocation, then recovers without VM or configuration replay", async () => {
		const f = await fixture();
		f.configuration.registry.mockClear();
		const result = await f.run();
		expect(result).toMatchObject({ state: "active", activationId: id(102), bootId: id(103) });
		expect(await f.run()).toEqual(result);
		expect(f.state.preparations).toBe(1);
		expect(f.state.activations).toBe(1);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.configuration.exec).toHaveBeenCalledOnce();
		expect(f.configuration.resume.submit).toHaveBeenCalledOnce();
		expect(f.configuration.registry).not.toHaveBeenCalled();
		expect(f.inspect).toHaveBeenCalledTimes(2);
		await expect(f.configuration.run()).rejects.toThrow("BOOT_CONFIGURATION_UNCONFIRMED");
	});
	it.each([
		"qorpera_prepare_runtime_office_boot_successor",
		"qorpera_activate_runtime_office_boot_successor",
	] as const)("recovers lost committed %s reply", async (method) => {
		const f = await fixture(),
			call = f.registry.getMockImplementation()!;
		let lost = false;
		f.registry.mockImplementation(async (...args) => {
			const value = await call(...args);
			if (args[0] === method && !lost) {
				lost = true;
				throw new Error("lost commit reply");
			}
			return value;
		});
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		expect(lost).toBe(true);
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(f.state.preparations).toBe(1);
		expect(f.state.activations).toBe(1);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("confirms an already active invocation after preparation is disabled and readiness expires", async () => {
		const f = await fixture();
		const result = await f.run();
		f.state.enabled = false;
		f.state.current = { ...f.state.current!, readinessFresh: false };
		await expect(f.run()).resolves.toEqual(result);
		expect(f.inspect).toHaveBeenCalledTimes(2);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.state.activations).toBe(1);
	});
	it.each([true, false])("never repeats an unknown root start (physical %s)", async (physical) => {
		const f = await fixture(),
			exec = f.exec.getMockImplementation()!;
		f.state.physical = physical;
		f.exec.mockImplementationOnce(async (...args) => {
			await exec(...args);
			throw new Error("lost start reply");
		});
		await expect(f.run()).resolves.toMatchObject({ state: physical ? "active" : "unknown" });
		await expect(f.run()).resolves.toMatchObject({ state: physical ? "active" : "unknown" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it("waits for real matching readiness without repeating start", async () => {
		const f = await fixture();
		f.state.ready = false;
		await expect(f.run()).resolves.toMatchObject({ state: "awaiting_readiness" });
		expect(f.state.activations).toBe(0);
		f.state.current = {
			...f.state.current!,
			state: "ready",
			readinessFresh: true,
			serviceInvocationId: "c".repeat(32),
		};
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each(["seed", "prepared", "packet", "index", "journal"] as const)(
		"refuses a missing acknowledged %s",
		async (key) => {
			const f = await fixture();
			await f.run();
			await rm(f.paths[key], { recursive: true });
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it.each(["sql", "host", "boot", "configuration", "receipt", "history", "index"])(
		"rechecks %s after staging",
		async (kind) => {
			const f = await fixture(),
				stage = f.stage.getMockImplementation()!;
			f.stage.mockImplementation(async (...args) => {
				await stage(...args);
				if (kind === "sql") f.state.enabled = false;
				if (kind === "host")
					f.check.mockImplementation(async () => ({ hostBootId: id(129), signal: signal(), validForMs: 5000 }));
				if (kind === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(id(129));
				if (kind === "configuration") f.guest.delete(`${companyComputerBootDirectory(id(103))}/credentials/native`);
				if (kind === "receipt") f.guest.delete(`${companyComputerBootDirectory(id(103))}/adoption.json`);
				if (kind === "history") await writeFile(f.configuration.resume.powerOff.paths.done, "{}");
				if (kind === "index") await writeFile(f.paths.index, "{}");
			});
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).not.toHaveBeenCalled();
		},
	);
	it.each(["invocation", "pid", "custody", "configuration-claim", "completion"])(
		"refuses changed %s on active recovery",
		async (kind) => {
			const f = await fixture();
			await f.run();
			const file = f.guest.get(f.completionPath)!;
			if (kind === "completion") f.guest.delete(f.completionPath);
			if (kind === "custody") file.mode = 0o644;
			if (kind === "configuration-claim")
				f.guest.delete(`${companyComputerBootDirectory(id(103))}/configuration-claim.json`);
			if (kind === "invocation" || kind === "pid") {
				const value = JSON.parse(file.content.toString());
				if (kind === "invocation") value.serviceInvocationId = "d".repeat(32);
				else value.mainPid++;
				file.content = Buffer.from(JSON.stringify(value));
			}
			await expect(f.run()).rejects.toThrow("UNCONFIRMED");
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.state.activations).toBe(1);
		},
	);
	it("retains one command through interrupted staging before dispatch", async () => {
		const f = await fixture();
		f.readStage.mockRejectedValueOnce(new Error("lost stage"));
		await expect(f.run()).rejects.toThrow("UNCONFIRMED");
		const packet = await readFile(f.paths.packet);
		await expect(f.run()).resolves.toMatchObject({ state: "active" });
		expect(await readFile(f.paths.packet)).toEqual(packet);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("holds cancellation across replacement workers until pending SQL settles", async () => {
		const f = await fixture(),
			call = f.registry.getMockImplementation()!,
			abort = new AbortController();
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>((r) => {
				enter = r;
			}),
			pending = new Promise<void>((r) => {
				release = r;
			});
		f.registry.mockImplementationOnce(async (...args) => {
			enter();
			await pending;
			return call(...args);
		});
		const result = f.run(abort.signal);
		await entered;
		abort.abort();
		await expect(result).rejects.toThrow("ABORTED");
		await expect(f.run()).rejects.toThrow("PENDING");
		release();
		await vi.waitFor(
			async () => {
				await expect(f.run()).resolves.toMatchObject({ state: "active" });
			},
			{ timeout: 10000 },
		);
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
