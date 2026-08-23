#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LXD_IMAGE_PROVENANCE_SCHEMA,
	type LxdImageProvenanceStatement,
	parseLxdImageProvenanceStatement,
	signLxdImageProvenance,
	verifyLxdImageProvenanceFiles,
} from "./lxd-image-provenance.ts";

function options(args: readonly string[]): Map<string, string> {
	if (args.length % 2 !== 0) throw new Error("Every provenance option requires a value");
	const parsed = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!name?.startsWith("--") || !value || parsed.has(name)) throw new Error("Provenance options are invalid");
		parsed.set(name, value);
	}
	return parsed;
}

function required(values: Map<string, string>, name: string): string {
	const value = values.get(name);
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function exact(values: Map<string, string>, names: readonly string[]): void {
	if (values.size !== names.length || names.some((name) => !values.has(name))) {
		throw new Error(`Expected options: ${names.join(" ")}`);
	}
}

function createStatement(values: Map<string, string>): void {
	const names = [
		"--image-server",
		"--image-fingerprint",
		"--base-image-fingerprint",
		"--guest-package-manifest-sha256",
		"--runner-image",
		"--runner-image-archive-sha256",
		"--runner-image-cosign-bundle-sha256",
		"--source-repository",
		"--source-commit",
		"--source-tree",
		"--tested-at",
		"--acceptance-evidence-sha256",
		"--output",
	] as const;
	exact(values, names);
	const statement = parseLxdImageProvenanceStatement({
		schema: LXD_IMAGE_PROVENANCE_SCHEMA,
		image: {
			server: required(values, "--image-server"),
			fingerprint: required(values, "--image-fingerprint"),
			baseFingerprint: required(values, "--base-image-fingerprint"),
			guestPackageManifestSha256: required(values, "--guest-package-manifest-sha256"),
			runnerImage: required(values, "--runner-image"),
			runnerImageArchiveSha256: required(values, "--runner-image-archive-sha256"),
			runnerImageCosignBundleSha256: required(values, "--runner-image-cosign-bundle-sha256"),
		},
		source: {
			repository: required(values, "--source-repository"),
			commit: required(values, "--source-commit"),
			tree: required(values, "--source-tree"),
		},
		acceptance: {
			testedAt: required(values, "--tested-at"),
			evidenceSha256: required(values, "--acceptance-evidence-sha256"),
			virtualization: "kvm",
			bootMode: "uefi-secureboot",
			secureBoot: true,
			credentials: "absent",
			identityVolume: "absent",
			services: "fail-closed",
		},
	});
	writeFileSync(resolve(required(values, "--output")), `${JSON.stringify(statement, null, 2)}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
}

function signStatement(values: Map<string, string>): void {
	const names = ["--statement", "--private-key", "--output"] as const;
	const passphraseStdin = values.get("--private-key-passphrase-stdin");
	if (passphraseStdin === undefined) exact(values, names);
	else {
		exact(values, [...names, "--private-key-passphrase-stdin"]);
		if (passphraseStdin !== "true") throw new Error("--private-key-passphrase-stdin must be true");
	}
	const statement = JSON.parse(readFileSync(resolve(required(values, "--statement")), "utf-8")) as unknown;
	const privateKey = readFileSync(resolve(required(values, "--private-key")));
	const passphrase = passphraseStdin === "true" ? readFileSync(0, "utf-8").replace(/[\r\n]+$/, "") : undefined;
	if (passphraseStdin === "true" && !passphrase) throw new Error("The private-key passphrase is empty");
	const envelope = signLxdImageProvenance(
		parseLxdImageProvenanceStatement(statement),
		passphrase === undefined ? privateKey : { key: privateKey, passphrase },
	);
	writeFileSync(resolve(required(values, "--output")), `${JSON.stringify(envelope, null, 2)}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
}

function verifyEnvelope(values: Map<string, string>): void {
	const names = [
		"--provenance",
		"--public-key",
		"--image-server",
		"--image-fingerprint",
		"--guest-package-manifest-sha256",
		"--runner-image",
		"--runner-image-archive-sha256",
		"--runner-image-cosign-bundle-sha256",
	] as const;
	exact(values, names);
	const statement = verifyLxdImageProvenanceFiles(
		resolve(required(values, "--provenance")),
		resolve(required(values, "--public-key")),
		{
			imageServer: required(values, "--image-server"),
			imageFingerprint: required(values, "--image-fingerprint"),
			guestPackageManifestSha256: required(values, "--guest-package-manifest-sha256"),
			runnerImage: required(values, "--runner-image"),
			runnerImageArchiveSha256: required(values, "--runner-image-archive-sha256"),
			runnerImageCosignBundleSha256: required(values, "--runner-image-cosign-bundle-sha256"),
		},
	);
	console.log("LXD_IMAGE_PROVENANCE_VERIFIED");
	console.log(`fingerprint=${statement.image.fingerprint}`);
	console.log(`source_commit=${statement.source.commit}`);
}

function main(args: readonly string[]): void {
	const [command, ...rest] = args;
	if (command === "create") {
		createStatement(options(rest));
		return;
	}
	if (command === "sign") {
		signStatement(options(rest));
		return;
	}
	if (command === "verify") {
		verifyEnvelope(options(rest));
		return;
	}
	throw new Error("Usage: qorpera-lxd-image-provenance {create|sign|verify} [options]");
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

export type { LxdImageProvenanceStatement };
