import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guard = resolve(dirname(fileURLToPath(import.meta.url)), "check-release-train-derived-files.mjs");
const generator = (version, template) =>
	`const activation = "supabase/migrations/20260926035100_runtime_bundle_activation_v${version}.sql";\n` +
	`const activationVersion = ${version};\nconst previousActivationVersion = ${version - 1};\n` +
	`const previousActivationSha256 = "${"a".repeat(64)}";\nconst template = "${template}";\n`;

test("fails a feature pull request that touches release-owned runtime bundle files", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-release-train-guard-"));
	const git = (...args) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd: root, encoding: "utf8" },
		);
	const write = async (path, text) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	};
	const check = () => spawnSync(process.execPath, [guard, "base", "HEAD"], { cwd: root, encoding: "utf8" });
	try {
		git("init", "-q", "-b", "base");
		await write("scripts/generate-cloud-runtime-bundle.mjs", generator(129, "guard A"));
		await write("packages/runtime/src/cloud-runtime-bundle.generated.ts", "// v129\n");
		await write("packages/runtime/src/cloud-native-company-context.ts", "export const a = 1;\n");
		git("add", ".");
		git("commit", "-q", "-m", "base");

		const branch = async (name, edits) => {
			git("checkout", "-q", "-b", name, "base");
			for (const [path, text] of edits) await write(path, text);
			git("add", ".");
			git("commit", "-q", "-m", name);
			return check();
		};
		// Source changes, new plain migrations and generator logic are feature work.
		const feature = await branch("feature", [
			["packages/runtime/src/cloud-native-company-context.ts", "export const a = 2;\n"],
			["supabase/migrations/20260926210000_feature.sql", "select 1;\n"],
			["scripts/generate-cloud-runtime-bundle.mjs", generator(129, "guard B")],
		]);
		assert.equal(feature.status, 0, feature.stderr);
		assert.match(feature.stdout, /No release-owned runtime bundle files changed \(3 files checked\)/);

		for (const [name, path, text, reported] of [
			["generated", "packages/runtime/src/cloud-runtime-bundle.generated.ts", "// v130\n"],
			["manifest", "deploy/first-node/native-codex/runtime-bundle-manifest.json", "{}\n"],
			["pin", "deploy/first-node/native-codex/guest-package-manifest.json", "{}\n"],
			["activation", "supabase/migrations/20260926220000_runtime_bundle_activation_v130.sql", "select 1;\n"],
			[
				"version",
				"scripts/generate-cloud-runtime-bundle.mjs",
				generator(130, "guard A"),
				"scripts/generate-cloud-runtime-bundle.mjs (bundle version lines)",
			],
		]) {
			const result = await branch(name, [[path, text]]);
			assert.equal(result.status, 1, `${name}: ${result.stdout}`);
			assert.ok(result.stderr.includes(`  ${reported ?? path}\n`), result.stderr);
			assert.match(result.stderr, /deploy\/first-node\/RUNTIME-RELEASE-TRAIN\.md/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
