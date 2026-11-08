import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileSeconds, slowestSpecsFirst, TEST_FILE_SECONDS, timedShare, timedSpecs } from "./helpers/timed-shards.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, "test"))
	.filter((name) => name.endsWith(".test.ts"))
	.map((name) => `test/${name}`);
const load = (paths: readonly string[]) => paths.reduce((sum, path) => sum + fileSeconds(path), 0);

describe("runner-orchestrator's shards by time", () => {
	it.each([1, 2, 3])("shares 1/%i to n/n run every test file of the package exactly once", (count) => {
		const shares = Array.from({ length: count }, (_, k) => timedShare(files, k + 1, count));
		expect(shares.flat().sort()).toEqual([...files].sort());
		expect(new Set(shares.flat()).size).toBe(files.length);
	});

	it("splits the same files the same way in any order", () => {
		const reversed = [...files].reverse();
		const backwards = (path: string) => [...path].reverse().join("");
		const shuffled = [...files].sort((a, b) => (backwards(a) < backwards(b) ? -1 : 1));
		for (const index of [1, 2]) {
			expect(timedShare(reversed, index, 2)).toEqual(timedShare(files, index, 2));
			expect(timedShare(shuffled, index, 2)).toEqual(timedShare(files, index, 2));
		}
	});

	it("keeps the halves within the slowest file of each other, and both halves well under the whole", () => {
		const [one, two] = [timedShare(files, 1, 2), timedShare(files, 2, 2)];
		const slowest = Math.max(...files.map(fileSeconds));
		expect(Math.abs(load(one) - load(two))).toBeLessThanOrEqual(slowest);
		expect(Math.max(load(one), load(two))).toBeLessThan(0.6 * load(files));
	});

	it("gives vitest each spec of its share once, by its path from the package root, and the slowest first", () => {
		const specs = files.map((path) => ({ moduleId: join(root, path), project: "runner-orchestrator" }));
		const shares = [1, 2].map((index) => timedSpecs(specs, root, index, 2).map((spec) => spec.moduleId));
		expect(shares.flat().sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
		for (const index of [1, 2])
			expect(new Set(shares[index - 1])).toEqual(
				new Set(timedShare(files, index, 2).map((path) => join(root, path))),
			);
		const sorted = slowestSpecsFirst(specs, root).map((spec) => spec.moduleId.slice(root.length + 1));
		expect(sorted[0]).toBe("test/lxd-office-boot-successor-worker.test.ts");
		expect(sorted.map(fileSeconds)).toEqual(sorted.map(fileSeconds).sort((a, b) => b - a));
	});

	it("names only files that exist, so a renamed file is noticed", () => {
		for (const path of Object.keys(TEST_FILE_SECONDS)) expect(existsSync(join(root, path)), path).toBe(true);
	});

	it("refuses a share that is not one of 1 to n, and a file listed twice", () => {
		for (const [index, count] of [
			[0, 2],
			[3, 2],
			[1, 0],
			[1.5, 2],
		])
			expect(() => timedShare(files, index, count)).toThrow("Invalid shard");
		expect(() => timedShare([files[0], files[0]], 1, 2)).toThrow("listed twice");
	});
});
