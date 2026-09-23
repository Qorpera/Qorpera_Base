#!/usr/bin/env node
// Builds and signs a node release folder (phase B): release.json, release.sig and the listed files.
//   node make-release.mjs --spec <spec.json> --key <ed25519 private key, PKCS#8 PEM> --out <new folder>
// spec: { revision, previousRevision, sourceCommit, runtimeBundleSha256, order,
//         files: { <name>: <path> }, roles: { <role>: { component: <name>, env: { KEY: value } } } }
// Values may use ${release}, which the launcher replaces with the release folder on the node.

import { createHash, createPrivateKey, sign } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRelease } from "./qorpera-node-agent.mjs";

export async function buildRelease(spec, privateKeyPem, out) {
	const files = [];
	for (const [name, path] of Object.entries(spec.files)) {
		const content = await readFile(path);
		files.push({ name, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length });
	}
	const release = {
		schema: "qorpera.node-release/v1",
		revision: spec.revision,
		previousRevision: spec.previousRevision,
		sourceCommit: spec.sourceCommit,
		runtimeBundleSha256: spec.runtimeBundleSha256,
		order: spec.order,
		files,
		roles: spec.roles,
	};
	const bytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
	parseRelease(bytes);
	await mkdir(out, { mode: 0o755 });
	await writeFile(join(out, "release.json"), bytes, { flag: "wx" });
	await writeFile(join(out, "release.sig"), `${sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64")}\n`, {
		flag: "wx",
	});
	for (const [name, path] of Object.entries(spec.files)) await copyFile(path, join(out, name));
	return release;
}

async function main(argv) {
	const option = (name) => argv[argv.indexOf(name) + 1];
	const spec = JSON.parse(await readFile(option("--spec"), "utf8"));
	const release = await buildRelease(spec, await readFile(option("--key"), "utf8"), option("--out"));
	process.stdout.write(`${JSON.stringify({ revision: release.revision, files: release.files })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`make-release: ${error.message}\n`);
		process.exit(1);
	});
}
