import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	foundingNativePackageEnvironment,
	foundingNativePackageOptions,
	verifyFoundingNativePackage,
} from "./founding-native-package.mjs";

test("isolated packaging requires bootable immutable inputs and disjoint output", () => {
	const args = [
		"--out",
		"/tmp/founding-package",
		"--signed-runner-image",
		"/opt/signed-image",
		"--native-company-artifact",
		"/opt/native-codex",
	];
	assert.deepEqual(foundingNativePackageOptions(args), {
		out: "/tmp/founding-package",
		signedImage: "/opt/signed-image",
		nativeArtifact: "/opt/native-codex",
	});
	for (const invalid of [
		args.slice(0, 4),
		[...args, "--contract-only", "true"],
		[...args, "--out", "/tmp/other"],
		["--out", "/opt", ...args.slice(2)],
		["--out", "/opt/native-codex/output", ...args.slice(2)],
		["--out", "/tmp/../package", ...args.slice(2)],
	])
		assert.throws(() => foundingNativePackageOptions(invalid));
});

test("only the reviewed test hook is inherited; strict production enforcement receives no bypass", () => {
	const testEnvironment = foundingNativePackageEnvironment({ PATH: "/usr/bin" });
	assert.match(
		testEnvironment.NODE_OPTIONS,
		/^--import=file:.*scripts\/fixtures\/committed-runtime-bundle\/register\.mjs$/,
	);
	const enforced = { PATH: "/usr/bin", QORPERA_ENFORCE_RUNTIME_BUNDLE: "1" };
	assert.deepEqual(foundingNativePackageEnvironment(enforced), enforced);
	assert.equal(foundingNativePackageEnvironment(enforced).NODE_OPTIONS, undefined);
	for (const QORPERA_ENFORCE_RUNTIME_BUNDLE of [undefined, "1"])
		assert.throws(
			() =>
				foundingNativePackageEnvironment({
					QORPERA_ENFORCE_RUNTIME_BUNDLE,
					NODE_OPTIONS: "--import=/tmp/untrusted.mjs",
				}),
			/Inherited NODE_OPTIONS/,
		);
});

test("package evidence requires actual matching native and signed-image bytes, never contract-only metadata", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "founding-package-")));
	try {
		const directory = join(root, "package");
		await mkdir(join(directory, "native-company"), { recursive: true });
		await mkdir(join(directory, "runner-image"));
		const files = ["native-company/codex", "runner-image/image.tar", "runner-image/signature.json"];
		const artifacts = [];
		for (const file of files) {
			const bytes = Buffer.from(`fixture:${file}`);
			await writeFile(join(directory, file), bytes);
			artifacts.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
		}
		const manifest = {
			schema: "qorpera.lxd-runner-guest-package/v1",
			platform: "linux-x64",
			nativeCompany: { schema: "qorpera.native-company-guest/v1" },
			runnerImage: { archive: { file: files[1] }, cosign_bundle: { file: files[2] } },
			artifacts,
		};
		const save = (value) => writeFile(join(directory, "manifest.json"), JSON.stringify(value));
		await save(manifest);
		assert.deepEqual(await verifyFoundingNativePackage(directory), {
			artifacts: 3,
			sha256: createHash("sha256")
				.update(await readFile(join(directory, "manifest.json")))
				.digest("hex"),
		});
		await writeFile(join(directory, files[0]), "tampered");
		await assert.rejects(verifyFoundingNativePackage(directory));
		await writeFile(join(directory, files[0]), `fixture:${files[0]}`);
		await save({ ...manifest, artifacts: artifacts.slice(0, 2) });
		await assert.rejects(verifyFoundingNativePackage(directory), /Bootable pinned/);
		await save({ ...manifest, artifacts: [...artifacts, artifacts[0]] });
		await assert.rejects(verifyFoundingNativePackage(directory), /duplicate/);
		await save({ ...manifest, artifacts: [{ ...artifacts[0], file: "../escape" }, ...artifacts.slice(1)] });
		await assert.rejects(verifyFoundingNativePackage(directory), /Unsafe/);
		await save(manifest);
		await rm(join(directory, files[0]));
		await writeFile(join(root, "outside"), `fixture:${files[0]}`);
		await symlink(join(root, "outside"), join(directory, files[0]));
		await assert.rejects(verifyFoundingNativePackage(directory));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
