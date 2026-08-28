import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeCredentialCapsule, sealNativeCredentialCapsule } from "../../src/cloud-native-provider-host.ts";

/** Linux-only custody component proof. No cloud credentials, service mutation,
 * provider traffic or guest-isolation claim. Each race is injected at the
 * exact file-open boundary after the collector's initial metadata check. */
export async function runNativeCredentialCustodyProbe() {
	assert.equal(process.platform, "linux");
	assert.notEqual(process.getuid?.(), 0, "Run custody acceptance without root authority");
	const root = await mkdtemp(join(tmpdir(), "qorpera-credential-linux-proof-"));
	const originalOpen = fs.open;
	const key = randomBytes(32).toString("base64url");
	const id = randomUUID();
	const paths = new Set(["codex/auth.json"]);
	const cases: string[] = [];
	try {
		const identity = join(root, "identity");
		const codex = join(identity, "codex");
		const auth = join(codex, "auth.json");
		const outside = join(root, "outside");
		await mkdir(codex, { recursive: true, mode: 0o700 });
		await mkdir(outside, { mode: 0o700 });
		await writeFile(auth, "SYNTHETIC_NATIVE_CREDENTIAL", { mode: 0o600 });
		await writeFile(join(outside, "auth.json"), "SYNTHETIC_UNRELATED_HOST_SECRET", { mode: 0o600 });

		let swapped = false;
		fs.open = async (path, flags, mode) => {
			if (
				!swapped &&
				String(path).endsWith("/auth.json") &&
				typeof flags === "number" &&
				!(flags & constants.O_DIRECTORY)
			) {
				swapped = true;
				await rename(codex, join(identity, "codex-moved"));
				await symlink(outside, codex, "dir");
			}
			return originalOpen(path, flags, mode);
		};
		syncBuiltinESMExports();
		const sealed = await sealNativeCredentialCapsule(identity, key, id, paths);
		fs.open = originalOpen;
		syncBuiltinESMExports();
		assert.equal(swapped, true);
		const restored = join(root, "restored");
		await openNativeCredentialCapsule(sealed, restored, key, id);
		assert.equal(await readFile(join(restored, "codex", "auth.json"), "utf8"), "SYNTHETIC_NATIVE_CREDENTIAL");
		cases.push("renamed-parent-stays-on-open-directory");
		await rm(codex);
		await rename(join(identity, "codex-moved"), codex);

		swapped = false;
		fs.open = async (path, flags, mode) => {
			if (
				!swapped &&
				String(path).endsWith("/auth.json") &&
				typeof flags === "number" &&
				!(flags & constants.O_DIRECTORY)
			) {
				swapped = true;
				await rename(auth, join(codex, "original-auth"));
				await symlink(join(outside, "auth.json"), auth);
			}
			return originalOpen(path, flags, mode);
		};
		syncBuiltinESMExports();
		await assert.rejects(sealNativeCredentialCapsule(identity, key, id, paths), { code: "ELOOP" });
		fs.open = originalOpen;
		syncBuiltinESMExports();
		assert.equal(swapped, true);
		cases.push("raced-file-symlink-rejected-before-read");
		await rm(auth);
		await rename(join(codex, "original-auth"), auth);

		await rm(auth);
		await link(join(outside, "auth.json"), auth);
		await assert.rejects(sealNativeCredentialCapsule(identity, key, id, paths), /unsafe or changed/);
		cases.push("hardlink-rejected");
		await rm(auth);
		await assert.rejects(sealNativeCredentialCapsule(identity, key, id, paths), /lost an original credential path/);
		cases.push("missing-original-credential-rejected");
		assert.equal(await readFile(join(outside, "auth.json"), "utf8"), "SYNTHETIC_UNRELATED_HOST_SECRET");
		cases.push("unrelated-host-file-unchanged");
		return {
			schema: "qorpera.native-credential-custody-proof/v1",
			platform: process.platform,
			node: process.version,
			cases,
		};
	} finally {
		fs.open = originalOpen;
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
}
