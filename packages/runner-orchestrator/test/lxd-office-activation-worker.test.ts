import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLxdOfficeActivationEvidence } from "../src/lxd-office-activation-evidence.ts";
import { officeActivationWorkerFixture } from "./fixtures/office-activation-worker.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const fixture = (configured = true) => officeActivationWorkerFixture(roots, configured);
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("provider activation after acknowledged configuration", () => {
	it.each(["missing", "changed", "mode", "owner"])(
		"refuses %s selected boot credentials while original credentials are intact",
		async (fault) => {
			const f = await fixture();

			const selected = [...f.guest.keys()].find(
				(path) => path.startsWith("/etc/qorpera-office/boots/") && path.endsWith("/native"),
			)!;
			expect(selected).toBeDefined();
			const original = Buffer.from(f.guest.get("/etc/qorpera-office/credentials/native")!.content);
			const file = f.guest.get(selected)!;
			if (fault === "missing") f.guest.delete(selected);
			if (fault === "changed") file.content = Buffer.from("changed");
			if (fault === "mode") file.mode = 0o644;
			if (fault === "owner") file.uid = 1000;
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_ACTIVATION_UNCONFIRMED");
			expect(f.guest.get("/etc/qorpera-office/credentials/native")!.content.equals(original)).toBe(true);
			expect(f.exec).not.toHaveBeenCalled();
			expect(f.registry).not.toHaveBeenCalled();
		},
	);

	it("reads acknowledged configuration as historical evidence without replaying its worker", async () => {
		const f = await fixture();
		const evidence = await readLxdOfficeActivationEvidence(f.root, f.request, f.binding, f.client, signal(), {
			readProtected: f.readProtected,
			readCredential: f.readCredential,
		});
		expect(evidence.configuration.files["config.json"].bytes).toBeGreaterThan(0);
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("starts once, freshly inspects, activates the exact invocation and recovers from a new provider", async () => {
		const f = await fixture();
		const originalPrep = f.preparation.exec.mock.calls.length,
			originalConfig = f.configuration.exec.mock.calls.length;
		const result = await f.worker.reconcile(f.request, signal());
		expect(result).toMatchObject({ state: "active", serviceInvocationId: "a".repeat(32) });
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledTimes(2);
		expect(f.transitions()).toBe(1);
		expect(f.preparation.exec).toHaveBeenCalledTimes(originalPrep);
		expect(f.configuration.exec).toHaveBeenCalledTimes(originalConfig);
		for (const bytes of f.credentialBuffers) expect(bytes.every((v) => v === 0)).toBe(true);
		for (const path of [
			f.names.seed,
			f.names.index,
			f.names.completion,
			...(await readdir(f.names.journal)).map((name) => join(f.names.journal, name)),
		]) {
			const text = await readFile(path, "utf8");
			for (const secret of Object.values(f.secrets)) expect(text).not.toContain(secret);
		}
	});
	it("requires existing configuration acknowledgement without invoking earlier phases", async () => {
		const f = await fixture(false);
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(/^OFFICE_ACTIVATION_UNCONFIRMED$/);
		expect(f.stage).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
		expect(f.configuration.exec).not.toHaveBeenCalled();
		expect(f.registry).not.toHaveBeenCalled();
	});
	it("recovers a lost start reply with original protected completion and a fresh read-only inspection", async () => {
		const f = await fixture(),
			original = f.exec.getMockImplementation()!;
		f.exec.mockImplementationOnce(async (...args) => {
			await original(...args);
			throw new Error("lost start reply");
		});
		const result = await f.worker.reconcile(f.request, signal());
		expect(result.state).toBe("active");
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.transitions()).toBe(1);
		expect(await readdir(f.names.journal)).toEqual(expect.arrayContaining(["authority.json", "000000.json"]));
		expect(await readdir(f.names.journal)).not.toContain("000001.json");
	});
	it("keeps unknown starts unresolved when protected completion is absent", async () => {
		const f = await fixture();
		f.exec.mockRejectedValue(new Error("unknown"));
		const result = await f.worker.reconcile(f.request, signal());
		expect(result.state).toBe("unknown");
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.inspect).not.toHaveBeenCalled();
		expect(f.transitions()).toBe(0);
	});
	it("recovers a lost committed SQL reply with the original activation and no preparation calls", async () => {
		const f = await fixture(),
			original = f.registry.getMockImplementation()!;
		let lost = false;
		f.registry.mockImplementation(async (...args) => {
			const result = await original(...args);
			if (args[0] === "qorpera_activate_runtime_office" && !lost) {
				lost = true;
				throw new Error("lost committed reply");
			}
			return result;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(/^OFFICE_ACTIVATION_UNCONFIRMED$/);
		expect(f.state()?.state).toBe("active");
		f.call.mockRejectedValue(new Error("preparation disabled"));
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "active" });
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.transitions()).toBe(1);
	});
	it("waits for actual SQL readiness and never repeats the ordinary service start", async () => {
		const f = await fixture(),
			original = f.exec.getMockImplementation()!;
		f.exec.mockImplementation(async (...args) => {
			const result = await original(...args);
			Object.assign(f.state()!, { readinessFresh: false });
			return result;
		});
		await expect(f.worker.reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_readiness" });
		expect(f.transitions()).toBe(0);
		Object.assign(f.state()!, { readinessFresh: true });
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "active" });
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each(["seed", "index", "journal"] as const)(
		"refuses lost acknowledged %s without another start",
		async (field) => {
			const f = await fixture();
			await f.worker.reconcile(f.request, signal());
			await rm(f.names[field], { recursive: true });
			await expect(f.create().reconcile(f.request, signal())).rejects.toThrow(/^OFFICE_ACTIVATION_UNCONFIRMED$/);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it.each(["source", "installed", "configuration evidence", "boot", "kernel", "SQL", "inspection"])(
		"refuses changed %s before first activation",
		async (fault) => {
			const f = await fixture(),
				original = f.exec.getMockImplementation()!;
			f.exec.mockImplementation(async (...args) => {
				const result = await original(...args);
				if (fault === "source") f.secrets.native = "x".repeat(43);
				if (fault === "installed") f.guest.get("/etc/qorpera-office/credentials/native")!.content.fill(0);
				if (fault === "configuration evidence")
					await writeFile(join(f.root, f.configuration.names.observation), "{}");
				if (fault === "boot")
					f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(
						"ffffffff-ffff-4fff-8fff-ffffffffffff\n",
					);
				if (fault === "kernel") f.kernelLock.mockRejectedValue(new Error("lock lost"));
				if (fault === "SQL") f.call.mockRejectedValue(new Error("revoked"));
				if (fault === "inspection") f.inspect.mockRejectedValue(new Error("unit changed"));
				return result;
			});
			await f.worker.reconcile(f.request, signal()).catch(() => {});
			expect(f.transitions()).toBe(0);
			expect(f.exec).toHaveBeenCalledOnce();
		},
	);
	it.each([true, false])("refuses a different ready invocation even when freshness is %s", async (readinessFresh) => {
		const f = await fixture(),
			original = f.exec.getMockImplementation()!;
		f.exec.mockImplementation(async (...args) => {
			const result = await original(...args);
			Object.assign(f.state()!, { serviceInvocationId: "b".repeat(32), readinessFresh });
			return result;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(/^OFFICE_ACTIVATION_UNCONFIRMED$/);
		expect(f.transitions()).toBe(0);
	});
	it("recovers active work without rereading the obsolete writer handoff or running earlier helpers", async () => {
		const f = await fixture();
		await f.worker.reconcile(f.request, signal());
		const read = f.readProtected.getMockImplementation()!;
		f.readProtected.mockImplementation(async (path) => {
			if (path !== f.request.serviceBootstrapPath) throw new Error("old writer handoff no longer applies");
			return read(path);
		});
		f.preparation.exec.mockRejectedValue(new Error("preparation cannot run on changed working files"));
		f.configuration.exec.mockRejectedValue(new Error("configuration cannot run on an active service"));
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "active" });
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it("checks the original monotonic inspection deadline after SQL status, even if timers have not fired", async () => {
		const f = await fixture(),
			original = f.registry.getMockImplementation()!;
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => elapsed);
		let statuses = 0;
		f.registry.mockImplementation(async (...args) => {
			const result = await original(...args);
			if (f.inspect.mock.calls.length && args[0] === "qorpera_runtime_office_activation_status") {
				statuses++;
				// Poll authorization, readback authorization, final authorization,
				// then the consumer's readiness-status read.
				if (statuses === 3) elapsed = 4800;
				if (statuses === 4) elapsed = 5000;
			}
			return result;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(/^OFFICE_ACTIVATION_UNCONFIRMED$/);
		expect(statuses).toBe(4);
		expect(f.transitions()).toBe(0);
	});
	it("retains stalled inspection IO after cancellation until it settles", async () => {
		const f = await fixture(),
			abort = new AbortController();
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const inspect = f.inspect.getMockImplementation()!;
		f.inspect.mockImplementationOnce(async (...args) => {
			enter();
			await pending;
			return inspect(...args);
		});
		const result = f.worker.reconcile(f.request, abort.signal);
		await entered;
		abort.abort();
		await expect(result).rejects.toThrow(/^OFFICE_ACTIVATION_RECONCILIATION_ABORTED$/);
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(
			/^OFFICE_ACTIVATION_RECONCILIATION_PENDING$/,
		);
		release();
		await vi.waitFor(
			async () => {
				await expect(f.worker.reconcile(f.request, signal())).resolves.toMatchObject({ state: "active" });
			},
			{ timeout: 10000, interval: 100 },
		);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.transitions()).toBe(1);
	});
});
