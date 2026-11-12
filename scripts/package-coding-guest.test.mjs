import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CODING_GUEST_HELPER_MAX_BYTES } from "../packages/contracts/src/cloud-coding-command.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packager = join(repositoryRoot, "scripts", "package-coding-guest.mjs");
const HELPERS = [
	["cloud-coding-storage-guest-main.ts", "cloud-coding-storage-guest.mjs"],
	["cloud-coding-command-guest.ts", "cloud-coding-command-guest.mjs"],
	["cloud-coding-git-guest.ts", "cloud-coding-git-guest.mjs"],
	["cloud-coding-watchdog-main.ts", "cloud-coding-watchdog.mjs"],
];

function packageGuest(cwd, output) {
	return spawnSync(process.execPath, [packager, "--out", output], { cwd, encoding: "utf-8" });
}

test("packages the four coding guest helpers, each within the bound the executor reads it with", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-coding-guest-package-test-"));
	try {
		const output = join(root, "out");
		const packaged = packageGuest(repositoryRoot, output);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf-8"));
		assert.equal(manifest.schema, "qorpera.coding-guest-package/v1");
		assert.deepEqual(
			manifest.artifacts.map(({ file }) => file),
			HELPERS.map(([, file]) => file),
		);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(output, artifact.file));
			assert.equal(artifact.bytes, bytes.length);
			assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
			assert.ok(bytes.length <= CODING_GUEST_HELPER_MAX_BYTES, `${artifact.file} is ${bytes.length} bytes`);
			assert.equal(artifact.installedPath, `/opt/qorpera-coding/${artifact.file}`);
			// What only the executor and the guest agent use stays out of the helpers (contracts' package caches).
			assert.ok(!bytes.includes("/var/cache/qorpera-packages"), `${artifact.file} bundles the package caches`);
			console.log(`coding guest helper ${artifact.file}: ${bytes.length} bytes`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("takes a helper past 64 KiB and refuses one past the helpers' bound, writing nothing of it", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-coding-guest-package-test-"));
	try {
		// Stand-in sources, each a program of a chosen size, beside the real installation record.
		const tree = async (name, sizes) => {
			const at = join(root, name);
			await mkdir(join(at, "packages", "runtime", "src"), { recursive: true });
			await mkdir(join(at, "deploy", "coding-worker"), { recursive: true });
			await copyFile(
				join(repositoryRoot, "deploy", "coding-worker", "command-guest-installation.json"),
				join(at, "deploy", "coding-worker", "command-guest-installation.json"),
			);
			for (const [index, [source]] of HELPERS.entries())
				await writeFile(
					join(at, "packages", "runtime", "src", source),
					`export const data = "${"a".repeat(sizes[index])}";\nconsole.log(data.length);\n`,
				);
			return at;
		};
		const large = await tree("large", [1000, 100_000, 1000, 1000]);
		const taken = packageGuest(large, join(large, "out"));
		assert.equal(taken.status, 0, taken.stderr);
		const manifest = JSON.parse(await readFile(join(large, "out", "manifest.json"), "utf-8"));
		const command = manifest.artifacts.find(({ file }) => file === "cloud-coding-command-guest.mjs");
		assert.ok(command.bytes > 65536 && command.bytes <= CODING_GUEST_HELPER_MAX_BYTES, `${command.bytes} bytes`);
		const over = await tree("over", [1000, CODING_GUEST_HELPER_MAX_BYTES, 1000, 1000]);
		const refused = packageGuest(over, join(over, "out"));
		assert.notEqual(refused.status, 0);
		assert.match(
			refused.stderr,
			/Coding guest artifact exceeds protected transport bound: cloud-coding-command-guest\.mjs/,
		);
		assert.ok(!(await readdir(join(over, "out"))).includes("manifest.json"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
