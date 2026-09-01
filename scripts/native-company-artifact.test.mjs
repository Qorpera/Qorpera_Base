import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyNativeCompanyArtifact } from "./native-company-artifact.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-artifact-test-"));
	const source = JSON.parse(await readFile(join(repository, "deploy/first-node/native-codex/source.json"), "utf-8"));
	// Synthetic bytes test packaging only. They are never executed or passed off as a cloud binary.
	const binary = Buffer.from("synthetic packaging fixture\n");
	const artifact = {
		schema: "qorpera.native-codex-artifact/v1", source,
		artifact: { file: "codex", bytes: binary.length, sha256: createHash("sha256").update(binary).digest("hex"),
			target: "x86_64-unknown-linux-gnu", profile: "release", compiler: `rustc ${source.rustToolchain} (fixture)\nhost: x86_64-unknown-linux-gnu\n` },
		cloudAcceptance: "not_performed",
	};
	await writeFile(join(root, "codex"), binary);
	await writeFile(join(root, "artifact.json"), JSON.stringify(artifact));
	await writeFile(join(root, "LICENSE"), "fixture license, not a distributed native binary\n");
	await writeFile(join(root, "NOTICE"), "fixture notice\n");
	return { root, artifact };
}

test("packages the explicit native release artifact and retains its source and notices", async () => {
	const { root, artifact } = await fixture();
	const output = await mkdtemp(join(tmpdir(), "qorpera-native-package-test-"));
	try {
		const verified = await verifyNativeCompanyArtifact(root);
		assert.equal(verified.contract.binarySha256, artifact.artifact.sha256);
		const result = spawnSync(process.execPath, ["scripts/package-lxd-runner-guest.mjs", "--out", output,
			"--contract-only", "--native-company-artifact", root], { cwd: repository, encoding: "utf-8" });
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf-8"));
		assert.deepEqual(manifest.nativeCompany, verified.contract);
		for (const name of ["codex", "artifact.json", "LICENSE", "NOTICE"]) {
			assert.ok(manifest.artifacts.some((item) => item.file === `native-company/${name}`));
			assert.deepEqual(await readFile(join(output, "native-company", name)), await readFile(join(root, name)));
		}
		assert.equal(manifest.nativeCompany.profile, "release");
	} finally {
		await rm(output, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects development artifacts before modifying an output directory", async () => {
	const { root, artifact } = await fixture();
	const output = await mkdtemp(join(tmpdir(), "qorpera-native-rejected-package-"));
	try {
		artifact.artifact.profile = "dev";
		await writeFile(join(root, "artifact.json"), JSON.stringify(artifact));
		await writeFile(join(output, "keep"), "KEEP");
		const result = spawnSync(process.execPath, ["scripts/package-lxd-runner-guest.mjs", "--out", output,
			"--contract-only", "--native-company-artifact", root], { cwd: repository, encoding: "utf-8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /pinned Linux x64 release artifact/);
		assert.equal(await readFile(join(output, "keep"), "utf-8"), "KEEP");
	} finally {
		await rm(output, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects changed source, target, compiler, bytes, symlinks, and missing notices", async () => {
	const { root, artifact } = await fixture();
	try {
		for (const mutate of [
			(value) => { value.source.patchSha256 = "f".repeat(64); },
			(value) => { value.artifact.target = "aarch64-apple-darwin"; },
			(value) => { value.artifact.compiler = "rustc 1.90.0 (fixture)\nhost: x86_64-unknown-linux-gnu"; },
			(value) => { value.artifact.sha256 = "f".repeat(64); },
		]) {
			const bad = structuredClone(artifact);
			mutate(bad);
			await writeFile(join(root, "artifact.json"), JSON.stringify(bad));
			await assert.rejects(verifyNativeCompanyArtifact(root), /release artifact|checksum/);
		}
		await writeFile(join(root, "artifact.json"), JSON.stringify(artifact));
		await rm(join(root, "NOTICE"));
		await assert.rejects(verifyNativeCompanyArtifact(root), /ENOENT/);
		await symlink(join(root, "LICENSE"), join(root, "NOTICE"));
		await assert.rejects(verifyNativeCompanyArtifact(root), /unsafe or incomplete/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("never erases its native artifact source through overlapping output", async () => {
	const { root } = await fixture();
	try {
		const result = spawnSync(process.execPath, ["scripts/package-lxd-runner-guest.mjs", "--out", root,
			"--contract-only", "--native-company-artifact", root], { cwd: repository, encoding: "utf-8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /must not contain a source artifact directory/);
		assert.ok((await readFile(join(root, "codex"))).length > 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("detects source/output overlap through physical directory aliases", async () => {
	const { root } = await fixture();
	const aliases = await mkdtemp(join(tmpdir(), "qorpera-native-package-alias-"));
	try {
		const alias = join(aliases, "source");
		await symlink(root, alias, "dir");
		for (const [output, source] of [[alias, root], [root, alias]]) {
			const result = spawnSync(process.execPath, ["scripts/package-lxd-runner-guest.mjs", "--out", output,
				"--contract-only", "--native-company-artifact", source], { cwd: repository, encoding: "utf-8" });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /must not contain a source artifact directory/);
			assert.ok((await readFile(join(root, "codex"))).length > 0);
		}
	} finally {
		await rm(aliases, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});
