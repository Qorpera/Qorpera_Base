import type { CodeReleaseCalls, CodeReleases } from "../cloud/releases.ts";

/**
 * A company's reads of What's new, as the apps drawer, What's new's page and the threads' "a change is ready" cards
 * make them (own code storage, thread pieces). Two rules keep what they show true when answers come back out of order
 * (review r1 of #1848, F1):
 *
 * - Every read is numbered when it starts, whoever makes it. The company's last read (`last`, which a thread's card
 *   starts from without a read of its own, and from which the drawer's badge is counted) is replaced only by an answer
 *   to a read that started after the one it holds: an older read that answers late never puts an earlier state back.
 * - The drawer and the threads share one read while it is out (`shared`): every caller that asks meanwhile gets its
 *   answer. Never across a write, from any of them or from What's new's page (`own`): a write moves a count as it
 *   leaves and as it lands, and a read that was out before or during a write is not shared with a caller after it.
 *
 * What's new's page reads with calls of its own (`own`: each of its reads is its own call, as before), numbered the
 * same way, and writes through the same count.
 */
export interface CompanyReleaseReads {
	/** The drawer's and the threads' calls: one read out at a time, never across a write. */
	readonly shared: CodeReleaseCalls;
	/** What's new's page's calls: reads of its own, writes that end the sharing of a read that is out. */
	readonly own: CodeReleaseCalls;
	/** The answer to the latest-started read that answered; undefined before one did. */
	readonly last: CodeReleases | undefined;
}

/** `signal`: the company's lifetime, which bounds the shared read (each caller drops an answer that comes after its own
 * end). */
export function companyReleaseReads(calls: CodeReleaseCalls, signal: AbortSignal): CompanyReleaseReads {
	let writes = 0;
	let started = 0;
	/** The place of the read `last` answers. */
	let lastStarted = 0;
	let last: CodeReleases | undefined;
	let out: { readonly writes: number; readonly read: Promise<CodeReleases> } | undefined;
	const numbered = (read: Promise<CodeReleases>): Promise<CodeReleases> => {
		const place = ++started;
		return read.then((answer) => {
			if (place > lastStarted) {
				lastStarted = place;
				last = answer;
			}
			return answer;
		});
	};
	// A write moves the count on as it leaves and as it lands: no read out meanwhile is shared after it.
	const write = <T>(work: () => Promise<T>): Promise<T> => {
		writes++;
		return work().finally(() => {
			writes++;
		});
	};
	const writesOf = (): Pick<CodeReleaseCalls, "putLive" | "goBack" | "openPreview"> => ({
		putLive: (owner, name, shown, callSignal) => write(() => calls.putLive(owner, name, shown, callSignal)),
		goBack: (owner, name, shown, callSignal) => write(() => calls.goBack(owner, name, shown, callSignal)),
		openPreview: (owner, name, shown, callSignal) => write(() => calls.openPreview(owner, name, shown, callSignal)),
	});
	return {
		shared: {
			list: () => {
				if (out?.writes === writes) return out.read;
				const read = numbered(calls.list(signal));
				const flight = { writes, read };
				out = flight;
				const landed = () => {
					if (out === flight) out = undefined;
				};
				void read.then(landed, landed);
				return read;
			},
			...writesOf(),
		},
		own: {
			list: (callSignal) => numbered(calls.list(callSignal)),
			...writesOf(),
		},
		get last() {
			return last;
		},
	};
}
