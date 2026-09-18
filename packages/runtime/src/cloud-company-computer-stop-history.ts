import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerPreparationCommand,
	companyComputerStopHistoryDirectory as directory,
	parseCompanyComputerStopHistoryManifest as parse,
	parseCompanyComputerPreparationCommand,
	COMPANY_COMPUTER_STOP_HISTORY_ROOT as ROOT,
} from "@qorpera/contracts";
import { assertCompanyComputerImageArtifact } from "./cloud-company-computer-linux-host.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected,
	readCompanyComputerPreparationProtected,
} from "./cloud-company-computer-preparation-control.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export interface CompanyComputerStopHistoryFile {
	path: string;
	bytes: Buffer;
	mode: number;
}
/** History is created only after claiming the stop. Its presence therefore
 * fences a new dispatch if both boot-scoped stop records have been lost. */
export async function assertCompanyComputerStopHistoryAbsent(bootId: string, activationId: string) {
	try {
		await lstat(directory(bootId, activationId));
	} catch (error) {
		if (missing(error)) return;
		throw error;
	}
	throw new Error("history requires retained stop claim");
}
async function custody(path: string) {
	await assertCompanyComputerImageArtifact(path, true);
	const stat = await lstat(path),
		anchor = await lstat("/etc/qorpera-office");
	if (stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700 || stat.dev !== anchor.dev)
		throw new Error("history custody");
}
async function createDirectory(path: string) {
	await assertCompanyComputerImageArtifact(dirname(path), true);
	const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		await custody(path);
		await parent.sync();
	} finally {
		await parent.close();
	}
}
/** Root-disk evidence only: no SQL authority, file restoration or new boot.
 * A sealed archive with missing/corrupt blobs cannot be repaired by reading it.
 * Explicit boot/activation identity selects history, never a latest pointer. */
export async function readCompanyComputerStopHistory(bootId: string, activationId: string) {
	const root = directory(bootId, activationId);
	for (const path of [ROOT, `${ROOT}/${bootId}`, root]) await custody(path);
	const bytes = await readCompanyComputerPreparationProtected(`${root}/manifest.json`, 65536, 0o600);
	const manifest = parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), bootId, activationId);
	if (!(await readCompanyComputerPreparationProtected(`${root}/claim.json`, 65536, 0o600)).equals(bytes))
		throw new Error("history claim differs");
	const files = new Map<string, Buffer>();
	for (const entry of manifest.entries) {
		const content = await readCompanyComputerPreparationProtected(`${root}/${entry.sha256}.json`, entry.bytes, 0o600);
		if (content.length !== entry.bytes || hash(content) !== entry.sha256) throw new Error("history bytes differ");
		files.set(entry.path, content);
	}
	if (!(await readCompanyComputerPreparationProtected(`${root}/manifest.json`, 65536, 0o600)).equals(bytes))
		throw new Error("history changed");
	return { manifest, files, manifestSha256: hash(bytes) };
}

/** Called only after the stop helper verifies its current boot, retained
 * claims, configuration and empty service cgroup. Immutable blob publication
 * precedes sealing. An interrupted unsealed archive may complete with the
 * identical current evidence; an already sealed archive is verification-only. */
export async function sealCompanyComputerStopHistory(
	value: CompanyComputerPreparationCommand,
	activationId: string,
	completionPath: string,
	evidence: readonly CompanyComputerStopHistoryFile[],
	verify: () => Promise<void>,
	signal: AbortSignal,
	existingOnly = false,
) {
	const command = parseCompanyComputerPreparationCommand(value),
		root = directory(command.bootId, activationId);
	await assertCompanyComputerPreparationLockAndBoot(command);
	const files = new Map<string, CompanyComputerStopHistoryFile>();
	for (const file of evidence) {
		const previous = files.get(file.path);
		if (previous && (previous.mode !== file.mode || !previous.bytes.equals(file.bytes)))
			throw new Error("history source changed");
		files.set(file.path, file);
	}
	const manifest = parse(
		{
			schema: "qorpera.office-stop-history/v1",
			command,
			activationId,
			completionPath,
			entries: [...files.values()]
				.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes), mode: file.mode }))
				.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		},
		command.bootId,
		activationId,
	);
	const bytes = encode(manifest);
	let sealed = false;
	try {
		await lstat(`${root}/manifest.json`);
		sealed = true;
	} catch (error) {
		if (!missing(error)) throw error;
	}
	if (existingOnly && !sealed) throw new Error("history seal missing");
	await verify();
	signal.throwIfAborted();
	if (!sealed) {
		for (const path of [ROOT, `${ROOT}/${command.bootId}`, root]) await createDirectory(path);
		await publishCompanyComputerPreparationProtected(`${root}/claim.json`, bytes, 0o600);
		for (const entry of manifest.entries) {
			await verify();
			signal.throwIfAborted();
			await publishCompanyComputerPreparationProtected(
				`${root}/${entry.sha256}.json`,
				files.get(entry.path)!.bytes,
				0o600,
			);
		}
		await verify();
		signal.throwIfAborted();
		await publishCompanyComputerPreparationProtected(`${root}/manifest.json`, bytes, 0o600);
	}
	const result = await readCompanyComputerStopHistory(command.bootId, activationId);
	if (!isDeepStrictEqual(result.manifest, manifest)) throw new Error("history differs");
	await verify();
	signal.throwIfAborted();
	return result;
}
