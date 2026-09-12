import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	chmod,
	type FileHandle,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH } from "@qorpera/contracts";
import { OFFICE_IMAGE_PACKAGE_FILES } from "../../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import {
	installLxdOfficeServiceSoftwareFiles,
	OFFICE_SERVICE_SOFTWARE_JOURNAL,
} from "../../src/lxd-office-service-software-files.ts";

const target = COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH;
const previous = Buffer.from("console.log('old fixture');\n"),
	next = Buffer.from("console.log('new fixture');\n");
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const signal = new AbortController().signal;
const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
function fixture() {
	const keys = generateKeyPairSync("ed25519");
	const manifest = (service: Buffer) =>
		Buffer.from(
			JSON.stringify({
				schema: "qorpera.company-computer-package/v1",
				platform: "linux",
				minimumNode: "22.19.0",
				playwright: "1.62.1",
				imagePrerequisites: [
					"cgroup-v2",
					"systemd-credentials",
					"unprivileged-user-namespaces",
					"bubblewrap",
					"tini",
					"xfce",
					"tigervnc",
					"chromium",
				],
				artifacts: [
					...OFFICE_IMAGE_PACKAGE_FILES,
					"node_modules/playwright-core/package.json",
					"node_modules/playwright-core/index.mjs",
					"node_modules/playwright-core/browsers.json",
					"wallpapers/qorpera-screen-pebble.png",
				].map((file, i) => ({ file, bytes: i === 0 ? service.length : 1, sha256: hash(i === 0 ? service : file) })),
			}),
		);
	const manifests = { previous: manifest(previous), next: manifest(next) };
	const statement = {
		schema: "qorpera.office-service-software-statement/v1",
		base: {
			imageSha256: hash("image"),
			bootstrapSha256: hash("bootstrap"),
			packageManifestSha256: hash(manifests.previous),
			sourceCommit: "1".repeat(40),
		},
		previous: {
			sourceCommit: "1".repeat(40),
			packageManifestSha256: hash(manifests.previous),
			service: { path: target, bytes: previous.length, sha256: hash(previous) },
		},
		next: {
			packageManifestSha256: hash(manifests.next),
			service: { path: target, bytes: next.length, sha256: hash(next) },
		},
		source: { repository: "https://example.test/source", commit: "2".repeat(40), tree: "clean" },
		acceptance: {
			testedAt: "2026-01-01T00:00:00.000Z",
			evidenceSha256: hash("fixture only"),
			change: "service-only",
		},
	};
	const plan = {
		schema: "qorpera.office-service-software-plan/v1",
		updateId: randomUUID(),
		successorActivationId: randomUUID(),
		stopAcknowledgementSha256: hash("fixture stop"),
		statementSha256: officeDigest(statement),
		predecessor: {
			schema: "qorpera.office-lifecycle-request/v1",
			action: "service_restart",
			transitionId: randomUUID(),
			activationId: randomUUID(),
			providerId: randomUUID(),
			providerPolicySha256: hash("policy"),
			startup: {
				scope: {
					companyId: randomUUID(),
					environmentId: randomUUID(),
					companyComputerId: randomUUID(),
					logicalComputerId: randomUUID(),
				},
				computerGeneration: 1,
				allocationId: randomUUID(),
				instanceSha256: hash("instance"),
				imageSha256: statement.base.imageSha256,
				bootstrapSha256: statement.base.bootstrapSha256,
				bootId: boot,
				configurationSha256: hash("configuration"),
				serviceInvocationId: "1".repeat(32),
			},
		},
	};
	return {
		envelope: {
			schema: "qorpera.office-service-software-envelope/v1",
			statement,
			signature: {
				algorithm: "ed25519",
				value: sign(null, Buffer.from(officeCanonical(statement)), keys.privateKey).toString("base64"),
			},
		},
		plan,
		manifests,
		serviceBytes: next,
		trust: {
			verificationKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
			statementSha256: officeDigest(statement),
			planSha256: officeDigest(plan),
		},
		// SQL and systemd authority are explicitly fixtures in this filesystem lane.
		authorize: async (_signal: AbortSignal) => {},
	};
}
async function fresh() {
	for (const root of ["/opt/qorpera-office", OFFICE_SERVICE_SOFTWARE_JOURNAL]) {
		for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true });
	}
	await chmod("/opt/qorpera-office", 0o755);
	await chmod(OFFICE_SERVICE_SOFTWARE_JOURNAL, 0o700);
	await writeFile(target, previous, { mode: 0o444 });
	return fixture();
}
let checks = 0;
{
	const f = await fresh();
	const receipt = await installLxdOfficeServiceSoftwareFiles(f, signal);
	const installed = await stat(target);
	assert((await readFile(target)).equals(next));
	assert((await readFile(join(OFFICE_SERVICE_SOFTWARE_JOURNAL, f.plan.updateId, "previous.mjs"))).equals(previous));
	assert(
		(await readFile(join(OFFICE_SERVICE_SOFTWARE_JOURNAL, f.plan.updateId, "previous-manifest.json"))).equals(
			f.manifests.previous,
		),
	);
	assert(
		(await readFile(join(OFFICE_SERVICE_SOFTWARE_JOURNAL, f.plan.updateId, "next-manifest.json"))).equals(
			f.manifests.next,
		),
	);
	assert.deepEqual(await installLxdOfficeServiceSoftwareFiles(f, signal), receipt);
	assert.equal((await stat(target)).ino, installed.ino);
	assert.equal(installed.mode & 0o7777, 0o444);
	checks++;
}
for (const kind of [
	"unauthorized",
	"bad-artifact",
	"bad-key",
	"old-bytes",
	"symlink",
	"hardlink",
	"writable",
	"journal-mode",
	"wrong-boot",
]) {
	const f = await fresh();
	if (kind === "unauthorized")
		f.authorize = async () => {
			throw new Error("fixture authority withheld");
		};
	if (kind === "bad-artifact") f.serviceBytes = Buffer.from("wrong");
	if (kind === "bad-key") f.trust.verificationKeySpki = fixture().trust.verificationKeySpki;
	if (kind === "old-bytes") await writeFile(target, "modified", { mode: 0o444 });
	if (kind === "symlink") {
		await unlink(target);
		await writeFile("/opt/qorpera-office/other", previous, { mode: 0o444 });
		await symlink("other", target);
	}
	if (kind === "hardlink") await link(target, "/opt/qorpera-office/other");
	if (kind === "writable") await chmod(target, 0o644);
	if (kind === "journal-mode") await chmod(OFFICE_SERVICE_SOFTWARE_JOURNAL, 0o755);
	if (kind === "wrong-boot") {
		f.plan.predecessor.startup.bootId = randomUUID();
		f.trust.planSha256 = officeDigest(f.plan);
	}
	await assert.rejects(installLxdOfficeServiceSoftwareFiles(f, signal));
	assert(!(await readFile(target)).equals(next));
	checks++;
}
{
	const f = await fresh();
	const journal = join(OFFICE_SERVICE_SOFTWARE_JOURNAL, f.plan.updateId);
	f.authorize = async () => {
		if ((await readdir(journal).catch((): string[] => [])).includes("install-intent.json"))
			throw new Error("fixture revoked before rename");
	};
	await assert.rejects(installLxdOfficeServiceSoftwareFiles(f, signal), /fixture revoked/);
	assert((await readFile(target)).equals(previous));
	f.authorize = async () => {};
	await installLxdOfficeServiceSoftwareFiles(f, signal);
	assert((await readFile(target)).equals(next));
	checks++;
}
{
	const f = await fresh();
	f.authorize = async () => {
		if ((await readFile(target)).equals(next)) throw new Error("fixture interrupted after rename");
	};
	await assert.rejects(installLxdOfficeServiceSoftwareFiles(f, signal), /fixture interrupted/);
	const before = await stat(target);
	f.authorize = async () => {};
	const receipt = await installLxdOfficeServiceSoftwareFiles(f, signal);
	assert.equal((await stat(target)).ino, before.ino);
	assert.deepEqual(await installLxdOfficeServiceSoftwareFiles(f, signal), receipt);
	checks++;
}
for (const kind of [
	"missing-intent",
	"changed-custody",
	"replaced-target",
	"changed-receipt",
	"changed-manifest",
	"symlink-journal",
]) {
	const f = await fresh();
	const journal = join(OFFICE_SERVICE_SOFTWARE_JOURNAL, f.plan.updateId);
	if (kind === "symlink-journal") {
		await mkdir(join(OFFICE_SERVICE_SOFTWARE_JOURNAL, "other"), { mode: 0o700 });
		await symlink("other", journal);
	} else {
		await installLxdOfficeServiceSoftwareFiles(f, signal);
		if (kind === "missing-intent") await unlink(join(journal, "install-intent.json"));
		if (kind === "changed-custody") await writeFile(join(journal, "previous.mjs"), "corrupt");
		if (kind === "changed-receipt") await writeFile(join(journal, "installed.json"), "{}");
		if (kind === "changed-manifest") await writeFile(join(journal, "previous-manifest.json"), "{}");
		if (kind === "replaced-target") {
			await unlink(target);
			await writeFile(target, next, { mode: 0o444 });
		}
	}
	await assert.rejects(installLxdOfficeServiceSoftwareFiles(f, signal));
	checks++;
}
{
	// Inject an I/O failure at the actual directory flush immediately following
	// rename. On retry, trace actual fsyncs before the receipt is published.
	// This proves recovery ordering, not physical power-loss durability on tmpfs.
	const f = await fresh();
	const handle = await open(target, "r");
	const prototype = Object.getPrototypeOf(handle) as { sync: (this: FileHandle) => Promise<void> };
	const originalSync = prototype.sync;
	await handle.close();
	const synced: string[] = [];
	let fail = true;
	prototype.sync = async function () {
		const path = await readlink(`/proc/self/fd/${this.fd}`);
		if (fail && path === "/opt/qorpera-office" && (await readFile(target)).equals(next))
			throw new Error("fixture lost directory flush after rename");
		synced.push(path);
		return originalSync.call(this);
	};
	try {
		await assert.rejects(installLxdOfficeServiceSoftwareFiles(f, signal), /fixture lost directory flush/);
		assert((await readFile(target)).equals(next));
		const inode = (await stat(target)).ino;
		fail = false;
		synced.length = 0;
		await installLxdOfficeServiceSoftwareFiles(f, signal);
		assert.equal((await stat(target)).ino, inode);
		const journal = join(OFFICE_SERVICE_SOFTWARE_JOURNAL, f.plan.updateId);
		const receiptSync = synced.indexOf(join(journal, "installed.json"));
		assert(receiptSync > 0);
		for (const path of [
			"/opt/qorpera-office",
			OFFICE_SERVICE_SOFTWARE_JOURNAL,
			join(journal, "install-intent.json"),
			join(journal, "previous.mjs"),
			join(journal, "next.mjs"),
		]) {
			assert(
				synced.indexOf(path) >= 0 && synced.indexOf(path) < receiptSync,
				`Recovered prefix was not flushed before receipt: ${path}`,
			);
		}
		checks++;
	} finally {
		prototype.sync = originalSync;
	}
}
console.log(
	JSON.stringify({
		passed: true,
		filesystemChecks: checks,
		actualAtomicRenameAndCrashReconciliation: true,
		authorityAndServiceStateAreFixtures: true,
		serviceStarted: false,
	}),
);
