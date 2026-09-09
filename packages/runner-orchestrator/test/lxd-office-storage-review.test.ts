import { describe, expect, it } from "vitest";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../src/lxd-office-inventory-worker.ts";
import { parseLxdOfficeStorageReview } from "../src/lxd-office-storage-review.ts";

function fixture() {
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		allocationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		providerBindingSha256: "c".repeat(64),
		hostBootId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		inventory: {
			schema: "qorpera.office-storage-inventory/v1",
			root: "/mnt/workbench",
			mountId: "111",
			entries: [
				{
					path: ".",
					kind: "directory",
					dev: "123",
					ino: "456",
					uid: 1000,
					gid: 1000,
					mode: 0o700,
					ctimeNs: "1",
					mtimeNs: "1",
					bytes: 0,
					sha256: null,
				},
			],
			totalBytes: 0,
		},
	};
	const planSha256 = "e".repeat(64);
	const review = {
		schema: "qorpera.lxd-office-storage-review/v1",
		reviewId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
		decision: "initialize_empty",
		observationSha256: officeDigest(observation),
		planSha256,
		writerFence: { state: "exclusive_writers_confirmed", evidenceSha256: "1".repeat(64) },
	};
	return { observation, planSha256, review };
}
describe("explicit office storage review", () => {
	it("snapshots the exact review without granting admission or producing a receipt", () => {
		const f = fixture();
		const review = parseLxdOfficeStorageReview(f.review, f.observation, f.planSha256);
		f.review.writerFence.evidenceSha256 = "2".repeat(64);
		expect(review.writerFence.evidenceSha256).toBe("1".repeat(64));
		expect(Object.isFrozen(review)).toBe(true);
		expect(Object.isFrozen(review.writerFence)).toBe(true);
		expect(review.schema).toBe("qorpera.lxd-office-storage-review/v1");
	});
	it.each(["intentId", "allocationId", "providerBindingSha256", "hostBootId"] as const)(
		"rejects review replay after %s changes",
		(key) => {
			const f = fixture();
			expect(() =>
				parseLxdOfficeStorageReview(f.review, { ...f.observation, [key]: "changed" }, f.planSha256),
			).toThrow("REVIEW_MISMATCH");
		},
	);
	it.each(["root", "mountId", "totalBytes"] as const)("rejects changed inventory %s", (key) => {
		const f = fixture();
		expect(() =>
			parseLxdOfficeStorageReview(
				f.review,
				{
					...f.observation,
					inventory: { ...f.observation.inventory, [key]: "changed" },
				} as LxdOfficeStorageObservation,
				f.planSha256,
			),
		).toThrow("REVIEW_MISMATCH");
	});
	it("rejects changed file identities or a substituted plan", () => {
		const f = fixture();
		Object.assign(f.observation.inventory.entries[0], { ino: "789" });
		expect(() => parseLxdOfficeStorageReview(f.review, f.observation, f.planSha256)).toThrow("REVIEW_MISMATCH");
		expect(() => parseLxdOfficeStorageReview(f.review, fixture().observation, "0".repeat(64))).toThrow(
			"REVIEW_MISMATCH",
		);
	});
	it.each(["empty directory", "empty file", "bytes", "missing root"])(
		"does not infer empty storage from zero-byte content: %s",
		(kind) => {
			const f = fixture();
			const root = f.observation.inventory.entries[0];
			const inventory = {
				...f.observation.inventory,
				entries:
					kind === "missing root"
						? []
						: kind === "bytes"
							? [root]
							: [
									root,
									{
										...root,
										path: "existing",
										kind: kind === "empty file" ? ("file" as const) : ("directory" as const),
									},
								],
				totalBytes: kind === "bytes" ? 1 : 0,
			};
			const observed = { ...f.observation, inventory };
			expect(() =>
				parseLxdOfficeStorageReview(
					{ ...f.review, observationSha256: officeDigest(observed) },
					observed,
					f.planSha256,
				),
			).toThrow("OFFICE_STORAGE_NOT_EMPTY");
		},
	);
	it("requires explicit migration review for existing state", () => {
		const f = fixture();
		const inventory = {
			...f.observation.inventory,
			entries: [...f.observation.inventory.entries, { ...f.observation.inventory.entries[0], path: "legacy" }],
		};
		const observed = { ...f.observation, inventory };
		const review = parseLxdOfficeStorageReview(
			{ ...f.review, observationSha256: officeDigest(observed), decision: "migrate_existing" },
			observed,
			f.planSha256,
		);
		expect(review.decision).toBe("migrate_existing");
	});
	it.each([
		{ schema: "qorpera.office-state-adoption/v1" },
		{ reviewId: "screen-1" },
		{ decision: "automatic" },
		{ extra: true },
		{ writerFence: { state: "unknown", evidenceSha256: "1".repeat(64) } },
		{ writerFence: { state: "exclusive_writers_confirmed", evidenceSha256: "unknown" } },
		{ writerFence: { state: "exclusive_writers_confirmed", evidenceSha256: "1".repeat(64), expiresIn: 1 } },
	])("rejects an incomplete or open review document: %j", (change) => {
		const f = fixture();
		expect(() => parseLxdOfficeStorageReview({ ...f.review, ...change }, f.observation, f.planSha256)).toThrow();
	});
});
