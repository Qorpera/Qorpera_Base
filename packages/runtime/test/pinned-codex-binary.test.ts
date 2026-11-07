import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pinnedCodexBinary } from "./fixtures/pinned-codex-binary.ts";

describe("the file the real-binary tests run", () => {
	const directory = mkdtempSync(join(tmpdir(), "pinned-codex-"));
	const file = join(directory, "codex");
	writeFileSync(file, "a build\n");
	const pin = createHash("sha256").update("a build\n").digest("hex");
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it("is none when the variable is unset, so the tests skip", () => {
		expect(pinnedCodexBinary({}, pin)).toBeUndefined();
	});
	it("is the pinned build", () => {
		expect(pinnedCodexBinary({ QORPERA_CODEX_FENCE_BINARY: file }, pin)).toBe(file);
	});
	it("refuses another build, and a path with no file", () => {
		expect(() => pinnedCodexBinary({ QORPERA_CODEX_FENCE_BINARY: file }, "0".repeat(64))).toThrow(
			/not the pinned build/,
		);
		expect(() => pinnedCodexBinary({ QORPERA_CODEX_FENCE_BINARY: join(directory, "none") }, pin)).toThrow(
			/names no file/,
		);
	});
	it("lets a build that is not yet the pin run only when told to", () => {
		const env = { QORPERA_CODEX_FENCE_BINARY: file, QORPERA_CODEX_FENCE_UNPINNED: "1" };
		expect(pinnedCodexBinary(env, "0".repeat(64))).toBe(file);
		expect(() => pinnedCodexBinary({ ...env, QORPERA_CODEX_FENCE_BINARY: join(directory, "none") }, pin)).toThrow(
			/names no file/,
		);
	});
	it("takes the pin from the guest package manifest", () => {
		const manifest = readFileSync(
			new URL("../../../deploy/first-node/native-codex/guest-package-manifest.json", import.meta.url),
			"utf8",
		);
		const pinned = JSON.parse(manifest).nativeCompany.binarySha256;
		expect(pinned).toMatch(/^[0-9a-f]{64}$/);
		expect(() => pinnedCodexBinary({ QORPERA_CODEX_FENCE_BINARY: file })).toThrow(pinned);
	});
});
