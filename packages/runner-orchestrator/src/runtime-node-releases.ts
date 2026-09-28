import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const RELEASES = "/opt/qorpera-node/releases";
const RELEASE_KEY = "/etc/qorpera-node/keys/release.pem";
const REVISION = /^(0|[1-9][0-9]{0,8})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RELEASE_BYTES = 1048576;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_RELEASES = 16;
const field = (value: unknown, key: string): unknown =>
	value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;

/** The runner images the node agent's signed releases pin (deploy/node-agent): the
 * provider role's `QORPERA_LXD_IMAGE_FINGERPRINT` in each release folder the agent
 * holds (staged, current or the rollback), newest 16 by revision. A release counts
 * only when its release.json carries a valid signature by the node's enrolled
 * release key; a folder that does not verify, or is half-written, is skipped. No
 * key or no releases gives no images, so an entry listed by role is not accepted.
 * Read-only; the files are root-owned and world-readable. */
export async function readNodeReleaseImages(root = RELEASES, keyPath = RELEASE_KEY): Promise<Set<string>> {
	const images = new Set<string>();
	let key: KeyObject, names: string[];
	try {
		key = createPublicKey(await readFile(keyPath));
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
			if (!verify(null, bytes, key, signature)) continue;
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
