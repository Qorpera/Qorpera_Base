import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudCompanyDisplayRoot, prepareCloudCompanyDisplay } from "../src/cloud-company-display.ts";

const user = "29500000-0000-4000-8000-000000000001";
const other = "29500000-0000-4000-8000-000000000002";
const company = "29500000-0000-4000-8000-000000000003";
const environment = "29500000-0000-4000-8000-000000000004";
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "qorpera-display-test-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("cloud company display ownership", () => {
	it("keeps per-human projections separate without copying company bytes", () => {
		const old = join(root, "old-company-cache");
		mkdirSync(old);
		writeFileSync(join(old, "private.txt"), "private old bytes");
		const first = prepareCloudCompanyDisplay(root, user, company, environment);
		const second = prepareCloudCompanyDisplay(root, other, company, environment);
		expect(first).not.toBe(second);
		expect(prepareCloudCompanyDisplay(root, user, company, environment)).toBe(first);
		expect(readFileSync(join(old, "private.txt"), "utf8")).toBe("private old bytes");
		expect(existsSync(join(first, "private.txt"))).toBe(false);
	});
	it.each(["../other", "", "A9500000-0000-4000-8000-000000000001", "company/name"])(
		"rejects an invalid principal or tenant path %s",
		(id) => {
			expect(() => cloudCompanyDisplayRoot(root, id, company, environment)).toThrow(
				"Invalid company display identity",
			);
		},
	);
	it("will not adopt a pre-existing unmarked root", () => {
		const path = cloudCompanyDisplayRoot(root, user, company, environment);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "keep.txt"), "keep");
		expect(() => prepareCloudCompanyDisplay(root, user, company, environment)).toThrow();
		expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("keep");
	});
	it("will not adopt a root symlink or a hard-linked identity marker", () => {
		const destination = prepareCloudCompanyDisplay(root, other, company, environment);
		const path = cloudCompanyDisplayRoot(root, user, company, environment);
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(destination, path, "dir");
		expect(() => prepareCloudCompanyDisplay(root, user, company, environment)).toThrow();
		const marker = join(destination, ".qorpera-display-owner.json");
		linkSync(marker, join(root, "linked-marker"));
		expect(() => prepareCloudCompanyDisplay(root, other, company, environment)).toThrow();
	});
});
