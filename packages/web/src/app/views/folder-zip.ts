const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const MADE_ON_UNIX = (3 << 8) | VERSION_NEEDED;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const FILE_MODE = 0o100644;
const EXECUTABLE_MODE = 0o100755;
const FOLDER_MODE = 0o40755;
const DOS_FOLDER = 0x10;
const MAX_ENTRIES = 0xffff;
const MAX_ZIP_BYTES = 0xffffffff;

const encoder = new TextEncoder();

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

export function crc32(bytes: Uint8Array, previous = 0): number {
	let crc = (previous ^ 0xffffffff) >>> 0;
	for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryPlan {
	readonly name: string;
	readonly bytes: number;
}

export function zipEntryBytes(entry: ZipEntryPlan): number {
	return LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * encoder.encode(entry.name).byteLength + entry.bytes;
}

export function storedZipBytes(entries: readonly ZipEntryPlan[]): number {
	return entries.reduce((total, entry) => total + zipEntryBytes(entry), END_BYTES);
}

function dosStamp(date: Date): { readonly time: number; readonly day: number } {
	const year = date.getFullYear();
	if (Number.isNaN(year) || year < 1980) return { time: 0, day: (1 << 5) | 1 };
	if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, day: (127 << 9) | (12 << 5) | 31 };
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

interface Header {
	readonly name: Uint8Array;
	readonly stamp: { readonly time: number; readonly day: number };
	readonly crc: number;
	readonly bytes: number;
	readonly mode: number;
	readonly dos: number;
	readonly offset: number;
}

function localHeader(header: Header): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(LOCAL_HEADER_BYTES + header.name.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, LOCAL_SIGNATURE, true);
	view.setUint16(4, VERSION_NEEDED, true);
	view.setUint16(6, UTF8_NAMES, true);
	view.setUint16(8, STORED, true);
	view.setUint16(10, header.stamp.time, true);
	view.setUint16(12, header.stamp.day, true);
	view.setUint32(14, header.crc, true);
	view.setUint32(18, header.bytes, true);
	view.setUint32(22, header.bytes, true);
	view.setUint16(26, header.name.byteLength, true);
	view.setUint16(28, 0, true);
	out.set(header.name, LOCAL_HEADER_BYTES);
	return out;
}

function centralHeader(header: Header): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(CENTRAL_HEADER_BYTES + header.name.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, CENTRAL_SIGNATURE, true);
	view.setUint16(4, MADE_ON_UNIX, true);
	view.setUint16(6, VERSION_NEEDED, true);
	view.setUint16(8, UTF8_NAMES, true);
	view.setUint16(10, STORED, true);
	view.setUint16(12, header.stamp.time, true);
	view.setUint16(14, header.stamp.day, true);
	view.setUint32(16, header.crc, true);
	view.setUint32(20, header.bytes, true);
	view.setUint32(24, header.bytes, true);
	view.setUint16(28, header.name.byteLength, true);
	view.setUint32(38, ((header.mode << 16) | header.dos) >>> 0, true);
	view.setUint32(42, header.offset, true);
	out.set(header.name, CENTRAL_HEADER_BYTES);
	return out;
}

export interface ZipFileWriter {
	add(piece: Uint8Array): void;
	end(): void;
}

export class StoredZip {
	readonly #parts: Blob[] = [];
	readonly #central: Uint8Array<ArrayBuffer>[] = [];
	#offset = 0;
	#open = false;

	folder(name: string, modified: Date): void {
		this.#entry(`${name}/`, modified, FOLDER_MODE, DOS_FOLDER).end();
	}

	file(name: string, modified: Date, executable: boolean): ZipFileWriter {
		return this.#entry(name, modified, executable ? EXECUTABLE_MODE : FILE_MODE, 0);
	}

	finish(): { readonly parts: Blob[]; readonly bytes: number } {
		if (this.#open) throw new Error("A zip entry is still being written");
		const directory = this.#central.reduce((total, header) => total + header.byteLength, 0);
		const end = new Uint8Array(END_BYTES);
		const view = new DataView(end.buffer);
		view.setUint32(0, END_SIGNATURE, true);
		view.setUint16(8, this.#central.length, true);
		view.setUint16(10, this.#central.length, true);
		view.setUint32(12, directory, true);
		view.setUint32(16, this.#offset, true);
		const parts = [...this.#parts, new Blob(this.#central), new Blob([end])];
		return { parts, bytes: this.#offset + directory + END_BYTES };
	}

	#entry(name: string, modified: Date, mode: number, dos: number): ZipFileWriter {
		if (this.#open) throw new Error("A zip entry is still being written");
		if (this.#central.length === MAX_ENTRIES) throw new Error("Too many zip entries");
		const encoded = encoder.encode(name);
		if (encoded.byteLength === 0 || encoded.byteLength > 0xffff) throw new Error("Invalid zip entry name");
		this.#open = true;
		const offset = this.#offset;
		const slot = this.#parts.push(new Blob([])) - 1;
		let crc = 0;
		let bytes = 0;
		return {
			add: (piece) => {
				crc = crc32(piece, crc);
				bytes += piece.byteLength;
				if (offset + LOCAL_HEADER_BYTES + encoded.byteLength + bytes > MAX_ZIP_BYTES)
					throw new Error("The zip is too large");
				this.#parts.push(new Blob([piece as BlobPart]));
			},
			end: () => {
				const header: Header = { name: encoded, stamp: dosStamp(modified), crc, bytes, mode, dos, offset };
				const local = localHeader(header);
				this.#parts[slot] = new Blob([local]);
				this.#central.push(centralHeader(header));
				this.#offset = offset + local.byteLength + bytes;
				this.#open = false;
			},
		};
	}
}
