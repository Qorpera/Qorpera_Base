import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentPins, planImages, planStaging, tidy } from "./qorpera-node-tidy.mjs";

const HOUR = 60 * 60_000;
const now = Date.parse("2026-09-23T18:00:00.000Z");
const fp = (character) => character.repeat(64);
const image = (character, hoursAgo, description = "Qorpera native runtime", project = "default") => ({
	fingerprint: fp(character),
	project,
	size: 1_800_000_000,
	uploadedAt: new Date(now - hoursAgo * HOUR).toISOString(),
	description,
});
const config = (overrides = {}) => ({
	schema: "qorpera.node-tidy/v1",
	lxdSocket: "/var/snap/lxd/common/lxd/unix.socket",
	unitPattern: "qorpera*",
	extraRoots: [],
	pinFiles: "/etc/qorpera-native25-phql-a1/provider-env*-v*.json",
	keepFingerprints: [fp("0")],
	recentHours: 48,
	maxDelete: 20,
	staging: [],
	stagingMaxAgeHours: 6,
	...overrides,
});

test("keeps what a live service, machine, rollback or build can use and removes the rest", () => {
	const images = [
		image("0", 900, "Qorpera native34 base"),
		image("1", 300),
		image("2", 200),
		image("3", 100),
		image("4", 72),
		image("5", 10),
		image("6", 500, "Ubuntu 26.04 LTS server"),
		image("7", 400, "Qorpera office image"),
		image("8", 400, "Qorpera coding guest"),
		image("9", 600),
	];
	const plan = planImages({
		images,
		instances: [{ project: "qo26a1", name: "qorpera-office-1", status: "Stopped", baseImage: fp("7") }],
		referenced: new Set([fp("8")]),
		pins: [
			{ version: 49, fingerprint: fp("2"), live: false },
			{ version: 51, fingerprint: fp("3"), live: false },
			{ version: 52, fingerprint: fp("4"), live: false },
			{ version: 53, fingerprint: fp("4"), live: true },
			{ version: 54, fingerprint: fp("5"), live: false },
		],
		now,
		config: config(),
	});
	assert.equal(plan.refusal, null);
	assert.deepEqual(
		Object.fromEntries(plan.keep.map((kept) => [kept.fingerprint[0], kept.reason])),
		{
			0: "configured",
			3: "previous runtime pin",
			4: "live runtime pin",
			5: "staged runtime pin",
			6: "base image",
			7: "instance qo26a1/qorpera-office-1",
			8: "live configuration",
		},
	);
	assert.deepEqual(
		plan.remove.map((removed) => removed.fingerprint[0]),
		["1", "2", "9"],
	);
});

test("keeps recent uploads, such as an image a cut is importing", () => {
	const plan = planImages({
		images: [image("4", 72), image("5", 2), image("9", 600)],
		instances: [],
		referenced: new Set(),
		pins: [{ version: 53, fingerprint: fp("4"), live: true }],
		now,
		config: config(),
	});
	assert.deepEqual(
		plan.keep.map((kept) => [kept.fingerprint[0], kept.reason]),
		[
			["4", "live runtime pin"],
			["5", "recent upload"],
		],
	);
	assert.deepEqual(
		plan.remove.map((removed) => removed.fingerprint[0]),
		["9"],
	);
});

test("refuses to delete anything when the live pin is missing, not local, or the list is too long", () => {
	const images = [image("4", 72), image("1", 300), image("2", 300)];
	const base = { images, instances: [], referenced: new Set(), now };
	const refused = [
		planImages({ ...base, pins: [{ version: 53, fingerprint: fp("4"), live: false }], config: config() }),
		planImages({ ...base, pins: [{ version: 53, fingerprint: fp("e"), live: true }], config: config() }),
		planImages({ ...base, pins: [{ version: 53, fingerprint: fp("4"), live: true }], config: config({ maxDelete: 1 }) }),
	];
	assert.deepEqual(
		refused.map((plan) => plan.refusal),
		[
			"no live runtime pin was found",
			"the live runtime pin names no local image",
			"would delete 2 images, more than 1",
		],
	);
	for (const plan of refused) assert.deepEqual(plan.remove, []);
});

test("removes image transfer files only once they are old", () => {
	const files = [
		{ path: "/var/tmp/qorpera-native80-image-a1.tar.gz", mtimeMs: now - 30 * HOUR },
		{ path: "/var/tmp/qorpera-native83-image-a1.tar.gz", mtimeMs: now - HOUR },
	];
	assert.deepEqual(
		planStaging(files, now, 6).map((file) => file.path),
		["/var/tmp/qorpera-native80-image-a1.tar.gz"],
	);
});

async function nodeFixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-tidy-"));
	const etc = join(root, "etc");
	const tmp = join(root, "tmp");
	for (const directory of [etc, tmp]) await mkdir(directory);
	const launcher = join(root, "provider-launch-v62.py");
	await writeFile(launcher, "v=json.loads(read(BASE/'provider-env-v53.json',0o440,32768))\n");
	const env = (character) => `${JSON.stringify({ env: { QORPERA_LXD_IMAGE_FINGERPRINT: fp(character) } })}\n`;
	await writeFile(join(etc, "provider-env-v51.json"), env("3"));
	await writeFile(join(etc, "provider-env-v52.json"), env("4"));
	await writeFile(join(etc, "provider-env-v53.json"), env("4"));
	await writeFile(join(etc, "office-policy.json"), JSON.stringify({ image: fp("7") }));
	const oldTransfer = join(tmp, "qorpera-native80-image-a1.tar.gz");
	const newTransfer = join(tmp, "qorpera-native83-image-a1.tar.gz");
	await writeFile(oldTransfer, "old");
	await writeFile(newTransfer, "new");
	await utimes(oldTransfer, (now - 30 * HOUR) / 1000, (now - 30 * HOUR) / 1000);
	await utimes(newTransfer, (now - HOUR) / 1000, (now - HOUR) / 1000);
	const deleted = [];
	const lxd = {
		async images() {
			return [image("0", 900), image("3", 100), image("4", 72), image("7", 400), image("9", 600, "x", "qn25b2")];
		},
		async instances() {
			return [{ project: "qn25b2", name: "qorpera-exec-node02", status: "Running", baseImage: fp("4") }];
		},
		async deleteImage(fingerprint, project) {
			deleted.push(`${fingerprint[0]}@${project}`);
		},
	};
	const systemd = {
		async units() {
			return ["qorpera-native25-phql-provider.service"];
		},
		async startPaths() {
			return [launcher];
		},
	};
	const nodeConfig = config({
		extraRoots: [join(etc, "office-*.json")],
		pinFiles: join(etc, "provider-env*-v*.json"),
		staging: [join(tmp, "qorpera-*-image-*.tar.gz")],
	});
	return { root, tmp, lxd, systemd, deleted, config: nodeConfig };
}

test("a dry run reports and changes nothing; an apply deletes exactly the reported items", async () => {
	const node = await nodeFixture();
	try {
		const dry = await tidy({ config: node.config, apply: false, lxd: node.lxd, systemd: node.systemd, now });
		assert.equal(dry.mode, "dry-run");
		assert.equal(dry.refusal, null);
		assert.deepEqual(
			dry.keep.map((kept) => [kept.fingerprint[0], kept.reason]),
			[
				["0", "configured"],
				["3", "previous runtime pin"],
				["4", "instance qn25b2/qorpera-exec-node02"],
				["7", "live configuration"],
			],
		);
		assert.deepEqual(
			dry.remove.map((removed) => `${removed.fingerprint[0]}@${removed.project}`),
			["9@qn25b2"],
		);
		assert.deepEqual(
			dry.staging.map((file) => file.path),
			[join(node.tmp, "qorpera-native80-image-a1.tar.gz")],
		);
		assert.deepEqual(node.deleted, []);
		assert.equal((await readdir(node.tmp)).length, 2);

		const applied = await tidy({ config: node.config, apply: true, lxd: node.lxd, systemd: node.systemd, now });
		assert.deepEqual(node.deleted, ["9@qn25b2"]);
		assert.deepEqual(applied.errors, []);
		assert.deepEqual(await readdir(node.tmp), ["qorpera-native83-image-a1.tar.gz"]);
	} finally {
		await rm(node.root, { recursive: true, force: true });
	}
});

test("a refusal deletes nothing, not even old transfer files", async () => {
	const node = await nodeFixture();
	try {
		const report = await tidy({
			config: node.config,
			apply: true,
			lxd: node.lxd,
			systemd: { ...node.systemd, startPaths: async () => [] },
			now,
		});
		assert.equal(report.refusal, "no live runtime pin was found");
		assert.deepEqual(report.remove, []);
		assert.deepEqual(report.staging, []);
		assert.deepEqual(node.deleted, []);
		assert.equal((await readdir(node.tmp)).length, 2);
	} finally {
		await rm(node.root, { recursive: true, force: true });
	}
});

/** The node agent's layout: releases/<n>/release.json, current, roles/provider. */
async function agentLayout(root, releases, { current, provider }) {
	const agent = join(root, "opt-qorpera-node");
	await mkdir(join(agent, "roles"), { recursive: true });
	for (const [revision, character] of Object.entries(releases)) {
		await mkdir(join(agent, "releases", revision), { recursive: true });
		const env = { QORPERA_LXD_IMAGE_FINGERPRINT: fp(character) };
		await writeFile(join(agent, "releases", revision, "release.json"), JSON.stringify({ roles: { provider: { env } } }));
	}
	await mkdir(join(agent, "releases", ".stage-x"));
	await symlink(`releases/${current}`, join(agent, "current"));
	if (provider !== undefined) await symlink(`../releases/${provider}`, join(agent, "roles", "provider"));
	return agent;
}

test("on a node agent node the releases decide, and the old lane's pins are held until archived", async () => {
	const node = await nodeFixture();
	try {
		// Release 0 runs image 4 (as env v53 did), release 1 is staged with image 8; the provider still runs release 0.
		const agentRoot = await agentLayout(node.root, { 0: "4", 1: "8" }, { current: 0, provider: 0 });
		assert.deepEqual(await agentPins(agentRoot), [
			{ version: 0, fingerprint: fp("4"), live: true },
			{ version: 1, fingerprint: fp("8"), live: false },
		]);
		const lxd = { ...node.lxd, images: async () => [...(await node.lxd.images()), image("8", 100), image("5", 100)] };
		// The fixed launcher names no env file: without agentRoot, tidy finds no live pin and refuses.
		const systemd = { ...node.systemd, startPaths: async () => [] };
		const without = await tidy({ config: node.config, apply: false, lxd, systemd, now });
		assert.equal(without.refusal, "no live runtime pin was found");
		const report = await tidy({ config: { ...node.config, agentRoot }, apply: false, lxd, systemd, now });
		assert.equal(report.refusal, null);
		assert.deepEqual(
			report.keep.map((kept) => [kept.fingerprint[0], kept.reason]),
			[
				["0", "configured"],
				["3", "old lane pin, until archived"],
				["4", "instance qn25b2/qorpera-exec-node02"],
				["7", "live configuration"],
				["8", "staged runtime pin"],
			],
		);
		assert.deepEqual(
			report.remove.map((removed) => removed.fingerprint[0]),
			["9", "5"],
		);
	} finally {
		await rm(node.root, { recursive: true, force: true });
	}
});

test("the live release is the one the provider role runs, and the one before it with another image is the rollback", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-tidy-agent-"));
	try {
		// A rollback left the provider on release 1 while current names 2.
		const agentRoot = await agentLayout(root, { 0: "a", 1: "b", 2: "c" }, { current: 2, provider: 1 });
		const pins = await agentPins(agentRoot);
		assert.deepEqual(
			pins.filter((pin) => pin.live).map((pin) => pin.version),
			[1],
		);
		const plan = planImages({
			images: [image("a", 400), image("b", 400), image("c", 400), image("d", 400)],
			instances: [],
			referenced: new Set(),
			pins,
			now,
			config: config({ keepFingerprints: [] }),
		});
		assert.deepEqual(
			plan.keep.map((kept) => [kept.fingerprint[0], kept.reason]),
			[
				["a", "previous runtime pin"],
				["b", "live runtime pin"],
				["c", "staged runtime pin"],
			],
		);
		assert.equal(await agentPins(join(root, "missing")), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the installer pins the tool, unit and timer it installs", async () => {
	const here = new URL(".", import.meta.url);
	const installer = await readFile(new URL("install-node-tidy.sh", here), "utf8");
	for (const [name, file] of [
		["TOOL", "qorpera-node-tidy.mjs"],
		["UNIT", "qorpera-node-tidy.service"],
		["TIMER", "qorpera-node-tidy.timer"],
	]) {
		const digest = createHash("sha256")
			.update(await readFile(new URL(file, here)))
			.digest("hex");
		assert.ok(installer.includes(`EXPECTED_${name}_SHA256="${digest}"`), `installer pin for ${file} is stale`);
	}
});
