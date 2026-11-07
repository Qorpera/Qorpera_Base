import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const RELEASES = "/opt/qorpera-node/releases";
const RELEASE_KEYS = "/usr/share/qorpera/release-keys";
const RELEASE_KEY = "/etc/qorpera-node/keys/release.pem"; // the legacy key, read until a follow-up drops it
const REVISION = /^(0|[1-9][0-9]{0,8})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_KEY_NAME = /^[0-9a-f]{16}\.pem$/;
const RELEASE_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----\n?$/;
const MAX_RELEASE_BYTES = 1048576;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_RELEASES = 16;
const MAX_RELEASE_KEYS = 8;
const MAX_RELEASE_KEY_BYTES = 4096;
const field = (value: unknown, key: string): unknown =>
	value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;

function need(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}

/** Where the release keys are and who must own them (root on a node; a test's own user in tests). */
export interface NodeReleaseKeyPaths {
	folder?: string;
	legacy?: string;
	owner?: number;
}

export interface NodeReleaseKey {
	id: string;
	key: KeyObject;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
const ownedSafely = (info: Stats, owner: number): boolean => info.uid === owner && (info.mode & 0o022) === 0;

/** One release key file, already checked by lstat: opened without following a link and without blocking, it must
 * still be that file, and hold exactly one PEM public key, Ed25519. */
async function readReleaseKey(path: string, before: Stats, owner: number, label: string): Promise<KeyObject> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let bytes: Buffer;
	try {
		const info = await handle.stat();
		need(
			info.isFile() &&
				info.dev === before.dev &&
				info.ino === before.ino &&
				ownedSafely(info, owner) &&
				info.size <= MAX_RELEASE_KEY_BYTES,
			`RELEASE_KEYS_FILE ${label}`,
		);
		bytes = await handle.readFile();
	} finally {
		await handle.close();
	}
	need(bytes.length <= MAX_RELEASE_KEY_BYTES, `RELEASE_KEYS_FILE ${label}`);
	const pem = RELEASE_KEY_PEM.exec(bytes.toString("latin1"));
	let key: KeyObject | null = null;
	try {
		if (pem)
			key = createPublicKey({
				key: Buffer.from(pem[1].replaceAll("\n", ""), "base64"),
				format: "der",
				type: "spki",
			});
	} catch {
		/* not a public key */
	}
	need(key?.asymmetricKeyType === "ed25519", `RELEASE_KEYS_TYPE ${label}`);
	return key;
}

/** The release keys a node-agent release may verify with, under the node agent's own rules (readReleaseKeys in
 * deploy/node-agent/qorpera-node-agent.mjs, README.md "Release keys"; both run fixtures/release-key-cases.json there):
 * every `<key id>.pem` directly in the folder, plus the legacy key file while the two overlap. A key id is the first 16
 * hex characters of sha256 over the key's SPKI DER. The folders and files must belong to `owner` and not be group- or
 * world-writable, checked without following links before anything is read. Any other entry, a bad file, more than 8
 * keys or no key at all refuses the whole set. Sorted by id. */
export async function readNodeReleaseKeys({
	folder = RELEASE_KEYS,
	legacy = RELEASE_KEY,
	owner = 0,
}: NodeReleaseKeyPaths = {}): Promise<NodeReleaseKey[]> {
	const files: { path: string; info: Stats; label: string }[] = [];
	const folderInfo = await lstatOrNull(folder);
	if (folderInfo) {
		need(folderInfo.isDirectory() && ownedSafely(folderInfo, owner), "RELEASE_KEYS_FOLDER");
		const names = (await readdir(folder)).sort();
		need(names.length <= MAX_RELEASE_KEYS, "RELEASE_KEYS_COUNT");
		for (const name of names) {
			const info = await lstat(join(folder, name));
			need(info.isFile(), `RELEASE_KEYS_ENTRY ${name}`);
			need(ownedSafely(info, owner) && info.size <= MAX_RELEASE_KEY_BYTES, `RELEASE_KEYS_FILE ${name}`);
			need(RELEASE_KEY_NAME.test(name), `RELEASE_KEYS_NAME ${name}`);
			files.push({ path: join(folder, name), info, label: name });
		}
	}
	const legacyInfo = await lstatOrNull(legacy);
	if (legacyInfo) {
		const parent = await lstat(dirname(legacy));
		need(parent.isDirectory() && ownedSafely(parent, owner), "RELEASE_KEYS_FOLDER legacy");
		need(legacyInfo.isFile(), "RELEASE_KEYS_ENTRY legacy");
		need(ownedSafely(legacyInfo, owner) && legacyInfo.size <= MAX_RELEASE_KEY_BYTES, "RELEASE_KEYS_FILE legacy");
		files.push({ path: legacy, info: legacyInfo, label: "legacy" });
	}
	const keys = new Map<string, KeyObject>();
	for (const { path, info, label } of files) {
		const key = await readReleaseKey(path, info, owner, label);
		const id = createHash("sha256")
			.update(key.export({ type: "spki", format: "der" }))
			.digest("hex")
			.slice(0, 16);
		need(label === "legacy" || label === `${id}.pem`, `RELEASE_KEYS_NAME ${label}`);
		keys.set(id, key);
	}
	need(keys.size <= MAX_RELEASE_KEYS, "RELEASE_KEYS_COUNT");
	need(keys.size > 0, "RELEASE_KEYS_NONE");
	return [...keys].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, key]) => ({ id, key }));
}

/** The runner images the node agent's signed releases pin (deploy/node-agent): the
 * provider role's `QORPERA_LXD_IMAGE_FINGERPRINT` in each release folder the agent
 * holds (staged, current or the rollback), newest 16 by revision. A release counts
 * only when its release.json carries a valid signature by one of the node's release
 * keys (readNodeReleaseKeys); a folder that does not verify, or is half-written, is
 * skipped. A refused key set or no releases gives no images, so an entry listed by
 * role is not accepted. Read-only; the files are root-owned and world-readable. */
export async function readNodeReleaseImages(root = RELEASES, keyPaths: NodeReleaseKeyPaths = {}): Promise<Set<string>> {
	const images = new Set<string>();
	let keys: NodeReleaseKey[], names: string[];
	try {
		keys = await readNodeReleaseKeys(keyPaths);
		names = await readdir(root);
	} catch {
		return images;
	}
	const revisions = names
		.filter((name) => REVISION.test(name))
		.sort((a, b) => Number(b) - Number(a))
		.slice(0, MAX_RELEASES);
	for (const revision of revisions) {
		try {
			// Only small regular files are read: a pipe or device would block the observer's scan.
			const path = join(root, revision, "release.json"),
				signaturePath = join(root, revision, "release.sig");
			const [info, signatureInfo] = await Promise.all([stat(path), stat(signaturePath)]);
			if (
				!info.isFile() ||
				!signatureInfo.isFile() ||
				info.size > MAX_RELEASE_BYTES ||
				signatureInfo.size > MAX_SIGNATURE_BYTES
			)
				continue;
			const bytes = await readFile(path);
			if (bytes.length > MAX_RELEASE_BYTES) continue;
			const signature = Buffer.from((await readFile(signaturePath, "utf8")).trim(), "base64");
			if (!keys.some(({ key }) => verify(null, bytes, key, signature))) continue;
			const release: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
			if (field(release, "schema") !== "qorpera.node-release/v1" || field(release, "revision") !== Number(revision))
				continue;
			const image = field(field(field(field(release, "roles"), "provider"), "env"), "QORPERA_LXD_IMAGE_FINGERPRINT");
			if (typeof image === "string" && SHA256.test(image)) images.add(image);
		} catch {
			/* not a complete release */
		}
	}
	return images;
}
