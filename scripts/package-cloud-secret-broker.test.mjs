import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("packages the secret broker separately from every execution host", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-secret-broker-package-test-"));
	try {
		const destination = join(temporary, "package");
		const packaged = spawnSync(process.execPath, ["scripts/package-cloud-secret-broker.mjs", "--out", destination], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(packaged.status, 0, packaged.stderr);
		const encoded = await readFile(join(destination, "manifest.json"), "utf8");
		const manifest = JSON.parse(encoded);
		assert.equal(manifest.schema, "qorpera.cloud-secret-broker-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"qorpera-cloud-secret-broker-service.mjs",
				"qorpera-cloud-secret-broker.service",
				"qorpera-shared-vault.service",
				"shared-vault-secrets.py",
				"supabase-prod-ca-2021.crt",
			],
		);
		const sharedUnit = await readFile(join(destination, "qorpera-shared-vault.service"), "utf8");
		assert.match(sharedUnit, /^LoadCredential=qorpera-cloud-secret-principal:\/etc\/qorpera-shared-vault\/principal-secret$/m);
		assert.match(sharedUnit, /^LoadCredential=qorpera-cloud-secret-master-keys:\/etc\/qorpera-shared-vault\/master-keys.json$/m);
		assert.match(sharedUnit, /^TimeoutStopSec=90$/m);
		assert.match(sharedUnit, /^NoNewPrivileges=yes$/m);
		assert.doesNotMatch(sharedUnit, /qorpera-cloud-secret-control|qorpera-cloud-secret-keyring/);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(destination, artifact.file));
			assert.equal(bytes.byteLength, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
		}
		// By default the database's CA is Supabase's, as the repository pins it, and no own CA rides along.
		assert.deepEqual(
			await readFile(join(destination, "supabase-prod-ca-2021.crt")),
			await readFile(join(repositoryRoot, "deploy/cloud-secret-broker/supabase-prod-ca-2021.crt")),
		);
		const executable = join(destination, "qorpera-cloud-secret-broker-service.mjs");
		const bundle = await readFile(executable, "utf8");
		assert.ok(!bundle.includes("DesktopSecretVault"));
		assert.ok(!bundle.includes("LocalSecretStore"));
		assert.ok(!bundle.includes("secret://"));
		assert.ok(!bundle.includes("NativeProviderHost"));
		const syntax = spawnSync(process.execPath, ["--check", executable], { encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
		const help = spawnSync(process.execPath, [executable, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /systemd credentials and a TLS reverse proxy/);
		const service = await readFile(join(destination, "qorpera-cloud-secret-broker.service"), "utf8");
		assert.match(service, /^ProtectSystem=strict$/m);
		assert.match(service, /^NoNewPrivileges=yes$/m);
		assert.match(service, /^TimeoutStopSec=90$/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-keyring:/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-runtime:/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-database-url:/m);
		assert.match(service, /^LoadCredential=qorpera-cloud-secret-database-ca:/m);
		assert.doesNotMatch(service, /qorpera-supabase-service-key/);
		assert.ok(!service.includes("Environment=QORPERA_"));
		const repeated = spawnSync(
			process.execPath,
			["scripts/package-cloud-secret-broker.mjs", "--out", destination],
			{ cwd: repositoryRoot, encoding: "utf8" },
		);
		assert.notEqual(repeated.status, 0);
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), encoded);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
const usage = /--out <new-directory> \[--database-ca <file> --database-ca-sha256 <sha256>\]/;

test("packages our own database CA only with its sha256 pin, the two given together", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-secret-broker-own-ca-test-"));
	try {
		// Throwaway CAs (openssl CLI), made for this test.
		const ca = (tag) => {
			execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(temporary, `${tag}.key`)], {
				stdio: "ignore",
			});
			execFileSync(
				"openssl",
				["req", "-new", "-x509", "-key", join(temporary, `${tag}.key`), "-out", join(temporary, `${tag}.crt`), "-days", "2"]
					.concat(["-subj", `/CN=qorpera-test-${tag}`, "-addext", `basicConstraints=critical,CA:${tag === "leaf" ? "FALSE" : "TRUE"}`]),
				{ stdio: "ignore" },
			);
			return join(temporary, `${tag}.crt`);
		};
		const own = ca("own");
		const other = ca("other");
		const leaf = ca("leaf");
		const two = join(temporary, "two.crt");
		await writeFile(two, Buffer.concat([await readFile(own), await readFile(other)]));
		const pin = digestOf(await readFile(own));
		const pack = (destination, ...input) =>
			spawnSync(process.execPath, ["scripts/package-cloud-secret-broker.mjs", "--out", destination, ...input], {
				cwd: repositoryRoot,
				encoding: "utf8",
				timeout: 30_000,
			});

		// Half an input, a pin the file does not match, a file that is not one CA certificate: refused before anything is
		// built, and no package folder is made.
		for (const [input, reason] of [
			[["--database-ca", own], /--database-ca and --database-ca-sha256 go together/],
			[["--database-ca-sha256", pin], /--database-ca and --database-ca-sha256 go together/],
			[["--database-ca", own, "--database-ca-sha256", digestOf(await readFile(other))], /does not match/],
			[["--database-ca", own, "--database-ca-sha256", pin.toUpperCase()], /is not a sha256/],
			[["--database-ca", own, "--database-ca-sha256"], usage],
			[["--database-ca", own, "--database-ca", own, "--database-ca-sha256", pin], usage],
			[["--database-ca", two, "--database-ca-sha256", digestOf(await readFile(two))], /is not one PEM certificate/],
			[["--database-ca", leaf, "--database-ca-sha256", digestOf(await readFile(leaf))], /is not a CA certificate/],
		]) {
			const destination = join(temporary, "refused");
			const refused = pack(destination, ...input);
			assert.notEqual(refused.status, 0, input.join(" "));
			assert.match(refused.stderr, reason, input.join(" "));
			await assert.rejects(access(destination), input.join(" "));
		}

		// Both: the package carries the CA byte for byte, its pin and the units' drop-in, all in its manifest.
		const destination = join(temporary, "package");
		const packaged = pack(destination, "--database-ca", own, "--database-ca-sha256", pin);
		assert.equal(packaged.status, 0, packaged.stderr);
		const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
		assert.equal(manifest.schema, "qorpera.cloud-secret-broker-package/v1");
		assert.deepEqual(
			manifest.artifacts.map((artifact) => artifact.file),
			[
				"qorpera-cloud-secret-broker-service.mjs",
				"qorpera-cloud-secret-broker.service",
				"qorpera-shared-vault.service",
				"shared-vault-secrets.py",
				"supabase-prod-ca-2021.crt",
				"database-own-ca.crt",
				"database-own-ca.sha256",
				"database-own-ca.conf",
			],
		);
		for (const artifact of manifest.artifacts) {
			assert.equal(digestOf(await readFile(join(destination, artifact.file))), artifact.sha256);
		}
		assert.deepEqual(await readFile(join(destination, "database-own-ca.crt")), await readFile(own));
		assert.equal(await readFile(join(destination, "database-own-ca.sha256"), "utf8"), `${pin}\n`);
		const dropIn = await readFile(join(destination, "database-own-ca.conf"), "utf8");
		assert.deepEqual(
			dropIn.split("\n").filter((line) => line && !line.startsWith("#")),
			[
				"[Service]",
				"LoadCredential=qorpera-cloud-secret-database-own-ca:/etc/qorpera-secret-broker/database-own-ca.crt",
				"LoadCredential=qorpera-cloud-secret-database-own-ca-sha256:/etc/qorpera-secret-broker/database-own-ca.sha256",
			],
		);
		// The units themselves stay as they are: Supabase's CA credential is still loaded, and checked, in either mode.
		for (const unit of ["qorpera-cloud-secret-broker.service", "qorpera-shared-vault.service"]) {
			assert.deepEqual(
				await readFile(join(destination, unit)),
				await readFile(join(repositoryRoot, "deploy/cloud-secret-broker", unit)),
			);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
