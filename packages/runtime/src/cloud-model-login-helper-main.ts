import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelLoginHelperService } from "./cloud-model-login-helper.ts";
import { CodexLoginRenewer } from "./cloud-model-login-renewal.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function readCredential(directory: string, name: string): Promise<string> {
	if (!isAbsolute(directory) || !/^[a-z][a-z0-9-]+$/.test(name))
		throw new Error("Login helper credential path is invalid");
	const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
	try {
		const metadata = await handle.stat();
		if (
			metadata.size < 1 ||
			!systemdCredentialMetadataIsSafe(
				{
					isFile: metadata.isFile(),
					size: metadata.size,
					uid: metadata.uid,
					gid: metadata.gid,
					mode: metadata.mode,
				},
				process.geteuid?.(),
				MAX_CREDENTIAL_BYTES,
				"linux",
			)
		)
			throw new Error("Login helper credential is unsafe");
		const read = await handle.read(bytes, 0, bytes.byteLength, 0);
		if (read.bytesRead !== metadata.size) throw new Error("Login helper credential changed during read");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead)).trim();
	} finally {
		bytes.fill(0);
		await handle.close();
	}
}

function absolute(value: unknown, label: string): string {
	if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value))
		throw new Error(`${label} is invalid`);
	return value;
}

/** The pinned official Codex: root-owned, not writable by anyone else, exactly the bytes
 * the configuration names. */
async function verifiedCodex(path: string, sha256: string): Promise<void> {
	let current = path;
	while (true) {
		const metadata = await lstat(current);
		if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || metadata.isSymbolicLink())
			throw new Error("Login helper Codex binary is not root-owned");
		if (current === "/") break;
		current = dirname(current);
	}
	if (
		createHash("sha256")
			.update(await readFile(path))
			.digest("hex") !== sha256
	)
		throw new Error("Login helper Codex binary differs from its pin");
}

/**
 * The vault's login helper (Stateless Compute step 1, change 2). A separate Linux service
 * beside the cloud secret broker: it renews a login with the pinned official Codex when the
 * broker asks over the helper's Unix socket, and keeps nothing.
 */
export async function runModelLoginHelperMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (process.platform !== "linux") throw new Error("The login helper requires a separate Linux service");
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory || !isAbsolute(directory)) throw new Error("The login helper requires systemd credentials");
	const value: unknown = JSON.parse(await readCredential(directory, "qorpera-model-login-helper-config"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Login helper configuration is invalid");
	const config = value as Record<string, unknown>;
	const keys = ["schema", "socketPath", "codexPath", "codexSha256", "temporaryRoot", "isolationEntryPoint"];
	if (
		Object.keys(config).sort().join() !== [...keys].sort().join() ||
		config.schema !== "qorpera.model-login-helper/v1" ||
		typeof config.codexSha256 !== "string" ||
		!SHA256.test(config.codexSha256)
	)
		throw new Error("Login helper configuration is invalid");
	const codexPath = absolute(config.codexPath, "Login helper Codex path");
	await verifiedCodex(codexPath, config.codexSha256);
	const token = await readCredential(directory, "qorpera-model-login-helper-token");
	if (!TOKEN.test(token)) throw new Error("Login helper token is invalid");
	const service = new ModelLoginHelperService({
		socketPath: absolute(config.socketPath, "Login helper socket"),
		token,
		renewer: new CodexLoginRenewer({
			codexPath,
			temporaryRoot: absolute(config.temporaryRoot, "Login helper temporary root"),
			isolation: { entryPoint: absolute(config.isolationEntryPoint, "Login helper isolation entry point") },
		}),
	});
	const stop = new AbortController();
	const shutdown = (): void => stop.abort();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await service.start();
		await new Promise<void>((resolveWait) => {
			if (stop.signal.aborted) resolveWait();
			else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
		});
	} finally {
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGTERM", shutdown);
		await service.close();
	}
}

if (
	process.argv[1] &&
	["cloud-model-login-helper-main.ts", "qorpera-model-login-helper.mjs"].includes(basename(process.argv[1])) &&
	realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log("Model login helper. Requires private systemd credentials and the pinned official Codex.");
	} else {
		runModelLoginHelperMain().catch(() => {
			console.error("Model login helper could not start or continue; inspect its private configuration.");
			process.exitCode = 1;
		});
	}
}
