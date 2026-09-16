import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	companyComputerServiceSoftwareChangedFiles,
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
	/** Exact bytes of every changed guest code entry of a guest-code revision,
	 * keyed by package entry name; unchanged entries are neither staged nor touched. */
	files?: Readonly<Record<string, Buffer>>;
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
async function createServiceSoftwareJournalRoot() {
	try {
		await mkdir(OFFICE_SERVICE_SOFTWARE_JOURNAL, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		return;
	}
	const parent = await open(dirname(OFFICE_SERVICE_SOFTWARE_JOURNAL), constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
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
	// Every target of the revision: the service (legacy journal names, so an
	// interrupted earlier update still reconciles) and each changed guest code
	// entry (names suffixed by the entry). Unchanged entries are never touched.
	const changedFiles = companyComputerServiceSoftwareChangedFiles(statement);
	const provided = options.files ?? {};
	if (
		Object.keys(provided).some((file) => !changedFiles.some((entry) => entry.file === file)) ||
		changedFiles.some((entry) => {
			const bytes = provided[entry.file];
			return !Buffer.isBuffer(bytes) || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256;
		})
	)
		throw new Error("OFFICE_SOFTWARE_ARTIFACT_CHANGED");
	const serviceChanged = statement.previous.service.sha256 !== statement.next.service.sha256;
	type Target = {
		directory: string;
		name: string;
		mode: number;
		previous: { bytes: number; sha256: string };
		next: { bytes: number; sha256: string };
		bytes: Buffer;
		journal: { previous: string; next: string; intent: string };
		candidate: string;
	};
	const targets: Target[] = [];
	if (serviceChanged)
		targets.push({
			directory,
			name: service,
			mode: 0o444,
			previous: statement.previous.service,
			next: statement.next.service,
			bytes: next,
			journal: { previous: "previous.mjs", next: "next.mjs", intent: "install-intent.json" },
			candidate: `.qorpera-service-update-${plan.updateId}.mjs`,
		});
	for (const entry of changedFiles) {
		const before = statement.previous.files!.find((item) => item.file === entry.file)!;
		targets.push({
			directory: dirname(entry.path),
			name: entry.path.slice(dirname(entry.path).length + 1),
			mode: entry.mode,
			previous: before,
			next: entry,
			bytes: Buffer.from(provided[entry.file]),
			journal: {
				previous: `previous-${entry.file}`,
				next: `next-${entry.file}`,
				intent: `install-intent-${entry.file}.json`,
			},
			candidate: `.qorpera-update-${plan.updateId}-${entry.file}`,
		});
	}
	let parent: Anchor | undefined, journal: Anchor | undefined;
	try {
		// The historical image ships without the guest journal root; the first
		// governed revision creates it (root-only) and the anchor still verifies
		// ownership, mode and identity before anything is written beneath it.
		await createServiceSoftwareJournalRoot();
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
		for (const item of targets) await installTarget(item, journal, planSha256, authorize);
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
						...(statement.next.files ? { files: statement.next.files } : {}),
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
	}
}

/** One target: retain previous/next bytes and an intent under the update
 * journal, stage the candidate beside the target, then rename atomically. An
 * interrupted rename reconciles from the retained intent and exact inode. */
async function installTarget(
	item: {
		directory: string;
		name: string;
		mode: number;
		previous: { bytes: number; sha256: string };
		next: { bytes: number; sha256: string };
		bytes: Buffer;
		journal: { previous: string; next: string; intent: string };
		candidate: string;
	},
	journal: Anchor,
	planSha256: string,
	authorize: () => Promise<void>,
): Promise<void> {
	const target = await anchor(item.directory, 0o755);
	try {
		const current = await read(target, item.name, item.mode, 32 * 1024 ** 2);
		const intentBytes = await optional(journal, item.journal.intent, 0o400, 65536);
		let intent: {
			schema: string;
			planSha256: string;
			previous: ReturnType<typeof identity>;
			next: ReturnType<typeof identity>;
		};
		if (!intentBytes) {
			if (current.bytes.length !== item.previous.bytes || hash(current.bytes) !== item.previous.sha256)
				throw new Error("OFFICE_SOFTWARE_PREDECESSOR_CHANGED");
			if (await optional(journal, "installed.json", 0o400, 65536)) throw new Error("OFFICE_SOFTWARE_INTENT_LOST");
			await authorize();
			await retain(journal, item.journal.previous, current.bytes, 0o400);
			await retain(journal, item.journal.next, item.bytes, 0o400);
			const staged = await retain(target, item.candidate, item.bytes, item.mode);
			intent = {
				schema: "qorpera.office-software-install-intent/v1",
				planSha256,
				previous: current.identity,
				next: staged.identity,
			};
			await retain(journal, item.journal.intent, encode(intent), 0o400);
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
		const previous = await read(journal, item.journal.previous, 0o400, item.previous.bytes);
		const storedNext = await read(journal, item.journal.next, 0o400, item.bytes.length);
		if (hash(previous.bytes) !== item.previous.sha256 || !storedNext.bytes.equals(item.bytes))
			throw new Error("OFFICE_SOFTWARE_CUSTODY_CHANGED");
		await authorize();
		let observed = await read(target, item.name, item.mode, 32 * 1024 ** 2);
		if (observed.bytes.equals(previous.bytes) && isDeepStrictEqual(observed.identity, intent.previous)) {
			const staged = await read(target, item.candidate, item.mode, item.bytes.length);
			if (!staged.bytes.equals(item.bytes) || !isDeepStrictEqual(staged.identity, intent.next))
				throw new Error("OFFICE_SOFTWARE_STAGING_CHANGED");
			await authorize();
			const final = await read(target, item.name, item.mode, previous.bytes.length);
			if (!final.bytes.equals(previous.bytes) || !isDeepStrictEqual(final.identity, intent.previous))
				throw new Error("OFFICE_SOFTWARE_PREDECESSOR_CHANGED");
			await rename(join(target.path, item.candidate), join(target.path, item.name));
			await target.file.sync();
			observed = await read(target, item.name, item.mode, item.bytes.length);
		}
		if (!observed.bytes.equals(item.bytes) || !isDeepStrictEqual(observed.identity, intent.next))
			throw new Error("OFFICE_SOFTWARE_INSTALL_UNCONFIRMED");
		// Reconciliation may resume after rename but before its directory fsync.
		// The installation receipt must never outrun durable target publication.
		await target.file.sync();
	} finally {
		await target.file.close();
	}
}
