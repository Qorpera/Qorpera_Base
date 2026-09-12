import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLxdOfficeRetainedCodePackageRoot } from "../src/lxd-office-code-package-history.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import {
	cleanupOfficeCodePackagePipelineFixtures,
	officeCodePackagePipelineFixture,
} from "./fixtures/office-code-package-pipeline.ts";

afterEach(cleanupOfficeCodePackagePipelineFixtures);
async function fixture() {
	const f = await officeCodePackagePipelineFixture();
	await f.ensure();
	await publish(f.root, `preparation-request-${f.f.binding.allocationId}.json`, f.context.originalPreparation);
	return {
		...f,
		check: (rootId = f.f.resetPlan.rootIncarnationId) =>
			assertLxdOfficeRetainedCodePackageRoot(
				f.root,
				f.f.binding,
				f.f.policy,
				rootId,
				new AbortController().signal,
				f.f.ports,
			),
	};
}
describe("prior package root provenance before another reset", () => {
	it("proves old exact root after physical deletion without credentials, current config or guest operations", async () => {
		const f = await fixture(),
			reads = f.f.reads.filter((p) => p === f.f.document.providerCapabilityCredential.path).length,
			actions = f.actions.length;
		f.files.clear();
		const result = await f.check();
		expect(result.rootIncarnationId).toBe(f.f.resetPlan.rootIncarnationId);
		expect(f.actions).toHaveLength(actions);
		expect(f.f.reads.filter((p) => p === f.f.document.providerCapabilityCredential.path)).toHaveLength(reads);
	});
	it.each(["root-claim", "root-receipt", "completed"])(
		"holds missing %s before deletion authorization",
		async (part) => {
			const f = await fixture();
			await rm(join(f.root, `code-package-${part}-${f.f.plan.provisionId}.json`));
			await expect(f.check()).rejects.toThrow();
		},
	);
	it("refuses a predecessor root not proved by retained signed history", async () => {
		const f = await fixture();
		await expect(f.check(randomUUID())).rejects.toThrow("PRIOR_ROOT_UNCONFIRMED");
	});
	it("refuses a changed installclaim even when the signed receipt is intact", async () => {
		const f = await fixture(),
			path = join(f.root, `code-package-root-claim-${f.f.plan.provisionId}.json`),
			r = JSON.parse(await readFile(path, "utf8"));
		r.requestSha256 = "f".repeat(64);
		await writeFile(path, JSON.stringify(r));
		await expect(f.check()).rejects.toThrow("HISTORY_UNCONFIRMED");
	});
	it("refuses two retained descriptors claiming the same root", async () => {
		const f = await fixture();
		await writeFile(
			join(f.root, `code-package-material-${randomUUID()}.json`),
			await readFile(join(f.root, `code-package-material-${f.f.plan.provisionId}.json`)),
			{ mode: 0o600 },
		);
		await expect(f.check()).rejects.toThrow("PRIOR_ROOT_UNCONFIRMED");
	});
});
