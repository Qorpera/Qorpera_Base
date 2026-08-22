import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LegacyObjectMigrationAuthority,
	type LegacyObjectMigrationItem,
	migrateLegacyObjects,
} from "../src/migration.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";

const firstProfile = "8ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const secondProfile = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const roots: string[] = [];

class FakeMigrationAuthority implements LegacyObjectMigrationAuthority {
	readonly items: LegacyObjectMigrationItem[];
	readonly contents: Map<string, Uint8Array>;
	readonly confirmed: string[] = [];

	constructor(entries: Array<{ profileId: string; bytes: Uint8Array }>) {
		this.items = entries
			.map((entry) => ({
				profileId: entry.profileId,
				sha256: createHash("sha256").update(entry.bytes).digest("hex"),
				bytes: entry.bytes.byteLength,
			}))
			.sort((left, right) =>
				left.profileId === right.profileId
					? left.sha256.localeCompare(right.sha256, "en")
					: left.profileId.localeCompare(right.profileId, "en"),
			);
		this.contents = new Map(
			entries.map((entry) => {
				const sha256 = createHash("sha256").update(entry.bytes).digest("hex");
				return [`${entry.profileId}/${sha256}`, entry.bytes] as const;
			}),
		);
	}

	async listLegacyObjects(
		after: { profileId: string; sha256: string } | undefined,
		limit: number,
	): Promise<LegacyObjectMigrationItem[]> {
		const start = after
			? this.items.findIndex(
					(item) =>
						item.profileId > after.profileId ||
						(item.profileId === after.profileId && item.sha256 > after.sha256),
				)
			: 0;
		return start < 0 ? [] : this.items.slice(start, start + limit);
	}

	async readLegacyObject(profileId: string, sha256: string): Promise<Uint8Array> {
		const bytes = this.contents.get(`${profileId}/${sha256}`);
		if (!bytes) throw new Error("missing");
		return bytes;
	}

	async confirmUpload(profileId: string, sha256: string, _bytes: number): Promise<void> {
		this.confirmed.push(`${profileId}/${sha256}`);
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy object migration", () => {
	it("copies verified objects in bounded cursor batches and confirms after storage", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-object-migration-"));
		roots.push(root);
		const authority = new FakeMigrationAuthority([
			{ profileId: secondProfile, bytes: Buffer.from("second", "utf-8") },
			{ profileId: firstProfile, bytes: Buffer.from("first", "utf-8") },
			{ profileId: secondProfile, bytes: Buffer.from("third", "utf-8") },
		]);
		const store = new FileSystemObjectStore(root);
		expect(await migrateLegacyObjects(authority, store, 2)).toBe(3);
		expect(authority.confirmed).toEqual(authority.items.map((item) => `${item.profileId}/${item.sha256}`));
		for (const item of authority.items) {
			expect(Buffer.from(await store.get(item.profileId, item.sha256, item.bytes))).toEqual(
				Buffer.from(authority.contents.get(`${item.profileId}/${item.sha256}`)!),
			);
		}
	});

	it("fails before confirmation when legacy bytes do not match the catalog", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-object-migration-"));
		roots.push(root);
		const authority = new FakeMigrationAuthority([{ profileId: firstProfile, bytes: Buffer.from("valid") }]);
		const item = authority.items[0]!;
		authority.contents.set(`${item.profileId}/${item.sha256}`, Buffer.from("wrong"));
		await expect(migrateLegacyObjects(authority, new FileSystemObjectStore(root))).rejects.toThrow("integrity");
		expect(authority.confirmed).toEqual([]);
	});
});
