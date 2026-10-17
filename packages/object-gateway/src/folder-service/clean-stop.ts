import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isUuid } from "@qorpera/contracts";

/** The note a clean stop of the folder service leaves its next run (F3 5g-5), in the unit's RuntimeDirectory: kept
 * across a stop and a start (RuntimeDirectoryPreserve=yes), gone at a reboot (a tmpfs). It names the machines the run
 * vouched for (`FolderService.vouched`): none of them holds a read a run served and never released. A run that crashed,
 * or stopped without a clean stop, leaves none, so the next run vouches for no machine, and every machine is lost until
 * the executor says it restarted. A machine is vouched for from its first start after the node's boot, so a note holds
 * the machines started since then. */
const NOTE = "clean-stop.json";
const WRITING = "clean-stop.json.writing";
const SCHEMA = "qorpera.folder-service-clean-stop/v1";
/** A larger note is not read: it vouches for no machine. */
const MAX_NOTE_BYTES = 4 * 1024 * 1024;

/** At the start, before anything is served (cli.ts): the machines the last run vouched for, and its note removed, so a
 * crash of this run leaves none. No note, or one that cannot be read: none. A note that is there and cannot be removed
 * throws, which stops the service at its start. */
export function takeCleanStop(directory: string, log: (line: string) => void): string[] {
	const path = join(directory, NOTE);
	let text: string | undefined;
	try {
		if (statSync(path).size > MAX_NOTE_BYTES)
			log(`folder-service: the clean-stop note is over ${MAX_NOTE_BYTES} bytes`);
		else text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			log(`folder-service: the clean-stop note cannot be read: ${(error as Error).message}`);
	}
	try {
		rmSync(path, { force: true });
		rmSync(join(directory, WRITING), { force: true });
		syncDirectory(directory);
	} catch (error) {
		throw new Error(`The clean-stop note in ${directory} cannot be removed: ${(error as Error).message}`);
	}
	const machines = text === undefined ? undefined : parseNote(text);
	if (text !== undefined && machines === undefined)
		log("folder-service: the clean-stop note is not one this service wrote");
	if (machines === undefined) {
		log("folder-service: the last run left no clean stop: every machine is lost until it restarts");
		return [];
	}
	log(`folder-service: the last run stopped cleanly; it vouched for ${machines.length} machines`);
	return machines;
}

/** Once the clean stop succeeded (cli.ts), before the process ends: the note naming the machines this run vouches for,
 * whole or not at all. Throws if it cannot be written; then the next run vouches for no machine. */
export function leaveCleanStop(directory: string, machines: readonly string[], now: Date = new Date()): void {
	const text = `${JSON.stringify({ schema: SCHEMA, stoppedAt: now.toISOString(), machines: [...new Set(machines)] })}\n`;
	const writing = join(directory, WRITING);
	const fd = openSync(writing, "w", 0o600);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(writing, join(directory, NOTE));
	syncDirectory(directory);
}

/** The machines a note names, or nothing if it is not a note this service wrote. */
function parseNote(text: string): string[] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const note = value as Record<string, unknown>;
	if (
		Object.keys(note).sort().join() !== "machines,schema,stoppedAt" ||
		note.schema !== SCHEMA ||
		typeof note.stoppedAt !== "string" ||
		!Array.isArray(note.machines) ||
		!note.machines.every((machine) => isUuid(machine))
	)
		return undefined;
	return [...new Set(note.machines as string[])];
}

function syncDirectory(directory: string): void {
	const fd = openSync(directory, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
