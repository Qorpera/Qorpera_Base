import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLxdOfficeBootActivationEvidence } from "../src/lxd-office-boot-activation-evidence.ts";
import { openLxdOfficeCreationIdentity } from "../src/lxd-office-creation-journal.ts";
import { officeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";

const roots: string[] = [],
	signal = () => new AbortController().signal;
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const f = await officeBootConfigurationWorkerFixture(roots);
	await f.run();
	const creation = await openLxdOfficeCreationIdentity(f.policy, f.input.intentId, true, f.client, signal());
	const run = () =>
		readLxdOfficeBootActivationEvidence(f.root, f.input, creation, f.client, signal(), {
			readProtected: f.readProtected,
			readCredential: f.readCredential,
		});
	return { ...f, readEvidence: run };
}
describe("retained boot activation evidence", () => {
	it("recovers exact evidence after boot-intent admission without SQL, dispatch or publication", async () => {
		const f = await fixture(),
			before = await readdir(f.root);
		const first = await f.readEvidence();
		f.intent.state = "admitted";
		f.registry.mockClear();
		f.exec.mockClear();
		f.stage.mockClear();
		f.resume.submit.mockClear();
		expect(await f.readEvidence()).toEqual(first);
		expect(await readdir(f.root)).toEqual(before);
		expect(first.configuration.activationId).toBe(f.request.activationId);
		expect(f.registry).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
		expect(f.stage).not.toHaveBeenCalled();
		expect(f.resume.submit).not.toHaveBeenCalled();
	});
	it.each(["seed", "prepared", "observation", "done"] as const)("refuses a lost resume %s", async (key) => {
		const f = await fixture();
		await rm(f.resume.names[key]);
		await expect(f.readEvidence()).rejects.toThrow();
	});
	it.each(["index", "observation", "done", "journal"] as const)("refuses a lost configuration %s", async (key) => {
		const f = await fixture();
		await rm(f.names[key], { recursive: true });
		await expect(f.readEvidence()).rejects.toThrow();
	});
	it.each(["request", "observation", "completed"])("refuses changed original preparation %s", async (kind) => {
		const f = await fixture();
		await writeFile(join(f.root, `preparation-${kind}-${f.binding.allocationId}.json`), "{}");
		await expect(f.readEvidence()).rejects.toThrow();
	});
	it("refuses a completed VM chain with a missing accepted operation", async () => {
		const f = await fixture();
		await rm(join(f.resume.powerOff.paths.journal, "000010.json"));
		await expect(f.readEvidence()).rejects.toThrow();
	});
	it("refuses changed protected sources after acknowledgement", async () => {
		const f = await fixture();
		f.readCredential.mockRejectedValue(new Error("lost credential"));
		await expect(f.readEvidence()).rejects.toThrow();
	});
	it("binds configuration observation bytes to its completion marker", async () => {
		const f = await fixture(),
			value = JSON.parse(await readFile(f.names.observation, "utf8"));
		value.completionSha256 = "1".repeat(64);
		await writeFile(f.names.observation, JSON.stringify(value));
		await expect(f.readEvidence()).rejects.toThrow();
	});
});
