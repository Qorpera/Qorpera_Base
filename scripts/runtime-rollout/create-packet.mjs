// Creates a disabled, reviewable packet. Never invokes a database or issues approval.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requiredKeys = ["project", "company", "environment", "owner", "identity", "clientIdentity", "registry", "logical",
	"head", "tree", "fileCount", "totalBytes", "source", "commit", "bundle", "previousBundle", "lifecycleDefinition",
	"baselineEvidence", "baselineSha256", "preflightEvidence", "preflightSha256", "predecessorPacketSha256",
	"pauseReason", "policyVersionBefore", "policyVersionPaused", "concurrency", "initialEnablement", "initialReason",
	"activationVersion", "bundleVersion", "previousBundleVersion", "manifestSha256", "cliPath"];

function readOwned(path) {
	const stat = lstatSync(path);
	assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o022), "Unsafe input file");
	assert(stat.size > 0 && stat.size <= 4 * 1024 * 1024, "Input size rejected");
	return readFileSync(path);
}

export function createPacket(specification, output) {
	assert(isAbsolute(output) && resolve(output) === output, "Output must be an absolute canonical path");
	assert.equal(realpathSync(dirname(output)), dirname(output), "Output parent must be canonical");
	const fixed = JSON.parse(readOwned(specification));
	assert.deepEqual(Object.keys(fixed).sort(), requiredKeys.toSorted(), "Specification keys changed");
	assert.equal(fixed.project, "wovsmjvghnbcbfazdtvr", "Only the reviewed Company41 project is supported");
	assert.equal(fixed.company, "88227549-9724-43c2-8966-9fafb3e855d6");
	assert.equal(fixed.environment, "0d2053f0-c1a8-444d-99a8-68c8214e5414");
	for (const key of ["company", "environment", "owner", "identity", "clientIdentity", "registry", "logical", "head"])
		assert.match(fixed[key], /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
	for (const key of ["tree", "bundle", "previousBundle", "lifecycleDefinition", "baselineSha256", "preflightSha256", "predecessorPacketSha256", "manifestSha256"])
		assert.match(fixed[key], /^[a-f0-9]{64}$/);
	assert.match(fixed.commit, /^[a-f0-9]{40}$/);
	assert.match(fixed.activationVersion, /^\d{14}$/);
	for (const key of ["source", "baselineEvidence", "preflightEvidence", "cliPath"])
		assert(typeof fixed[key] === "string" && isAbsolute(fixed[key]) && resolve(fixed[key]) === fixed[key], `Invalid ${key}`);
	for (const key of ["fileCount", "totalBytes", "policyVersionBefore", "policyVersionPaused", "bundleVersion", "previousBundleVersion"])
		assert(Number.isSafeInteger(fixed[key]) && fixed[key] > 0, `Invalid ${key}`);
	assert.equal(fixed.concurrency, 64);
	assert.equal(fixed.policyVersionPaused, fixed.policyVersionBefore + 1);
	assert.equal(fixed.bundleVersion, fixed.previousBundleVersion + 1);
	assert.notEqual(fixed.bundle, fixed.previousBundle);
	assert(["enabled", "disabled"].includes(fixed.initialEnablement));
	assert(fixed.initialEnablement === "enabled" ? fixed.initialReason === null : typeof fixed.initialReason === "string" && fixed.initialReason.length > 0);
	assert(typeof fixed.pauseReason === "string" && fixed.pauseReason.length > 0 && fixed.pauseReason.length <= 1000);
	assert.notEqual(fixed.pauseReason, fixed.initialReason);
	const baselineBytes = readOwned(fixed.baselineEvidence);
	assert.equal(sha(baselineBytes), fixed.baselineSha256);
	assert.equal(sha(readOwned(fixed.preflightEvidence)), fixed.preflightSha256);
	const baseline = JSON.parse(baselineBytes)[0].r;
	assert.equal(baseline.activeBundle, fixed.previousBundle);
	assert(Array.isArray(baseline.versions) && baseline.versions.length === baseline.count);
	assert(baseline.versions.every((version) => /^\d{14}$/.test(version)));
	assert.deepEqual(baseline.versions, [...new Set(baseline.versions)].sort());
	const names = readdirSync(join(fixed.source, "supabase/migrations")).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
	assert.equal(new Set(names.map((name) => name.slice(0, 14))).size, names.length, "Duplicate source migration version");
	const inputs = {
		baselineVersions: baseline.versions,
		productionOnly: baseline.versions.filter((version) => !names.some((name) => name.startsWith(`${version}_`))),
		migrations: names.filter((name) => !baseline.versions.includes(name.slice(0, 14))).map((file) => {
			const bytes = readOwned(join(fixed.source, "supabase/migrations", file));
			return { file, version: file.slice(0, 14), bytes: bytes.length, sha256: sha(bytes) };
		}),
	};
	assert.equal(inputs.productionOnly.length, 18, "Historical production-only ledger must be retained");
	assert(inputs.migrations.length > 0 && inputs.migrations.at(-1).version === fixed.activationVersion, "Activation must be the final new migration");
	fixed.baselineCount = baseline.count;
	fixed.sourceMigrationCount = names.length;
	fixed.migrationCount = inputs.migrations.length;
	mkdirSync(output, { mode: 0o700 });
	const write = (name, value) => writeFileSync(join(output, name), value, { mode: 0o600, flag: "wx" });
	for (const name of readdirSync(join(toolsRoot, "templates"))) {
		let bytes = readOwned(join(toolsRoot, "templates", name));
		if (name === "contract.mjs") bytes = Buffer.from(bytes.toString().replace(
			"Object.freeze(null); // Materialized by create-packet.mjs.", `Object.freeze(${JSON.stringify(fixed, null, 2)});`));
		write(name, bytes);
	}
	write("inputs.json", `${JSON.stringify(inputs, null, 2)}\n`);
	execFileSync(process.execPath, [join(output, "build-packet.mjs"), "build"], {
		env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
	});
	const packetSha256 = sha(readOwned(join(output, "packet.json")));
	const pins = Object.fromEntries(["contract.mjs", "files.mjs", "sql-packet.mjs", "build-packet.mjs", "transport.mjs", "inputs.json"].map((name) => [name, sha(readOwned(join(output, name)))]));
	const controller = readOwned(join(output, "controller.mjs")).toString()
		.replace("export const PACKET_SHA256 = null;", `export const PACKET_SHA256 = '${packetSha256}';`)
		.replace("export const LOCAL_PINS = Object.freeze({});", `export const LOCAL_PINS = Object.freeze(${JSON.stringify(pins, null, 2)});`);
	writeFileSync(join(output, "controller.mjs"), controller, { mode: 0o600 });
	execFileSync(process.execPath, [join(output, "controller.mjs"), "check"], {
		env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
	});
	return { passed: true, output, packetSha256, migrations: inputs.migrations.length, executionEnabled: false, productionWrites: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		assert.equal(process.argv.length, 4, "Usage: node create-packet.mjs specification.json /absolute/new-packet");
		console.log(JSON.stringify(createPacket(process.argv[2], process.argv[3])));
	} catch (error) {
		console.error(JSON.stringify({ passed: false, code: "PACKET_CREATION_REJECTED", reason: error instanceof Error ? error.message.split("\n")[0] : "Unknown error", productionWrites: false }));
		process.exitCode = 1;
	}
}
