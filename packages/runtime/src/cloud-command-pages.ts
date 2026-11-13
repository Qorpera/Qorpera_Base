import { CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES, CLOUD_CODING_COMMAND_PAGE_BYTES } from "@qorpera/contracts";

/** The header a command executor's service answers every call with (keyholes S1, 12 Nov 2026): the most output, in
 * bytes, one page of a command's log may ask it for. An executor from before says nothing, and refuses a read whose
 * `limit` is past CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES. */
export const CLOUD_COMMAND_PAGE_HEADER = "x-qorpera-command-page-bytes";

/** What each command executor, by origin, said in its last answer that it takes for a page. One that has said nothing
 * yet, or whose last answer did not say (an executor from before, or a proxy answering for it), takes the legacy 16,384:
 * a read never asks an executor for more than it said. One per process, shared by its gateways, so each call learns from
 * the answer before it; executors' own calls to their peers keep one too. */
export class CloudCommandPages {
	readonly #said = new Map<string, number>();
	/** The most a read sent to `origin` may ask for. */
	of(origin: string): number {
		return this.#said.get(origin) ?? CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES;
	}
	/** An answer came from `origin`, with these headers. */
	heard(origin: string, headers: Headers): void {
		const said = headers.get(CLOUD_COMMAND_PAGE_HEADER);
		this.#said.set(
			origin,
			said !== null && /^[1-9][0-9]{0,8}$/.test(said) && Number(said) >= 4
				? Math.min(Number(said), CLOUD_CODING_COMMAND_PAGE_BYTES)
				: CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES,
		);
	}
}
