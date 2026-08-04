/** Fork model semantics (spec §9a): fork, fast-forward, stage — never reset. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureUserland, isUnmodified, mergeTaskPrompt } from "../src/userland-manager.ts";

let root: string;
let baseV1: string;
let baseV2: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-userland-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	baseV1 = join(root, "base-v1");
	baseV2 = join(root, "base-v2");
	mkdirSync(join(root, "company"), { recursive: true });
	mkdirSync(baseV1, { recursive: true });
	mkdirSync(baseV2, { recursive: true });
	writeFileSync(join(baseV1, "index.html"), "<html>v1</html>", "utf-8");
	writeFileSync(join(baseV1, "renderer.js"), "// v1", "utf-8");
	writeFileSync(join(baseV2, "index.html"), "<html>v2</html>", "utf-8");
	writeFileSync(join(baseV2, "renderer.js"), "// v2 improved", "utf-8");
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

const company = () => join(root, "company");
const userland = () => join(company(), "userland");

describe("userland fork model", () => {
	it("forks the base into the company with a pristine copy and hash manifest", () => {
		const status = ensureUserland(company(), baseV1, "1.0.0");
		expect(status.action).toBe("forked");
		expect(readFileSync(join(userland(), "index.html"), "utf-8")).toBe("<html>v1</html>");
		expect(readFileSync(join(userland(), ".base", "index.html"), "utf-8")).toBe("<html>v1</html>");
		expect(isUnmodified(userland())).toBe(true);
		// Re-open with same base: no-op.
		expect(ensureUserland(company(), baseV1, "1.0.0").action).toBe("current");
	});

	it("fast-forwards an untouched fork to a new base", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		const status = ensureUserland(company(), baseV2, "2.0.0");
		expect(status.action).toBe("fast-forwarded");
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// v2 improved");
		expect(readFileSync(join(userland(), ".base", "renderer.js"), "utf-8")).toBe("// v2 improved");
		expect(isUnmodified(userland())).toBe(true);
	});

	it("never resets an evolved fork: stages the update with 3-way materials instead", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		// The controller evolves its app.
		writeFileSync(join(userland(), "renderer.js"), "// my company's own chrome", "utf-8");
		writeFileSync(join(userland(), "my-feature.js"), "// net-new capability", "utf-8");
		expect(isUnmodified(userland())).toBe(false);

		const status = ensureUserland(company(), baseV2, "2.0.0");
		expect(status.action).toBe("staged");
		expect(status.stagedVersion).toBe("2.0.0");
		// The evolution survives untouched.
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// my company's own chrome");
		expect(existsSync(join(userland(), "my-feature.js"))).toBe(true);
		// 3-way materials: mine (userland/), base (.base v1), theirs (.update v2).
		expect(readFileSync(join(userland(), ".base", "renderer.js"), "utf-8")).toBe("// v1");
		expect(readFileSync(join(userland(), ".update", "renderer.js"), "utf-8")).toBe("// v2 improved");

		// Idempotent while unmerged.
		expect(ensureUserland(company(), baseV2, "2.0.0").action).toBe("already-staged");

		const prompt = mergeTaskPrompt(status);
		expect(prompt).toContain("3-way merge");
		expect(prompt).toContain("v2.0.0");
	});
});
