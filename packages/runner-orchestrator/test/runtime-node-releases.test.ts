import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNodeReleaseImages, readNodeReleaseKeys } from "../src/runtime-node-releases.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** A node agent layout: releases/<revision>/release.json + release.sig, and the legacy release key alone (no
 * release-keys folder), owned by the test's own user. */
async function node() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-releases-"));
	roots.push(root);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keys = {
		folder: join(root, "release-keys"),
		legacy: join(root, "release.pem"),
		owner: process.getuid?.() ?? 0,
	};
	await writeFile(keys.legacy, publicKey.export({ type: "spki", format: "pem" }));
	// The reader refuses a key file others can write: fix the mode whatever the umask.
	await chmod(keys.legacy, 0o444);
	await mkdir(join(root, "releases"));
	const release = async (
		revision: number | string,
		image: unknown,
		options: { key?: KeyObject; body?: (value: Record<string, unknown>) => void } = {},
	) => {
		const value: Record<string, unknown> = {
			schema: "qorpera.node-release/v1",
			revision: Number(revision),
			previousRevision: null,
			roles: { provider: { component: "qorpera-lxd-provider.mjs", env: { QORPERA_LXD_IMAGE_FINGERPRINT: image } } },
		};
		options.body?.(value);
		const bytes = Buffer.from(JSON.stringify(value));
		await mkdir(join(root, "releases", String(revision)));
		await writeFile(join(root, "releases", String(revision), "release.json"), bytes);
		await writeFile(
			join(root, "releases", String(revision), "release.sig"),
			`${sign(null, bytes, options.key ?? privateKey).toString("base64")}\n`,
		);
	};
	return { root, releases: join(root, "releases"), keys, release };
}

describe("images the node's signed releases pin (identical nodes, change 6)", () => {
	it("reads the provider image of every signed release folder", async () => {
		const n = await node();
		await n.release(26, "a".repeat(64));
		await n.release(27, "b".repeat(64));
		await n.release(28, "b".repeat(64));
		expect(await readNodeReleaseImages(n.releases, n.keys)).toEqual(new Set(["a".repeat(64), "b".repeat(64)]));
	});
	it("skips a release signed by another key, a changed body, a wrong revision and a half-written folder", async () => {
		const n = await node();
		const other = generateKeyPairSync("ed25519").privateKey;
		await n.release(1, "1".repeat(64), { key: other });
		await n.release(2, "2".repeat(64), { body: (value) => Object.assign(value, { revision: 3 }) });
		await n.release(4, "4".repeat(64), { body: (value) => Object.assign(value, { schema: "x" }) });
		await n.release(5, "5".repeat(64));
		await writeFile(join(n.releases, "5", "release.json"), '{"schema":"qorpera.node-release/v1"}');
		await mkdir(join(n.releases, "6"));
		await n.release(7, "../x");
		await n.release(8, "8".repeat(64), { body: (value) => Object.assign(value, { roles: { orchestrator: {} } }) });
		await mkdir(join(n.releases, ".staging-9"));
		await n.release(10, "a".repeat(64));
		expect(await readNodeReleaseImages(n.releases, n.keys)).toEqual(new Set(["a".repeat(64)]));
	});
	it("reads only small regular files", async () => {
		const n = await node();
		await n.release(1, "1".repeat(64), { body: (value) => Object.assign(value, { padding: "x".repeat(1048576) }) });
		await n.release(2, "2".repeat(64));
		await rm(join(n.releases, "2", "release.sig"));
		await mkdir(join(n.releases, "2", "release.sig"));
		await n.release(3, "3".repeat(64));
		// A named pipe would block the read forever.
		await n.release(4, "4".repeat(64));
		await rm(join(n.releases, "4", "release.json"));
		expect(spawnSync("mkfifo", [join(n.releases, "4", "release.json")]).status).toBe(0);
		await n.release(5, "5".repeat(64));
		await rm(join(n.releases, "5", "release.sig"));
		expect(spawnSync("mkfifo", [join(n.releases, "5", "release.sig")]).status).toBe(0);
		expect(await readNodeReleaseImages(n.releases, n.keys)).toEqual(new Set(["3".repeat(64)]));
	});
	it("only the newest 16 revisions count", async () => {
		const n = await node();
		await n.release(1, "1".repeat(64));
		for (let revision = 2; revision <= 17; revision++) await n.release(revision, "f".repeat(64));
		expect(await readNodeReleaseImages(n.releases, n.keys)).toEqual(new Set(["f".repeat(64)]));
	});
	it("no key or no releases folder gives no images", async () => {
		const n = await node();
		await n.release(1, "1".repeat(64));
		expect(await readNodeReleaseImages(n.releases, { ...n.keys, legacy: `${n.keys.legacy}.missing` })).toEqual(
			new Set(),
		);
		expect(await readNodeReleaseImages(join(n.releases, "missing"), n.keys)).toEqual(new Set());
	});
});

// The release-key cases both verifiers run (deploy/node-agent/README.md "Release keys"); the node agent runs them in
// deploy/node-agent/qorpera-node-agent.test.mjs.
interface KeyEntry {
	key: string;
	name?: string;
	nameOf?: string;
	mode?: string;
	private?: boolean;
	size?: number;
	link?: boolean;
	dir?: boolean;
}
interface KeyCase {
	name: string;
	folder?: { mode?: string; owner?: "other"; entries: KeyEntry[] };
	legacy?: KeyEntry;
	signedBy: string;
	keys?: string[];
	verifiedBy?: string | null;
	error?: string;
}
const KEY_CASES = (
	JSON.parse(
		readFileSync(new URL("../../../deploy/node-agent/fixtures/release-key-cases.json", import.meta.url), "utf8"),
	) as { cases: KeyCase[] }
).cases;
const caseKeys = Object.fromEntries([
	...[..."abcdefghi"].map((label) => [label, generateKeyPairSync("ed25519")] as const),
	["x", generateKeyPairSync("x25519")] as const,
]);
const caseKeyId = (label: string) =>
	createHash("sha256")
		.update(caseKeys[label].publicKey.export({ type: "spki", format: "der" }))
		.digest("hex")
		.slice(0, 16);

/** Writes one case entry at `path`; a link points at a copy in `scratch`. */
async function writeCaseKey(scratch: string, path: string, entry: KeyEntry) {
	if (entry.dir) {
		await mkdir(path);
		await chmod(path, 0o755);
		return;
	}
	const pair = caseKeys[entry.key];
	const pem = String(
		entry.private
			? pair.privateKey.export({ type: "pkcs8", format: "pem" })
			: pair.publicKey.export({ type: "spki", format: "pem" }),
	);
	const file = entry.link ? join(scratch, `${randomUUID()}.pem`) : path;
	await writeFile(file, pem.padEnd(entry.size ?? 0, "#"));
	await chmod(file, Number.parseInt(entry.mode ?? "0444", 8));
	if (entry.link) await symlink(file, path);
}

describe("the release-key set: any key in it verifies, a bad one refuses it all (the shared cases)", () => {
	for (const keyCase of KEY_CASES)
		it(keyCase.name, async () => {
			const n = await node();
			const keys = { ...n.keys, owner: keyCase.folder?.owner === "other" ? n.keys.owner + 1 : n.keys.owner };
			await rm(keys.legacy);
			if (keyCase.legacy) await writeCaseKey(n.root, keys.legacy, keyCase.legacy);
			if (keyCase.folder) {
				await mkdir(keys.folder);
				for (const entry of keyCase.folder.entries)
					await writeCaseKey(
						n.root,
						join(keys.folder, entry.name ?? `${caseKeyId(entry.nameOf ?? entry.key)}.pem`),
						entry,
					);
				await chmod(keys.folder, Number.parseInt(keyCase.folder.mode ?? "0755", 8));
			}
			if (keyCase.error)
				await expect(readNodeReleaseKeys(keys)).rejects.toThrow(new RegExp(`^${keyCase.error}( |$)`));
			else
				expect((await readNodeReleaseKeys(keys)).map(({ id }) => id)).toEqual(
					(keyCase.keys ?? []).map(caseKeyId).sort(),
				);
			// The observer reads the same set: a refused set or a key outside it accepts no image.
			await n.release(1, "1".repeat(64), { key: caseKeys[keyCase.signedBy].privateKey });
			expect(await readNodeReleaseImages(n.releases, keys)).toEqual(
				keyCase.error || keyCase.verifiedBy === null ? new Set() : new Set(["1".repeat(64)]),
			);
		});
});
