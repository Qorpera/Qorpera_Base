import { createHash, X509Certificate } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
	"Usage: node scripts/package-cloud-secret-broker.mjs --out <new-directory> [--database-ca <file> --database-ca-sha256 <sha256>]";
const options = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
	const [name, value] = [args[index], args[index + 1]];
	if (!["--out", "--database-ca", "--database-ca-sha256"].includes(name) || !value || options.has(name)) {
		throw new Error(usage);
	}
	options.set(name, value);
}
if (!options.has("--out")) throw new Error(usage);
// The service trusts Supabase's CA by default. For a self-hosted database a deploy gives our own CA, always with its
// sha256 pin: the package then carries the CA, its pin and a drop-in that hands both to the broker's and the shared
// vault's units, and the service trusts that CA alone (packages/runtime/src/database-ca.ts checks both again).
const ownCa = await databaseOwnCa(options.get("--database-ca"), options.get("--database-ca-sha256"));
const output = resolve(options.get("--out"));
await mkdir(output, { mode: 0o700 });
await build({
	absWorkingDir: root,
	entryPoints: { "qorpera-cloud-secret-broker-service": "packages/runtime/src/cloud-secret-broker-service-main.ts" },
	outdir: output,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22.19",
	banner: {
		js: 'import { createRequire as __qorperaCreateRequire } from "node:module"; const require = __qorperaCreateRequire(import.meta.url);',
	},
	legalComments: "none",
	logLevel: "silent",
});
await copyFile(
	join(root, "deploy/cloud-secret-broker/qorpera-cloud-secret-broker.service"),
	join(output, "qorpera-cloud-secret-broker.service"),
);
await copyFile(
	join(root, "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"),
	join(output, "supabase-prod-ca-2021.crt"),
);
// The shared vault (Vault By Default) runs the same program under its own unit, with the tool that makes
// and moves its secrets on the vault hosts.
await copyFile(
	join(root, "deploy/cloud-secret-broker/qorpera-shared-vault.service"),
	join(output, "qorpera-shared-vault.service"),
);
await copyFile(
	join(root, "deploy/cloud-secret-broker/shared-vault-secrets.py"),
	join(output, "shared-vault-secrets.py"),
);
const files = [
	"qorpera-cloud-secret-broker-service.mjs",
	"qorpera-cloud-secret-broker.service",
	"qorpera-shared-vault.service",
	"shared-vault-secrets.py",
	"supabase-prod-ca-2021.crt",
];
if (ownCa) {
	await writeFile(join(output, "database-own-ca.crt"), ownCa.bytes, { mode: 0o644, flag: "wx" });
	await writeFile(join(output, "database-own-ca.sha256"), `${ownCa.sha256}\n`, { mode: 0o644, flag: "wx" });
	await writeFile(
		join(output, "database-own-ca.conf"),
		[
			"# A drop-in for qorpera-cloud-secret-broker.service and qorpera-shared-vault.service: our own database CA and",
			"# its sha256 pin, with database-own-ca.crt and database-own-ca.sha256 beside the Supabase CA.",
			"[Service]",
			"LoadCredential=qorpera-cloud-secret-database-own-ca:/etc/qorpera-secret-broker/database-own-ca.crt",
			"LoadCredential=qorpera-cloud-secret-database-own-ca-sha256:/etc/qorpera-secret-broker/database-own-ca.sha256",
			"",
		].join("\n"),
		{ mode: 0o644, flag: "wx" },
	);
	files.push("database-own-ca.crt", "database-own-ca.sha256", "database-own-ca.conf");
}
const artifacts = [];
for (const file of files) {
	const bytes = await readFile(join(output, file));
	artifacts.push({ file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(
	join(output, "manifest.json"),
	`${JSON.stringify({ schema: "qorpera.cloud-secret-broker-package/v1", artifacts }, null, 2)}\n`,
	{ mode: 0o600 },
);
console.log(output);

/** Our own CA from its two inputs: both or neither, the pin a sha256 the file matches, the file one PEM CA certificate. */
async function databaseOwnCa(file, sha256) {
	if (file === undefined && sha256 === undefined) return undefined;
	if (file === undefined || sha256 === undefined) {
		throw new Error("--database-ca and --database-ca-sha256 go together");
	}
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("--database-ca-sha256 is not a sha256 (64 lowercase hex digits)");
	if (!(await lstat(file)).isFile()) throw new Error("--database-ca is not a regular file");
	const bytes = await readFile(file);
	if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
		throw new Error("--database-ca does not match --database-ca-sha256");
	}
	const pem = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;
	let certificate;
	try {
		if (!pem.test(bytes.toString("utf8"))) throw new Error();
		certificate = new X509Certificate(bytes);
	} catch {
		throw new Error("--database-ca is not one PEM certificate");
	}
	if (certificate.ca !== true) throw new Error("--database-ca is not a CA certificate");
	return { bytes, sha256 };
}
