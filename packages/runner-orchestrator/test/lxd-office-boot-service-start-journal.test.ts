import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootFixtureId as id } from "../../runtime/test/fixtures/company-computer-boot-configuration.ts";
import { openLxdOfficeBootServiceStartJournal } from "../src/lxd-office-boot-service-start-journal.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "boot-service-start-journal-")));
	roots.push(root);
	const binding = lxdOfficeGuestPlan({
		schema: "qorpera.lxd-office-guest/v2",
		providerId: id(7),
		providerPolicySha256: "f".repeat(64),
		companyId: id(1),
		environmentId: id(2),
		companyComputerId: id(3),
		logicalComputerId: id(4),
		computerGeneration: 1,
		allocationId: id(5),
		project: "offices",
		imageFingerprint: "a".repeat(64),
		bootstrapSha256: "b".repeat(64),
		storagePool: "office-vms",
		rootDiskBytes: 64 * 1024 ** 3,
		workbenchSource: "/mnt/nas/office",
		network: "office-net",
		cpus: 2,
		memoryBytes: 4 * 1024 ** 3,
	});
	const identity = {
		intentId: id(6),
		binding: binding.binding,
		command: { commandId: id(8), bootId: id(9), requestSha256: "c".repeat(64) },
		bootObservationSha256: "d".repeat(64),
		configurationObservationSha256: "e".repeat(64),
		bootIntentId: id(10),
		activationId: id(11),
	};
	const path = join(root, `boot-service-start-${identity.binding.allocationId}-${identity.activationId}`);
	const submit = vi.fn(async () => {
		expect(JSON.parse(await readFile(join(path, "000000.json"), "utf8"))).toMatchObject({ kind: "dispatch" });
		return { project: "offices", instanceName: binding.request.name, operationId: id(12) };
	});
	const inspect = vi.fn(async () => "succeeded" as const);
	const client = { submitOfficeBootServiceStart: submit, inspectOfficeBootServiceStart: inspect };
	const open = (existing = true, value = identity) =>
		openLxdOfficeBootServiceStartJournal(root, value, client, existing);
	return { root, path, identity, open, submit, inspect };
}
describe("retained-boot service start command journal", () => {
	it("retains exactly one dispatch and reopens the same successful command", async () => {
		const f = await fixture(),
			journal = await f.open(false);
		const result = await journal.reconcile(new AbortController().signal);
		expect(result).toEqual({ state: "succeeded", operationId: id(12) });
		expect(await (await f.open()).reconcile(new AbortController().signal)).toEqual(result);
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.inspect).toHaveBeenCalledOnce();
	});
	it("never reissues an unknown submission after restart", async () => {
		const f = await fixture();
		f.submit.mockRejectedValueOnce(new Error("lost reply"));
		expect(await (await f.open(false)).reconcile(new AbortController().signal)).toEqual({ state: "unknown" });
		expect(await (await f.open()).reconcile(new AbortController().signal)).toEqual({ state: "unknown" });
		expect(f.submit).toHaveBeenCalledOnce();
		expect(f.inspect).not.toHaveBeenCalled();
	});
	it.each(["bootIntentId", "activationId", "configurationObservationSha256", "bootObservationSha256"] as const)(
		"rejects changed %s",
		async (key) => {
			const f = await fixture();
			await f.open(false);
			await expect(
				f.open(true, { ...f.identity, [key]: key.endsWith("Id") ? id(99) : "9".repeat(64) }),
			).rejects.toThrow("JOURNAL_UNCONFIRMED");
			expect(f.submit).not.toHaveBeenCalled();
		},
	);
	it.each(["authority", "dispatch", "prefix"])("refuses lost or foreign %s", async (fault) => {
		const f = await fixture();
		await (await f.open(false)).reconcile(new AbortController().signal);
		if (fault === "authority") await rm(join(f.path, "authority.json"));
		if (fault === "dispatch") await rm(join(f.path, "000000.json"));
		if (fault === "prefix") {
			const path = join(f.path, "authority.json");
			await writeFile(
				path,
				(await readFile(path, "utf8")).replace("boot-service-start-journal", "configuration-journal"),
			);
		}
		await expect(f.open()).rejects.toThrow("JOURNAL_UNCONFIRMED");
		expect(f.submit).toHaveBeenCalledOnce();
	});
});
