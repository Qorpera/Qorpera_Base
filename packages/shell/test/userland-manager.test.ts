/** Fork model semantics (spec §9a): fork, fast-forward, stage — never reset. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureUserland,
	getActiveApp,
	isUnmodified,
	listVersions,
	mergeTaskPrompt,
	restoreVersion,
	setActiveApp,
	snapshotIfChanged,
} from "../src/userland-manager.ts";

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

	it("relabels instead of staging when the new base is byte-identical to the pristine copy", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		writeFileSync(join(userland(), "renderer.js"), "// evolved", "utf-8");
		// Same content re-released under a new version (or a fork cut
		// mid-release): no merge material exists — just relabel.
		const status = ensureUserland(company(), baseV1, "1.0.1");
		expect(status.action).toBe("current");
		expect(status.baseVersion).toBe("1.0.1");
		expect(existsSync(join(userland(), ".update"))).toBe(false);
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolved");
		// A REAL content change still stages.
		expect(ensureUserland(company(), baseV2, "2.0.0").action).toBe("staged");
	});

	it("versions: snapshots only on change, restores content, and rollback is itself reversible", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		// Pristine fork: nothing to snapshot (that state lives in .base already).
		expect(snapshotIfChanged(userland())).toBeUndefined();
		expect(listVersions(userland())).toEqual([]);

		// First evolution → one snapshot; re-checking without change → none.
		writeFileSync(join(userland(), "renderer.js"), "// evolution 1", "utf-8");
		const v1 = snapshotIfChanged(userland())!;
		expect(v1).toBeTruthy();
		expect(snapshotIfChanged(userland())).toBeUndefined();

		// Second evolution → second snapshot, newest first.
		writeFileSync(join(userland(), "renderer.js"), "// evolution 2", "utf-8");
		const v2 = snapshotIfChanged(userland(), "second")!;
		const versions = listVersions(userland());
		expect(versions.map((v) => v.id)).toEqual([v2, v1]);
		expect(versions[0].label).toBe("second");

		// Rollback to evolution 1 — reversible because evolution 2 is saved.
		expect(restoreVersion(userland(), v1)).toBe(true);
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution 1");
		expect(restoreVersion(userland(), v2)).toBe(true);
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution 2");

		// Unsaved-at-restore work is captured as a pre-restore snapshot.
		writeFileSync(join(userland(), "renderer.js"), "// evolution 3, never snapshotted", "utf-8");
		expect(restoreVersion(userland(), v1)).toBe(true);
		const pre = listVersions(userland()).find((v) => v.label === "pre-restore");
		expect(pre).toBeTruthy();
		expect(restoreVersion(userland(), pre!.id)).toBe(true);
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution 3, never snapshotted");

		// Unknown id refused.
		expect(restoreVersion(userland(), "nope")).toBe(false);
	});

	it("active app choice persists and survives a fast-forward; snapshots don't break hashing", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		expect(getActiveApp(userland())).toBe("fork");
		setActiveApp(userland(), "base");
		expect(getActiveApp(userland())).toBe("base");

		// The choice is metadata, not an evolution — the fork still fast-forwards.
		const status = ensureUserland(company(), baseV2, "2.0.0");
		expect(status.action).toBe("fast-forwarded");
		expect(getActiveApp(userland())).toBe("base");

		// A .versions dir is invisible to modification detection.
		writeFileSync(join(userland(), "renderer.js"), "// changed", "utf-8");
		snapshotIfChanged(userland());
		expect(isUnmodified(userland())).toBe(false);
		writeFileSync(join(userland(), "renderer.js"), "// v2 improved", "utf-8");
		expect(isUnmodified(userland())).toBe(true);
	});
});
