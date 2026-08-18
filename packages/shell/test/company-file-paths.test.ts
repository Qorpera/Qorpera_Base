/**
 * File-mode path validation (Build 3): physical containment for the paths
 * the desktop host opens outside the sandbox — symlinks must not smuggle
 * `sendFile` reads or `saveTo` writes past the company folder or into
 * host-protected territory.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompanyFileResolver } from "../src/company-file-paths.ts";

const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

let tempDir: string;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		tempDir = "";
	}
});

function harness() {
	tempDir = mkdtempSync(join(tmpdir(), "qorpera-file-paths-"));
	const root = join(tempDir, "company");
	const outside = join(tempDir, "outside");
	mkdirSync(join(root, "trail"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	const resolve = createCompanyFileResolver(root, [join(root, "trail")]);
	return { root, outside, resolve };
}

describe("createCompanyFileResolver", () => {
	it("resolves ordinary paths inside the company folder", () => {
		const { root, resolve } = harness();
		expect(resolve(join("docs", "report.pdf"), "write")).toBe(join(realpathSync(root), "docs", "report.pdf"));
		writeFileSync(join(root, "notes.txt"), "hello");
		expect(resolve("notes.txt", "read")).toBe(join(realpathSync(root), "notes.txt"));
	});

	it("rejects lexical escapes and the root itself", () => {
		const { resolve } = harness();
		expect(() => resolve(join("..", "escape.txt"), "write")).toThrow(/must stay inside the company folder/);
		expect(() => resolve(".", "write")).toThrow(/must stay inside the company folder/);
	});

	it("rejects reads and writes through a symlinked directory pointing outside", () => {
		const { root, outside, resolve } = harness();
		writeFileSync(join(outside, "host-secret.txt"), "secret");
		symlinkSync(outside, join(root, "linked"), directoryLinkType);
		expect(() => resolve(join("linked", "host-secret.txt"), "read")).toThrow(/outside the company folder/);
		expect(() => resolve(join("linked", "planted.txt"), "write")).toThrow(/outside the company folder/);
	});

	it("allows symlinked directories that stay inside the company folder", () => {
		const { root, resolve } = harness();
		mkdirSync(join(root, "real-docs"));
		symlinkSync(join(root, "real-docs"), join(root, "docs"), directoryLinkType);
		expect(resolve(join("docs", "file.txt"), "write")).toBe(join(realpathSync(root), "real-docs", "file.txt"));
	});

	it("rejects writes routed into protected territory through a symlink", () => {
		const { root, resolve } = harness();
		symlinkSync(join(root, "trail"), join(root, "innocent"), directoryLinkType);
		expect(() => resolve(join("innocent", "session.jsonl"), "write")).toThrow(/host-protected territory/);
		expect(() => resolve(join("trail", "session.jsonl"), "write")).toThrow(/host-protected territory/);
	});

	it.skipIf(process.platform === "win32")("rejects a file symlink whose target is outside", () => {
		const { root, outside, resolve } = harness();
		writeFileSync(join(outside, "target.txt"), "data");
		symlinkSync(join(outside, "target.txt"), join(root, "alias.txt"));
		expect(() => resolve("alias.txt", "read")).toThrow(/outside the company folder/);
		expect(() => resolve("alias.txt", "write")).toThrow(/outside the company folder/);
	});

	it.skipIf(process.platform === "win32")("fails closed on dangling symlinks", () => {
		const { root, outside, resolve } = harness();
		// The link's target does not exist yet: a write would CREATE it outside.
		symlinkSync(join(outside, "not-yet.txt"), join(root, "dangling.txt"));
		expect(() => resolve("dangling.txt", "write")).toThrow(/broken link/);
	});

	it("works when the company root itself is reached through a link", () => {
		const { root } = harness();
		const alias = join(tempDir, "root-alias");
		symlinkSync(root, alias, directoryLinkType);
		const resolve = createCompanyFileResolver(alias, [join(alias, "trail")]);
		expect(resolve("file.txt", "write")).toBe(join(realpathSync(root), "file.txt"));
		expect(() => resolve(join("trail", "x.jsonl"), "write")).toThrow(/host-protected territory/);
		expect(() => resolve(`..${sep}escape.txt`, "write")).toThrow(/must stay inside the company folder/);
	});
});
