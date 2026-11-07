import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, parseCompanyComputerPreparationRequest } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { readRecord } from "../src/lxd-office-journal-files.ts";
import {
	type LxdOfficePreparationIdentity,
	LxdOfficePreparationJournal,
} from "../src/lxd-office-preparation-journal.ts";
import { officePreparationWorkerFixture } from "./fixtures/office-preparation-worker.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = (booted = true) => officePreparationWorkerFixture(roots, booted);

describe("preparation of an acknowledged first boot", () => {
	async function recoveredFixture() {
		const f = await fixture();
		f.poll.mockImplementation(async (reference) => {
			if (reference.operationId === id(20)) throw new Error("original operation expired");
			return "succeeded";
		});
		await f.worker.reconcile(f.request, signal());
		const original = await readFile(join(f.root, f.names.journal, "000001.json"));
		const { schema: _schema, ...identity } = JSON.parse(
			await readFile(join(f.root, f.names.journal, "authority.json"), "utf8"),
		) as LxdOfficePreparationIdentity & { schema: string };
		const review = {
			schema: "qorpera.lxd-office-preparation-recovery/v1",
			recoveryId: id(50),
			identitySha256: officeDigest(identity),
			originalOperationId: id(20),
			acceptedSha256: createHash("sha256").update(original).digest("hex"),
		};
		const recoveryRoot = join(f.root, `preparation-recovery-${f.binding.allocationId}-${review.recoveryId}`);
		await mkdir(recoveryRoot, { mode: 0o700 });
		const previous = f.exec.getMockImplementation()!;
		f.exec.mockImplementation(async (...args) => ({ ...(await previous(...args)), operationId: id(21) }));
		const recovery = await LxdOfficePreparationJournal.open(recoveryRoot, identity, f.client, false);
		await recovery.reconcile(signal());
		const read = f.readProtected.getMockImplementation()!;
		f.readProtected.mockImplementation(async (path) =>
			path === `${f.request.reviewPath}.preparation-recovery` ? encode(review) : read(path),
		);
		return { ...f, review, recoveryRoot, original };
	}
	it("consumes an explicitly reviewed settled recovery while retaining the unknown original attempt", async () => {
		const f = await recoveredFixture();
		const result = await f.create().reconcile(f.request, signal());
		expect(result).toMatchObject({ state: "awaiting_activation", operationId: id(21) });
		expect(await readFile(join(f.root, f.names.journal, "000001.json"))).toEqual(f.original);
		expect(await readdir(join(f.root, f.names.journal))).not.toContain("000002.json");
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledTimes(2);
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it.each(["identity", "original", "prefix", "pending", "missing-journal", "guest-report", "revoked"])(
		"refuses unconfirmed recovery: %s",
		async (fault) => {
			const f = await recoveredFixture();
			if (fault === "identity") f.review.identitySha256 = "0".repeat(64);
			if (fault === "original") f.review.originalOperationId = id(21);
			if (fault === "prefix") f.review.acceptedSha256 = "0".repeat(64);
			if (fault === "pending") {
				await unlink(join(f.recoveryRoot, f.names.journal, "000002.json"));
				f.poll.mockResolvedValue("pending");
			}
			if (fault === "missing-journal") await rm(f.recoveryRoot, { recursive: true });
			if (fault === "guest-report") f.guest.delete("/run/qorpera-office-preparation/completion.json");
			if (fault === "revoked") f.call.mockRejectedValue(new Error("revoked"));
			await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
			expect(f.exec).toHaveBeenCalledTimes(2);
			expect(await readdir(f.root)).not.toContain(f.names.completion);
		},
	);
	it("binds fixed guest settings and one command to retained evidence, and resumes after process replacement", async () => {
		const f = await fixture();
		const result = await f.worker.reconcile(f.request, signal());
		expect(result).toMatchObject({
			state: "awaiting_activation",
			bootId: id(4),
			operationId: id(20),
			allocationId: f.binding.allocationId,
		});
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.readStage).toHaveBeenCalledOnce();
		const request = parseCompanyComputerPreparationRequest(JSON.parse(f.staged()!.toString()));
		expect(request.workbenchMount).toEqual({
			filesystem: "virtiofs",
			source: "lxd_workbench",
			root: "/",
			mountPoint: "/var/lib/qorpera-office",
		});
		expect(request.limits).toEqual({ memoryBytes: 4 * 1024 ** 3, pids: 4096, cpuQuota: 200000, cpuPeriod: 100000 });
		expect(request.uid).toBe(f.policy.workbench.uid);
		expect(request.gid).toBe(f.policy.workbench.gid);
		expect(request.copy.adoptionId).toBe(f.copy.adoptionId);
		expect((await readRecord(join(f.root, f.names.request), 16 * 1024 ** 2)).bytes).toEqual(f.staged());
		const evidence = (await readRecord(join(f.root, f.names.observation), 65536)).value;
		if (!("observationSha256" in result)) throw new Error("missing observation");
		expect(officeDigest(evidence)).toBe(result.observationSha256);
		await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.push).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
		expect(f.call.mock.calls.every(([method]) => method === "qorpera_check_runtime_office_adoption")).toBe(true);
	});
	it("cannot initiate a boot when its acknowledged completion is absent", async () => {
		const f = await fixture(false);
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.submit).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
		expect(f.stage).not.toHaveBeenCalled();
	});
	it("resumes a pending operation without staging or dispatching again", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("pending");
		const first = await f.worker.reconcile(f.request, signal());
		expect(first.state).toBe("pending");
		expect(await readdir(f.root)).not.toContain(f.names.completion);
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({
			state: "awaiting_activation",
			commandId: first.commandId,
		});
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it.each(["lost-reply", "failed", "missing-operation"])(
		"retains %s without manufacturing readiness or retrying",
		async (kind) => {
			const f = await fixture();
			if (kind === "lost-reply") {
				const original = f.exec.getMockImplementation()!;
				f.exec.mockImplementation(async (...args) => {
					await original(...args);
					throw new Error("lost accepted reply");
				});
			} else if (kind === "failed") f.poll.mockResolvedValue("failed");
			else f.poll.mockRejectedValue(new Error("operation missing"));
			const result = await f.worker.reconcile(f.request, signal());
			expect(result.state).toBe(kind === "failed" ? "failed" : "unknown");
			await expect(f.create().reconcile(f.request, signal())).resolves.toEqual(result);
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.stage).toHaveBeenCalledOnce();
			expect(await readdir(f.root)).not.toContain(f.names.completion);
		},
	);
	it.each(["lock", "physical", "host", "cloud", "review", "maintenance", "boot", "copy"])(
		"requires current %s evidence before staging",
		async (kind) => {
			const f = await fixture();
			if (kind === "lock") f.kernelLock.mockRejectedValue(new Error("lock lost"));
			if (kind === "physical") f.check.mockRejectedValue(new Error("physical lost"));
			if (kind === "host") f.check.mockResolvedValue({ signal: signal(), validForMs: 5000, hostBootId: id(90) });
			if (kind === "cloud") f.call.mockRejectedValue(new Error("grant revoked"));
			if (kind === "review" || kind === "maintenance")
				f.readProtected.mockRejectedValue(new Error("protected evidence lost"));
			if (kind === "boot") f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(`${id(90)}\n`);
			if (kind === "copy") await unlink(join(f.root, f.files.copy));
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
			expect(f.exec).not.toHaveBeenCalled();
			expect(f.stage).not.toHaveBeenCalled();
		},
	);
	it.each(["uid", "gid", "mode", "content", "missing"])("requires the existing guest lock: %s", async (kind) => {
		const f = await fixture();
		const path = "/run/qorpera-office-preparation/control.lock";
		const lock = f.guest.get(path)!;
		if (kind === "missing") f.guest.delete(path);
		else if (kind === "content") lock.content = Buffer.from("x");
		else lock[kind as "uid" | "gid" | "mode"] = 1;
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.stage).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
	});
	it.each(["uid", "gid", "mode", "content"])("refuses changed staging readback before dispatch: %s", async (kind) => {
		const f = await fixture();
		const original = f.readStage.getMockImplementation()!;
		f.readStage.mockImplementation(async (...args) => {
			const file = await original(...args);
			if (kind === "content") file.content = Buffer.from("{}");
			else file[kind as "uid" | "gid" | "mode"] = 1;
			return file;
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("OFFICE_PREPARATION_STAGING_UNCONFIRMED");
		expect(f.exec).not.toHaveBeenCalled();
	});
	it("does not recreate a missing index from a dispatched journal without a completion", async () => {
		const f = await fixture();
		f.poll.mockResolvedValue("pending");
		await f.worker.reconcile(f.request, signal());
		await unlink(join(f.root, f.names.index));
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow("OFFICE_PREPARATION_IDENTITY_MISSING");
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
		await expect(readFile(join(f.root, f.names.index))).rejects.toThrow();
	});
	it("reuses an undispatched durable identity after a staging failure", async () => {
		const f = await fixture();
		f.stage.mockRejectedValueOnce(new Error("staging interrupted"));
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow("staging interrupted");
		const index = (await readRecord(join(f.root, f.names.index))).value;
		// Crash before the index was published is recoverable only with an intact,
		// undispatched authority. Simulate losing that last local publication.
		await unlink(join(f.root, f.names.index));
		await expect(f.create().reconcile(f.request, signal())).resolves.toMatchObject({ state: "awaiting_activation" });
		expect((await readRecord(join(f.root, f.names.index))).value).toEqual(index);
		expect(f.exec).toHaveBeenCalledOnce();
	});
	it.each(["index", "request", "journal", "authority", "observation"])(
		"does not rebuild lost acknowledged %s",
		async (kind) => {
			const f = await fixture();
			await f.worker.reconcile(f.request, signal());
			const path = join(
				f.root,
				kind === "authority" ? join(f.names.journal, "authority.json") : f.names[kind as keyof typeof f.names],
			);
			await rm(path, { recursive: true });
			await expect(f.create().reconcile(f.request, signal())).rejects.toThrow();
			expect(f.exec).toHaveBeenCalledOnce();
			expect(f.stage).toHaveBeenCalledOnce();
			await expect(readFile(path)).rejects.toThrow();
		},
	);
	it.each([
		"command",
		"invocation",
		"report-hash",
		"report",
		"boot",
		"copy",
		"uid",
		"gid",
		"mode",
		"missing",
		"invalid-json",
	])("refuses mismatched or unprotected guest completion: %s", async (kind) => {
		const f = await fixture();
		f.poll.mockImplementation(async () => {
			const path = "/run/qorpera-office-preparation/completion.json";
			const file = f.guest.get(path)!;
			const value = JSON.parse(file.content.toString());
			if (kind === "command") value.command.commandId = id(99);
			if (kind === "invocation") value.invocationId = "c".repeat(32);
			if (kind === "report-hash") value.reportSha256 = "d".repeat(64);
			if (kind === "report")
				f.guest.get("/run/qorpera-office-preparation/result.json")!.content = encode({
					...value.report,
					entries: 99,
				});
			if (kind === "boot") value.report.bootId = id(99);
			if (kind === "copy") value.report.copy.planSha256 = "d".repeat(64);
			if (kind === "uid" || kind === "gid" || kind === "mode") file[kind] = 1;
			file.content = kind === "invalid-json" ? Buffer.from("{") : encode(value);
			if (kind === "missing") f.guest.delete(path);
			return "succeeded";
		});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.exec).toHaveBeenCalledOnce();
		expect(await readdir(f.root)).not.toContain(f.names.completion);
	});
	it.each(["revoked", "reboot", "report-changed"])(
		"rechecks authority and report before publishing: %s",
		async (kind) => {
			const f = await fixture();
			const original = f.file.getMockImplementation()!;
			let reads = 0;
			f.file.mockImplementation(async (...args) => {
				const value = await original(...args);
				if (args[2].endsWith("/result.json") && ++reads === 1) {
					if (kind === "revoked") f.call.mockRejectedValue(new Error("revoked after report"));
					if (kind === "reboot")
						f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(`${id(99)}\n`);
					if (kind === "report-changed")
						f.guest.get(args[2])!.content = Buffer.concat([value.content, Buffer.from(" ")]);
				}
				return value;
			});
			await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
			expect(await readdir(f.root)).not.toContain(f.names.completion);
		},
	);
	it.each([
		"missing",
		"uid",
		"gid",
		"mode",
		"different-layout",
		"different-inventory",
		"hash",
		"old-completion",
		"changed-between-reads",
	])("requires independent protected receipt readback: %s", async (kind) => {
		const f = await fixture();
		const original = f.file.getMockImplementation()!;
		let reads = 0;
		f.file.mockImplementation(async (...args) => {
			if (args[2] === COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH && reads++ === 0) {
				const file = f.guest.get(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH)!;
				if (kind === "missing") f.guest.delete(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH);
				if (["uid", "gid", "mode"].includes(kind)) file[kind as "uid" | "gid" | "mode"] = 1;
				if (kind === "different-layout" || kind === "different-inventory") {
					const receipt = JSON.parse(file.content.toString());
					if (kind === "different-layout") receipt.layout.workbenchRoot += "-other";
					else receipt.inventorySha256 = "c".repeat(64);
					file.content = encode(receipt);
				}
			}
			const value = await original(...args);
			if (args[2] === COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH && kind === "changed-between-reads")
				f.guest.get(args[2])!.content = Buffer.from("{}");
			return value;
		});
		if (kind === "hash" || kind === "old-completion")
			f.poll.mockImplementation(async () => {
				const file = f.guest.get("/run/qorpera-office-preparation/completion.json")!;
				const completion = JSON.parse(file.content.toString());
				if (kind === "hash") completion.adoptionReceiptSha256 = "c".repeat(64);
				else {
					completion.schema = "qorpera.office-preparation-completion/v1";
					delete completion.adoptionReceiptSha256;
				}
				file.content = encode(completion);
				return "succeeded";
			});
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow();
		expect(f.exec).toHaveBeenCalledOnce();
		expect(await readdir(f.root)).not.toContain(f.names.completion);
	});
	it("refuses a changed retained request after a pending operation", async () => {
		const f = await fixture();
		f.poll.mockResolvedValueOnce("pending");
		await f.worker.reconcile(f.request, signal());
		await writeFile(join(f.root, f.names.request), Buffer.concat([f.staged()!, Buffer.from(" ")]));
		await expect(f.create().reconcile(f.request, signal())).rejects.toThrow("OFFICE_PREPARATION_IDENTITY_CHANGED");
		expect(f.exec).toHaveBeenCalledOnce();
		expect(f.stage).toHaveBeenCalledOnce();
	});
	it("keeps its busy state until cancelled underlying IO settles", async () => {
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
		await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce(), { timeout: 10000 });
		caller.abort();
		await expect(running).rejects.toThrow("OFFICE_PREPARATION_RECONCILIATION_ABORTED");
		await expect(f.worker.reconcile(f.request, signal())).rejects.toThrow(
			"OFFICE_PREPARATION_RECONCILIATION_PENDING",
		);
		expect(f.exec).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(
			async () =>
				expect(await f.worker.reconcile(f.request, signal())).toMatchObject({ state: "awaiting_activation" }),
			{ timeout: 10000 },
		);
		expect(f.exec).toHaveBeenCalledOnce();
	});
});
