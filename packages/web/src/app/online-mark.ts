import { CloudRpcError } from "../cloud/client.ts";

/** How often a tab in front marks the account online. Friends see "Online now" for five minutes after a mark. */
export const ONLINE_MARK_MS = 4 * 60_000;
/** A tab brought to the front marks at once, unless it marked this recently. */
const MARK_AGAIN_MS = 60_000;

export interface OnlineWatch {
	/** Marks now, unless a tab in front is not signed in (an account just signed in). */
	mark(): void;
	stop(): void;
}

/** Marks the signed-in account online (qorpera_mark_online) every four minutes while a tab is in front, when a tab
 * comes back to the front, and when asked (`mark`, once an account is signed in). A database without the function
 * (before migration 20260930690000) stops it for this page; any other failure waits for the next turn. */
export function watchOnline(markOnline: () => Promise<void>, signedIn: () => boolean): OnlineWatch {
	let stopped = false;
	let busy = false;
	let last = 0;
	const mark = (force: boolean) => {
		if (stopped || busy || !signedIn() || document.visibilityState !== "visible") return;
		if (!force && Date.now() - last < MARK_AGAIN_MS) return;
		busy = true;
		last = Date.now();
		markOnline()
			.catch((error: unknown) => {
				if (error instanceof CloudRpcError && error.missing) stop();
			})
			.finally(() => {
				busy = false;
			});
	};
	const onFront = () => mark(false);
	const timer = setInterval(() => mark(true), ONLINE_MARK_MS);
	document.addEventListener("visibilitychange", onFront);
	window.addEventListener("focus", onFront);
	function stop(): void {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		document.removeEventListener("visibilitychange", onFront);
		window.removeEventListener("focus", onFront);
	}
	return { mark: () => mark(true), stop };
}
