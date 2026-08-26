#!/usr/bin/env node
/* Creates and signs the Company Computer image provenance from the Mac.
 * Usage: node sign-provenance.mjs <image-fingerprint> <evidence-sha256> <tested-at-iso>
 * The Keychain item holds the Ed25519 key as base64url PKCS8 DER; it is
 * reconstructed in-process, written to a 0600 temp file for the CLI, and
 * removed immediately after. Nothing secret is printed. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [fingerprint, evidenceSha, testedAt] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(fingerprint ?? "") || !/^[0-9a-f]{64}$/.test(evidenceSha ?? "") || !testedAt) {
	throw new Error("usage: sign-provenance.mjs <fingerprint> <evidence-sha256> <tested-at>");
}
const repo = dirname(dirname(dirname(fileURLToPath(new URL(import.meta.url)))));
/* Build the tool first: npm run pack:lxd-provider */
const tool = process.env.QORPERA_PROVENANCE_TOOL ?? join(repo, ".artifacts/lxd-provider/qorpera-lxd-image-provenance.mjs");
const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "--untracked-files=all"], {
	encoding: "utf-8",
}).trim();
if (dirty) throw new Error("The tree is not clean; commit before signing");

const body = execFileSync(
	"security",
	["find-generic-password", "-w", "-s", "com.qorpera.company41.lxd-image-provenance", "-a", "jonas"],
	{ encoding: "utf-8" },
).trim();
const der = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;

const work = mkdtempSync(join(tmpdir(), "qorpera-provenance-"));
try {
	const keyPath = join(work, "signing-key.pem");
	writeFileSync(keyPath, pem, { mode: 0o600 });
	const statementPath = join(work, "statement.json");
	const outputPath = join(work, "lxd-company-image-provenance.json");
	const run = (args) => {
		const result = spawnSync("node", [tool, ...args], { encoding: "utf-8" });
		if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr.slice(0, 500)}`);
	};
	run([
		"create",
		"--image-server", "local",
		"--image-fingerprint", fingerprint,
		"--base-image-fingerprint", "7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f",
		"--guest-package-manifest-sha256", "acd2cd013361a66fdd56e61b30ecaa3807c8da0610db33ba48b3c6a660fbb1f0",
		"--runner-image",
		"localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1",
		"--runner-image-archive-sha256", "c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239",
		"--runner-image-cosign-bundle-sha256", "98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce",
		"--source-repository", "https://github.com/Qorpera/Qorpera_Base.git",
		"--source-commit", commit,
		"--source-tree", "clean",
		"--tested-at", testedAt,
		"--acceptance-evidence-sha256", evidenceSha,
		"--output", statementPath,
	]);
	run(["sign", "--statement", statementPath, "--private-key", keyPath, "--output", outputPath]);
	const scp = spawnSync("scp", ["-q", outputPath, "company41-node-01:step3-lxd/lxd-company-image-provenance.json"], {
		encoding: "utf-8",
	});
	if (scp.status !== 0) throw new Error(`scp failed: ${scp.stderr.slice(0, 300)}`);
	console.log(`signed provenance for ${fingerprint} at commit ${commit}, staged to the node`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
