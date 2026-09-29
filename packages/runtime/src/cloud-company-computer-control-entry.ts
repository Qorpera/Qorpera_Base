import { realpathSync, writeSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One pinned office control executable: the file names it runs under (source
 * and packaged), its fixed help and failure lines, and its protected work. */
export interface CompanyComputerControlEntry {
	readonly moduleUrl: string;
	readonly names: readonly string[];
	readonly help: string;
	readonly failure: string;
	readonly run: (args: readonly string[]) => Promise<void>;
}

/** Keeps a caller that awaits the write callback from hanging. */
function discard(...args: unknown[]): boolean {
	const callback = args.at(-1);
	if (typeof callback === "function") process.nextTick(callback as () => void);
	return true;
}

/** LXD 6.9 keeps a VM exec alive only with `record-output`, so the host keeps
 * whatever an office control writes. When the process runs under one of
 * `names`, this entry owns both streams:
 * - success writes nothing;
 * - a refusal or unexpected error, awaited or not (uncaught exception,
 *   unhandled rejection), writes exactly `failure` and a newline to stderr,
 *   once, and exits 1;
 * - `--help` alone writes exactly `help` and a newline to stdout;
 * - nothing else is written: console and stream writes are dropped and Node's
 *   warning printer is removed.
 * Protected requests, credentials and evidence are read only by the locked
 * child, which runs with ignored stdio. */
export function runCompanyComputerControlEntry(entry: CompanyComputerControlEntry): void {
	const script = process.argv[1];
	if (!script || !entry.names.includes(basename(script))) return;
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		process.exitCode = 1;
		try {
			writeSync(2, `${entry.failure}\n`);
		} catch {}
	};
	const abort = () => {
		fail();
		process.exit(1);
	};
	process.on("uncaughtException", abort);
	process.on("unhandledRejection", abort);
	process.removeAllListeners("warning");
	process.stdout.write = discard;
	process.stderr.write = discard;
	try {
		if (realpathSync(resolve(script)) !== realpathSync(fileURLToPath(entry.moduleUrl)))
			throw new Error("OFFICE_CONTROL_ENTRY_UNCONFIRMED");
	} catch {
		fail();
		return;
	}
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		try {
			writeSync(1, `${entry.help}\n`);
		} catch {
			fail();
		}
		return;
	}
	new Promise<void>((done) => done(entry.run(args))).catch(fail);
}
