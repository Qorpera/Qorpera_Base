import { APP_RETIRED_MAX_BYTES, APP_RETIRED_PATH } from "@qorpera/cloud-client/app-retired";
import { commitUnit, unsaved, type WebMemberFolder } from "./company-folder-writes.ts";

/*
 * A member retires an agent's interface app, or brings it back (the founder, 15 November 2026: users "should also get a
 * "retire interface" config when rightclicking an interface to stop maintaining it, and hide it";
 * deploy/first-node/RUNTIME-INTERFACE-APPS.md §3e). The state is one company file, `apps/retired.md` (the cloud
 * client's `app-retired.ts`), which only members write: here, through the member's own folder client, as the member's
 * other writes of the folder. The write names the version it read; when another member wrote the file in between, it
 * reads it again and tries once more.
 */

/** Tries in all: the first, and one more after a version conflict. */
const TRIES = 2;

/** Rewrites `apps/retired.md` from what it holds now. `rewrite` makes the next text from the current one (null: there
 * is no file), the same text (or null for no file) for nothing to do, or null when it cannot (the file is full:
 * `full` is thrown). */
export async function changeRetiredApps(
	folder: WebMemberFolder,
	rewrite: (text: string | null) => string | null,
	options: { readonly key: () => string; readonly failure: string; readonly full: string },
	signal: AbortSignal,
	check: () => void,
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const entry = (await folder.read(APP_RETIRED_PATH, signal)).entry;
		check();
		if (entry && (entry.kind !== "file" || !entry.file || entry.file.bytes > APP_RETIRED_MAX_BYTES))
			throw new Error(options.failure);
		let text: string | null = null;
		if (entry?.file) {
			const bytes = await folder.readFile(entry.file, signal, APP_RETIRED_MAX_BYTES);
			check();
			try {
				text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			} catch {
				throw new Error(options.failure);
			}
		}
		const next = rewrite(text);
		if (next === text) return;
		if (next === null) throw new Error(options.full);
		const result = await commitUnit(
			folder,
			options.key(),
			entry
				? { op: "write", path: APP_RETIRED_PATH, text: next, expectedVersion: entry.version }
				: { op: "write", path: APP_RETIRED_PATH, text: next },
			signal,
		);
		check();
		if (result.outcome === "saved") return;
		if (
			result.outcome === "conflict" &&
			(result.reason === "version_changed" || result.reason === "exists") &&
			attempt < TRIES
		)
			continue;
		throw unsaved(result, options.failure);
	}
}
