import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES,
	type CompanyComputerPreparationCommand,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationReport,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import {
	assertCompanyComputerImageArtifact,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";

export const OFFICE_PREPARATION_CONTROL_ROOT = "/run/qorpera-office-preparation";
export const OFFICE_PREPARATION_CONTROL_LOCK = `${OFFICE_PREPARATION_CONTROL_ROOT}/control.lock`;

/** A stop claim fences subsequent first-start requests even if shutdown's
 * reply or completion is lost. Only explicit successor recovery may retire it. */
export async function assertCompanyComputerNoServiceStopClaim(): Promise<void> {
	try {
		await lstat(`${OFFICE_PREPARATION_CONTROL_ROOT}/service-stop-claim.json`);
	} catch (error) {
		if (missing(error)) return;
		throw error;
	}
	throw new Error("OFFICE_SERVICE_STOP_CLAIMED");
}
const requestPath = "/etc/qorpera-office/preparation.json";
const INVOCATION = /^(?!0{32}$)[0-9a-f]{32}$/;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
const metadataKeys = ["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const;
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
	return metadataKeys.every((key) => a[key] === b[key]);
}

export { type CompanyComputerPreparationCommand, parseCompanyComputerPreparationCommand } from "@qorpera/contracts";

/** Trusted system manager port. Production uses the fixed systemctl adapter;
 * injecting this port is solely for isolated tests, not provider input. */
export interface CompanyComputerPreparationManager {
	inspect(signal: AbortSignal): Promise<CompanyComputerPreparationUnitState>;
	start(signal: AbortSignal): Promise<void>;
}
export interface CompanyComputerPreparationUnitState {
	invocationId: string;
	activeState: string;
	subState: string;
	result: string;
	mainPid: number;
	controlPid: number;
	jobId: number;
	execMainCode: number;
	execMainStatus: number;
}

/** Root-owned local files only. This intentionally never reads NAS contents. */
export async function readCompanyComputerPreparationProtected(
	path: string,
	limit: number,
	mode?: number,
): Promise<Buffer> {
	// A reset packet wraps the original preparation as an escaped JSON string.
	// Only its fixed incoming path receives that separately bounded larger cap.
	const maximum = /^\/run\/qorpera-office-preparation\/reset-configuration-incoming-[a-f0-9]{64}\.json$/.test(path)
		? COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES
		: COMPANY_COMPUTER_PREPARATION_MAX_BYTES;
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximum)
		throw new Error("OFFICE_PREPARATION_CONTROL_READ_LIMIT");
	await assertCompanyComputerImageArtifact(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.uid !== 0n ||
			before.gid !== 0n ||
			before.nlink !== 1n ||
			(mode === undefined ? (before.mode & 0o6022n) !== 0n : (before.mode & 0o7777n) !== BigInt(mode)) ||
			before.size > BigInt(limit)
		)
			throw new Error("OFFICE_PREPARATION_CONTROL_FILE_UNPROTECTED");
		const bytes = Buffer.alloc(Number(before.size) + 1);
		let size = 0;
		while (size < bytes.length) {
			const result = await file.read(bytes, size, bytes.length - size, null);
			if (!result.bytesRead) break;
			size += result.bytesRead;
		}
		if (
			size !== Number(before.size) ||
			!unchanged(before, await file.stat({ bigint: true })) ||
			!unchanged(before, await lstat(path, { bigint: true }))
		)
			throw new Error("OFFICE_PREPARATION_CONTROL_FILE_CHANGED");
		return bytes.subarray(0, size);
	} finally {
		await file.close();
	}
}

export async function openCompanyComputerPreparationLock(): Promise<FileHandle> {
	if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
		throw new Error("OFFICE_PREPARATION_ROOT_LINUX_REQUIRED");
	const status = await readCompanyComputerLinuxMetadata("/proc/self/status", 65536);
	if (!/^Uid:\s+0\s+0\s+0\s+0$/m.test(status) || !/^Gid:\s+0\s+0\s+0\s+0$/m.test(status))
		throw new Error("OFFICE_PREPARATION_ROOT_LINUX_REQUIRED");
	await assertCompanyComputerImageArtifact(OFFICE_PREPARATION_CONTROL_ROOT, true);
	const root = await lstat(OFFICE_PREPARATION_CONTROL_ROOT);
	if (root.uid !== 0 || root.gid !== 0 || (root.mode & 0o7777) !== 0o700)
		throw new Error("OFFICE_PREPARATION_INBOX_UNPROTECTED");
	await readCompanyComputerPreparationProtected(OFFICE_PREPARATION_CONTROL_LOCK, 0, 0o600);
	const lock = await open(
		OFFICE_PREPARATION_CONTROL_LOCK,
		constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		if (!unchanged(await lock.stat({ bigint: true }), await lstat(OFFICE_PREPARATION_CONTROL_LOCK, { bigint: true })))
			throw new Error("OFFICE_PREPARATION_LOCK_CHANGED");
		return lock;
	} catch (error) {
		await lock.close();
		throw error;
	}
}

export async function assertCompanyComputerPreparationLockAndBoot(
	command: CompanyComputerPreparationCommand,
): Promise<void> {
	const lock = await openCompanyComputerPreparationLock();
	try {
		const info = await lock.stat({ bigint: true });
		const major = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & 0xfffff000n);
		const minor = (info.dev & 0xffn) | ((info.dev >> 12n) & 0xffffff00n);
		const matches = (await readCompanyComputerLinuxMetadata("/proc/locks", 1048576)).split("\n").filter((line) => {
			const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line);
			return (
				match &&
				Number(match[1]) === process.pid &&
				BigInt(`0x${match[2]}`) === major &&
				BigInt(`0x${match[3]}`) === minor &&
				BigInt(match[4]) === info.ino
			);
		});
		if (matches.length !== 1) throw new Error("OFFICE_PREPARATION_KERNEL_LOCK_REQUIRED");
		if ((await readCompanyComputerLinuxMetadata("/proc/sys/kernel/random/boot_id", 64)).trim() !== command.bootId)
			throw new Error("OFFICE_PREPARATION_BOOT_CHANGED");
	} finally {
		await lock.close();
	}
}

/** Atomic no-overwrite publication. All callers are under the same real flock.
 * A surviving different request/claim/result is never replaced. */
export async function publishCompanyComputerPreparationProtected(
	path: string,
	bytes: Buffer,
	mode: number,
): Promise<boolean> {
	const parent = dirname(path);
	await assertCompanyComputerImageArtifact(parent, true);
	const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	const tempName = `.preparation-${randomUUID()}`;
	const temp = `/proc/self/fd/${directory.fd}/${tempName}`;
	let created = false;
	let temporaryExists = false;
	try {
		if ((await realpath(`/proc/self/fd/${directory.fd}`)) !== parent)
			throw new Error("OFFICE_PREPARATION_PARENT_CHANGED");
		const file = await open(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			mode,
		);
		temporaryExists = true;
		try {
			await file.writeFile(bytes);
			await file.chmod(mode);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await link(temp, path);
			created = true;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		} finally {
			await unlink(temp);
			temporaryExists = false;
			await directory.sync();
		}
		if (!(await readCompanyComputerPreparationProtected(path, Math.max(bytes.length, 1), mode)).equals(bytes))
			throw new Error("OFFICE_PREPARATION_EXISTING_FILE_CONFLICT");
		return created;
	} finally {
		try {
			if (temporaryExists) {
				await unlink(temp);
				await directory.sync();
			}
		} finally {
			await directory.close();
		}
	}
}

let pending = false;
/** Publishes a protected adoption receipt only after the exact copied-state
 * report matches the current completed preparation invocation. Installs no
 * credentials and never starts or activates the ordinary office. The provider
 * separately rechecks authority and receipt/report custody. */
export async function controlCompanyComputerPreparation(
	value: unknown,
	manager: CompanyComputerPreparationManager,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (pending) throw new Error("OFFICE_PREPARATION_CONTROL_PENDING");
	const command = parseCompanyComputerPreparationCommand(value);
	pending = true;
	try {
		await assertCompanyComputerPreparationLockAndBoot(command);
		const bytes = await readCompanyComputerPreparationProtected(
			`${OFFICE_PREPARATION_CONTROL_ROOT}/incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			0o400,
		);
		if (!bytes.length || hash(bytes) !== command.requestSha256) throw new Error("OFFICE_PREPARATION_STAGING_CHANGED");
		const request = parseCompanyComputerPreparationRequest(json(bytes));
		if (request.bootId !== command.bootId) throw new Error("OFFICE_PREPARATION_BOOT_CHANGED");
		const claimPath = `${OFFICE_PREPARATION_CONTROL_ROOT}/claim.json`;
		const completionPath = `${OFFICE_PREPARATION_CONTROL_ROOT}/completion.json`;
		let claim: { schema: string; command: CompanyComputerPreparationCommand; priorInvocationId: string } | undefined;
		try {
			claim = json(await readCompanyComputerPreparationProtected(claimPath, 4096, 0o600)) as typeof claim;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (
			claim !== undefined &&
			(!claim ||
				typeof claim !== "object" ||
				Array.isArray(claim) ||
				Object.keys(claim).sort().join() !== "command,priorInvocationId,schema" ||
				claim.schema !== "qorpera.office-preparation-claim/v1" ||
				!isDeepStrictEqual(claim.command, command) ||
				typeof claim.priorInvocationId !== "string" ||
				(claim.priorInvocationId !== "" && !INVOCATION.test(claim.priorInvocationId)))
		)
			throw new Error("OFFICE_PREPARATION_CLAIM_CONFLICT");
		const before = await manager.inspect(signal);
		if (!claim) {
			try {
				await readCompanyComputerPreparationProtected(completionPath, 65536, 0o600);
				throw new Error("OFFICE_PREPARATION_CLAIM_MISSING");
			} catch (error) {
				if (!missing(error)) throw error;
			}
			if (
				before.activeState !== "inactive" ||
				before.subState !== "dead" ||
				before.mainPid !== 0 ||
				before.controlPid !== 0 ||
				before.jobId !== 0 ||
				before.result !== "success"
			)
				throw new Error("OFFICE_PREPARATION_UNIT_ALREADY_USED");
			await publishCompanyComputerPreparationProtected(requestPath, bytes, 0o444);
			// PID 1 truncates this protected existing file when starting the unit.
			try {
				await readCompanyComputerPreparationProtected(
					`${OFFICE_PREPARATION_CONTROL_ROOT}/result.json`,
					65536,
					0o600,
				);
			} catch (error) {
				if (!missing(error)) throw error;
				await publishCompanyComputerPreparationProtected(
					`${OFFICE_PREPARATION_CONTROL_ROOT}/result.json`,
					Buffer.alloc(0),
					0o600,
				);
			}
			await assertCompanyComputerPreparationLockAndBoot(command);
			signal.throwIfAborted();
			if (!isDeepStrictEqual(before, await manager.inspect(signal)))
				throw new Error("OFFICE_PREPARATION_UNIT_CHANGED");
			claim = { schema: "qorpera.office-preparation-claim/v1", command, priorInvocationId: before.invocationId };
			const owner = await publishCompanyComputerPreparationProtected(claimPath, encode(claim), 0o600);
			if (!owner) throw new Error("OFFICE_PREPARATION_CLAIM_CONFLICT");
			signal.throwIfAborted();
			await manager.start(signal);
		}
		if (
			!(
				await readCompanyComputerPreparationProtected(requestPath, COMPANY_COMPUTER_PREPARATION_MAX_BYTES, 0o444)
			).equals(bytes)
		)
			throw new Error("OFFICE_PREPARATION_REQUEST_CHANGED");
		const completed = await manager.inspect(signal);
		if (
			completed.activeState !== "active" ||
			completed.subState !== "exited" ||
			completed.result !== "success" ||
			completed.mainPid !== 0 ||
			completed.controlPid !== 0 ||
			completed.jobId !== 0 ||
			completed.execMainCode !== 1 ||
			completed.execMainStatus !== 0 ||
			!INVOCATION.test(completed.invocationId) ||
			completed.invocationId === claim.priorInvocationId
		)
			throw new Error("OFFICE_PREPARATION_INVOCATION_UNCONFIRMED");
		const reportBytes = await readCompanyComputerPreparationProtected(
			`${OFFICE_PREPARATION_CONTROL_ROOT}/result.json`,
			65536,
			0o600,
		);
		const report = parseCompanyComputerPreparationReport(json(reportBytes), request, {
			requestSha256: command.requestSha256,
			contentSha256: hash(JSON.stringify(request.entries)),
		});
		if (report.invocationId !== completed.invocationId) throw new Error("OFFICE_PREPARATION_INVOCATION_UNCONFIRMED");
		await assertCompanyComputerPreparationLockAndBoot(command);
		signal.throwIfAborted();
		if (
			!isDeepStrictEqual(completed, await manager.inspect(signal)) ||
			!(
				await readCompanyComputerPreparationProtected(
					`${OFFICE_PREPARATION_CONTROL_ROOT}/result.json`,
					65536,
					0o600,
				)
			).equals(reportBytes) ||
			!(
				await readCompanyComputerPreparationProtected(requestPath, COMPANY_COMPUTER_PREPARATION_MAX_BYTES, 0o444)
			).equals(bytes)
		)
			throw new Error("OFFICE_PREPARATION_COMPLETION_CHANGED");
		const receiptBytes = encode(companyComputerPreparationAdoptionReceipt(request));
		const completion = {
			schema: "qorpera.office-preparation-completion/v2",
			command,
			invocationId: completed.invocationId,
			reportSha256: hash(reportBytes),
			adoptionReceiptSha256: hash(receiptBytes),
			report,
		};
		// Receipt publication precedes its acknowledgement. An already-acknowledged
		// completion may never recreate a missing receipt or repair different bytes.
		let existingCompletion: Buffer | undefined;
		try {
			existingCompletion = await readCompanyComputerPreparationProtected(completionPath, 65536, 0o600);
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (existingCompletion) {
			if (
				!existingCompletion.equals(encode(completion)) ||
				!(
					await readCompanyComputerPreparationProtected(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 16384, 0o444)
				).equals(receiptBytes)
			)
				throw new Error("OFFICE_PREPARATION_ADOPTION_CHANGED");
		}
		await assertCompanyComputerPreparationLockAndBoot(command);
		signal.throwIfAborted();
		await publishCompanyComputerPreparationProtected(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, receiptBytes, 0o444);
		signal.throwIfAborted();
		await publishCompanyComputerPreparationProtected(completionPath, encode(completion), 0o600);
		return completion;
	} finally {
		pending = false;
	}
}
