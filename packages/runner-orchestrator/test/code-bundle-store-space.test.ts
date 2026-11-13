import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_BUNDLE_FOLDER, createCodeBundleStore } from "../src/code-bundle-store.ts";
import { CODE_IMPORT_MAXIMUM_BYTES, CODE_IMPORT_MAXIMUM_BYTES_LIMIT } from "../src/code-import.ts";

// Step 6, part C2: how much room a writer's begin wants. statfs answers as the file system does, unless a test says
// how many bytes are free: no test machine has a disk small enough to meet twice an import's 2 GiB.
const space = vi.hoisted(() => ({ free: undefined as bigint | undefined }));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof FsPromises>();
	return {
		...actual,
		statfs: async (path: string, options: { bigint: true }) => {
			const stat = await actual.statfs(path, options);
			return space.free === undefined ? stat : { ...stat, bavail: space.free, bsize: 1n };
		},
	};
});

const COMPANY = "11111111-1111-4111-8111-111111111111";
const TARGET = { companyId: COMPANY, owner: "acme", name: "app" };
const GiB = 1024 ** 3;

const dirs: string[] = [];
afterEach(() => {
	space.free = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "code-bundle-space-")));
	dirs.push(parent);
	return createCodeBundleStore({ root: join(parent, CODE_BUNDLE_FOLDER) });
}

describe("the room a writer's begin wants", () => {
	it("is twice an import's maximum (by default 1 GiB), and twice an ordinary bundle's expected size", async () => {
		const bundles = store();
		expect([CODE_IMPORT_MAXIMUM_BYTES, CODE_IMPORT_MAXIMUM_BYTES_LIMIT]).toEqual([GiB, 2 * GiB]);
		space.free = BigInt(2 * GiB);
		await (await bundles.begin(TARGET, { kind: "import" })).abort();
		await (await bundles.begin(TARGET, { kind: "import", maximumBytes: GiB })).abort();
		await expect(bundles.begin(TARGET, { kind: "import", maximumBytes: GiB + 1 })).rejects.toThrow(
			"CODE_BUNDLE_NO_SPACE",
		);
		// An import's expected size is not its room: its maximum is.
		await (await bundles.begin(TARGET, { kind: "import", maximumBytes: 1024, expectedBytes: 4 * GiB })).abort();
		space.free = BigInt(2 * GiB - 1);
		await expect(bundles.begin(TARGET, { kind: "import" })).rejects.toThrow("CODE_BUNDLE_NO_SPACE");
		await (await bundles.begin(TARGET, { kind: "import", maximumBytes: GiB - 1 })).abort();

		// An ordinary bundle's rule is as it was: twice what its caller expects, and nothing when it says nothing.
		space.free = 0n;
		await (await bundles.begin(TARGET)).abort();
		await (await bundles.begin(TARGET, { maximumBytes: 4 * GiB })).abort();
		space.free = 2000n;
		await (await bundles.begin(TARGET, { expectedBytes: 1000 })).abort();
		await expect(bundles.begin(TARGET, { expectedBytes: 1001 })).rejects.toThrow("CODE_BUNDLE_NO_SPACE");
	});
});
