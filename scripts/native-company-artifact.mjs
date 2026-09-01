import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** Packaging validation, not remote attestation or a substitute for the image signer. */
export async function verifyNativeCompanyArtifact(directory) {
	const root = await realpath(directory);
	const metadata = await lstat(join(root, "artifact.json"));
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
		throw new Error("Native company artifact metadata is unsafe");
	}
	const artifact = JSON.parse(await readFile(join(root, "artifact.json"), "utf-8"));
	const source = JSON.parse(await readFile(join(repository, "deploy/first-node/native-codex/source.json"), "utf-8"));
	if (artifact.schema !== "qorpera.native-codex-artifact/v1" ||
		JSON.stringify(canonical(artifact.source)) !== JSON.stringify(canonical(source)) ||
		artifact.artifact?.file !== "codex" || artifact.artifact.target !== "x86_64-unknown-linux-gnu" ||
		artifact.artifact.profile !== "release" ||
		!Number.isSafeInteger(artifact.artifact.bytes) || artifact.artifact.bytes < 1 || artifact.artifact.bytes > 1024 ** 3 ||
		!/^[0-9a-f]{64}$/.test(artifact.artifact.sha256) ||
		typeof artifact.artifact.compiler !== "string" ||
		!artifact.artifact.compiler.startsWith(`rustc ${source.rustToolchain} `) ||
		!/^host: x86_64-unknown-linux-gnu$/m.test(artifact.artifact.compiler)) {
		throw new Error("Native company guest requires the pinned Linux x64 release artifact");
	}
	for (const name of ["codex", "LICENSE", "NOTICE"]) {
		const path = join(root, name);
		const entry = await lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 ||
			(name === "codex" ? entry.size !== artifact.artifact.bytes : entry.size > 64 * 1024)) {
			throw new Error("Native company artifact files are unsafe or incomplete");
		}
	}
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(join(root, "codex"))) digest.update(chunk);
	if (digest.digest("hex") !== artifact.artifact.sha256) throw new Error("Native company artifact checksum mismatch");
	return {
		root,
		contract: {
			schema: "qorpera.native-company-guest/v1", binaryPath: "/opt/qorpera-harnesses/native-company/codex",
			binarySha256: artifact.artifact.sha256, sourceCommit: source.commit, patchSha256: source.patchSha256,
			target: artifact.artifact.target, profile: artifact.artifact.profile,
		},
	};
}
