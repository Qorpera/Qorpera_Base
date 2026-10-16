import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = (name) => join(repositoryRoot, "scripts", name);
const read = (name) => readFileSync(script(name), "utf-8");
const signer = script("sign-office-image-provenance.mjs");
const GIB = 1024 ** 3;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// lxd-office-image-provenance.ts officeCanonical, written out again so the test checks the signature on its own.
const canonical = (value) => {
	const sorted = (input) => {
		if (Array.isArray(input)) return input.map(sorted);
		if (!input || typeof input !== "object") return input;
		return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sorted(input[key])]));
	};
	return JSON.stringify(sorted(value));
};
const run = (file, args) => spawnSync(file, args, { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe", timeout: 60000 });
const sign = (args) => run(process.execPath, [signer, ...args]);

test("the office image scripts parse, and so does the acceptance's guest proof", () => {
	for (const name of ["build-office-image-candidate.sh", "office-image-recipe.sh", "build-office-image-production.sh",
		"accept-office-image.sh"])
		execFileSync("bash", ["-n", script(name)]);
	const proof = read("accept-office-image.sh").match(/<<'EOF' \|\| true\n([\s\S]*?)\nEOF\n/)[1];
	execFileSync("python3", ["-I", "-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: proof, timeout: 5000 });
});

test("production builds and accepts in the host's own LXD: no stage, no alias, no network, admission on", () => {
	const production = read("build-office-image-production.sh");
	const accept = read("accept-office-image.sh");
	assert.match(production, /^source "\$repo\/scripts\/office-image-recipe\.sh"$/m);
	for (const step of ["office_image_boot_and_fetch", "office_image_install", "office_image_seal"])
		assert.match(production, new RegExp(`^${step}$`, "m"));
	for (const source of [production, accept]) {
		assert.match(source, / init "\$\w+" "\$vm" --vm --no-profiles --storage "\$pool" \\\n\t-c boot\.mode=uefi-secureboot /);
		assert.match(source, /-d root,size="\$root_size"/);
		assert.match(source, /\(\(available >= 16 \* 1024 \* 1024\)\) \|\| fail /);
		assert.match(source, /\[\[ \$\(id -u\) == 0 \]\] \|\| fail /);
		assert.match(source, /\[\[ \$\(hostname\) == "\$host" \]\] \|\| fail /);
		assert.match(source, /fail "kvm or vhost_vsock is not loaded"/);
		assert.doesNotMatch(source, /qorpera-office-stage|qoc-|--stage|--alias|\blx publish\b|nested proof|qorpera-testvm/);
		// Nothing here changes the host's modules, firewall, sysctls or links.
		assert.doesNotMatch(source, /\b(modprobe|insmod|rmmod)\b|nft (add|delete|flush|-f)|sysctl -w|ip link (add|del|set)/);
	}
	assert.match(accept, /fail "the VM unexpectedly has a NIC"/);
	// Each deletes only what it made.
	const deletes = (source) => [...source.matchAll(/^\tif \(\(made_\w+\)\); then (.*? delete .*?) \|\| status=1; fi$/gm)].map((m) => m[1]);
	assert.deepEqual(deletes(production), ['lx delete --force "$vm"', 'lx image delete "$base"']);
	assert.deepEqual(deletes(accept), ['la delete --force "$vm"', 'la image delete "$fingerprint"',
		'lxc --force-local project delete "$throwaway" </dev/null']);
	// The folder program comes built and must be the pinned build; the image is the clean commit's.
	assert.doesNotMatch(production, /node scripts\/build-folder-program/);
	assert.match(production, /folder_pin="\$repo\/deploy\/folder-service\/folder-program-linux-x64\.json"/);
	assert.match(production, /\[\[ \$\(clean_commit\) == "\$commit" \]\] \|\| fail /);
	assert.match(production, /profiles: \[\], aliases: \[\],/);
	assert.match(production, /"qorpera\.purpose": "production-office-4e"/);
});

test("the production builder and the acceptance refuse bad arguments before touching LXD", () => {
	const dir = mkdtempSync(join(tmpdir(), "office-image-arguments-"));
	try {
		const evidence = join(dir, "evidence.json");
		const fingerprint = "f".repeat(64);
		const refused = (name, args, pattern) => {
			const result = run("bash", [script(name), ...args]);
			assert.equal(result.status, 1, `${name} ${args.join(" ")}: ${result.stderr}`);
			assert.match(result.stderr, pattern);
		};
		const production = (args) => ["--folder-program", join(dir, "qorpera-folder"), "--evidence", evidence, ...args];
		refused("build-office-image-production.sh", [], /^FAIL: usage: /);
		refused("build-office-image-production.sh", ["--stage"], /^FAIL: usage: /);
		refused("build-office-image-production.sh", production(["--hostname", "node01", "--stage", "1"]), /^FAIL: usage: /);
		refused("build-office-image-production.sh", production(["--hostname", "node01", "--root-size", "20GiB"]),
			/^FAIL: the root size is 24GiB to 2048GiB/);
		refused("build-office-image-production.sh", production(["--hostname", "node01", "--project", "Qofleet01"]),
			/^FAIL: invalid project or pool name/);
		refused("build-office-image-production.sh",
			["--hostname", "node01", "--folder-program", "x", "--evidence", join(repositoryRoot, "evidence.json")],
			/^FAIL: the evidence must go outside the checkout/);
		refused("build-office-image-production.sh", production(["--hostname", "qorpera-not-this-host"]),
			/^FAIL: (run as root on node01's host|this machine is .+, not qorpera-not-this-host)$/m);
		const accept = (args) => ["--evidence", evidence, ...args];
		refused("accept-office-image.sh", [], /^FAIL: usage: /);
		refused("accept-office-image.sh", accept(["--hostname", "node01", fingerprint]), /^FAIL: usage: /);
		refused("accept-office-image.sh", accept(["--hostname", "node01", "--stage", fingerprint, "qofleet01"]), /^FAIL: usage: /);
		refused("accept-office-image.sh", accept(["--hostname", "node01", fingerprint.slice(1), "qofleet01"]),
			/^FAIL: the image is named by its full fingerprint/);
		refused("accept-office-image.sh", accept(["--hostname", "node01", "--root-size", "4096GiB", fingerprint, "qofleet01"]),
			/^FAIL: the root size is 24GiB to 2048GiB/);
		writeFileSync(`${evidence}.png`, "");
		refused("accept-office-image.sh", accept(["--hostname", "node01", fingerprint, "qofleet01"]), /^FAIL: .*\.png exists/);
		rmSync(`${evidence}.png`);
		refused("accept-office-image.sh", accept(["--hostname", "qorpera-not-this-host", fingerprint, "qofleet01"]),
			/^FAIL: (run as root on node01's host|this machine is .+, not qorpera-not-this-host)$/m);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A build's and an acceptance's evidence that agree, shaped as the two scripts write them. */
function evidence() {
	const commit = "c".repeat(40);
	const sums = { receipt: "1".repeat(64), manifest: "2".repeat(64), spec: "3".repeat(64), base: "4".repeat(64) };
	const officeUnit = { ActiveState: "inactive", ExecMainStartTimestampMonotonic: "0", InactiveExitTimestampMonotonic: "0",
		LoadState: "loaded", UnitFileState: "disabled" };
	const image = { fingerprint: "a".repeat(64), project: "qofleet01", type: "virtual-machine", public: false, autoUpdate: false,
		architecture: "x86_64", bytes: 3_221_225_472, profiles: [], aliases: [],
		properties: { description: "Qorpera production office 4e uid/gid 20045 ccccccccc", os: "Ubuntu", release: "resolute",
			architecture: "x86_64", "qorpera.purpose": "production-office-4e", "qorpera.packageManifestSha256": sums.manifest,
			"qorpera.baseFingerprint": sums.base, "qorpera.sourceCommit": commit, "qorpera.installationReceiptSha256": sums.receipt } };
	const build = { schema: "qorpera.office-image-build/v1", host: "node01", commit, tree: "clean", baseFingerprint: sums.base,
		project: "qofleet01", pool: "qorpera-vm", rootSize: "80GiB", rootDiskBytes: 80 * GIB, uid: 20045, gid: 20045,
		installationReceiptSha256: sums.receipt, specSha256: sums.spec, image, recipeSha256: "5".repeat(64),
		packageManifestSha256: sums.manifest, aptClosurePackages: 400, dependencies: {}, officeUnit,
		folderProgramSha256: "6".repeat(64), network: "none" };
	const closure = { receiptSha256: sums.receipt, filesVerified: 30, packageManifestSha256: sums.manifest, specSha256: sums.spec,
		uid: 20045, gid: 20045, dependenciesSha256: "7".repeat(64) };
	const custody = { empty: true, credentials: { path: "/etc/qorpera-office/credentials", mode: "0700", entries: 0 },
		mountinfoSha256: "8".repeat(64) };
	const uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
	const masks = ["apt-daily.timer", "apt-daily-upgrade.timer", "apt-daily.service", "apt-daily-upgrade.service",
		"unattended-upgrades.service"];
	const refused = { exitCode: 1, LoadState: "loaded", ActiveState: "failed", MainPID: "0", Job: "" };
	const acceptance = { schema: "qorpera.office-image-acceptance/v1", testedAt: new Date(Date.now() - 60000).toISOString(),
		host: "node01", pool: "qorpera-vm", rootSize: "80GiB", rootDiskBytes: 80 * GIB, bootMode: "uefi-secureboot",
		network: "none",
		virtualMachine: { uuid, devices: { root: { type: "disk", path: "/", pool: "qorpera-vm", size: "80GiB" } }, profiles: [] },
		image: structuredClone(image), cloudInit: "status: done",
		guest: { schema: "qorpera.office-image-cold-boot-proof/v1", passed: true,
			guest: { productUuid: uuid, virtualization: "kvm", firmware: "uefi",
				secureBootVariable: "SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c", secureBoot: true },
			unitsBefore: { "qorpera-company-computer.service": { ...officeUnit, Job: "", DropInPaths: "" } },
			closureBefore: closure, closureAfter: structuredClone(closure), custodyBefore: custody, custodyAfter: structuredClone(custody),
			aptMasks: Object.fromEntries(masks.map((unit) => [unit, { UnitFileState: "masked", ActiveState: "inactive" }])),
			secretScan: { roots: ["/"], skipped: ["/dev", "/proc", "/sys"], kinds: ["jwt", "supabase-secret"], filesScanned: 90000,
				bytesScanned: 4 * GIB, hits: [] },
			serviceAndMount: { "qorpera-company-computer.service": refused,
				"qorpera-company-computer-preparation.service": structuredClone(refused),
				privateMount: { bytes: 64 * 1024 ** 2, uid: 20045, gid: 20045, mode: 448, options: ["noexec", "nodev", "nosuid"] } },
			browser: { renderers: [{ pid: 900, seccomp: "2", noNewPrivs: "1", capEff: "0000000000000000" }] } } };
	return { build, acceptance };
}

/** The evidence, changed by `change`, and an ephemeral ed25519 key only the test's user can read. */
function signing(change = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "office-image-signing-"));
	const { build, acceptance } = evidence();
	change(build, acceptance);
	writeFileSync(join(dir, "build.json"), `${JSON.stringify(build, null, 2)}\n`);
	writeFileSync(join(dir, "acceptance.json"), `${JSON.stringify(acceptance, null, 2)}\n`);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	writeFileSync(join(dir, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o400 });
	const spki = publicKey.export({ type: "spki", format: "der" });
	const args = ["sign", "--build", join(dir, "build.json"), "--acceptance", join(dir, "acceptance.json"), "--key",
		join(dir, "key.pem"), "--out", join(dir, "out")];
	return { dir, build, acceptance, spki, args, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the signer signs the statement the orchestrator verifies and writes a policy's image fields", () => {
	const { dir, build, acceptance, spki, args, cleanup } = signing();
	try {
		const result = sign(args);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		const out = join(dir, "out");
		assert.equal(statSync(out).mode & 0o777, 0o700);
		const files = ["statement.json", "office-image-provenance.json", "policy-image.json"];
		for (const file of files) assert.equal(statSync(join(out, file)).mode & 0o777, 0o400, file);
		const [statement, envelope, policy] = files.map((file) => JSON.parse(readFileSync(join(out, file), "utf-8")));
		const acceptanceSha256 = hash(readFileSync(join(dir, "acceptance.json")));
		assert.deepEqual(statement, {
			schema: "qorpera.lxd-office-image-provenance/v1",
			image: { fingerprint: build.image.fingerprint, baseFingerprint: build.baseFingerprint, architecture: "x86_64",
				bytes: build.image.bytes, guestPackageManifestSha256: build.packageManifestSha256,
				bootstrapSha256: build.installationReceiptSha256 },
			source: { repository: "https://github.com/Qorpera/Qorpera_Base.git", commit: build.commit, tree: "clean" },
			acceptance: { testedAt: acceptance.testedAt, evidenceSha256: acceptanceSha256, virtualization: "kvm",
				bootMode: "uefi-secureboot", secureBoot: true, credentials: "absent", computeIdentity: "absent",
				companyState: "absent", services: "fail-closed" },
		});
		assert.deepEqual(Object.keys(envelope), ["schema", "statement", "signature"]);
		assert.equal(envelope.schema, "qorpera.lxd-office-image-provenance-envelope/v1");
		assert.deepEqual(envelope.statement, statement);
		assert.equal(envelope.signature.algorithm, "ed25519");
		const key = createPublicKey({ key: spki, format: "der", type: "spki" });
		const signature = Buffer.from(envelope.signature.value, "base64");
		assert.ok(verify(null, Buffer.from(canonical(statement)), key, signature));
		assert.ok(!verify(null, Buffer.from(canonical({ ...statement, source: { ...statement.source, commit: "d".repeat(40) } })), key,
			signature));
		assert.deepEqual(policy, {
			schema: "qorpera.office-image-policy-fields/v1",
			keyId: hash(spki),
			guest: { imageFingerprint: build.image.fingerprint, bootstrapSha256: build.installationReceiptSha256 },
			host: { architecture: "x86_64" },
			image: { bytes: build.image.bytes, guestPackageManifestSha256: build.packageManifestSha256,
				statementSha256: hash(canonical(statement)), verificationKeySpki: spki.toString("base64") },
			minimumRootDiskBytes: 80 * GIB,
		});
		const printed = JSON.parse(result.stdout);
		assert.equal(printed.statementSha256, policy.image.statementSha256);
		assert.equal(printed.acceptanceEvidenceSha256, acceptanceSha256);
		assert.equal(printed.buildEvidenceSha256, hash(readFileSync(join(dir, "build.json"))));
		assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
		// It never signs into an existing directory.
		const again = sign(args);
		assert.equal(again.status, 1);
		assert.equal(again.stderr, "OFFICE_IMAGE_SIGNING_OUTPUT_EXISTS\n");
	} finally {
		cleanup();
	}
});

test("the signer refuses evidence that does not hold together", () => {
	const cases = [
		[(b) => { b.tree = "dirty"; }, "OFFICE_IMAGE_SIGNING_BUILD_INVALID: tree"],
		[(b) => { b.image.aliases = [{ name: "office" }]; }, "OFFICE_IMAGE_SIGNING_BUILD_INVALID: image.profiles"],
		[(b) => { b.image.properties["qorpera.sourceCommit"] = "d".repeat(40); },
			"OFFICE_IMAGE_SIGNING_BUILD_INVALID: image.properties.qorpera.sourceCommit"],
		[(b) => { b.rootSize = "24GiB"; }, "OFFICE_IMAGE_SIGNING_BUILD_INVALID: rootDiskBytes"],
		[(_, a) => { a.guest.guest.secureBoot = false; }, "OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: guest.guest"],
		[(_, a) => { a.guest.guest.productUuid = "00000000-0000-4000-8000-000000000000"; },
			"OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: guest.guest.productUuid"],
		[(_, a) => { a.guest.secretScan.hits = [{ path: "/root/.env", kinds: ["jwt"] }]; },
			"OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: guest.secretScan"],
		[(_, a) => { a.guest.custodyAfter.credentials.entries = 1; }, "OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: guest.custodyAfter"],
		[(_, a) => { a.guest.serviceAndMount["qorpera-company-computer.service"].exitCode = 0; },
			"OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: guest.serviceAndMount.qorpera-company-computer.service"],
		[(_, a) => { a.virtualMachine.devices.eth0 = { type: "nic" }; }, "OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: virtualMachine"],
		[(_, a) => { a.testedAt = new Date(Date.now() + 3600000).toISOString(); }, "OFFICE_IMAGE_SIGNING_ACCEPTANCE_INVALID: testedAt"],
		[(_, a) => { a.image.bytes += 1; }, "OFFICE_IMAGE_SIGNING_EVIDENCE_INCONSISTENT: image"],
		[(_, a) => { a.image.project = "qoa-12345678"; }, "OFFICE_IMAGE_SIGNING_EVIDENCE_INCONSISTENT: image"],
		[(_, a) => { a.rootDiskBytes = 24 * GIB; }, "OFFICE_IMAGE_SIGNING_EVIDENCE_INCONSISTENT: rootDiskBytes"],
		[(_, a) => {
			a.guest.closureBefore.receiptSha256 = "9".repeat(64);
			a.guest.closureAfter.receiptSha256 = "9".repeat(64);
		}, "OFFICE_IMAGE_SIGNING_EVIDENCE_INCONSISTENT: installationReceiptSha256"],
	];
	for (const [change, code] of cases) {
		const { dir, args, cleanup } = signing(change);
		try {
			const result = sign(args);
			assert.equal(result.status, 1, code);
			assert.equal(result.stderr, `${code}\n`);
			assert.ok(!existsSync(join(dir, "out")), code);
		} finally {
			cleanup();
		}
	}
});

test("the signer refuses bad arguments and a key others can read", () => {
	const { dir, args, cleanup } = signing();
	try {
		for (const bad of [[], ["sign"], args.slice(0, -2), [...args, "--stage", "1"], [...args.slice(0, 3), "--build", "x", ...args.slice(3)],
			[...args, "--repository", "http://github.com/Qorpera/Qorpera_Base.git"],
			[...args, "--repository", "https://someone@github.com/Qorpera/Qorpera_Base.git"], ["--generate-key"]]) {
			const result = sign(bad);
			assert.equal(result.status, 2, bad.join(" "));
			assert.equal(result.stderr, "OFFICE_IMAGE_SIGNING_ARGUMENTS_INVALID\n");
		}
		chmodSync(join(dir, "key.pem"), 0o440);
		const result = sign(args);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "OFFICE_IMAGE_SIGNING_KEY_UNSAFE\n");
		assert.ok(!existsSync(join(dir, "out")));
	} finally {
		cleanup();
	}
});

test("the signing key is made only by root, once, readable by root alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "office-image-key-"));
	try {
		const keys = join(dir, "keys");
		if (process.getuid() !== 0) {
			const result = sign(["--generate-key", keys]);
			assert.equal(result.status, 1);
			assert.equal(result.stderr, "OFFICE_IMAGE_SIGNING_ROOT_REQUIRED\n");
			assert.ok(!existsSync(keys));
			return;
		}
		const result = sign(["--generate-key", keys]);
		assert.equal(result.status, 0, result.stderr);
		const printed = JSON.parse(result.stdout);
		assert.deepEqual(Object.keys(printed), ["key", "verificationKeySpki", "keyId"]);
		assert.equal(printed.key, join(keys, "office-image-signing.pem"));
		assert.equal(statSync(keys).mode & 0o777, 0o700);
		assert.equal(statSync(printed.key).mode & 0o777, 0o400);
		const spki = Buffer.from(printed.verificationKeySpki, "base64");
		assert.equal(printed.keyId, hash(spki));
		const made = createPublicKey(createPrivateKey(readFileSync(printed.key))).export({ type: "spki", format: "der" });
		assert.deepEqual(made, spki);
		assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
		const again = sign(["--generate-key", keys]);
		assert.equal(again.status, 1);
		assert.equal(again.stderr, "OFFICE_IMAGE_SIGNING_KEY_EXISTS\n");
		const open = join(dir, "open");
		mkdirSync(open, { mode: 0o755 });
		chmodSync(open, 0o755);
		const unsafe = sign(["--generate-key", open]);
		assert.equal(unsafe.status, 1);
		assert.equal(unsafe.stderr, "OFFICE_IMAGE_SIGNING_KEY_DIRECTORY_UNSAFE\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
