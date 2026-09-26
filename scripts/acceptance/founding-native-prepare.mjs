import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, chown, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { captureLxdOfficeHostNamespace } from "../../packages/runner-orchestrator/src/lxd-office-host-namespace.ts";
import { assertFoundingNativeHost, foundingNativeNetworkRules } from "./founding-native-network.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function foundingNativePreparation(value) {
	assert(value && typeof value === "object" && !Array.isArray(value));
	assert.deepEqual(
		Object.keys(value).sort(),
		[
			"schema",
			"disposableHost",
			"account",
			"uid",
			"gid",
			"workRoot",
			"out",
			"binDirectory",
			"tools",
			"guestPackage",
			"guestPackageSha256",
			"ubuntuImageFingerprint",
			"storagePool",
		].sort(),
	);
	assert.equal(value.schema, "qorpera.founding-native-preparation/v1");
	assert.equal(value.disposableHost, true, "Explicit disposable-host configuration required");
	assert(/^[a-z][a-z0-9_-]{0,30}$/.test(value.account));
	assert(
		Number.isSafeInteger(value.uid) &&
			value.uid >= 1000 &&
			Number.isSafeInteger(value.gid) &&
			value.gid >= 1000,
	);
	for (const key of ["workRoot", "out", "binDirectory", "tools", "guestPackage"]) {
		assert(
			isAbsolute(value[key]) &&
				resolve(value[key]) === value[key] &&
				value[key] !== "/" &&
				!/[\x00-\x20\x7f'\\]/.test(value[key]),
		);
	}
	assert(
		value.workRoot.startsWith("/opt/qorpera-founding-"),
		"Root-owned isolated staging namespace required",
	);
	assert(
		/^[0-9a-f]{64}$/.test(value.guestPackageSha256) && /^[0-9a-f]{64}$/.test(value.ubuntuImageFingerprint),
	);
	assert(/^[a-z][a-z0-9_-]{0,30}$/.test(value.storagePool));
	assert(
		value.out !== value.workRoot && !value.out.startsWith(`${value.workRoot}/`),
		"Evidence must exclude private staging",
	);
	return structuredClone(value);
}

/** Root preparation for an EMPTY disposable host, never a node deployment.
 * The actual production image installer consumes an explicit current package;
 * this module does not downgrade bundle provenance or fetch an unpinned image.
 * Secrets and cleanup metadata remain in workRoot, outside uploaded evidence.
 */
export async function prepareFoundingNative(configuration) {
	const config = foundingNativePreparation(configuration);
	assertFoundingNativeHost({
		platform: process.platform,
		uid: process.getuid?.(),
		cpuCount: cpus().length,
		memoryBytes: totalmem(),
		kvm: (await stat("/dev/kvm").catch(() => null))?.isCharacterDevice() === true,
		emptyBridge: true,
	});
	assert.equal(process.arch, "x64");
	assert((await stat("/run/systemd/system")).isDirectory());
	const command = async (file, args, timeout = 60000) => {
		try {
			return (
				await execute(file, args, { cwd: repository, timeout, maxBuffer: 8 * 1024 * 1024 })
			).stdout.trim();
		} catch {
			throw new Error(`FOUNDING_PREPARE_COMMAND_FAILED:${file}:${args[0] ?? ""}`);
		}
	};
	const lxc = (args, timeout) => command("/snap/bin/lxc", args, timeout);
	const nodeVersion = (await command("/usr/bin/node", ["--version"])).match(/^v(\d+)\.(\d+)\.(\d+)$/);
	assert(
		nodeVersion &&
			(Number(nodeVersion[1]) > 22 || (Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) >= 19)),
		"The actual systemd /usr/bin/node must support Node 22.19 or newer",
	);
	assert.equal(Number(await command("/usr/bin/id", ["-u", config.account])), config.uid);
	assert.equal(Number(await command("/usr/bin/id", ["-g", config.account])), config.gid);
	assert.deepEqual(
		JSON.parse(await lxc(["list", "--all-projects", "--format=json"])),
		[],
		"Existing physical guests are forbidden",
	);
	assert.equal(await realpath(config.guestPackage), config.guestPackage);
	const manifestBytes = await readFile(join(config.guestPackage, "manifest.json"));
	assert.equal(hash(manifestBytes), config.guestPackageSha256, "Exact current package manifest required");
	const manifest = JSON.parse(manifestBytes);
	assert.equal(manifest.schema, "qorpera.lxd-runner-guest-package/v1");
	assert.equal(manifest.platform, "linux-x64");
	assert.equal(manifest.nativeHarnesses.codex, "0.155.1");
	assert.equal(manifest.nativeCompany?.schema, "qorpera.native-company-guest/v1");
	for (const artifact of manifest.artifacts) {
		assert(
			typeof artifact.file === "string" &&
				!artifact.file.startsWith("/") &&
				!artifact.file.split("/").includes(".."),
		);
		const path = join(config.guestPackage, artifact.file),
			info = await lstat(path);
		assert(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0);
		assert.equal(await realpath(path), path);
		assert.equal(info.size, artifact.bytes);
		assert.equal(hash(await readFile(path)), artifact.sha256);
	}
	assert.equal(
		JSON.parse(await lxc(["query", `/1.0/images/${config.ubuntuImageFingerprint}`])).fingerprint,
		config.ubuntuImageFingerprint,
	);
	assert.equal(
		JSON.parse(await lxc(["query", `/1.0/storage-pools/${config.storagePool}`])).driver,
		"dir",
		"Acceptance uses an explicit local dir pool",
	);
	for (const path of [
		config.workRoot,
		"/var/lib/qorpera-native-computer-guard",
		"/run/qorpera-native-computer-guard",
	])
		assert.equal(
			await lstat(path).catch((error) => {
				if (error.code === "ENOENT") return null;
				throw error;
			}),
			null,
			"Existing guard or staging custody is forbidden",
		);
	await captureLxdOfficeHostNamespace();
	await mkdir(config.workRoot, { mode: 0o700 });
	await chown(config.workRoot, config.uid, config.gid);
	const nonce = randomBytes(6).toString("hex"),
		bridge = `qf${nonce.slice(0, 10)}`;
	const hostAddress = `10.231.${16 + (Number.parseInt(nonce.slice(0, 2), 16) % 224)}.1`;
	const guestAddress = hostAddress.replace(/\.1$/, ".2");
	const context = {
		...config,
		schema: "qorpera.founding-native-host/v1",
		bridge,
		hostAddress,
		guestAddress,
		table: `qorpera_founding_${nonce}`,
		dnsPort: 15453,
		tlsPort: 15443,
		platformPort: 15444,
		jobProfile: `qf-profile-${nonce}`,
		builder: `qf-builder-${nonce}`,
		alias: `qf-image-${nonce}`,
		unit: `qorpera-founding-guard-${nonce}`,
		lxdSocketPath: "/var/snap/lxd/common/lxd/unix.socket",
		imageFingerprint: null,
		caPath: join(config.workRoot, "ca.pem"),
		certificatePath: join(config.workRoot, "server.pem"),
		keyPath: join(config.workRoot, "server.key"),
		manifest,
		complete: false,
	};
	const save = () =>
		writeFile(join(config.workRoot, "host.json"), `${JSON.stringify(context)}\n`, { mode: 0o600 });
	await save();
	// The cleanup marker is retained before the first physical mutation. Never
	// infer absent resources or delete someone else's staging after a failure.
	await command("/usr/bin/openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-subj",
		"/CN=Disposable founding acceptance CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign,cRLSign",
		"-keyout",
		join(config.workRoot, "ca.key"),
		"-out",
		context.caPath,
	]);
	await chmod(join(config.workRoot, "ca.key"), 0o600);
	await command("/usr/bin/openssl", [
		"req",
		"-new",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-subj",
		"/CN=Disposable founding native endpoints",
		"-keyout",
		context.keyPath,
		"-out",
		join(config.workRoot, "server.csr"),
	]);
	await writeFile(
		join(config.workRoot, "server.ext"),
		`subjectAltName=IP:${hostAddress},DNS:chatgpt.com,DNS:auth.openai.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
		{ mode: 0o600 },
	);
	await command("/usr/bin/openssl", [
		"x509",
		"-req",
		"-in",
		join(config.workRoot, "server.csr"),
		"-CA",
		context.caPath,
		"-CAkey",
		join(config.workRoot, "ca.key"),
		"-CAcreateserial",
		"-days",
		"1",
		"-sha256",
		"-extfile",
		join(config.workRoot, "server.ext"),
		"-out",
		context.certificatePath,
	]);
	await chmod(context.keyPath, 0o600);
	await chown(context.keyPath, config.uid, config.gid);
	const guest = (args, timeout) => lxc(["exec", context.builder, "--", ...args], timeout);
	await lxc(
		[
			"init",
			config.ubuntuImageFingerprint,
			context.builder,
			"--vm",
			"--storage",
			config.storagePool,
			"-c",
			"boot.mode=uefi-secureboot",
			"-c",
			"limits.cpu=2",
			"-c",
			"limits.memory=4GiB",
			"-d",
			"root,size=30GiB",
		],
		300000,
	);
	await lxc(["start", context.builder]);
	let ready = false;
	for (let attempt = 0; attempt < 90; attempt++) {
		try {
			ready = (await guest(["cat", "/proc/1/comm"], 5000)) === "systemd";
		} catch {
			/* Actual guest agent starts asynchronously. */
		}
		if (ready) break;
		await delay(1000);
	}
	assert(ready, "Actual image builder did not boot");
	await command(
		"/usr/bin/tar",
		["-C", config.guestPackage, "-cf", join(config.workRoot, "guest-package.tar"), "."],
		120000,
	);
	await lxc(
		["file", "push", join(config.workRoot, "guest-package.tar"), `${context.builder}/root/guest-package.tar`],
		120000,
	);
	await guest(["mkdir", "/root/guest-package"]);
	await guest(["tar", "--no-same-owner", "-xf", "/root/guest-package.tar", "-C", "/root/guest-package"]);
	await guest(["bash", "/root/guest-package/install-image-contract.sh", "/root/guest-package"], 1800000);
	const installed = JSON.parse(await guest(["cat", "/etc/qorpera/lxd-runner-image.json"]));
	assert.equal(installed.guest_package_manifest_sha256, config.guestPackageSha256);
	assert.equal(installed.codex_version, "0.155.1");
	context.installation = installed;
	await lxc([
		"file",
		"push",
		"--uid=0",
		"--gid=0",
		"--mode=0444",
		context.caPath,
		`${context.builder}/usr/local/share/ca-certificates/qorpera-founding-test.crt`,
	]);
	await guest(["update-ca-certificates"]);
	await guest(["mkdir", "-p", "/etc/systemd/system.conf.d"]);
	const manager = join(config.workRoot, "manager.conf");
	await writeFile(
		manager,
		"[Manager]\nDefaultEnvironment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/qorpera-founding-test.crt\n",
		{ mode: 0o644 },
	);
	await lxc([
		"file",
		"push",
		"--uid=0",
		"--gid=0",
		"--mode=0444",
		manager,
		`${context.builder}/etc/systemd/system.conf.d/90-qorpera-founding-ca.conf`,
	]);
	await guest(["rm", "-rf", "/root/guest-package", "/root/guest-package.tar"]);
	await lxc(["stop", context.builder], 120000);
	await lxc(["publish", context.builder, "--alias", context.alias], 300000);
	context.imageFingerprint = JSON.parse(await lxc(["query", `/1.0/images/aliases/${context.alias}`])).target;
	assert(/^[0-9a-f]{64}$/.test(context.imageFingerprint));
	const imagePath = `/1.0/images/${context.imageFingerprint}`;
	const initialImage = JSON.parse(await lxc(["query", imagePath]));
	await lxc([
		"query",
		"--request",
		"PUT",
		imagePath,
		"--data",
		JSON.stringify({
			public: false,
			auto_update: false,
			profiles: [],
			properties: initialImage.properties,
		}),
	]);
	assert.deepEqual(JSON.parse(await lxc(["query", imagePath])).profiles, []);
	await lxc(["delete", context.builder]);
	await lxc(["profile", "create", context.jobProfile]);
	const profile = JSON.parse(await lxc(["query", `/1.0/profiles/${context.jobProfile}`]));
	assert.deepEqual(profile.devices, {});
	assert.deepEqual(profile.config, {});
	await lxc([
		"network",
		"create",
		bridge,
		`ipv4.address=${hostAddress}/24`,
		"ipv4.nat=false",
		"ipv6.address=none",
		`ipv4.dhcp.ranges=${guestAddress}-${guestAddress}`,
		"dns.mode=none",
	]);
	const network = JSON.parse(await lxc(["query", `/1.0/networks/${bridge}`]));
	assert.deepEqual(network.used_by, []);
	assert.equal(network.config["ipv4.nat"], "false");
	await writeFile(
		join(config.workRoot, "network.nft"),
		foundingNativeNetworkRules({ ...context, platformPorts: [context.platformPort] }),
		{ mode: 0o600 },
	);
	await command("/usr/sbin/nft", ["-c", "-f", join(config.workRoot, "network.nft")]);
	await command("/usr/sbin/nft", ["-f", join(config.workRoot, "network.nft")]);
	const guard = join(config.workRoot, "guard.mjs");
	await build({
		absWorkingDir: repository,
		entryPoints: ["deploy/runtime-computers/paid-computer-guard.ts"],
		outfile: guard,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		logLevel: "silent",
	});
	await chmod(guard, 0o555);
	const unit = (
		await readFile(join(repository, "deploy/runtime-computers/qorpera-computer-guard.service.in"), "utf8")
	)
		.replaceAll("@PROVIDER@", "native")
		.replaceAll("@ACCOUNT@", config.account)
		.replace("/opt/qorpera/computer-guard/qorpera-runtime-computer-guard.mjs", guard);
	await writeFile(`/run/systemd/system/${context.unit}.service`, unit, { flag: "wx", mode: 0o644 });
	await command("/usr/bin/systemctl", ["daemon-reload"]);
	await command("/usr/bin/systemctl", ["start", `${context.unit}.service`]);
	assert.equal(await command("/usr/bin/systemctl", ["is-active", `${context.unit}.service`]), "active");
	context.complete = true;
	await save();
	await chown(join(config.workRoot, "host.json"), config.uid, config.gid);
	return join(config.workRoot, "host.json");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	assert(
		process.argv.length === 4 && process.argv[2] === "--config",
		"Usage: sudo node scripts/acceptance/founding-native-prepare.mjs --config /absolute/preparation.json",
	);
	const path = process.argv[3];
	assert(isAbsolute(path) && (await realpath(path)) === path);
	const metadata = await lstat(path);
	assert(metadata.uid === 0 && metadata.isFile() && (metadata.mode & 0o077) === 0 && metadata.size < 16384);
	const context = await prepareFoundingNative(JSON.parse(await readFile(path, "utf8")));
	console.log(JSON.stringify({ prepared: true, privateContext: context, acceptancePassed: false }));
}
