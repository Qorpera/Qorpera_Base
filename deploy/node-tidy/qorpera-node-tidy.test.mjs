import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentPins, nodeLxd, parseConfig, planImages, planStaging, readHoldDir, tidy } from "./qorpera-node-tidy.mjs";

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
async function agentLayout(root, releases, { current, provider, previous }) {
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
	if (previous !== undefined) await symlink(`releases/${previous}`, join(agent, "previous"));
	return agent;
}

test("on a node agent node the releases decide, and only the pin a resting old unit starts from is held", async () => {
	const node = await nodeFixture();
	try {
		// Release 0 runs image 6, release 1 is staged with image 8; the provider still runs release 0.
		const agentRoot = await agentLayout(node.root, { 0: "6", 1: "8" }, { current: 0, provider: 0 });
		assert.deepEqual(await agentPins(agentRoot), [
			{ version: 0, fingerprint: fp("6"), live: true },
			{ version: 1, fingerprint: fp("8"), live: false },
		]);
		const lxd = {
			...node.lxd,
			images: async () => [...(await node.lxd.images()), image("6", 100), image("8", 100), image("5", 100)],
		};
		// The new unit runs the fixed launcher, which names no env file. The old unit is installed but inactive; its
		// launcher names env v53 (image 4). Env v51 (image 3) is named by nothing.
		const OLD = "qorpera-native25-phql-provider.service";
		const [launcher] = await node.systemd.startPaths();
		const systemd = {
			units: async () => ["qorpera-node-provider.service"],
			installedUnits: async () => ["qorpera-node-provider.service", OLD],
			startPaths: async (unit) => (unit === OLD ? [launcher] : []),
		};
		const without = await tidy({ config: node.config, apply: false, lxd, systemd, now });
		assert.equal(without.refusal, "no live runtime pin was found");
		const report = await tidy({ config: { ...node.config, agentRoot }, apply: false, lxd, systemd, now });
		assert.equal(report.refusal, null);
		assert.deepEqual(
			report.keep.map((kept) => [kept.fingerprint[0], kept.reason]),
			[
				["0", "configured"],
				["4", "instance qn25b2/qorpera-exec-node02"],
				["7", "live configuration"],
				["6", "live runtime pin"],
				["8", "staged runtime pin"],
			],
		);
		assert.deepEqual(
			report.remove.map((removed) => removed.fingerprint[0]),
			["3", "9", "5"],
		);
		// Without the exec host, image 4 stays only as the resting old unit's pin; image 3 (env v51) is not held.
		const lone = { ...lxd, instances: async () => [] };
		const resting = await tidy({ config: { ...node.config, agentRoot }, apply: false, lxd: lone, systemd, now });
		assert.deepEqual(
			resting.keep.filter((kept) => "34".includes(kept.fingerprint[0])).map((kept) => [kept.fingerprint[0], kept.reason]),
			[["4", "old lane pin, until archived"]],
		);
		// Once the old unit is archived, nothing holds the old lane's pins.
		const archived = { ...systemd, installedUnits: async () => ["qorpera-node-provider.service"] };
		const after = await tidy({ config: { ...node.config, agentRoot }, apply: false, lxd, systemd: archived, now });
		assert.ok(!after.keep.some((kept) => kept.reason === "old lane pin, until archived"));
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

test("holdDir keeps an unstaged release image and its transfer tarball past recentHours (Oct 18 v181 guard)", async () => {
	const node = await nodeFixture();
	const holdDir = join(node.root, "holds.d");
	await mkdir(holdDir, { mode: 0o700 });
	try {
		const unstaged = image("a", 24, "Qorpera native181 unstaged candidate");
		const stale = image("b", 100, "Qorpera native170 old");
		const lxd = {
			...node.lxd,
			images: async () => [...(await node.lxd.images()), unstaged, stale],
		};
		await writeFile(
			join(holdDir, "cut-v181.json"),
			JSON.stringify({
				schema: "qorpera.node-tidy-hold/v1",
				fingerprint: unstaged.fingerprint,
				reason: "cut-v181 awaiting staging",
				stagingFiles: ["qorpera-native80-image-a1.tar.gz"],
			}),
			{ mode: 0o600 },
		);
		await writeFile(join(holdDir, ".tmp-writing"), "{", { mode: 0o600 });
		const cfg = { ...node.config, recentHours: 12, holdDir };
		const report = await tidy({ config: cfg, apply: true, lxd, systemd: node.systemd, now });
		assert.equal(report.refusal, null);
		assert.ok(report.keep.some((k) => k.fingerprint === unstaged.fingerprint && k.reason.includes("cut-v181.json")));
		assert.deepEqual(
			report.remove.map((r) => r.fingerprint[0]).sort(),
			["9", "b"],
		);
		assert.deepEqual(report.staging, [], "held transfer tarball stays untouched");
		assert.ok((await readdir(node.tmp)).includes("qorpera-native80-image-a1.tar.gz"));
	} finally {
		await rm(node.root, { recursive: true, force: true });
	}
});

test("holdDir fails closed and deletes nothing when a hold file is corrupt or a symlink", async () => {
	const node = await nodeFixture();
	const holdDir = join(node.root, "holds.d");
	await mkdir(holdDir, { mode: 0o700 });
	try {
		await writeFile(join(holdDir, "broken.json"), "{not-json", { mode: 0o600 });
		const badJson = await tidy({ config: { ...node.config, holdDir }, apply: true, lxd: node.lxd, systemd: node.systemd, now });
		assert.match(badJson.refusal ?? "", /not valid JSON/);
		assert.deepEqual(node.deleted, []);
		assert.equal((await readdir(node.tmp)).length, 2);

		await rm(join(holdDir, "broken.json"));
		const target = join(node.root, "outside.json");
		await writeFile(target, JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("9"), reason: "x" }), {
			mode: 0o600,
		});
		await symlink(target, join(holdDir, "link.json"));
		const linkRefused = await tidy({ config: { ...node.config, holdDir }, apply: true, lxd: node.lxd, systemd: node.systemd, now });
		assert.match(linkRefused.refusal ?? "", /unsafe or oversized/);
		assert.deepEqual(node.deleted, []);
	} finally {
		await rm(node.root, { recursive: true, force: true });
	}
});

test("parseConfig validates optional holdDir under /etc or /opt and rejects unsafe paths", () => {
	assert.equal(parseConfig(config({ holdDir: "/etc/qorpera-node-tidy.holds.d" })).holdDir, "/etc/qorpera-node-tidy.holds.d");
	assert.equal(parseConfig(config({ holdDir: "/opt/qorpera-node-tidy/holds.d" })).holdDir, "/opt/qorpera-node-tidy/holds.d");
	for (const bad of ["relative/holds.d", "/var/tmp/holds.d", "/etc/../var/tmp/holds.d", "/etc/.", 42]) {
		assert.throws(() => parseConfig(config({ holdDir: bad })), /invalid/);
	}
});

test("readHoldDir fails closed on unsafe ownership/mode, unreadable dir, non-directory, oversized files, subdirs, and invalid schemas; skips vanished holds", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-tidy-hold-"));
	try {
		const missing = await readHoldDir(join(root, "does-not-exist"));
		assert.equal(missing.refusal, null);
		assert.deepEqual(missing.held, []);

		const regularFile = join(root, "not-a-dir");
		await writeFile(regularFile, "{}", { mode: 0o600 });
		assert.match((await readHoldDir(regularFile)).refusal ?? "", /not a directory/);

		const realDir = join(root, "real-dir");
		await mkdir(realDir, { mode: 0o700 });
		const dirLink = join(root, "dir-link");
		await symlink(realDir, dirLink);
		assert.match((await readHoldDir(dirLink)).refusal ?? "", /not a directory/);

		const writableDir = join(root, "group-writable");
		await mkdir(writableDir, { mode: 0o700 });
		await chmod(writableDir, 0o775);
		assert.match((await readHoldDir(writableDir)).refusal ?? "", /ownership or permissions/);
		await chmod(writableDir, 0o700);
		assert.match(
			(await readHoldDir(writableDir, { expectedUid: (process.getuid?.() ?? 0) + 1 })).refusal ?? "",
			/ownership or permissions/,
		);

		const writableFileDir = join(root, "group-writable-file");
		await mkdir(writableFileDir, { mode: 0o700 });
		const wf = join(writableFileDir, "cut.json");
		await writeFile(wf, JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "ok" }), {
			mode: 0o600,
		});
		await chmod(wf, 0o664);
		assert.match((await readHoldDir(writableFileDir)).refusal ?? "", /unsafe or oversized/);

		const vanishDir = join(root, "vanish-dir");
		await mkdir(vanishDir, { mode: 0o700 });
		await writeFile(
			join(vanishDir, "a-vanished.json"),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "gone" }),
			{ mode: 0o600 },
		);
		await writeFile(
			join(vanishDir, "b-kept.json"),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("b"), reason: "kept" }),
			{ mode: 0o600 },
		);
		const vanished = await readHoldDir(vanishDir, {
			readdir: async (dir) => {
				const list = await readdir(dir);
				await rm(join(dir, "a-vanished.json"));
				return list;
			},
		});
		assert.equal(vanished.refusal, null);
		assert.deepEqual(
			vanished.held.map((h) => h.fingerprint),
			[fp("b")],
		);

		if (process.getuid?.() !== 0) {
			const lockedDir = join(root, "locked");
			await mkdir(lockedDir, { mode: 0o700 });
			await chmod(lockedDir, 0o000);
			try {
				assert.match((await readHoldDir(lockedDir)).refusal ?? "", /holdDir could not be read: EACCES/);
			} finally {
				await chmod(lockedDir, 0o700);
			}
		}

		const subHoldDir = join(root, "with-subdir");
		await mkdir(join(subHoldDir, "nested"), { recursive: true, mode: 0o700 });
		await chmod(subHoldDir, 0o700);
		assert.match((await readHoldDir(subHoldDir)).refusal ?? "", /unsafe or oversized/);

		const bigDir = join(root, "with-big");
		await mkdir(bigDir, { mode: 0o700 });
		await writeFile(join(bigDir, "huge.json"), " ".repeat(65_537), { mode: 0o600 });
		assert.match((await readHoldDir(bigDir)).refusal ?? "", /unsafe or oversized/);

		const invalidPayloads = [
			"null",
			"[]",
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "ok", extra: 1 }),
			JSON.stringify({ schema: "wrong/v1", fingerprint: fp("a"), reason: "ok" }),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: "not-hex", reason: "ok" }),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "   " }),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "ok", stagingFiles: ["../x"] }),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "ok", stagingFiles: ["a/b"] }),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "ok", stagingFiles: ["."] }),
			JSON.stringify({ schema: "qorpera.node-tidy-hold/v1", fingerprint: fp("a"), reason: "ok", stagingFiles: [".."] }),
		];
		for (let i = 0; i < invalidPayloads.length; i++) {
			const dir = join(root, `schema-${i}`);
			await mkdir(dir, { mode: 0o700 });
			await writeFile(join(dir, "bad.json"), invalidPayloads[i], { mode: 0o600 });
			assert.match((await readHoldDir(dir)).refusal ?? "", /is invalid/, `payload #${i} must be refused`);
		}

		const node = await nodeFixture();
		try {
			const badHold = join(node.root, "bad-holds");
			await mkdir(badHold, { mode: 0o700 });
			await writeFile(join(badHold, "corrupt.json"), "{", { mode: 0o600 });
			const both = await tidy({
				config: { ...node.config, holdDir: badHold },
				apply: false,
				lxd: node.lxd,
				systemd: { ...node.systemd, startPaths: async () => [] },
				now,
			});
			assert.match(both.refusal ?? "", /no live runtime pin was found/);
			assert.match(both.refusal ?? "", /not valid JSON/);
		} finally {
			await rm(node.root, { recursive: true, force: true });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps the agent's explicit previous rollback image even when an abandoned higher revision exists", async () => {
	const node = await nodeFixture();
	try {
		const agentRoot = await agentLayout(
			node.root,
			{ 10: "a", 11: "b", 12: "c" },
			{ current: 12, provider: 12, previous: 10 },
		);
		const lxd = {
			async images() {
				return [image("a", 300), image("b", 200), image("c", 100)];
			},
			async instances() {
				return [];
			},
			async deleteImage() {},
		};
		const systemd = {
			async units() {
				return [];
			},
			async installedUnits() {
				return [];
			},
			async startPaths() {
				return [];
			},
		};
		const report = await tidy({
			config: config({ agentRoot, keepFingerprints: [] }),
			apply: false,
			lxd,
			systemd,
			now,
		});
		assert.equal(report.refusal, null);
		assert.deepEqual(
			Object.fromEntries(report.keep.map((kept) => [kept.fingerprint[0], kept.reason])),
			{ a: "previous runtime pin", c: "live runtime pin" },
		);
		assert.deepEqual(
			report.remove.map((removed) => removed.fingerprint[0]),
			["b"],
		);
	} finally {
		await rm(node.root, { recursive: true, force: true });
	}
});

test("agentPins rejects malformed previous links and falls back when previous has no provider fingerprint", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-tidy-prev-"));
	try {
		const badRoot = await agentLayout(root, { 10: "a", 11: "b" }, { current: 11, provider: 11 });
		await symlink("../releases/10", join(badRoot, "previous"));
		await assert.rejects(() => agentPins(badRoot), /previous link is unexpected/);

		const fallbackRoot = join(root, "fallback-agent");
		await mkdir(join(fallbackRoot, "roles"), { recursive: true });
		await mkdir(join(fallbackRoot, "releases", "10"), { recursive: true });
		await mkdir(join(fallbackRoot, "releases", "11"), { recursive: true });
		await mkdir(join(fallbackRoot, "releases", "12"), { recursive: true });
		await writeFile(
			join(fallbackRoot, "releases", "10", "release.json"),
			JSON.stringify({ roles: { provider: { env: { QORPERA_LXD_IMAGE_FINGERPRINT: fp("a") } } } }),
		);
		await writeFile(join(fallbackRoot, "releases", "11", "release.json"), JSON.stringify({ roles: {} }));
		await writeFile(
			join(fallbackRoot, "releases", "12", "release.json"),
			JSON.stringify({ roles: { provider: { env: { QORPERA_LXD_IMAGE_FINGERPRINT: fp("c") } } } }),
		);
		await symlink("releases/12", join(fallbackRoot, "current"));
		await symlink("../releases/12", join(fallbackRoot, "roles", "provider"));
		await symlink("releases/11", join(fallbackRoot, "previous"));
		const pins = await agentPins(fallbackRoot);
		const plan = planImages({
			images: [image("a", 300), image("c", 100)],
			instances: [],
			referenced: new Set(),
			pins,
			now,
			config: config({ keepFingerprints: [] }),
		});
		assert.deepEqual(
			Object.fromEntries(plan.keep.map((kept) => [kept.fingerprint[0], kept.reason])),
			{ a: "previous runtime pin", c: "live runtime pin" },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("nodeLxd rejects truncated socket responses and HTTP 500 errors promptly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "qorpera-tidy-lxd-"));
	const sock = join(dir, "lxd.sock");
	let mode = "truncate";
	const server = createServer((socket) => {
		socket.once("data", () => {
			if (mode === "truncate") {
				socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{"meta');
				socket.destroy();
			} else {
				const payload = JSON.stringify({ type: "error", error: "daemon shutting down" });
				socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`);
			}
		});
	});
	try {
		await new Promise((resolve) => server.listen(sock, resolve));
		const lxd = nodeLxd(sock);
		await assert.rejects(() => lxd.images(), /closed|aborted|truncated/i);
		mode = "error";
		await assert.rejects(() => lxd.images(), /daemon shutting down/);
	} finally {
		server.close();
		await rm(dir, { recursive: true, force: true });
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
