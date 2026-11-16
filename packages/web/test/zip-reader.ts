export interface ReadZipEntry {
	readonly name: string;
	readonly crc: number;
	readonly bytes: Uint8Array;
	readonly flags: number;
	readonly method: number;
	readonly mode: number;
	readonly dos: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function readZip(zip: Uint8Array): ReadZipEntry[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const end = zip.byteLength - 22;
	if (view.getUint32(end, true) !== 0x06054b50) throw new Error("No end of central directory");
	const count = view.getUint16(end + 10, true);
	if (view.getUint16(end + 8, true) !== count) throw new Error("Entry counts differ");
	const directoryBytes = view.getUint32(end + 12, true);
	let at = view.getUint32(end + 16, true);
	if (at + directoryBytes !== end) throw new Error("The central directory is not where the end says");
	const entries: ReadZipEntry[] = [];
	for (let index = 0; index < count; index++) {
		if (view.getUint32(at, true) !== 0x02014b50) throw new Error("No central header");
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const crc = view.getUint32(at + 16, true);
		const compressed = view.getUint32(at + 20, true);
		const size = view.getUint32(at + 24, true);
		const nameBytes = view.getUint16(at + 28, true);
		const extra = view.getUint16(at + 30, true);
		const comment = view.getUint16(at + 32, true);
		const external = view.getUint32(at + 38, true);
		const local = view.getUint32(at + 42, true);
		const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameBytes));
		if (compressed !== size) throw new Error(`${name}: sizes differ`);
		if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: no local header`);
		const localName = decoder.decode(zip.subarray(local + 30, local + 30 + view.getUint16(local + 26, true)));
		if (
			localName !== name ||
			view.getUint16(local + 6, true) !== flags ||
			view.getUint16(local + 8, true) !== method ||
			view.getUint32(local + 14, true) !== crc ||
			view.getUint32(local + 18, true) !== size ||
			view.getUint32(local + 22, true) !== size
		)
			throw new Error(`${name}: the local header differs from the central one`);
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		entries.push({
			name,
			crc,
			bytes: zip.slice(start, start + size),
			flags,
			method,
			mode: external >>> 16,
			dos: external & 0xffff,
		});
		at += 46 + nameBytes + extra + comment;
	}
	return entries;
}
