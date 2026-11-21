import { createHash, X509Certificate } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
	"Usage: node scripts/package-agent-exit-rules.mjs --out <new-directory> [--database-ca <file> --database-ca-sha256 <sha256>]";
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
const ownCa = await databaseOwnCa(options.get("--database-ca"), options.get("--database-ca-sha256"));
const output = resolve(options.get("--out"));
await mkdir(output, { mode: 0o700 });
await build({
	absWorkingDir: root,
	entryPoints: { "qorpera-agent-exit-rules": "packages/runtime/src/agent-exit-rules-main.ts" },
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
	join(root, "deploy/agent-exit/qorpera-agent-exit-rules.service"),
	join(output, "qorpera-agent-exit-rules.service"),
);
await copyFile(
	join(root, "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt"),
	join(output, "supabase-prod-ca-2021.crt"),
);
const files = ["qorpera-agent-exit-rules.mjs", "qorpera-agent-exit-rules.service", "supabase-prod-ca-2021.crt"];
if (ownCa) {
	await writeFile(join(output, "database-own-ca.crt"), ownCa.bytes, { mode: 0o644, flag: "wx" });
	await writeFile(join(output, "database-own-ca.sha256"), `${ownCa.sha256}\n`, { mode: 0o644, flag: "wx" });
	await writeFile(
		join(output, "database-own-ca.conf"),
		[
			"[Service]",
			"LoadCredential=qorpera-agent-exit-rules-database-own-ca:/usr/local/libexec/qorpera-agent-exit/database-own-ca.crt",
			"LoadCredential=qorpera-agent-exit-rules-database-own-ca-sha256:/usr/local/libexec/qorpera-agent-exit/database-own-ca.sha256",
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
	`${JSON.stringify({ schema: "qorpera.agent-exit-rules-package/v1", artifacts }, null, 2)}\n`,
	{ mode: 0o600 },
);
console.log(output);

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
