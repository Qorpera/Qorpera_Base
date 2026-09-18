import assert from "node:assert/strict";

/** Test-only bridge to a disposable systemd guest. It executes the packaged
 * root controls; it is never a production provider or a source of SQL authority. */
export interface OfficeHttpGuest {
	readonly bootId: string;
	stage(path: string, content: Buffer): Promise<void>;
	execute(argv: readonly string[]): Promise<void>;
	read(path: string): Promise<{ content: Buffer; uid: number; gid: number; mode: string } | undefined>;
}
export async function officeHttpGuestRead(
	files: Map<string, { content: Buffer; mode: string }>,
	guest: OfficeHttpGuest | undefined,
	path: string,
) {
	if (!guest) return files.get(path);
	const file = await guest.read(path);
	if (!file) {
		files.delete(path);
		return undefined;
	}
	assert.equal(file.uid, 0);
	assert.equal(file.gid, 0);
	files.set(path, { content: file.content, mode: file.mode });
	return files.get(path);
}

export async function officeHttpGuestRefresh(
	files: Map<string, { content: Buffer; mode: string }>,
	guest: OfficeHttpGuest,
	paths: string[],
) {
	for (const path of paths)
		assert(await officeHttpGuestRead(files, guest, path), `Missing actual guest file: ${path}`);
}
