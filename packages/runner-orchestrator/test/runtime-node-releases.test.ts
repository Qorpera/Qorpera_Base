import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNodeReleaseImages } from "../src/runtime-node-releases.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** A node agent layout: releases/<revision>/release.json + release.sig, and the enrolled public key. */
async function node() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-releases-"));
	roots.push(root);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyPath = join(root, "release.pem");
	await writeFile(keyPath, publicKey.export({ type: "spki", format: "pem" }));
	await mkdir(join(root, "releases"));
	const release = async (
		revision: number | string,
		image: unknown,
		options: { key?: typeof privateKey; body?: (value: Record<string, unknown>) => void } = {},
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
	return { releases: join(root, "releases"), keyPath, release };
}

describe("images the node's signed releases pin (identical nodes, change 6)", () => {
	it("reads the provider image of every signed release folder", async () => {
		const n = await node();
		await n.release(26, "a".repeat(64));
		await n.release(27, "b".repeat(64));
		await n.release(28, "b".repeat(64));
		expect(await readNodeReleaseImages(n.releases, n.keyPath)).toEqual(new Set(["a".repeat(64), "b".repeat(64)]));
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
		expect(await readNodeReleaseImages(n.releases, n.keyPath)).toEqual(new Set(["a".repeat(64)]));
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
		expect(await readNodeReleaseImages(n.releases, n.keyPath)).toEqual(new Set(["3".repeat(64)]));
	});
	it("only the newest 16 revisions count", async () => {
		const n = await node();
		await n.release(1, "1".repeat(64));
		for (let revision = 2; revision <= 17; revision++) await n.release(revision, "f".repeat(64));
		expect(await readNodeReleaseImages(n.releases, n.keyPath)).toEqual(new Set(["f".repeat(64)]));
	});
	it("no key or no releases folder gives no images", async () => {
		const n = await node();
		await n.release(1, "1".repeat(64));
		expect(await readNodeReleaseImages(n.releases, join(n.keyPath, "missing"))).toEqual(new Set());
		expect(await readNodeReleaseImages(join(n.releases, "missing"), n.keyPath)).toEqual(new Set());
	});
});
