import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

/** F3 4e: the office image's provenance. `--generate-key <dir>` makes the
 * ed25519 signing key once, as root on the node's host, and prints only its
 * public half. `sign` holds the production build's evidence against the
 * cold-boot acceptance's, signs the statement lxd-office-image-provenance.ts
 * verifies, and writes the fields a physical policy pins. The private key is
 * read once and never printed. See deploy/first-node/OFFICE-IMAGE-PRODUCTION.md. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = "office-image-signing.pem";
const OFFICE_ID = 20045;
const GIB = 1024 ** 3;
const FLAGS = {
	"--build": "build",
	"--acceptance": "acceptance",
	"--key": "key",
	"--out": "out",
	"--repository": "repository",
};
const REQUIRED = ["build", "acceptance", "key", "out"];
const USAGE = `Usage: node scripts/sign-office-image-provenance.mjs --generate-key <new or private directory>
       node scripts/sign-office-image-provenance.mjs sign --build <build-office-image-production.sh evidence> \\
         --acceptance <accept-office-image.sh evidence> --key <ed25519 private key PEM> --out <new directory> \\
         [--repository <https URL, default https://github.com/Qorpera/Qorpera_Base.git>]
`;
const OFFICE_UNIT = {
	ActiveState: "inactive",
	ExecMainStartTimestampMonotonic: "0",
	InactiveExitTimestampMonotonic: "0",
	LoadState: "loaded",
	UnitFileState: "disabled",
};
const SERVICES = ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"];
const APT_MASKS = ["apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service", "unattended-upgrades.service"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (code) => {
	throw new Error(code);
};
const sha = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const count = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = FLAGS[argv[index]];
		const value = argv[index + 1];
		if (!key || typeof value !== "string" || !value || value.startsWith("--") || key in options) fail("OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID");
		options[key] = value;
	}
	for (const key of REQUIRED) if (!(key in options)) fail("OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID");
	options.repository ??= "https://github.com/Qorpera/Qorpera_Base.git";
	let repository;
	try {
		repository = new URL(options.repository);
	} catch {
		fail("OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID");
	}
	// As parseLxdOfficeImageStatement takes a source repository.
	const { protocol, username, password, hash: fragment, search } = repository;
	if (protocol !== "https:" || username || password || fragment || search || repository.toString() !== options.repository)
		fail("OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID");
	for (const key of ["build", "acceptance", "key", "out"]) options[key] = resolve(options[key]);
	return options;
}
async function generateKey(directory) {
	if (process.getuid() !== 0) fail("OFFICE_IMAGE_SIGNING_ROOT_REQUIRED");
	process.umask(0o077);
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") fail("OFFICE_IMAGE_SIGNING_KEY_DIRECTORY_UNSAFE");
	}
	const folder = await lstat(directory);
	if (!folder.isDirectory() || folder.uid !== 0 || (folder.mode & 0o077) !== 0) fail("OFFICE_IMAGE_SIGNING_KEY_DIRECTORY_UNSAFE");
	const path = join(directory, KEY_FILE);
	if (await lstat(path).then(() => true, () => false)) fail("OFFICE_IMAGE_SIGNING_KEY_EXISTS");
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const pem = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
	try {
		await writeFile(path, pem, { mode: 0o400, flag: "wx" });
	} catch (error) {
		fail(error?.code === "EEXIST" ? "OFFICE_IMAGE_SIGNING_KEY_EXISTS" : "OFFICE_IMAGE_SIGNING_KEY_UNWRITTEN");
	} finally {
		pem.fill(0);
	}
	const written = await lstat(path);
	if (!written.isFile() || written.uid !== 0 || (written.mode & 0o777) !== 0o400) fail("OFFICE_IMAGE_SIGNING_KEY_UNWRITTEN");
	const spki = publicKey.export({ type: "spki", format: "der" });
	process.stdout.write(json({ key: path, verificationKeySpki: spki.toString("base64"), keyId: hash(spki) }));
}
/** Owned by whoever signs, and readable by nobody else. */
async function loadSigningKey(path) {
	let pem;
	try {
		const file = await lstat(path);
		if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) fail("OFFICE_IMAGE_SIGNING_KEY_UNSAFE");
		pem = await readFile(path);
	} catch (error) {
		fail(error?.message === "OFFICE_IMAGE_SIGNING_KEY_UNSAFE" ? error.message : "OFFICE_IMAGE_SIGNING_KEY_INVALID");
	}
	try {
		const privateKey = createPrivateKey({ key: pem, format: "pem" });
		if (privateKey.asymmetricKeyType !== "ed25519") fail("OFFICE_IMAGE_SIGNING_KEY_INVALID");
		const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
		return { privateKey, verificationKeySpki: spki.toString("base64"), keyId: hash(spki) };
	} catch {
		fail("OFFICE_IMAGE_SIGNING_KEY_INVALID");
	} finally {
		pem.fill(0);
	}
}
/** Bundle the repository's own verifier and policy check once per run; the
 * signer must accept exactly what the orchestrator will accept. */
async function loadVerifier() {
	const { build } = await import("esbuild");
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-image-provenance-"));
	const outfile = join(temporary, "verifier.mjs");
	await build({
		absWorkingDir: root,
		stdin: {
			contents: [
				'export { officeCanonical, officeDigest, verifyLxdOfficeImageProvenance } from "./packages/runner-orchestrator/src/lxd-office-image-provenance.ts";',
				'export { assertLxdOfficePhysicalImage } from "./packages/runner-orchestrator/src/lxd-office-physical-policy.ts";',
			].join("\n"),
			resolveDir: root,
			loader: "ts",
		},
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		legalComments: "none",
		logLevel: "silent",
	});
	return { module: await import(pathToFileURL(outfile).href), dispose: () => rm(temporary, { recursive: true, force: true }) };
}
async function readEvidence(path) {
	try {
		const bytes = await readFile(path);
		return { bytes, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) };
	} catch {
		fail("OFFICE_IMAGE_SIGNING_INPUT_INVALID");
	}
}
/** The build's and the acceptance's evidence, held against each other. Each
 * check names the field it refuses. */
function checkEvidence(build, acceptance) {
	const need = (ok, code, field) => {
		if (!ok) fail(`${code}: ${field}`);
	};
	const b = (ok, field) => need(ok, "OFFICE_IMAGE_SIGNING_BUILD_INVALID", field);
	const a = (ok, field) => need(ok, "OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID", field);
	const both = (ok, field) => need(ok, "OFFICE_IMAGE_SIGNING_EVIDENCE_INCONSISTENT", field);
	b(build?.schema === "qorpera.office-image-build/v1", "schema");
	b(typeof build.commit === "string" && /^[0-9a-f]{40}$/.test(build.commit), "commit");
	b(build.tree === "clean", "tree");
	b(sha(build.baseFingerprint), "baseFingerprint");
	b(build.uid === OFFICE_ID && build.gid === OFFICE_ID, "uid");
	for (const field of ["installationReceiptSha256", "packageManifestSha256", "specSha256", "folderProgramSha256", "recipeSha256"]) b(sha(build[field]), field);
	b(count(build.rootDiskBytes, 24 * GIB, 2048 * GIB) && build.rootDiskBytes % GIB === 0 && build.rootSize === `${build.rootDiskBytes / GIB}GiB`, "rootDiskBytes");
	b(build.network === "none", "network");
	b(isDeepStrictEqual(build.officeUnit, OFFICE_UNIT), "officeUnit");
	const image = build.image;
	b(sha(image?.fingerprint), "image.fingerprint");
	b(image.type === "virtual-machine" && image.public === false && image.autoUpdate === false, "image.type");
	b(image.architecture === "x86_64", "image.architecture");
	b(count(image.bytes, 1, 1024 ** 4), "image.bytes");
	b(isDeepStrictEqual(image.profiles, []) && isDeepStrictEqual(image.aliases, []), "image.profiles");
	const labels = image.properties ?? {};
	b(labels["qorpera.sourceCommit"] === build.commit, "image.properties.qorpera.sourceCommit");
	b(labels["qorpera.baseFingerprint"] === build.baseFingerprint, "image.properties.qorpera.baseFingerprint");
	b(labels["qorpera.installationReceiptSha256"] === build.installationReceiptSha256, "image.properties.qorpera.installationReceiptSha256");
	b(labels["qorpera.packageManifestSha256"] === build.packageManifestSha256, "image.properties.qorpera.packageManifestSha256");

	a(acceptance?.schema === "qorpera.office-image-acceptance/v1", "schema");
	const tested = acceptance.testedAt;
	const testedAt = typeof tested === "string" && tested.length === 24 ? Date.parse(tested) : Number.NaN;
	a(Number.isFinite(testedAt) && new Date(testedAt).toISOString() === tested && testedAt <= Date.now() + 5 * 60 * 1000, "testedAt");
	a(acceptance.bootMode === "uefi-secureboot" && acceptance.network === "none", "bootMode");
	a(isDeepStrictEqual(acceptance.virtualMachine?.profiles, []) && isDeepStrictEqual(Object.keys(acceptance.virtualMachine?.devices ?? {}), ["root"]), "virtualMachine");
	a(count(acceptance.rootDiskBytes, 24 * GIB, 2048 * GIB), "rootDiskBytes");
	const guest = acceptance.guest;
	a(guest?.schema === "qorpera.office-image-cold-boot-proof/v1" && guest.passed === true, "guest.passed");
	a(guest.guest?.virtualization === "kvm" && guest.guest.firmware === "uefi" && guest.guest.secureBoot === true, "guest.guest");
	a(guest.guest.secureBootVariable === "SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c", "guest.guest.secureBootVariable");
	a(guest.guest.productUuid === acceptance.virtualMachine.uuid, "guest.guest.productUuid");
	const office = guest.unitsBefore?.[SERVICES[0]] ?? {};
	a(isDeepStrictEqual(Object.fromEntries(Object.keys(OFFICE_UNIT).map((key) => [key, office[key]])), OFFICE_UNIT), "guest.unitsBefore");
	a(isDeepStrictEqual(guest.closureBefore, guest.closureAfter), "guest.closureAfter");
	a(guest.closureBefore?.uid === OFFICE_ID && guest.closureBefore.gid === OFFICE_ID, "guest.closureBefore.uid");
	for (const custody of ["custodyBefore", "custodyAfter"]) a(guest[custody]?.empty === true && guest[custody].credentials?.entries === 0, `guest.${custody}`);
	a(isDeepStrictEqual(Object.keys(guest.aptMasks ?? {}).sort(), [...APT_MASKS].sort()), "guest.aptMasks");
	a(isDeepStrictEqual(guest.secretScan?.hits, []) && count(guest.secretScan.filesScanned, 1, Number.MAX_SAFE_INTEGER), "guest.secretScan");
	for (const unit of SERVICES) {
		const refused = guest.serviceAndMount?.[unit];
		a(Number.isInteger(refused?.exitCode) && refused.exitCode !== 0 && refused.MainPID === "0", `guest.serviceAndMount.${unit}`);
	}
	a(guest.serviceAndMount.privateMount?.bytes === 64 * 1024 ** 2, "guest.serviceAndMount.privateMount");
	const renderers = guest.browser?.renderers;
	a(Array.isArray(renderers) && renderers.length > 0 && renderers.every((r) => r.seccomp === "2" && r.noNewPrivs === "1" && /^0+$/.test(r.capEff)), "guest.browser.renderers");

	// One image: the one built, labelled and booted.
	both(isDeepStrictEqual(acceptance.image, image) && image.project === build.project, "image");
	both(acceptance.rootDiskBytes >= build.rootDiskBytes, "rootDiskBytes");
	both(guest.closureBefore.receiptSha256 === build.installationReceiptSha256, "installationReceiptSha256");
	both(guest.closureBefore.packageManifestSha256 === build.packageManifestSha256, "packageManifestSha256");
	both(guest.closureBefore.specSha256 === build.specSha256, "specSha256");
}
async function signImage(options) {
	const build = await readEvidence(options.build);
	const acceptance = await readEvidence(options.acceptance);
	checkEvidence(build.value, acceptance.value);
	const { privateKey, verificationKeySpki, keyId } = await loadSigningKey(options.key);
	const { module: v, dispose } = await loadVerifier();
	try {
		const image = build.value.image;
		const statement = {
			schema: "qorpera.lxd-office-image-provenance/v1",
			image: {
				fingerprint: image.fingerprint,
				baseFingerprint: build.value.baseFingerprint,
				architecture: image.architecture,
				bytes: image.bytes,
				guestPackageManifestSha256: build.value.packageManifestSha256,
				bootstrapSha256: build.value.installationReceiptSha256,
			},
			source: { repository: options.repository, commit: build.value.commit, tree: "clean" },
			acceptance: {
				testedAt: acceptance.value.testedAt,
				evidenceSha256: hash(acceptance.bytes),
				virtualization: "kvm",
				bootMode: "uefi-secureboot",
				secureBoot: true,
				credentials: "absent",
				computeIdentity: "absent",
				companyState: "absent",
				services: "fail-closed",
			},
		};
		const envelope = {
			schema: "qorpera.lxd-office-image-provenance-envelope/v1",
			statement,
			signature: { algorithm: "ed25519", value: sign(null, Buffer.from(v.officeCanonical(statement)), privateKey).toString("base64") },
		};
		const statementSha256 = v.officeDigest(statement);
		// The fields of a physical policy (lxd-office-physical-policy.ts) that name this image. Its root disk may not be smaller
		// than the build's: the image's virtual size is the build VM's root.
		const policy = {
			schema: "qorpera.office-image-policy-fields/v1",
			keyId,
			guest: { imageFingerprint: image.fingerprint, bootstrapSha256: build.value.installationReceiptSha256 },
			host: { architecture: image.architecture },
			image: { bytes: image.bytes, guestPackageManifestSha256: build.value.packageManifestSha256, statementSha256, verificationKeySpki },
			minimumRootDiskBytes: build.value.rootDiskBytes,
		};
		const confirm = (value) => {
			try {
				v.verifyLxdOfficeImageProvenance(value, verificationKeySpki, statementSha256);
				v.assertLxdOfficePhysicalImage(policy, value);
			} catch {
				fail("OFFICE_IMAGE_SIGNING_UNCONFIRMED");
			}
		};
		confirm(envelope);
		try {
			await mkdir(options.out, { mode: 0o700 });
		} catch (error) {
			fail(error?.code === "EEXIST" ? "OFFICE_IMAGE_SIGNING_OUTPUT_EXISTS" : "OFFICE_IMAGE_SIGNING_OUTPUT_INVALID");
		}
		const files = [
			["statement.json", json(statement)],
			["office-image-provenance.json", json(envelope)],
			["policy-image.json", json(policy)],
		];
		for (const [file, text] of files) await writeFile(join(options.out, file), text, { mode: 0o400, flag: "wx" });
		// Re-read what was written: the envelope must verify on its own.
		confirm(JSON.parse(await readFile(join(options.out, "office-image-provenance.json"), "utf8")));
		process.stdout.write(
			json({
				out: options.out,
				imageFingerprint: image.fingerprint,
				statementSha256,
				keyId,
				buildEvidenceSha256: hash(build.bytes),
				acceptanceEvidenceSha256: statement.acceptance.evidenceSha256,
			}),
		);
	} finally {
		await dispose();
	}
}
async function main(argv) {
	if (argv.length === 1 && argv[0] === "--help") {
		process.stdout.write(USAGE);
		return;
	}
	if (argv.length === 2 && argv[0] === "--generate-key" && argv[1] && !argv[1].startsWith("--")) return generateKey(resolve(argv[1]));
	if (argv[0] === "sign") return signImage(parseArguments(argv.slice(1)));
	fail("OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID");
}
try {
	await main(process.argv.slice(2));
} catch (error) {
	const code = error instanceof Error && /^OFFICE_IMAGE_SIGNING_[A-Z_]+(: [\w.@-]+)?$/.test(error.message) ? error.message : "OFFICE_IMAGE_SIGNING_UNCONFIRMED";
	process.stderr.write(`${code}\n`);
	process.exitCode = code === "OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID" ? 2 : 1;
}
