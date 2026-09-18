import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertLxdOfficeServiceBootstrapContinuity,
	parseLxdOfficeServiceBootstrapRevisions,
} from "../src/lxd-office-service-bootstrap-revisions.ts";
import { officeBootConfigurationWorkerFixture } from "./fixtures/office-boot-configuration-worker.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Plans as the fixture serves them; a rotation replaces the two TLS entries. */
async function plans() {
	const f = await officeBootConfigurationWorkerFixture(roots);
	const path = f.input.serviceBootstrapPath;
	const original = await f.readProtected(path);
	const rotate = (text: string, suffix: string, keys = ["tlsCert", "tlsKey"]) => {
		const plan = JSON.parse(text);
		for (const key of keys)
			plan.credentials[key] = {
				path: `${plan.credentials[key].path}-${suffix}`,
				bytes: plan.credentials[key].bytes + 1,
				sha256: hash(`${key}-${suffix}`),
			};
		return JSON.stringify(plan);
	};
	return { f, path, original: original.toString("utf8"), rotate };
}
const revision = (revision: number, previousPlan: string, next: string, changed = ["tlsCert", "tlsKey"]) => ({
	revision,
	previousSha256: hash(previousPlan),
	nextSha256: hash(next),
	previousPlan,
	changed,
	reason: "tailnet certificate renewed",
	at: "2026-09-17T12:00:00Z",
});
const serve = (f: Awaited<ReturnType<typeof plans>>["f"], current: string, chain?: unknown) => {
	const original = f.readProtected.getMockImplementation()!;
	f.readProtected.mockImplementation(async (path: string) => {
		if (path === f.input.serviceBootstrapPath) return Buffer.from(current);
		if (path.endsWith("/service-bootstrap-revisions.json")) {
			if (chain === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			return Buffer.from(JSON.stringify(chain));
		}
		return original(path);
	});
};

describe("service bootstrap revisions", () => {
	it("accepts an unchanged plan without a chain document", async () => {
		const { f, path, original } = await plans();
		await expect(
			assertLxdOfficeServiceBootstrapContinuity(
				{ planBytes: Buffer.from(original), planPath: path, predecessorSha256: hash(original), binding: f.binding },
				f.readProtected,
				signal(),
			),
		).resolves.toBe(0);
	});
	it("refuses a changed plan without a chain document", async () => {
		const { f, path, original, rotate } = await plans();
		const next = rotate(original, "r1");
		serve(f, next);
		await expect(
			assertLxdOfficeServiceBootstrapContinuity(
				{ planBytes: Buffer.from(next), planPath: path, predecessorSha256: hash(original), binding: f.binding },
				f.readProtected,
				signal(),
			),
		).rejects.toThrow("OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED");
	});
	it("accepts one and two recorded credential revisions and counts the steps since the predecessor", async () => {
		const { f, path, original, rotate } = await plans();
		const first = rotate(original, "r1"),
			second = rotate(first, "r2");
		const chain = {
			schema: "qorpera.lxd-office-service-bootstrap-revisions/v1",
			allocationId: f.binding.allocationId,
			revisions: [revision(1, original, first), revision(2, first, second)],
		};
		expect(parseLxdOfficeServiceBootstrapRevisions(chain, f.binding.allocationId).revisions).toHaveLength(2);
		serve(f, second, chain);
		const check = (predecessor: string) =>
			assertLxdOfficeServiceBootstrapContinuity(
				{
					planBytes: Buffer.from(second),
					planPath: path,
					predecessorSha256: hash(predecessor),
					binding: f.binding,
				},
				f.readProtected,
				signal(),
			);
		await expect(check(original)).resolves.toBe(2);
		await expect(check(first)).resolves.toBe(1);
		await expect(check(rotate(original, "elsewhere"))).rejects.toThrow(
			"OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED",
		);
	});
	it.each(["endpoint", "extra credential", "unchanged credential", "broken chain", "foreign allocation"])(
		"refuses a chain whose step changes more than its named credentials (%s)",
		async (kind) => {
			const { f, path, original, rotate } = await plans();
			let next = rotate(original, "r1");
			const chain = {
				schema: "qorpera.lxd-office-service-bootstrap-revisions/v1",
				allocationId: f.binding.allocationId,
				revisions: [revision(1, original, next)],
			};
			if (kind === "endpoint") {
				const plan = JSON.parse(next);
				plan.registryUrl = "https://other.example.test";
				next = JSON.stringify(plan);
				chain.revisions[0]!.nextSha256 = hash(next);
			} else if (kind === "extra credential") {
				next = rotate(original, "r1", ["tlsCert", "tlsKey", "native"]);
				chain.revisions[0]!.nextSha256 = hash(next);
			} else if (kind === "unchanged credential") {
				chain.revisions[0]!.changed = ["tlsCert", "tlsKey", "objects"];
			} else if (kind === "broken chain") {
				chain.revisions.push({ ...revision(2, rotate(original, "other"), rotate(next, "r2")) });
				next = rotate(next, "r2");
			} else chain.allocationId = "20000000-0000-4000-8000-000000000098";
			serve(f, next, chain);
			await expect(
				assertLxdOfficeServiceBootstrapContinuity(
					{ planBytes: Buffer.from(next), planPath: path, predecessorSha256: hash(original), binding: f.binding },
					f.readProtected,
					signal(),
				),
			).rejects.toThrow("OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED");
		},
	);
});
