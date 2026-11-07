import { randomBytes } from "node:crypto";

/** A UUID that sorts by when it was made (RFC 9562 version 7): 48 bits of Unix milliseconds, then 74 random bits.
 *
 * The node's reports are stored under (node, id). A fully random id lands on a random page of that index, so nearly
 * every report touches a page nothing has written since the last checkpoint, and PostgreSQL logs that whole page
 * (47 % of all WAL in a quiet hour in production on 7 November 2026). A time-ordered id lands beside the one before it.
 * The id is not a secret: the same report carries its time in the clear. */
export function timeOrderedUuid(now: number = Date.now()): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(now, 0, 6);
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
