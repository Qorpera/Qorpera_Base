import { readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import { readRecord } from "../src/lxd-office-journal-files.ts";
import { officeBootWorkerFixture } from "./fixtures/office-boot-worker.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = () => officeBootWorkerFixture(roots);

describe("restricted first office boot", () => {
	it("refuses first power-on when node health or capacity is unavailable", async () => {
		const f = await fixture(),
			call = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args) => {
			if (method === "qorpera_reserve_runtime_node_machine") throw new Error("node admission refused");
			return call(method, args);
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
		f.call.mockImplementation(call);
		await expect(f.worker.reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_preparation" });
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("requires retained reviewed copy and fresh authority, journals one start and binds actual boot readback", async () => {
		const f = await fixture();
		const result = await f.worker.reconcile(f.request, signal());
		if (result.state !== "awaiting_preparation") throw new Error("Expected completed first boot");
		expect(result).toMatchObject({
			state: "awaiting_preparation",
			allocationId: f.binding.allocationId,
			bootId: id(4),
			copySha256: officeDigest(f.copy),
		});
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.submit.mock.calls[0][1].action).toBe("start");
		expect(
			f.call.mock.calls.every(([method]) =>
				["qorpera_check_runtime_office_adoption", "qorpera_reserve_runtime_node_machine"].includes(method),
			),
		).toBe(true);
		expect(f.file).toHaveBeenCalledTimes(4);
		expect(f.execute).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
		const evidence = (await readRecord(join(f.root, f.files.boot))).value;
		expect(evidence).toMatchObject({
			schema: "qorpera.lxd-office-first-boot-observation/v1",
			bootId: id(4),
			startCommandId: result.startCommandId,
		});
		expect(officeDigest(evidence)).toBe(result.bootObservationSha256);
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("resumes the accepted operation after process replacement without a second start", async () => {
		const f = await fixture();
		f.inspect.mockResolvedValueOnce("pending");
		const first = await f.worker.reconcile(f.request, signal());
		expect(first.state).toBe("pending");
		expect(await readdir(f.root)).not.toContain(f.files.boot);
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({
			state: "awaiting_preparation",
			startCommandId: first.startCommandId,
		});
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("retains an unknown submission even when the VM is reported running", async () => {
		const f = await fixture();
		f.submit.mockRejectedValue(new Error("reply lost after acceptance"));
		const first = await f.worker.reconcile(f.request, signal());
		expect(first.state).toBe("unknown");
		f.get.mockResolvedValue({ ...f.instance, status: "Running", statusCode: 103 });
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(first);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.file).not.toHaveBeenCalled();
	});
	it.each(["failed", "unavailable"])("keeps %s operations from becoming readiness or a new command", async (kind) => {
		const f = await fixture();
		if (kind === "failed") f.inspect.mockResolvedValue("failed");
		else f.inspect.mockRejectedValue(new Error("operation missing"));
		const first = await f.worker.reconcile(f.request, signal());
		expect(first.state).toBe(kind === "failed" ? "failed" : "unknown");
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(first);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.file).not.toHaveBeenCalled();
	});
	it.each(["lock", "physical", "host", "cloud", "maintenance", "review"])(
		"refuses absent or changed %s authority before any start",
		async (kind) => {
			const f = await fixture();
			if (kind === "lock") f.kernelLock.mockRejectedValue(new Error("lock refused"));
			if (kind === "physical") f.check.mockRejectedValue(new Error("physical refused"));
			if (kind === "host") f.check.mockResolvedValue({ signal: signal(), validForMs: 5000, hostBootId: id(90) });
			if (kind === "cloud") f.call.mockRejectedValue(new Error("grant revoked"));
			if (kind === "maintenance" || kind === "review")
				f.readProtected.mockImplementation(async (path) => {
					if (path === (kind === "maintenance" ? f.request.writerFencePath : f.request.reviewPath))
						throw new Error("protected evidence refused");
					return path === f.request.reviewPath ? f.reviewBytes : f.handoffBytes;
				});
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(/refused|HOST_CHANGED|grant revoked/);
			expect(f.submit).not.toHaveBeenCalled();
			expect(f.file).not.toHaveBeenCalled();
		},
	);
	it.each(["observation", "authority", "copy"] as const)("does not reconstruct lost %s evidence", async (kind) => {
		const f = await fixture();
		await unlink(join(f.root, f.files[kind]));
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("rejects a changed copy receipt or changed reviewed plan", async () => {
		const f = await fixture();
		await writeFile(join(f.root, f.files.copy), officeCanonical({ ...f.copy, reviewSha256: "0".repeat(64) }));
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_BOOT_COPY_MISMATCH");
		expect(f.submit).not.toHaveBeenCalled();
	});
	it.each(["running", "configuration"])("refuses an unrecorded %s VM before dispatch", async (kind) => {
		const f = await fixture();
		f.get.mockResolvedValue(
			kind === "running"
				? { ...f.instance, status: "Running", statusCode: 103 }
				: {
						...f.instance,
						expandedDevices: {
							...f.instance.expandedDevices,
							secret: { type: "disk", path: "/secret", source: "/secret" },
						},
					},
		);
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
	});
	it("does not recreate a lost first-boot identity after dispatch", async () => {
		const f = await fixture();
		await f.worker.reconcile(f.request, signal());
		await unlink(join(f.root, f.files.bootIntent));
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow("OFFICE_INITIAL_CREATION_UNCONFIRMED");
		expect(await readdir(f.root)).not.toContain(f.files.bootIntent);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it.each(["stop", "delete", "start"] as const)(
		"rejects a later %s command, even if its outcome is unknown",
		async (action) => {
			const f = await fixture();
			await f.worker.reconcile(f.request, signal());
			f.submit.mockRejectedValue(new Error("unknown later operation"));
			await f.journal.reconcile(id(99), action, signal());
			f.submit.mockClear();
			await expect(f.create().reconcile(f.request, signal())).rejects.toThrow(
				"OFFICE_INITIAL_BOOT_SEQUENCE_UNCONFIRMED",
			);
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it("refuses readiness after requester revocation while retaining the accepted start", async () => {
		const f = await fixture();
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args) => {
			if (f.running()) throw new Error("grant revoked after start");
			return original(method, args);
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("grant revoked after start");
		expect(f.submit).toHaveBeenCalledOnce();
		expect(await readdir(f.root)).not.toContain(f.files.boot);
	});
	it("does not replace the retained guest boot after a reboot", async () => {
		const f = await fixture();
		await f.worker.reconcile(f.request, signal());
		const before = await readFile(join(f.root, f.files.boot));
		f.file.mockResolvedValue({ content: Buffer.from(`${id(91)}\n`), uid: 0, gid: 0, mode: 0o444 });
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow("OFFICE_GUEST_BOOT_CHANGED");
		expect(await readFile(join(f.root, f.files.boot))).toEqual(before);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("refuses a reboot between separately renewed physical observations", async () => {
		const f = await fixture();
		f.file
			.mockResolvedValueOnce({ content: Buffer.from(`${id(4)}\n`), uid: 0, gid: 0, mode: 0o444 })
			.mockResolvedValueOnce({ content: Buffer.from(`${id(4)}\n`), uid: 0, gid: 0, mode: 0o444 })
			.mockResolvedValue({ content: Buffer.from(`${id(91)}\n`), uid: 0, gid: 0, mode: 0o444 });
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_GUEST_BOOT_CHANGED");
		expect(await readdir(f.root)).not.toContain(f.files.boot);
	});
	it("does not recreate a lost acknowledged boot observation", async () => {
		const f = await fixture();
		await f.worker.reconcile(f.request, signal());
		await unlink(join(f.root, f.files.boot));
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
		expect(await readdir(f.root)).not.toContain(f.files.boot);
		expect(f.submit).toHaveBeenCalledOnce();
	});
	it("retains pending underlying IO after caller cancellation", async () => {
		const f = await fixture();
		let finish!: () => void;
		f.check.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { signal: signal(), validForMs: 5000, hostBootId: id(5) };
		});
		const caller = new AbortController();
		const running = f.worker.reconcile(f.request, caller.signal);
		await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
		caller.abort();
		await expect(running).rejects.toThrow("OFFICE_BOOT_RECONCILIATION_ABORTED");
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_BOOT_RECONCILIATION_PENDING");
		expect(f.submit).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(async () => {
			expect(await f.worker.reconcile(f.request, signal())).toMatchObject({ state: "awaiting_preparation" });
		});
		expect(f.submit).toHaveBeenCalledOnce();
	});
});
