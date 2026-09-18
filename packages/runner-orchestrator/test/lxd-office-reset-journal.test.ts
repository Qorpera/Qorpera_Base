import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompanyComputerLifecycleRequest, CompanyComputerResetPlan } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import {
	LxdOfficeResetJournal,
	parseLxdOfficeResetSeed,
	readLxdOfficeResetPlan,
} from "../src/lxd-office-reset-journal.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(64);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const predecessor = (): CompanyComputerLifecycleRequest => ({
	schema: "qorpera.office-lifecycle-request/v1",
	transitionId: id(2),
	action: "replace",
	activationId: id(3),
	providerId: id(12),
	providerPolicySha256: sha("f"),
	startup: {
		scope: { companyId: id(6), environmentId: id(7), companyComputerId: id(8), logicalComputerId: id(9) },
		computerGeneration: 1,
		allocationId: id(10),
		instanceSha256: sha("a"),
		imageSha256: sha("b"),
		bootstrapSha256: sha("c"),
		bootId: id(11),
		configurationSha256: sha("d"),
		serviceInvocationId: "e".repeat(32),
	},
});
const plan = (): CompanyComputerResetPlan => ({
	schema: "qorpera.lxd-office-reset-plan/v1",
	resetId: id(1),
	intentId: id(13),
	predecessor: predecessor(),
	preparationObservationSha256: sha("1"),
	providerBindingSha256: sha("2"),
	nodeId: null,
	predecessorRootIncarnationId: null,
	rootIncarnationId: id(5),
	successorActivationId: id(4),
	commands: { stopCommandId: id(20), deleteCommandId: id(21), createCommandId: id(22), startCommandId: id(23) },
	custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
});
async function root() {
	const path = await realpath(await mkdtemp(join(tmpdir(), "office-reset-journal-")));
	roots.push(path);
	await chmod(path, 0o700);
	return path;
}

describe("office reset phase journal", () => {
	it("appends hash-chained phases forward only and reopens the identical chain", async () => {
		const dir = await root();
		const journal = await LxdOfficeResetJournal.open(dir, plan());
		expect(journal.phase).toBe(null);
		const first = await journal.advance("fenced", sha("1"));
		expect(first).toMatchObject({ sequence: 1, phase: "fenced", previousSha256: null, evidenceSha256: sha("1") });
		await expect(journal.advance("fenced", sha("1"))).resolves.toEqual(first);
		await expect(journal.advance("fenced", sha("2"))).rejects.toThrow("OFFICE_RESET_JOURNAL_CHANGED");
		await expect(journal.advance("custodied", sha("3"))).rejects.toThrow("OFFICE_RESET_JOURNAL_ORDER");
		await expect(journal.advance("active", sha("3"))).rejects.toThrow("OFFICE_RESET_JOURNAL_ORDER");
		const second = await journal.advance("stopped", sha("2"));
		expect(second.previousSha256).toBe(officeDigest(first));
		await expect(journal.advance("fenced", sha("1"))).rejects.toThrow("OFFICE_RESET_JOURNAL_CHANGED");
		expect(journal.phase).toBe("stopped");
		expect(journal.evidenceSha256("stopped")).toBe(sha("2"));
		expect(journal.evidenceSha256("custodied")).toBeUndefined();
		const reopened = await LxdOfficeResetJournal.open(dir, plan());
		expect(reopened.records).toEqual([first, second]);
		expect(reopened.phase).toBe("stopped");
	});
	it("refuses gaps, altered records and a different plan without repairing anything", async () => {
		const dir = await root();
		const journal = await LxdOfficeResetJournal.open(dir, plan());
		for (const [index, phase] of (["fenced", "stopped", "custodied"] as const).entries())
			await journal.advance(phase, sha(String(index + 1)));
		const name = (n: number) => join(dir, `reset-phase-${id(10)}-${id(1)}-${n}.json`);
		const original = await readFile(name(2));
		await unlink(name(2));
		await expect(LxdOfficeResetJournal.open(dir, plan())).rejects.toThrow("OFFICE_RESET_JOURNAL_GAP");
		await writeFile(name(2), original.toString().replace(sha("2"), sha("9")), { mode: 0o600 });
		await expect(LxdOfficeResetJournal.open(dir, plan())).rejects.toThrow("OFFICE_RESET_JOURNAL_CHANGED");
		const third = JSON.parse((await readFile(name(3))).toString());
		await writeFile(name(2), JSON.stringify({ ...third, sequence: 2, phase: "stopped" }), { mode: 0o600 });
		await expect(LxdOfficeResetJournal.open(dir, plan())).rejects.toThrow(
			/OFFICE_RESET_JOURNAL_CHANGED|INVALID_OFFICE_RESET_PHASE_RECORD/,
		);
		await writeFile(name(2), original, { mode: 0o600 });
		await expect(LxdOfficeResetJournal.open(dir, plan())).resolves.toMatchObject({ phase: "custodied" });
		const other = await LxdOfficeResetJournal.open(dir, { ...plan(), resetId: id(99) });
		expect(other.phase).toBe(null);
		await expect(LxdOfficeResetJournal.open(dir, { ...plan(), schema: "x" } as never)).rejects.toThrow(
			"INVALID_OFFICE_RESET_PLAN",
		);
		await chmod(dir, 0o750);
		await expect(LxdOfficeResetJournal.open(dir, plan())).rejects.toThrow("LXD_OFFICE_JOURNAL_DIRECTORY_UNSAFE");
	});
});

describe("protected reset plan reader", () => {
	it("reads only the retained replace request's plan and treats absence as no permission", async () => {
		const files = new Map<string, unknown>();
		const readProtected = vi.fn(async (path: string) => {
			if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return Buffer.from(JSON.stringify(files.get(path)));
		});
		const path = "/protected/lifecycle.json";
		await expect(readLxdOfficeResetPlan(readProtected, path, predecessor())).resolves.toBeUndefined();
		expect(readProtected).toHaveBeenCalledWith(`${path}.reset`, 65536);
		files.set(`${path}.reset`, plan());
		const read = await readLxdOfficeResetPlan(readProtected, path, predecessor());
		expect(read?.plan).toEqual(plan());
		expect(read?.planSha256).toBe(officeDigest(plan()));
		await expect(
			readLxdOfficeResetPlan(readProtected, path, { ...predecessor(), transitionId: id(50) }),
		).rejects.toThrow("OFFICE_RESET_PLAN_PREDECESSOR_DIFFERS");
		files.set(`${path}.reset`, { ...plan(), predecessor: { ...predecessor(), action: "reboot" } });
		await expect(readLxdOfficeResetPlan(readProtected, path, predecessor())).rejects.toThrow(
			"INVALID_OFFICE_RESET_PLAN",
		);
		const failing = vi.fn(async () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		});
		await expect(readLxdOfficeResetPlan(failing, path, predecessor())).rejects.toThrow("denied");
	});
});

describe("reset seed record", () => {
	const seed = () => ({
		schema: "qorpera.lxd-office-reset-seed/v1",
		intentId: id(13),
		planSha256: sha("1"),
		hostBootId: id(30),
		attestation: {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: id(3),
			bootId: id(11),
			preparationObservationSha256: sha("1"),
			configurationObservationSha256: sha("a"),
			configurationSha256: sha("b"),
			adoptionReceiptSha256: sha("5"),
			nativePort: 9443,
			viewerPort: 9444,
		},
		completionPath: "/run/qorpera-office-preparation/service-stop-completion.json",
		stopCompletionSha256: sha("2"),
		startObservationSha256: sha("3"),
		bootObservationSha256: sha("4"),
		originalBootId: id(11),
		adoptionReceiptSha256: sha("5"),
		commands: [
			{ commandId: id(40), action: "create" },
			{ commandId: id(41), action: "start" },
		],
	});
	it("accepts a complete seed and rejects any other shape", () => {
		expect(parseLxdOfficeResetSeed(seed()).originalBootId).toBe(id(11));
		expect(
			parseLxdOfficeResetSeed({
				...seed(),
				completionPath: `/run/qorpera-office-preparation/service-stop-completion-${id(3)}.json`,
			}).completionPath,
		).toContain(id(3));
		for (const change of [
			{ extra: 1 },
			{ schema: "qorpera.lxd-office-reset-seed/v2" },
			{ intentId: "x" },
			{ planSha256: "1" },
			{ completionPath: "/tmp/completion.json" },
			{ commands: [{ commandId: id(40), action: "create" }] },
			{ commands: [...seed().commands, { commandId: id(42), action: "start" }] },
			{ commands: [...seed().commands, { commandId: id(42), action: "stop", extra: 1 }] },
			{ attestation: { ...seed().attestation, nativePort: "9443" } },
		])
			expect(() => parseLxdOfficeResetSeed({ ...seed(), ...change })).toThrow();
	});
});
