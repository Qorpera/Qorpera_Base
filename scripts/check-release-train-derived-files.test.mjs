import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guard = resolve(dirname(fileURLToPath(import.meta.url)), "check-release-train-derived-files.mjs");
const generatorPath = "scripts/generate-cloud-runtime-bundle.mjs";
// `declare` sets how the version lines are written (const, let, var, export,
// indented); `activationTemplate` is not a version line although its name
// starts alike. `blank` inserts a blank line between version lines.
const generator = (version, template, declare = (name) => `const ${name}`, blank = "") =>
	`${declare("activation")} = "supabase/migrations/20260926035100_runtime_bundle_activation_v${version}.sql";\n` +
	`${blank}${declare("activationVersion")} = ${version};\n${declare("previousActivationVersion")} = ${version - 1};\n` +
	`${declare("previousActivationSha256")} = "${"a".repeat(64)}";\nconst activationTemplate = "${template}";\n`;

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
	const commit = async (name, from, edits) => {
		git("checkout", "-q", "-b", name, from);
		for (const [path, text] of edits) await write(path, text);
		git("add", ".");
		git("commit", "-q", "-m", name);
	};
	const check = (base, head) => spawnSync(process.execPath, [guard, base, head], { cwd: root, encoding: "utf8" });
	const assertRefused = (result, name, reported) => {
		assert.equal(result.status, 1, `${name}: ${result.stdout}`);
		assert.ok(result.stderr.includes(`  ${reported}\n`), result.stderr);
		assert.match(result.stderr, /deploy\/first-node\/RUNTIME-RELEASE-TRAIN\.md/);
	};
	try {
		git("init", "-q", "-b", "empty");
		git("commit", "-q", "--allow-empty", "-m", "empty");
		await commit("base", "empty", [
			[generatorPath, generator(129, "guard A")],
			["packages/runtime/src/cloud-runtime-bundle.generated.ts", "// v129\n"],
			["packages/runtime/src/cloud-native-company-context.ts", "export const a = 1;\n"],
		]);

		// Source changes, new plain migrations and generator logic (including a
		// blank line or indentation around unchanged version lines) are feature work.
		await commit("feature", "base", [
			["packages/runtime/src/cloud-native-company-context.ts", "export const a = 2;\n"],
			["supabase/migrations/20260926210000_feature.sql", "select 1;\n"],
			[generatorPath, generator(129, "guard B", (name) => `\tconst ${name}`, "\n")],
		]);
		const feature = check("base", "feature");
		assert.equal(feature.status, 0, feature.stderr);
		assert.match(feature.stdout, /No release-owned runtime bundle files changed \(3 files checked\)/);

		for (const [name, path, text] of [
			["generated", "packages/runtime/src/cloud-runtime-bundle.generated.ts", "// v130\n"],
			["manifest", "deploy/first-node/native-codex/runtime-bundle-manifest.json", "{}\n"],
			["pin", "deploy/first-node/native-codex/guest-package-manifest.json", "{}\n"],
			["activation", "supabase/migrations/20260926220000_runtime_bundle_activation_v130.sql", "select 1;\n"],
		]) {
			await commit(name, "base", [[path, text]]);
			assertRefused(check("base", name), name, path);
		}

		// A version bump is refused however the version lines are declared; each
		// style gets its own base so only the version changes.
		for (const [name, declare] of [
			["const", (name) => `const ${name}`],
			["let", (name) => `\tlet ${name}`],
			["var", (name) => `var ${name}`],
			["export", (name) => `export const ${name}`],
		]) {
			await commit(`${name}-base`, "empty", [[generatorPath, generator(129, "guard A", declare)]]);
			await commit(`${name}-bump`, `${name}-base`, [[generatorPath, generator(130, "guard A", declare)]]);
			assertRefused(check(`${name}-base`, `${name}-bump`), name, `${generatorPath} (bundle version lines)`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
