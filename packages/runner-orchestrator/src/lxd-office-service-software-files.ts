import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerServiceSoftwareEnvelope,
	parseCompanyComputerServiceSoftwarePlan,
} from "@qorpera/contracts";
import {
	verifyLxdOfficeServiceSoftware,
	verifyLxdOfficeServiceSoftwareReceipt,
} from "./lxd-office-service-software.ts";

const directory = "/opt/qorpera-office";
const service = "qorpera-company-computer-service.mjs";
export const OFFICE_SERVICE_SOFTWARE_JOURNAL = "/var/lib/qorpera-office-service-software";
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
type Verification = Parameters<typeof verifyLxdOfficeServiceSoftware>;
export interface LxdOfficeServiceSoftwareFilesOptions {
	envelope: Verification[0];
	plan: Verification[1];
	trust: Verification[2];
	manifests: Verification[3];
	serviceBytes: Buffer;
	/** Must hold the provider/guest exclusive update lock and independently
	 * verify current stopped-service and SQL update dispatch authority. Neither
	 * a signature nor this filesystem primitive supplies those authorities. */
	authorize: (signal: AbortSignal) => Promise<void>;
}

function identity(value: Awaited<ReturnType<FileHandle["stat"]>>) {
	return {
		dev: String(value.dev),
		ino: String(value.ino),
		bytes: Number(value.size),
		mtime: String(value.mtimeMs),
	};
}
async function anchor(path: string, mode: number) {
	for (let current = path; ; current = dirname(current)) {
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022)
			throw new Error("OFFICE_SOFTWARE_DIRECTORY_UNSAFE");
		if (current === "/") break;
	}
	if ((await realpath(path)) !== path) throw new Error("OFFICE_SOFTWARE_DIRECTORY_UNSAFE");
	const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const original = await file.stat();
		if ((original.mode & 0o7777) !== mode) throw new Error("OFFICE_SOFTWARE_DIRECTORY_UNSAFE");
		const check = async () => {
			const current = await lstat(path);
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				current.dev !== original.dev ||
				current.ino !== original.ino ||
				current.uid !== 0 ||
				current.gid !== 0 ||
				(current.mode & 0o7777) !== mode ||
				(await realpath(path)) !== path
			)
				throw new Error("OFFICE_SOFTWARE_DIRECTORY_CHANGED");
		};
		await check();
		return { file, path: `/proc/self/fd/${file.fd}`, check };
	} catch (error) {
		await file.close();
		throw error;
	}
}
type Anchor = Awaited<ReturnType<typeof anchor>>;
async function read(root: Anchor, name: string, mode: number, limit: number) {
	await root.check();
	const file = await open(join(root.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.uid !== 0 ||
			before.gid !== 0 ||
			before.nlink !== 1 ||
			(before.mode & 0o7777) !== mode ||
			before.size < 1 ||
			before.size > limit
		)
			throw new Error("OFFICE_SOFTWARE_FILE_UNSAFE");
		const buffer = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const result = await file.read(buffer, length, buffer.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		const after = await file.stat();
		const named = await lstat(join(root.path, name));
		if (
			length !== before.size ||
			!isDeepStrictEqual(identity(before), identity(after)) ||
			before.ctimeMs !== after.ctimeMs ||
			before.mode !== after.mode ||
			before.uid !== after.uid ||
			before.gid !== after.gid ||
			after.nlink !== 1 ||
			named.dev !== before.dev ||
			named.ino !== before.ino
		)
			throw new Error("OFFICE_SOFTWARE_FILE_CHANGED");
		await root.check();
		// A complete-looking record may be a prior process's unsynced write.
		// Reestablish its durability when accepting any recovered prefix.
		await file.sync();
		await root.file.sync();
		return { bytes: buffer.subarray(0, length), identity: identity(before) };
	} finally {
		await file.close();
	}
}
async function optional(root: Anchor, name: string, mode: number, limit: number) {
	try {
		return await read(root, name, mode, limit);
	} catch (error) {
		if (!missing(error)) throw error;
		return undefined;
	}
}
async function retain(root: Anchor, name: string, bytes: Buffer, mode: number) {
	const existing = await optional(root, name, mode, bytes.length);
	if (existing) {
		if (!existing.bytes.equals(bytes)) throw new Error("OFFICE_SOFTWARE_RECORD_CHANGED");
		return existing;
	}
	await root.check();
	const file = await open(
		join(root.path, name),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await file.writeFile(bytes);
		await file.chmod(mode);
		await file.sync();
	} finally {
		await file.close();
	}
	await root.file.sync();
	const result = await read(root, name, mode, bytes.length);
	if (!result.bytes.equals(bytes)) throw new Error("OFFICE_SOFTWARE_RECORD_CHANGED");
	return result;
}

/** Protected, service-only file operation. Does not start a service, advance
 * SQL, change the image pin, restore credentials, or authorize an invocation.
 * The external worker owns the live lock/stop/dispatch checks. An interrupted
 * atomic rename is reconciled from the retained intent and exact inode; any
 * incomplete or conflicting prefix holds without deleting evidence. */
export async function installLxdOfficeServiceSoftwareFiles(
	options: LxdOfficeServiceSoftwareFilesOptions,
	signal: AbortSignal,
) {
	if (process.platform !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0)
		throw new Error("OFFICE_SOFTWARE_ROOT_LINUX_REQUIRED");
	const envelope = parseCompanyComputerServiceSoftwareEnvelope(options.envelope);
	const requested = parseCompanyComputerServiceSoftwarePlan(options.plan);
	const trust = { ...options.trust };
	const manifests = { previous: Buffer.from(options.manifests.previous), next: Buffer.from(options.manifests.next) };
	const verified = verifyLxdOfficeServiceSoftware(envelope, requested, trust, manifests);
	const { statement, plan, planSha256 } = verified;
	const next = Buffer.from(options.serviceBytes);
	if (next.length !== statement.next.service.bytes || hash(next) !== statement.next.service.sha256)
		throw new Error("OFFICE_SOFTWARE_ARTIFACT_CHANGED");
	const authorize = async () => {
		signal.throwIfAborted();
		if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== plan.predecessor.startup.bootId)
			throw new Error("OFFICE_SOFTWARE_BOOT_CHANGED");
		await options.authorize(signal);
		signal.throwIfAborted();
	};
	await authorize();
	const target = await anchor(directory, 0o755);
	let parent: Anchor | undefined, journal: Anchor | undefined;
	try {
		parent = await anchor(OFFICE_SERVICE_SOFTWARE_JOURNAL, 0o700);
		await authorize();
		try {
			await mkdir(join(parent.path, plan.updateId), { mode: 0o700 });
			await parent.file.sync();
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		await parent.file.sync();
		journal = await anchor(join(OFFICE_SERVICE_SOFTWARE_JOURNAL, plan.updateId), 0o700);
		const request = encode({ schema: "qorpera.office-software-files/v1", plan, planSha256, statement });
		await retain(journal, "request.json", request, 0o400);
		await retain(journal, "envelope.json", encode(envelope), 0o400);
		await retain(
			journal,
			"trust.json",
			encode({ verificationKeySpki: trust.verificationKeySpki, statementSha256: trust.statementSha256, planSha256 }),
			0o400,
		);
		await retain(journal, "previous-manifest.json", manifests.previous, 0o400);
		await retain(journal, "next-manifest.json", manifests.next, 0o400);
		const current = await read(target, service, 0o444, 32 * 1024 ** 2);
		const intentBytes = await optional(journal, "install-intent.json", 0o400, 65536);
		const candidateName = `.qorpera-service-update-${plan.updateId}.mjs`;
		let intent: {
			schema: string;
			planSha256: string;
			previous: ReturnType<typeof identity>;
			next: ReturnType<typeof identity>;
		};
		if (!intentBytes) {
			if (
				current.bytes.length !== statement.previous.service.bytes ||
				hash(current.bytes) !== statement.previous.service.sha256
			)
				throw new Error("OFFICE_SOFTWARE_PREDECESSOR_CHANGED");
			if (await optional(journal, "installed.json", 0o400, 65536)) throw new Error("OFFICE_SOFTWARE_INTENT_LOST");
			await authorize();
			await retain(journal, "previous.mjs", current.bytes, 0o400);
			await retain(journal, "next.mjs", next, 0o400);
			const staged = await retain(target, candidateName, next, 0o444);
			intent = {
				schema: "qorpera.office-software-install-intent/v1",
				planSha256,
				previous: current.identity,
				next: staged.identity,
			};
			await retain(journal, "install-intent.json", encode(intent), 0o400);
		} else {
			const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(intentBytes.bytes));
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new Error("OFFICE_SOFTWARE_INTENT_CHANGED");
			intent = value as typeof intent;
			if (
				Object.keys(intent).sort().join() !== "next,planSha256,previous,schema" ||
				intent.schema !== "qorpera.office-software-install-intent/v1" ||
				intent.planSha256 !== planSha256
			)
				throw new Error("OFFICE_SOFTWARE_INTENT_CHANGED");
		}
		const previous = await read(journal, "previous.mjs", 0o400, statement.previous.service.bytes);
		const storedNext = await read(journal, "next.mjs", 0o400, next.length);
		if (hash(previous.bytes) !== statement.previous.service.sha256 || !storedNext.bytes.equals(next))
			throw new Error("OFFICE_SOFTWARE_CUSTODY_CHANGED");
		await authorize();
		let observed = await read(target, service, 0o444, 32 * 1024 ** 2);
		if (observed.bytes.equals(previous.bytes) && isDeepStrictEqual(observed.identity, intent.previous)) {
			const staged = await read(target, candidateName, 0o444, next.length);
			if (!staged.bytes.equals(next) || !isDeepStrictEqual(staged.identity, intent.next))
				throw new Error("OFFICE_SOFTWARE_STAGING_CHANGED");
			await authorize();
			const final = await read(target, service, 0o444, previous.bytes.length);
			if (!final.bytes.equals(previous.bytes) || !isDeepStrictEqual(final.identity, intent.previous))
				throw new Error("OFFICE_SOFTWARE_PREDECESSOR_CHANGED");
			await rename(join(target.path, candidateName), join(target.path, service));
			await target.file.sync();
			observed = await read(target, service, 0o444, next.length);
		}
		if (!observed.bytes.equals(next) || !isDeepStrictEqual(observed.identity, intent.next))
			throw new Error("OFFICE_SOFTWARE_INSTALL_UNCONFIRMED");
		// Reconciliation may resume after rename but before its directory fsync.
		// The installation receipt must never outrun durable target publication.
		await target.file.sync();
		await authorize();
		const completed = await optional(journal, "installed.json", 0o400, 65536);
		const receipt = verifyLxdOfficeServiceSoftwareReceipt(
			completed
				? JSON.parse(completed.bytes.toString("utf8"))
				: {
						schema: "qorpera.office-service-software-receipt/v1",
						plan,
						planSha256,
						state: "installed",
						service: statement.next.service,
						installedAt: new Date().toISOString(),
					},
			envelope,
			requested,
			trust,
			manifests,
		);
		if (!isDeepStrictEqual(receipt.service, statement.next.service))
			throw new Error("OFFICE_SOFTWARE_RECEIPT_CHANGED");
		await retain(journal, "installed.json", encode(receipt), 0o400);
		await parent.check();
		return receipt;
	} finally {
		await journal?.file.close();
		await parent?.file.close();
		await target.file.close();
	}
}
