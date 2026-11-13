import type { CloudCodingCommandReceipt } from "@qorpera/contracts";
import {
	CLOUD_TOOL_RESULT_RESERVE_BYTES,
	cloudToolJsonText,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "./cloud-native-tool-boundary.ts";

/** What a read of a command's log asks for when the agent names no smaller `limit` (keyholes S1, 12 Nov 2026): one
 * result's room. Each byte of output takes at least one byte of the result, so no page could show more; the page that
 * comes back is cut to what fits (fitCloudCommandPage). */
export const CLOUD_COMMAND_PAGE_ASK = MAX_CLOUD_TOOL_RESULT_BYTES - CLOUD_TOOL_RESULT_RESERVE_BYTES;

/** Whether `value` reaches the model whole as one tool result: its JSON text, escaped once more as the boundary's
 * envelope escapes it, within the result's bound less the envelope's reserve. A text past even a tool JSON's own bound
 * does not fit either. */
export function cloudCommandFits(value: unknown): boolean {
	try {
		return (
			Buffer.byteLength(JSON.stringify(cloudToolJsonText(value, 131072)).replace(/[<>&\u2028\u2029]/g, "\\u0000")) <=
			MAX_CLOUD_TOOL_RESULT_BYTES - CLOUD_TOOL_RESULT_RESERVE_BYTES
		);
	} catch {
		return false;
	}
}

type Page = Pick<CloudCodingCommandReceipt, "output" | "truncated" | "log">;

/**
 * `page` with as much of its output as fits one result beside the rest of it, as `fits` measures it: the start of the
 * output for a read from an offset, its end for a tail, with the cursor (and `truncated`) moved to match. Worked out
 * once from the page itself, so a read needs one request, not one per halving.
 *
 * A character of output stands for its bytes of UTF-8 in the log, except U+FFFD, which the log's reader also shows for a
 * byte that is not UTF-8. The cursor is counted from the part shown, or from the part left out, whichever holds no
 * U+FFFD. When both hold one, the answer is `{ ask }`: the bytes of output that fit, for the caller to ask for exactly
 * that page (a read of `ask` bytes from the same offset shows the same start). Null: not even the page without output
 * fits.
 */
export function fitCloudCommandPage<T extends Page>(
	page: T,
	tail: boolean,
	fits: (shown: T) => boolean,
): { page: T } | { ask: number } | null {
	if (fits(page)) return { page };
	const points = Array.from(page.output);
	const parts = (count: number) =>
		tail
			? { shown: points.slice(points.length - count), left: points.slice(0, points.length - count) }
			: { shown: points.slice(0, count), left: points.slice(count) };
	/** The page showing `count` characters, its cursor counted from the part left out (`fromLeft`) or the part shown. */
	const at = (count: number, fromLeft: boolean): T => {
		const { shown, left } = parts(count);
		const output = shown.join("");
		const leftBytes = Buffer.byteLength(left.join(""));
		const log = tail
			? {
					...page.log,
					offset: fromLeft ? page.log.offset + leftBytes : page.log.nextOffset - Buffer.byteLength(output),
				}
			: {
					...page.log,
					nextOffset: fromLeft ? page.log.nextOffset - leftBytes : page.log.offset + Buffer.byteLength(output),
				};
		return { ...page, output, truncated: log.nextOffset < log.totalBytes || log.limitReached, log };
	};
	let low = 0;
	let high = points.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(at(middle, false))) low = middle;
		else high = middle - 1;
	}
	// The exact cursor's digits may take a byte more than the measured one's: step back until the exact page fits.
	for (let count = low; count >= 0; count--) {
		const { shown, left } = parts(count);
		if (!shown.includes("\uFFFD") || !left.includes("\uFFFD")) {
			const exact = at(count, shown.includes("\uFFFD"));
			if (fits(exact)) return { page: exact };
		} else {
			const ask = Buffer.byteLength(shown.join(""));
			// A read asks for at least 4 bytes; below that, fewer characters are shown instead.
			if (ask >= 4) return { ask };
		}
	}
	return null;
}
