import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLxdOfficeRetainedCodePackageInvocation } from "../src/lxd-office-code-package-retained.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import {
	cleanupOfficeCodePackagePipelineFixtures,
	officeCodePackagePipelineFixture,
} from "./fixtures/office-code-package-pipeline.ts";

const signal = () => new AbortController().signal;
afterEach(cleanupOfficeCodePackagePipelineFixtures);
async function fixture() {
	const f = await officeCodePackagePipelineFixture();
	await f.ensure();
	await publish(f.root, `preparation-request-${f.f.binding.allocationId}.json`, f.context.originalPreparation);
	const prepare = () =>
		prepareLxdOfficeRetainedCodePackageInvocation(
			{ root: f.root, binding: f.f.binding, policy: f.f.policy, client: f.client, registry: f.registry },
			signal(),
			f.f.ports,
		);
	return { ...f, prepare };
}
describe("retained root code package discovery", () => {
	it("restages immutable public material after /run loss, then freshly measures rebooted service without install replay", async () => {
		const f = await fixture();
		f.files.clear();
		const prepared = await f.prepare();
		expect(prepared).toBeDefined();
		const startup = {
			...f.f.resetPlan.predecessor.startup,
			bootId: randomUUID(),
			serviceInvocationId: randomUUID().replaceAll("-", ""),
		};
		await prepared!.measure(randomUUID(), startup, performance.now() + 5000, signal());
		prepared!.dispose();
		expect(f.actions.filter((a) => a === "bootstrap:install")).toHaveLength(1);
		expect(f.methods.filter((m) => m === "qorpera_check_office_package_invocation")).toHaveLength(1);
	});
	it("permits historical lane only on definite absence", async () => {
		const f = await fixture();
		f.client.discoverOfficeCodePackage = async () => undefined;
		expect(await f.prepare()).toBeUndefined();
	});
	it("does not fall back after discovery failure", async () => {
		const f = await fixture();
		f.client.discoverOfficeCodePackage = async () => {
			throw new Error("unavailable");
		};
		await expect(f.prepare()).rejects.toThrow("unavailable");
	});
	it.each(["material", "packet", "original", "completed"])("holds missing retained %s", async (part) => {
		const f = await fixture();
		await rm(join(f.root, `code-package-${part}-${f.f.plan.provisionId}.json`));
		await expect(f.prepare()).rejects.toThrow();
	});
	it("rejects a different original preparation even with retained package history", async () => {
		const f = await fixture();
		await writeFile(join(f.root, `preparation-request-${f.f.binding.allocationId}.json`), "{}");
		await expect(f.prepare()).rejects.toThrow("HISTORY_UNCONFIRMED");
	});
	it("rejects a foreign binding in retained descriptor", async () => {
		const f = await fixture(),
			path = join(f.root, `code-package-material-${f.f.plan.provisionId}.json`),
			value = JSON.parse(await readFile(path, "utf8"));
		value.binding.allocationId = randomUUID();
		await writeFile(path, JSON.stringify(value));
		await expect(f.prepare()).rejects.toThrow("RETAINED_BINDING_UNCONFIRMED");
	});
	it("rejects root receipt custody before staging code", async () => {
		const f = await fixture(),
			read = f.client.readOfficeCodePackageReceipt,
			before = f.actions.length;
		f.client.readOfficeCodePackageReceipt = async (...args) => ({ ...(await read(...args)), uid: 1000 });
		await expect(f.prepare()).rejects.toThrow("RETAINED_UNCONFIRMED");
		expect(f.actions).toHaveLength(before);
	});
	it("refuses replaced protected target files instead of following latest package config", async () => {
		const f = await fixture();
		f.f.files.set(f.f.document.measurementToolPath, Buffer.from("changed"));
		await expect(f.prepare()).rejects.toThrow("MATERIAL_UNCONFIRMED");
	});
});
