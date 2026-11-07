import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";

const MANIFEST = new URL("../../../../deploy/first-node/native-codex/guest-package-manifest.json", import.meta.url);

function sha256OfFile(path: string): string {
	const hash = createHash("sha256");
	const file = openSync(path, "r");
	const chunk = Buffer.alloc(1024 * 1024);
	try {
		for (let read = readSync(file, chunk); read > 0; read = readSync(file, chunk))
			hash.update(chunk.subarray(0, read));
	} finally {
		closeSync(file);
	}
	return hash.digest("hex");
}

/** The patched Codex the real-binary tests run: the file QORPERA_CODEX_FENCE_BINARY names, undefined when that is unset
 * (the tests skip). A missing file, or one whose sha256 is not the pinned build's, stops the test file: a stale file at a
 * known path would otherwise pass tests that never ran the build they are for. QORPERA_CODEX_FENCE_UNPINNED=1 lets a build
 * run that is not yet the pin. */
export function pinnedCodexBinary(
	env: NodeJS.ProcessEnv = process.env,
	pin: string = JSON.parse(readFileSync(MANIFEST, "utf8")).nativeCompany.binarySha256,
): string | undefined {
	const binary = env.QORPERA_CODEX_FENCE_BINARY;
	if (!binary) return undefined;
	if (!existsSync(binary)) throw new Error(`QORPERA_CODEX_FENCE_BINARY names no file here: ${binary}`);
	if (env.QORPERA_CODEX_FENCE_UNPINNED === "1") return binary;
	const sha256 = sha256OfFile(binary);
	if (sha256 !== pin) {
		throw new Error(
			`${binary} has sha256 ${sha256}, not the pinned build's ${pin} (QORPERA_CODEX_FENCE_UNPINNED=1 for a new build)`,
		);
	}
	return binary;
}
