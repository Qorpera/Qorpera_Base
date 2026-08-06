/** Fork model semantics (spec §9a): fork, fast-forward, stage — never reset. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	setVersionFavorite,
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
		expect(restoreVersion(userland(), v1)?.action).toBe("current");
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution 1");
		expect(restoreVersion(userland(), v2)?.action).toBe("current");
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution 2");

		// Unsaved-at-restore work is captured as a pre-restore snapshot.
		writeFileSync(join(userland(), "renderer.js"), "// evolution 3, never snapshotted", "utf-8");
		expect(restoreVersion(userland(), v1)).toBeTruthy();
		const pre = listVersions(userland()).find((v) => v.label === "pre-restore");
		expect(pre).toBeTruthy();
		expect(restoreVersion(userland(), pre!.id)).toBeTruthy();
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution 3, never snapshotted");

		// Unknown id refused.
		expect(restoreVersion(userland(), "nope")).toBeUndefined();
	});

	it("numbers versions, describes each delta, and tracks favorites and last use", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		writeFileSync(join(userland(), "renderer.js"), "// evolution 1", "utf-8");
		const v1 = snapshotIfChanged(userland())!;
		writeFileSync(join(userland(), "widgets.js"), "// net new", "utf-8");
		const v2 = snapshotIfChanged(userland())!;

		// Monotonic numbers, newest first; deltas vs the pristine base / previous version.
		let versions = listVersions(userland());
		expect(versions.map((v) => v.seq)).toEqual([2, 1]);
		expect(versions[1].description).toBe("changed renderer.js");
		expect(versions[0].description).toBe("added widgets.js");

		// Favorites persist; unknown ids refused.
		expect(setVersionFavorite(userland(), v1, true)).toBe(true);
		expect(setVersionFavorite(userland(), "nope", true)).toBe(false);
		versions = listVersions(userland());
		expect(versions.find((v) => v.id === v1)?.favorite).toBe(true);
		expect(versions.find((v) => v.id === v2)?.favorite).toBeFalsy();
		expect(setVersionFavorite(userland(), v1, false)).toBe(true);
		expect(listVersions(userland()).find((v) => v.id === v1)?.favorite).toBe(false);

		// Restore stamps last use, and the pre-restore capture of unsaved work numbers on.
		writeFileSync(join(userland(), "renderer.js"), "// evolution 3, never snapshotted", "utf-8");
		expect(restoreVersion(userland(), v1)?.action).toBe("current");
		versions = listVersions(userland());
		expect(versions.find((v) => v.id === v1)?.lastUsedAt).toBeTruthy();
		expect(versions.find((v) => v.id === v2)?.lastUsedAt).toBeFalsy();
		expect(versions.find((v) => v.label === "pre-restore")?.seq).toBe(3);
	});

	it("legacy bare snapshots get chronological numbers and stay meta-free", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		// A pre-meta snapshot: bare content dir, no content/ nesting, no meta.json.
		const legacyId = "2020-01-01T00-00-00-000Z";
		mkdirSync(join(userland(), ".versions", legacyId), { recursive: true });
		writeFileSync(join(userland(), ".versions", legacyId, "index.html"), "<html>old</html>", "utf-8");

		writeFileSync(join(userland(), "renderer.js"), "// evolved", "utf-8");
		const fresh = snapshotIfChanged(userland())!;
		const versions = listVersions(userland());
		expect(versions.map((v) => [v.id, v.seq])).toEqual([
			[fresh, 2],
			[legacyId, 1],
		]);

		// Writing meta into a bare dir would leak it into the app on restore — refused.
		expect(setVersionFavorite(userland(), legacyId, true)).toBe(false);
		restoreVersion(userland(), legacyId);
		expect(existsSync(join(userland(), "meta.json"))).toBe(false);
		expect(readFileSync(join(userland(), "index.html"), "utf-8")).toBe("<html>old</html>");
	});

	it("snapshots carry their base version and pristine copy; restore rejoins the current base", () => {
		ensureUserland(company(), baseV1, "1.0.0");
		writeFileSync(join(userland(), "renderer.js"), "// evolution on v1", "utf-8");
		const snap = snapshotIfChanged(userland())!;
		expect(listVersions(userland())[0].baseVersion).toBe("1.0.0");

		// The controller completes a merge to base v2 (per the merge protocol).
		ensureUserland(company(), baseV2, "2.0.0");
		writeFileSync(join(userland(), "renderer.js"), "// evolution merged with v2", "utf-8");
		rmSync(join(userland(), ".update"), { recursive: true, force: true });
		rmSync(join(userland(), ".base"), { recursive: true, force: true });
		cpSync(baseV2, join(userland(), ".base"), { recursive: true });
		const manifestPath = join(userland(), "userland.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		manifest.baseVersion = "2.0.0";
		delete manifest.stagedVersion;
		writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"), "utf-8");

		// Restoring the v1-era snapshot brings back ITS content and ITS pristine
		// base, and stages the current base — exactly like an update arriving.
		const status = restoreVersion(userland(), snap, { dir: baseV2, version: "2.0.0" })!;
		expect(status.action).toBe("staged");
		expect(status.baseVersion).toBe("1.0.0");
		expect(status.stagedVersion).toBe("2.0.0");
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution on v1");
		expect(readFileSync(join(userland(), ".base", "renderer.js"), "utf-8")).toBe("// v1");
		expect(readFileSync(join(userland(), ".update", "renderer.js"), "utf-8")).toBe("// v2 improved");

		// Restoring a snapshot already on the current base clears staging instead.
		const latest = listVersions(userland()).find((v) => v.label === "pre-restore")!;
		expect(latest.baseVersion).toBe("2.0.0");
		const back = restoreVersion(userland(), latest.id, { dir: baseV2, version: "2.0.0" })!;
		expect(back.action).toBe("current");
		expect(back.baseVersion).toBe("2.0.0");
		expect(existsSync(join(userland(), ".update"))).toBe(false);
		expect(readFileSync(join(userland(), "renderer.js"), "utf-8")).toBe("// evolution merged with v2");
	});

	it("never writes outside userland/ — the base cannot conflict with the company file", () => {
		writeFileSync(join(company(), "company.md"), "identity — never touched", "utf-8");
		mkdirSync(join(company(), "trail"));
		writeFileSync(join(company(), "trail", "session.jsonl"), "{}", "utf-8");

		ensureUserland(company(), baseV1, "1.0.0");
		writeFileSync(join(userland(), "renderer.js"), "// evolved", "utf-8");
		const snap = snapshotIfChanged(userland())!;
		ensureUserland(company(), baseV2, "2.0.0");
		restoreVersion(userland(), snap, { dir: baseV2, version: "2.0.0" });

		expect(readdirSync(company()).sort()).toEqual(["company.md", "trail", "userland"]);
		expect(readFileSync(join(company(), "company.md"), "utf-8")).toBe("identity — never touched");
		expect(readdirSync(join(company(), "trail"))).toEqual(["session.jsonl"]);
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
