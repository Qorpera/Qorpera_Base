import { boundedObjectOperation } from "./dependency.ts";

/** How long a stop waits for the audit lines before it says they were not written. A flush takes tens of milliseconds.
 * This bounds the wait, not the stop: if a call is truly hung, Node's exit waits for it and the unit's kill ends it. */
const STOP_FLUSH_MS = 3_000;

export interface GatewayStop {
	/** Stops taking requests; `done` once the last has ended. */
	close(done: () => void): void;
	forceClose?(): void;
	/** Writes the stored objects' audit lines waiting. */
	flush(): Promise<void>;
	say(line: string): void;
	exit(code: number): void;
	flushMs?: number;
}

export interface ActiveGatewayStop {
	force(): void;
}

/** A clean stop: the requests end, the audit lines go or the stop says within a bound that they did not, and then it
 * calls exit either way. */
export function stopGateway(stop: GatewayStop): ActiveGatewayStop {
	let finished = false;
	let forced = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		void boundedObjectOperation(() => stop.flush(), stop.flushMs ?? STOP_FLUSH_MS)
			.catch(() => stop.say("Object gateway audit lines were not written at stop\n"))
			.finally(() => stop.exit(0));
	};
	stop.close(finish);
	return {
		force() {
			if (finished || forced) return;
			forced = true;
			if (stop.forceClose) {
				stop.forceClose();
				return;
			}
			finish();
		},
	};
}

export interface GatewaySignalHandlerOptions {
	onFirstSignal(): void;
	stop: GatewayStop;
}

export function createGatewaySignalHandler(options: GatewaySignalHandlerOptions): () => void {
	let activeStop: ActiveGatewayStop | undefined;
	return () => {
		if (!activeStop) {
			// WHY: Run first-signal cleanup once and escalate a repeat signal so slow streams cannot wedge shutdown indefinitely.
			options.onFirstSignal();
			activeStop = stopGateway(options.stop);
			return;
		}
		activeStop.force();
	};
}
