// The fixtures' seeded helpers: a generator, a message's bytes, and how a hostile writer cuts what it writes.

/** A small seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One message's bytes: its kind, then a pattern of its member, its place and its size. */
export function message(member: number, index: number, size: number): Buffer {
	const bytes = Buffer.allocUnsafe(size);
	bytes[0] = 2;
	for (let i = 1; i < size; i++) bytes[i] = (i * 31 + member * 7 + index * 13) & 0xff;
	return bytes;
}

/** The sizes of the pieces a hostile writer cuts its bytes into: from 1 byte to 256 KiB, with long runs of 1-byte pieces. */
export function pieces(seed: number): () => number {
	const random = seeded(seed ^ 0x5eed);
	let run = 0;
	return () => {
		if (run > 0) {
			run--;
			return 1;
		}
		if (random() < 0.2) {
			run = 500 + Math.floor(random() * 5000);
			return 1;
		}
		return 1 + Math.floor(random() * 256 * 1024);
	};
}
