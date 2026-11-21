import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { validateReleaseManifest } from "./manifest.mjs";

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_64 = /^[0-9a-f]{64}$/;
const ACTIVATION_FILE = /^\d{14}_runtime_bundle_activation(?:_v\d+)?\.sql$/;
const REASON_SAFE = /^(?=.*[^ ])[A-Za-z0-9 ._:+()-]{1,200}$/;

export function readPrStateViaGh(prNumber, { repo = "Qorpera/Qorpera_Base", exec = execFileSync } = {}) {
	if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
		throw new Error(`Invalid PR number: ${prNumber}`);
	}
	if (typeof repo !== "string" || !REPO_SLUG.test(repo)) {
		throw new Error(`Invalid GitHub repository slug: ${repo}`);
	}
	const stdout = exec("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergeable"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	const parsed = JSON.parse(stdout);
	return {
		state: typeof parsed?.state === "string" ? parsed.state.trim() : "",
		mergeable: typeof parsed?.mergeable === "string" ? parsed.mergeable.trim() : "",
	};
}

export function buildRuntimeRollPacketArgs(
	manifest,
	{ activation, toSha, nodeAId, nodeBId, reason, outDir, repo = null, empty = "runs" },
) {
	validateReleaseManifest(manifest);
	if (manifest.mode === "sql-only") {
		throw new Error("sql-only manifests use writeSqlOnlyPackets, not runtime-roll.mjs");
	}
	if (manifest.releaseCommit === null) {
		throw new Error("releaseCommit must be set on the manifest before generating runtime-roll packets");
	}
	if (typeof activation !== "string" || !ACTIVATION_FILE.test(basename(activation))) {
		throw new Error(`Invalid activation migration file: ${activation}`);
	}
	if (typeof toSha !== "string" || !SHA_64.test(toSha) || toSha === manifest.previousBundleSha256) {
		throw new Error("toSha must be a 64-hex SHA-256 distinct from previousBundleSha256");
	}
	if (typeof nodeAId !== "string" || !UUID.test(nodeAId) || typeof nodeBId !== "string" || !UUID.test(nodeBId) || nodeAId === nodeBId) {
		throw new Error("nodeAId and nodeBId must be two distinct UUIDs");
	}
	if (typeof reason !== "string" || !REASON_SAFE.test(reason)) {
		throw new Error("reason must be 1-200 safe ASCII characters");
	}
	if (typeof outDir !== "string" || outDir.length === 0 || outDir.startsWith("-")) {
		throw new Error("outDir must be a non-empty path");
	}
	if (empty !== "runs" && empty !== "full") {
		throw new Error("empty must be 'runs' or 'full'");
	}
	const args = [
		"packets",
		"--ref",
		manifest.releaseCommit,
		"--activation",
		basename(activation),
		"--from-version",
		String(manifest.previousVersion),
		"--from-sha",
		manifest.previousBundleSha256,
		"--to-version",
		String(manifest.version),
		"--to-sha",
		toSha,
		"--node-a",
		nodeAId,
		"--node-b",
		nodeBId,
		"--reason",
		reason,
		"--empty",
		empty,
		"--out",
		outDir,
	];
	for (const migration of manifest.migrations) {
		args.push("--migration", basename(migration.file));
	}
	if (repo !== null) {
		if (typeof repo !== "string" || repo.length === 0 || repo.startsWith("-")) {
			throw new Error("repo must be a non-empty path");
		}
		args.push("--repo", repo);
	}
	return args;
}
