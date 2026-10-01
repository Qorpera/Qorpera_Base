/** Shared by the folder service's tests: a company in memory (the folder core) and its bytes on a stand-in for the
 * storage server's share. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CoreEntry,
	CoreRefusal,
	type FeedEvent,
	type FolderActor,
	type FolderCore,
} from "../src/folder-service/core.ts";
import type { MachineRef } from "../src/folder-service/machines.ts";
import { MountGrants, parseOperatorMounts } from "../src/folder-service/mounts.ts";
import type { BridgeInfo } from "../src/folder-service/protocol.ts";

export const ENV = "11111111-2222-4333-8444-555555555555";
export const PROFILE = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
export const MEMBER = "66666666-7777-4888-8999-000000000000";
export const MACHINE: MachineRef = {
	project: "qn25b2",
	name: "qorpera-exec-node02",
	physicalId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
export const CID = 42;
/** What the bridge says for the configured machine. */
export const BRIDGE: BridgeInfo = { cid: CID, lookup: "found", machine: MACHINE };
/** The core's version ids are uuids; tests number them. */
export const v = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const PASS = "operator-pass-0123456789-abcdefghijklmnopq";
export const hashOf = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** Stores a file's bytes the way the gateway does (a v2 manifest and its chunks) and returns its core entry. */
export async function storeFile(
	root: string,
	path: string,
	content: string,
	version: number,
	chunkBytes = 4,
	options: { executable?: boolean; mediaType?: string } = {},
): Promise<CoreEntry> {
	const bytes = Buffer.from(content);
	const chunks: { sha256: string; bytes: number }[] = [];
	await mkdir(join(root, PROFILE), { recursive: true });
	for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
		const chunk = bytes.subarray(offset, offset + chunkBytes);
		chunks.push({ sha256: hashOf(chunk), bytes: chunk.byteLength });
		await writeFile(join(root, PROFILE, hashOf(chunk)), chunk);
	}
	const mediaType = options.mediaType ?? "text/plain";
	const executable = options.executable ?? false;
	const manifest = JSON.stringify({
		schema: "qorpera.cloud-file-manifest/v2",
		fileSha256: hashOf(bytes),
		bytes: bytes.byteLength,
		mediaType,
		executable,
		chunks,
	});
	await writeFile(join(root, PROFILE, hashOf(manifest)), manifest);
	return {
		path,
		kind: "file",
		version: v(version),
		manifestSha256: hashOf(manifest),
		fileSha256: hashOf(bytes),
		bytes: bytes.byteLength,
		mediaType,
		executable,
		updatedAt: "2026-10-01T12:00:00.000Z",
	};
}

export function folder(path: string, version = 1): CoreEntry {
	return { path, kind: "folder", version: v(version), updatedAt: "2026-10-01T12:00:00.000Z" };
}

/** The folder core, in memory: one company, a journal of change sets and access changes, and a visibility rule for
 * the member. Pages are two entries long so paging is exercised. */
export class FakeCore implements FolderCore {
	seq = 0;
	readonly entries = new Map<string, CoreEntry>();
	readonly journal: FeedEvent[] = [];
	hidden: (path: string) => boolean = () => false;
	deny = false;
	listCalls = 0;
	profileCalls = 0;

	seed(entries: CoreEntry[]): void {
		for (const e of entries) this.entries.set(e.path, e);
	}

	write(entry: CoreEntry): void {
		this.seq++;
		this.entries.set(entry.path, entry);
		this.journal.push({ seq: this.seq, kind: "change_set", changes: [{ ...entry, op: "write" }] });
	}

	remove(path: string): void {
		this.seq++;
		const old = this.entries.get(path)!;
		this.entries.delete(path);
		this.journal.push({ seq: this.seq, kind: "change_set", changes: [{ ...old, op: "delete" }] });
	}

	authority(hidden: (path: string) => boolean): void {
		this.seq++;
		this.hidden = hidden;
		this.journal.push({ seq: this.seq, kind: "authority" });
	}

	#visible(actor: FolderActor): CoreEntry[] {
		return [...this.entries.values()]
			.filter((e) => actor.kind === "platform" || !this.hidden(e.path))
			.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	async list(environmentId: string, actor: FolderActor, after: string | null) {
		this.listCalls++;
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		if (this.deny) throw new CoreRefusal("denied");
		const all = this.#visible(actor);
		const start = after === null ? 0 : all.findIndex((e) => e.path === after) + 1;
		const page = all.slice(start, start + 2);
		return { asOfSeq: this.seq, entries: page, next: start + 2 < all.length ? page[page.length - 1]!.path : null };
	}

	async feed(environmentId: string, actor: FolderActor, afterSeq: number) {
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		if (this.deny) throw new CoreRefusal("denied");
		const events = this.journal
			.filter((e) => e.seq > afterSeq)
			.map((e) =>
				e.kind === "change_set"
					? { ...e, changes: e.changes.filter((c) => actor.kind === "platform" || !this.hidden(c.path)) }
					: e,
			)
			.filter((e) => e.kind === "authority" || e.changes.length > 0);
		return {
			asOfSeq: this.seq,
			resync: afterSeq > this.seq,
			events,
			next: { afterSeq: this.seq, cursor: null },
			more: false,
		};
	}

	async clocks(environmentIds: readonly string[]) {
		return new Map(environmentIds.filter((id) => id === ENV).map((id) => [id, this.seq]));
	}

	async objectProfile(environmentId: string) {
		this.profileCalls++;
		if (environmentId !== ENV) throw new CoreRefusal("invalid");
		return PROFILE;
	}
}

export function grants(): MountGrants {
	return new MountGrants(
		parseOperatorMounts([
			{
				id: "proof",
				environmentId: ENV,
				actor: { kind: "member", userId: MEMBER },
				machine: MACHINE,
				passSha256: hashOf(PASS),
			},
		]),
	);
}
