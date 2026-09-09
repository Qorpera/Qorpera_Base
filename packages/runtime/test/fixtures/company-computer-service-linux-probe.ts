import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCompanyComputerServiceCredential } from "../../src/cloud-company-computer-service-credentials.ts";

const directory = "/run/credentials/qorpera-company-computer.service";
const native = join(directory, "qorpera-office-native");
if (process.argv[2] === "--prepare") {
	assert.equal(process.getuid?.(), 0);
	await mkdir(directory, { recursive: true, mode: 0o755 });
	await writeFile(native, "n".repeat(43), { mode: 0o400 });
	await chown(native, 1000, 1000);
	await symlink(native, join(directory, "qorpera-office-objects"));
	await writeFile(join(directory, "qorpera-office-registry"), "r".repeat(64), { mode: 0o444 });
	await writeFile(join(directory, "qorpera-office-config"), "{}", { mode: 0o600 });
	await chown(join(directory, "qorpera-office-config"), 1000, 1000);
	await writeFile(join(directory, "hardlink-source"), "synthetic-key", { mode: 0o400 });
	await chown(join(directory, "hardlink-source"), 1000, 1000);
	await link(join(directory, "hardlink-source"), join(directory, "qorpera-office-tls-key"));
	assert.equal(spawnSync("mkfifo", ["-m", "444", join(directory, "qorpera-office-tls-cert")]).status, 0);
	await chown(directory, 1000, 1000);
	await chmod(directory, 0o500);
	const child = spawnSync(
		"setpriv",
		[
			"--reuid=1000",
			"--regid=1000",
			"--clear-groups",
			"--bounding-set=-all",
			process.execPath,
			fileURLToPath(import.meta.url),
		],
		{ stdio: "inherit", timeout: 15000 },
	);
	assert.equal(child.status, 0);
} else {
	assert.equal(process.getuid?.(), 1000);
	assert.equal(
		(await readCompanyComputerServiceCredential(directory, "qorpera-office-native")).toString(),
		"n".repeat(43),
	);
	for (const name of [
		"qorpera-office-objects",
		"qorpera-office-registry",
		"qorpera-office-config",
		"qorpera-office-tls-key",
		"qorpera-office-tls-cert",
	] as const) {
		await assert.rejects(
			readCompanyComputerServiceCredential(directory, name),
			/^Error: OFFICE_SERVICE_CREDENTIAL_UNAVAILABLE$/,
		);
	}
	const binary = "/artifact/qorpera-company-computer-service.mjs";
	const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" };
	const help = spawnSync(process.execPath, [binary, "--help"], {
		cwd: "/tmp",
		env: environment,
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Headless shared office/);
	const failed = spawnSync(process.execPath, [binary], {
		cwd: "/tmp",
		env: environment,
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /^Office service could not start or continue;/);
	assert.doesNotMatch(failed.stderr, /Error:|node_modules|credentials\//);
	console.log(
		JSON.stringify({
			platform: process.platform,
			uid: process.getuid?.(),
			credentialChecks: 6,
			packagedStartupChecks: 2,
			physicalServiceStartup: false,
		}),
	);
}
