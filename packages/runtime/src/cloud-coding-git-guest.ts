import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { type CloudCodingRepository, cloudCodingSessionLayout, parseCloudCodingRepository } from "@qorpera/contracts";
import {
	type CodingGuestConfiguration,
	type CodingGuestFolders,
	parseCodingGuestConfiguration,
} from "./cloud-coding-guest-configuration.ts";
import { assertCloudCodingGuestStorage } from "./cloud-coding-storage-guest.ts";

const exec = promisify(execFile);
const ENTRY = "/opt/qorpera-coding/cloud-coding-git-guest.mjs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The seeded base, which an export leaves out. */
const BASE_REF = "refs/qorpera/base";
export const CODING_GIT_CHUNK_BYTES = 32768;
export const CODING_GIT_BUNDLE_BYTES = 64 * 1024 ** 2;
/** A seed is the base's whole history. Its chunk's base64 is exactly LXD's
 * largest file push (256 KiB); Git's 256 MiB file-size limit bounds it. */
export const CODING_GIT_SEED_CHUNK_BYTES = 196608;
export const CODING_GIT_SEED_BYTES = 256 * 1024 ** 2;

export interface CodingGitGuestRequest {
	schema: "qorpera.coding-git-transfer/v1";
	workerId: string;
	vmId: string;
	transferId: string;
	action: "seed" | "export";
	repository: CloudCodingRepository;
	headSha: string;
	bundleSha256: string | null;
	bundleBytes: number;
}
export interface CodingGitGuestReceipt {
	schema: "qorpera.coding-git-receipt/v1";
	workerId: string;
	vmId: string;
	transferId: string;
	action: "seed" | "export";
	headSha: string;
	bundleSha256: string;
	bundleBytes: number;
	chunkCount: number;
}
export type CodingGitGuestConfiguration = CodingGuestConfiguration;
export interface CodingGitGuestPorts {
	/** Trusted test composition only; production uses the session's fixed layout
	 * (cloudCodingSessionLayout) and subprocess. */
	root?: string;
	configurationPath?: string;
	folders?: CodingGuestFolders;
	protectedUid?: number;
	protectedDirectoryRoot?: string;
	inspectMachine?: () => Promise<string>;
	execute?: (request: CodingGitGuestRequest, guest: CodingGitGuestConfiguration, root: string) => Promise<Buffer>;
	assertStorage?: (guest: CodingGuestConfiguration) => Promise<void>;
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== keys.sort().join()
	)
		throw new Error("INVALID_CODING_GIT_GUEST_RECORD");
	return value as Record<string, unknown>;
}
export function parseCodingGitGuestRequest(value: unknown): CodingGitGuestRequest {
	const record = closed(value, [
		"schema",
		"workerId",
		"vmId",
		"transferId",
		"action",
		"repository",
		"headSha",
		"bundleSha256",
		"bundleBytes",
	]);
	if (
		record.schema !== "qorpera.coding-git-transfer/v1" ||
		![record.workerId, record.vmId, record.transferId].every((id) => typeof id === "string" && UUID.test(id)) ||
		typeof record.headSha !== "string" ||
		!SHA.test(record.headSha) ||
		!["seed", "export"].includes(String(record.action)) ||
		(record.action === "seed"
			? typeof record.bundleSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(record.bundleSha256) ||
				!Number.isSafeInteger(record.bundleBytes) ||
				Number(record.bundleBytes) < 1 ||
				Number(record.bundleBytes) > CODING_GIT_SEED_BYTES
			: record.bundleSha256 !== null || record.bundleBytes !== 0)
	)
		throw new Error("INVALID_CODING_GIT_GUEST_REQUEST");
	return Object.freeze({
		...record,
		repository: parseCloudCodingRepository(record.repository),
	}) as unknown as CodingGitGuestRequest;
}
async function protectedRead(
	path: string,
	owner: number,
	limit: number,
	boundary = "/",
	mountRoot?: string,
): Promise<Buffer> {
	for (let parent = dirname(path); ; parent = dirname(parent)) {
		const stat = await lstat(parent);
		// Only the session's verified NAS custody mount root is the host service's.
		if (!stat.isDirectory() || (stat.uid !== owner && parent !== mountRoot) || (stat.mode & 0o022) !== 0)
			throw new Error("UNPROTECTED_CODING_GIT_PATH");
		if (parent === boundary || parent === dirname(parent)) break;
	}
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > limit)
			throw new Error("UNPROTECTED_CODING_GIT_FILE");
		const buffer = Buffer.alloc(stat.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const read = await file.read(buffer, used, buffer.length - used, used);
			if (!read.bytesRead) break;
			used += read.bytesRead;
		}
		if (used !== stat.size) throw new Error("CODING_GIT_FILE_CHANGED");
		return buffer.subarray(0, used);
	} finally {
		await file.close();
	}
}
async function retain(path: string, ...parts: Buffer[]): Promise<void> {
	const file = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o444,
	);
	try {
		// Each part continues at the file's position.
		for (const part of parts) await file.writeFile(part);
		await file.sync();
	} finally {
		await file.close();
	}
	const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
/** A ref of the workspace's own Git directory, read as text, never through Git. */
async function workspaceRef(workspace: string, name: string): Promise<string | undefined> {
	try {
		return (await readFile(join(workspace, ".git", name), "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let packed: string;
	try {
		packed = await readFile(join(workspace, ".git", "packed-refs"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
	const refs = packed.split("\n").filter((line) => line.endsWith(` ${name}`));
	return refs.length === 1 ? refs[0].split(" ")[0] : undefined;
}
async function machine(): Promise<string> {
	if (process.platform !== "linux") throw new Error("CODING_GIT_GUEST_REQUIRES_VM");
	await exec("/usr/bin/systemd-detect-virt", ["--vm", "--quiet"], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
	return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}
async function load(
	ports: CodingGitGuestPorts,
	workerId: string,
	transferId: string,
): Promise<{ request: CodingGitGuestRequest; guest: CodingGitGuestConfiguration; root: string }> {
	if (!UUID.test(transferId)) throw new Error("INVALID_CODING_GIT_TRANSFER_ID");
	const layout = cloudCodingSessionLayout(workerId);
	const owner = ports.protectedUid ?? 0,
		root = ports.root ?? layout.custodyRoot;
	const path = ports.configurationPath ?? `${layout.configurationRoot}/guest.json`;
	if (((await lstat(path)).mode & 0o777) !== 0o444) throw new Error("CODING_GIT_GUEST_CONFIG_MODE");
	const guest = parseCodingGuestConfiguration(
		JSON.parse((await protectedRead(path, owner, 8192, ports.protectedDirectoryRoot)).toString("utf8")),
		ports.folders,
	);
	if (guest.workerId !== workerId) throw new Error("CODING_GIT_GUEST_SCOPE_CHANGED");
	await (ports.assertStorage ?? assertCloudCodingGuestStorage)(guest);
	if ((await (ports.inspectMachine ?? machine)()) !== guest.bootId) throw new Error("CODING_GIT_GUEST_BOOT_CHANGED");
	const request = parseCodingGitGuestRequest(
		JSON.parse(
			(
				await protectedRead(
					join(root, "inbox", `${transferId}.git.json`),
					owner,
					8192,
					ports.protectedDirectoryRoot,
					root,
				)
			).toString("utf8"),
		),
	);
	if (request.transferId !== transferId || request.workerId !== guest.workerId || request.vmId !== guest.vmId)
		throw new Error("CODING_GIT_GUEST_SCOPE_CHANGED");
	return { request, guest, root };
}

/** Root never parses Git or opens the coding user's repository. It supervises
 * one fixed unprivileged child, then copies bounded bytes into protected files. */
export async function runCodingGitGuest(
	action: "prepare" | "seed" | "export",
	workerId: string,
	transferId: string,
	ports: CodingGitGuestPorts = {},
): Promise<CodingGitGuestReceipt | null> {
	if (!ports.inspectMachine && process.getuid?.() !== 0) throw new Error("CODING_GIT_GUEST_REQUIRES_ROOT");
	const { request, guest, root } = await load(ports, workerId, transferId);
	if (action !== "prepare" && action !== request.action) throw new Error("CODING_GIT_GUEST_ACTION_CHANGED");
	const directory = join(root, "git", transferId);
	await mkdir(join(root, "git"), { recursive: true, mode: 0o755 });
	try {
		await mkdir(directory, { mode: 0o755 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const read = (name: string, limit: number) =>
		protectedRead(join(directory, name), ports.protectedUid ?? 0, limit, ports.protectedDirectoryRoot, root);
	try {
		const intent = JSON.parse((await read("intent.json", 8192)).toString("utf8"));
		if (!isDeepStrictEqual(intent, request)) throw new Error("CODING_GIT_GUEST_INTENT_CHANGED");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await retain(join(directory, "intent.json"), Buffer.from(JSON.stringify(request)));
	}
	if (action === "prepare") return null;
	if (action === "export") {
		const seed = parseCodingGitGuestRequest(
			JSON.parse(
				(
					await protectedRead(
						join(root, "git", "seed-claim.json"),
						ports.protectedUid ?? 0,
						8192,
						ports.protectedDirectoryRoot,
						root,
					)
				).toString("utf8"),
			),
		);
		// The claim belongs to the session's volume, which outlives every machine
		// the session runs on: the seeding machine may be gone.
		if (seed.workerId !== request.workerId || !isDeepStrictEqual(seed.repository, request.repository))
			throw new Error("CODING_GIT_GUEST_REPOSITORY_CHANGED");
	}
	try {
		const receipt = JSON.parse((await read("receipt.json", 8192)).toString("utf8")) as CodingGitGuestReceipt;
		if (
			receipt.schema !== "qorpera.coding-git-receipt/v1" ||
			receipt.workerId !== request.workerId ||
			receipt.vmId !== request.vmId ||
			receipt.transferId !== transferId ||
			receipt.action !== request.action ||
			receipt.headSha !== request.headSha
		)
			throw new Error("CODING_GIT_GUEST_RECEIPT_CHANGED");
		return receipt;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (action === "seed") {
		// Hashed and written part by part, never joined into a second copy.
		const parts: Buffer[] = [],
			hash = createHash("sha256");
		for (let index = 0; index < Math.ceil(request.bundleBytes / CODING_GIT_SEED_CHUNK_BYTES); index++) {
			const encoded = (
				await read(`${String(index).padStart(6, "0")}.base64`, (CODING_GIT_SEED_CHUNK_BYTES / 3) * 4)
			).toString("ascii");
			const part = Buffer.from(encoded, "base64");
			if (
				part.toString("base64") !== encoded ||
				part.length !==
					Math.min(CODING_GIT_SEED_CHUNK_BYTES, request.bundleBytes - index * CODING_GIT_SEED_CHUNK_BYTES)
			)
				throw new Error("CODING_GIT_SEED_CHUNK_INVALID");
			hash.update(part);
			parts.push(part);
		}
		if (hash.digest("hex") !== request.bundleSha256) throw new Error("CODING_GIT_SEED_DIGEST_CHANGED");
		// Permanent global claim prevents a second transfer ID from reinitializing.
		await retain(join(root, "git", "seed-claim.json"), Buffer.from(JSON.stringify(request)));
		await retain(join(directory, "seed.bundle"), ...parts);
	}
	// No automatic retry after an uncertain child, even under a new process.
	await retain(join(directory, "dispatched.json"), Buffer.from(JSON.stringify({ transferId, bootId: guest.bootId })));
	const output = await (ports.execute ?? child)(request, guest, root);
	if (action === "seed" && output.toString("utf8") !== "seeded\n") throw new Error("CODING_GIT_SEED_UNCONFIRMED");
	if (action === "export" && (output.length < 1 || output.length > CODING_GIT_BUNDLE_BYTES))
		throw new Error("CODING_GIT_EXPORT_TOO_LARGE");
	const bytes = action === "seed" ? request.bundleBytes : output.length;
	const digest =
		action === "seed" ? (request.bundleSha256 as string) : createHash("sha256").update(output).digest("hex");
	if (action === "export")
		for (let index = 0; index < Math.ceil(bytes / CODING_GIT_CHUNK_BYTES); index++)
			await retain(
				join(directory, `${String(index).padStart(6, "0")}.bundle`),
				output.subarray(index * CODING_GIT_CHUNK_BYTES, (index + 1) * CODING_GIT_CHUNK_BYTES),
			);
	const receipt: CodingGitGuestReceipt = {
		schema: "qorpera.coding-git-receipt/v1",
		workerId: guest.workerId,
		vmId: guest.vmId,
		transferId,
		action,
		headSha: request.headSha,
		bundleSha256: digest,
		bundleBytes: bytes,
		chunkCount: Math.ceil(bytes / (action === "seed" ? CODING_GIT_SEED_CHUNK_BYTES : CODING_GIT_CHUNK_BYTES)),
	};
	await retain(join(directory, "receipt.json"), Buffer.from(JSON.stringify(receipt)));
	return receipt;
}

async function child(request: CodingGitGuestRequest, guest: CodingGitGuestConfiguration): Promise<Buffer> {
	return new Promise((resolveChild, reject) => {
		const processChild = spawn(
			"/usr/bin/setpriv",
			[
				"--reuid",
				String(guest.uid),
				"--regid",
				String(guest.gid),
				"--clear-groups",
				"--no-new-privs",
				"--inh-caps=-all",
				"--bounding-set=-all",
				"--",
				"/usr/bin/node",
				"--max-old-space-size=128",
				ENTRY,
				"execute",
				request.workerId,
				request.transferId,
			],
			{
				cwd: "/",
				env: { PATH: "/usr/bin:/bin", LANG: "C" },
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const parts: Buffer[] = [];
		let length = 0,
			failed = false;
		const kill = (): void => {
			failed = true;
			try {
				if (processChild.pid) process.kill(-processChild.pid, "SIGKILL");
			} catch {
				processChild.kill("SIGKILL");
			}
		};
		// The host waits 600 s for a seed's whole command (coding-git-transfer.ts).
		const timer = setTimeout(kill, request.action === "seed" ? 540000 : 120000);
		processChild.stdout.on("data", (bytes: Buffer) => {
			length += bytes.length;
			if (length > CODING_GIT_BUNDLE_BYTES) kill();
			else parts.push(bytes);
		});
		processChild.stderr.on("data", () => undefined);
		processChild.once("error", () => {
			clearTimeout(timer);
			reject(new Error("CODING_GIT_CHILD_UNCONFIRMED"));
		});
		processChild.once("close", (status) => {
			clearTimeout(timer);
			if (failed || status !== 0) reject(new Error("CODING_GIT_CHILD_UNCONFIRMED"));
			else resolveChild(Buffer.concat(parts));
		});
	});
}

/** Executed only as the coding uid. A fresh Git directory isolates export
 * from workspace configuration and hooks; root sees only the resulting bytes. */
export async function executeCodingGitGuest(workerId: string, transferId: string): Promise<Buffer> {
	const { request, guest, root } = await load({}, workerId, transferId);
	if (process.getuid?.() !== guest.uid || process.getgid?.() !== guest.gid)
		throw new Error("CODING_GIT_CHILD_IDENTITY_CHANGED");
	return executeCodingGitGuestRepository(request, guest, root);
}

/** Testable unprivileged repository operation. Production enters via the
 * identity-checked executeCodingGitGuest child above, never as host/root. */
export async function executeCodingGitGuestRepository(
	request: CodingGitGuestRequest,
	guest: CodingGitGuestConfiguration,
	root: string,
	gitProcess?: (args: readonly string[], cwd: string, env: Record<string, string>) => Promise<Buffer>,
): Promise<Buffer> {
	const workspace = guest.workspacePath,
		branch = `qorpera/coding/${request.workerId}`,
		ref = `refs/heads/${branch}`;
	const info = await lstat(workspace);
	if (!info.isDirectory() || (await realpath(workspace)) !== workspace) throw new Error("CODING_GIT_WORKSPACE_UNSAFE");
	const staging = await mkdtemp(join(tmpdir(), "qorpera-coding-git-"));
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin",
		LANG: "C",
		HOME: staging,
		XDG_CONFIG_HOME: staging,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/bin/false",
		GIT_ALLOW_PROTOCOL: "",
		GIT_NO_REPLACE_OBJECTS: "1",
	};
	const prefix = [
		"--no-replace-objects",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"protocol.allow=never",
		"-c",
		"submodule.recurse=false",
		"-c",
		"gc.auto=0",
	];
	// A seed imports the base's whole history.
	const [cpu, timeout] = request.action === "seed" ? [240, 300000] : [30, 60000];
	const invoke =
		gitProcess ??
		(async (args, cwd, environment) =>
			(
				await exec(
					"/usr/bin/prlimit",
					[
						"--as=1073741824",
						`--cpu=${cpu}`,
						"--fsize=268435456",
						"--nofile=64",
						"--nproc=512",
						"--core=0",
						"--",
						"/usr/bin/git",
						...args,
					],
					{ cwd, env: environment, timeout, maxBuffer: CODING_GIT_BUNDLE_BYTES, encoding: "buffer" },
				)
			).stdout);
	const git = (args: string[], cwd = workspace): Promise<Buffer> => invoke([...prefix, ...args], cwd, { ...env });
	try {
		if (request.action === "seed") {
			if ((await readdir(workspace)).length !== 0) throw new Error("CODING_GIT_WORKSPACE_NOT_EMPTY");
			const bundle = join(root, "git", request.transferId, "seed.bundle");
			await git(["init", "--template=", "."]);
			if ((await git(["bundle", "list-heads", bundle])).toString() !== `${request.headSha} ${ref}\n`)
				throw new Error("CODING_GIT_SEED_REF_CHANGED");
			await git(["bundle", "verify", bundle]);
			await git(["bundle", "unbundle", bundle]);
			if ((await git(["cat-file", "-t", request.headSha])).toString() !== "commit\n")
				throw new Error("CODING_GIT_SEED_COMMIT_CHANGED");
			await git(["fsck", "--strict", "--no-reflogs", request.headSha]);
			await git(["update-ref", ref, request.headSha]);
			// The base an export leaves out (the seed's head is the session's base).
			await git(["update-ref", BASE_REF, request.headSha]);
			await git(["symbolic-ref", "HEAD", ref]);
			await git(["read-tree", "--reset", "-u", request.headSha]);
			await git([
				"config",
				"--local",
				"remote.origin.url",
				`https://github.com/${request.repository.owner}/${request.repository.name}.git`,
			]);
			return Buffer.from("seeded\n");
		}
		if ((await readFile(join(workspace, ".git", "HEAD"), "utf8")) !== `ref: ${ref}\n`)
			throw new Error("CODING_GIT_BRANCH_CHANGED");
		if ((await workspaceRef(workspace, ref)) !== request.headSha) throw new Error("CODING_GIT_HEAD_CHANGED");
		const base = await workspaceRef(workspace, BASE_REF);
		await git(["init", "--bare", "--template=", staging], staging);
		env.GIT_OBJECT_DIRECTORY = join(workspace, ".git", "objects");
		await git(["update-ref", ref, request.headSha], staging);
		// Only the commits since the seeded base: the broker fetches the base from
		// the repository itself. An unchanged head leaves out its own parents; a
		// workspace without the base sends its whole history.
		let exclude = base !== undefined && SHA.test(base) ? [`^${base}`] : [];
		if (exclude.length > 0 && (await git(["rev-list", "--max-count=1", ref, ...exclude], staging)).length === 0)
			exclude = (await git(["rev-parse", `${ref}^@`], staging))
				.toString()
				.split("\n")
				.filter((line) => SHA.test(line))
				.map((sha) => `^${sha}`);
		return await git(["bundle", "create", "-", ref, ...exclude], staging);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [action, workerId, transferId, extra] = process.argv.slice(2);
	try {
		if (!workerId || !transferId || extra) throw new Error("INVALID_CODING_GIT_ARGUMENTS");
		if (action === "execute") process.stdout.write(await executeCodingGitGuest(workerId, transferId));
		else if (action === "prepare" || action === "seed" || action === "export")
			process.stdout.write(`${JSON.stringify(await runCodingGitGuest(action, workerId, transferId))}\n`);
		else throw new Error("INVALID_CODING_GIT_ARGUMENTS");
	} catch {
		process.stderr.write("CODING_GIT_GUEST_REFUSED\n");
		process.exitCode = 1;
	}
}
