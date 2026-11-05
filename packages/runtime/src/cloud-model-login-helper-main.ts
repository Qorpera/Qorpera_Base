import { createHash } from "node:crypto";
import { constants, createReadStream, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelLoginHelperService } from "./cloud-model-login-helper.ts";
import { CodexLoginRenewer, codexSelfCheck } from "./cloud-model-login-renewal.ts";
import { CodexSignIns } from "./cloud-model-login-sign-in.ts";
import { OfficialCliNativeHarnessDriver } from "./cloud-native-provider-host.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** An optional credential: absent means the feature stays off; any other failure stops the helper. */
async function readOptionalCredential(directory: string, name: string): Promise<string | undefined> {
	try {
		return await readCredential(directory, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
		throw error;
	}
}

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

/** What the isolation launcher requires of every artifact it runs, checked once at start so a
 * bad install stops the helper instead of failing every renewal: a physical path, root-owned
 * and not writable by others all the way up, one link. */
async function rootOwnedArtifact(path: string): Promise<void> {
	if ((await realpath(path)) !== path) throw new Error("Login helper artifact is not a physical path");
	let current = path;
	while (true) {
		const metadata = await lstat(current);
		if (
			metadata.uid !== 0 ||
			(metadata.mode & 0o022) !== 0 ||
			metadata.isSymbolicLink() ||
			(current === path ? !metadata.isFile() || metadata.nlink !== 1 : !metadata.isDirectory())
		)
			throw new Error("Login helper artifact is not root-owned");
		if (current === "/") break;
		current = dirname(current);
	}
}

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** A pinned official binary (Codex, or Claude Code): exactly the bytes the configuration names. Its identity at start
 * (device, inode, size, times) is checked again before every launch. */
async function pinnedBinary(path: string, sha256: string, name: string): Promise<() => Promise<void>> {
	const identity = async (): Promise<string> => {
		const metadata = await lstat(path);
		return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
	};
	const pinned = await identity();
	if ((await fileSha256(path)) !== sha256) throw new Error(`Login helper ${name} binary differs from its pin`);
	return async () => {
		if ((await identity()) !== pinned) throw new Error(`Login helper ${name} binary changed since start`);
	};
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
	// Optional: how many members' sign-ins run at once on this host, and per company. The shared vault
	// (Vault By Default) serves every new company from one helper and needs more than the defaults (6, 2).
	for (const optional of ["signInLimit", "signInCompanyLimit"])
		if (Object.hasOwn(config, optional)) keys.push(optional);
	// Optional, together: the pinned official Claude Code for members' Claude sign-ins (20260930564000). Without it a
	// Claude sign-in fails at once and nothing else changes.
	const claudeConfigured = Object.hasOwn(config, "claudePath") || Object.hasOwn(config, "claudeSha256");
	if (claudeConfigured) keys.push("claudePath", "claudeSha256");
	const limit = (name: string, fallback: number): number => {
		const configured = config[name];
		if (configured === undefined) return fallback;
		if (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured < 1 || configured > 64)
			throw new Error("Login helper configuration is invalid");
		return configured;
	};
	if (
		Object.keys(config).sort().join() !== [...keys].sort().join() ||
		config.schema !== "qorpera.model-login-helper/v1" ||
		typeof config.codexSha256 !== "string" ||
		!SHA256.test(config.codexSha256) ||
		(claudeConfigured && (typeof config.claudeSha256 !== "string" || !SHA256.test(config.claudeSha256)))
	)
		throw new Error("Login helper configuration is invalid");
	const codexPath = absolute(config.codexPath, "Login helper Codex path");
	const isolationEntryPoint = absolute(config.isolationEntryPoint, "Login helper isolation entry point");
	const claudePath = claudeConfigured ? absolute(config.claudePath, "Login helper Claude Code path") : undefined;
	for (const artifact of [
		"/usr/bin/bwrap",
		"/usr/bin/node",
		isolationEntryPoint,
		codexPath,
		...(claudePath ? [claudePath] : []),
	])
		await rootOwnedArtifact(artifact);
	const pinnedCodex = await pinnedBinary(codexPath, config.codexSha256, "Codex");
	const pinnedClaude = claudePath
		? await pinnedBinary(claudePath, config.claudeSha256 as string, "Claude Code")
		: undefined;
	const pinned = async (): Promise<void> => {
		await pinnedCodex();
		await pinnedClaude?.();
	};
	const stop = new AbortController();
	// A binary that changed since start stops the helper, so systemd restarts it and the pin
	// check at start decides again, instead of every renewal failing quietly.
	const beforeLaunch = async (): Promise<void> => {
		try {
			await pinned();
		} catch (error) {
			console.error("Model login helper: a pinned binary changed since start; stopping for a checked restart.");
			process.exitCode = 1;
			stop.abort();
			throw error;
		}
	};
	const token = await readCredential(directory, "qorpera-model-login-helper-token");
	if (!TOKEN.test(token)) throw new Error("Login helper token is invalid");
	// On a shared vault host (Vault By Default): the vault's own token, so the company brokers on the host
	// never see its members' sign-ins, nor it theirs.
	const vaultToken = await readOptionalCredential(directory, "qorpera-model-login-helper-vault-token");
	if (vaultToken !== undefined && (!TOKEN.test(vaultToken) || vaultToken === token))
		throw new Error("Login helper vault token is invalid");
	const temporaryRoot = absolute(config.temporaryRoot, "Login helper temporary root");
	const isolation = { entryPoint: isolationEntryPoint };
	// Before serving anything: the pinned Codex answers inside the sandbox, under this unit.
	// A failure stops the helper, visibly, instead of failing each member's sign-in.
	await beforeLaunch();
	const version = await codexSelfCheck({ codexPath, temporaryRoot, isolation });
	console.error(`Model login helper: sandbox self-check ok (${version}).`);
	// A member's sign-in runs the same official `codex login --device-auth` driver a node uses,
	// inside the same isolation, with the pinned binary checked before each of its launches and
	// its scratch under this helper's private runtime directory.
	const signInLimit = limit("signInLimit", 6);
	const signInCompanyLimit = limit("signInCompanyLimit", 2);
	if (signInCompanyLimit > signInLimit) throw new Error("Login helper configuration is invalid");
	// A member's Claude sign-in runs the official `claude auth login --claudeai` in the same isolation (Anthropic's
	// sign-in hosts only), with the pinned Claude Code checked the same way.
	const signIns = new CodexSignIns({
		driver: new OfficialCliNativeHarnessDriver(codexPath, claudePath ?? "/nonexistent/claude", isolation, {
			scratchParent: temporaryRoot,
			beforeLaunch,
		}),
		temporaryRoot,
		limit: signInLimit,
		companyLimit: signInCompanyLimit,
		claude: claudePath !== undefined,
	});
	if (claudePath) console.error("Model login helper: Claude sign-ins on (pinned Claude Code).");
	const service = new ModelLoginHelperService({
		socketPath: absolute(config.socketPath, "Login helper socket"),
		token,
		...(vaultToken === undefined ? {} : { vaultToken }),
		renewer: new CodexLoginRenewer({ codexPath, temporaryRoot, isolation, beforeLaunch }),
		signIns,
	});
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
		await signIns.close();
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
