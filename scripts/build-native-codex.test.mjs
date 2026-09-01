import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeNativeCargoLock } from "./build-native-codex.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repository, "scripts/build-native-codex.mjs");

test("normalizes only release metadata for local workspace packages", () => {
	const source = `version = 4

[[package]]
name = "codex-core"
version = "0.0.0"
dependencies = ["external"]

[[package]]
name = "external"
version = "0.0.0"
source = "registry+https://example.invalid"
checksum = "unchanged"

[[package]]
name = "git-package"
version = "0.0.0"
source = "git+https://example.invalid/repo#fixed"
`;
	assert.deepEqual(normalizeNativeCargoLock(source, "0.147.0"), {
		lock: source.replace('name = "codex-core"\nversion = "0.0.0"', 'name = "codex-core"\nversion = "0.147.0"'),
		packages: 1,
	});
	assert.throws(() => normalizeNativeCargoLock(source.replace('name = "codex-core"\nversion = "0.0.0"',
		'name = "codex-core"\nversion = "0.146.0"'), "0.147.0"), /Unexpected upstream path package/);
	assert.throws(() => normalizeNativeCargoLock(source, '0.147.0"\nsource = "untrusted'), /Invalid lock/);
});

test("rejects ambiguous build arguments without touching the output", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-build-args-"));
	try {
		const sentinel = join(root, "keep.txt");
		await writeFile(sentinel, "KEEP");
		for (const args of [[], ["--source", root], ["--source", root, "--out", root, "--jobs", "0"],
			["--source", root, "--out", root, "--profile", "unknown"], ["--source", root, "--out", root, "--out", root],
			["--source", root, "--out", "relative"]]) {
			const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Usage:/);
			assert.equal(await readFile(sentinel, "utf8"), "KEEP");
		}
		const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0);
		assert.match(help.stdout, /--prepare-only/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
