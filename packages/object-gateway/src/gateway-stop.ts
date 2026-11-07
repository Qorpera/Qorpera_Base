import { boundedObjectOperation } from "./dependency.ts";

/** How long a stop waits for the audit lines. A flush takes tens of milliseconds; a hung NAS must not hold a node's
 * reboot until the unit's kill. */
const STOP_FLUSH_MS = 3_000;

export interface GatewayStop {
	/** Stops taking requests; `done` once the last has ended. */
	close(done: () => void): void;
	/** Writes the stored objects' audit lines waiting. */
	flush(): Promise<void>;
	say(line: string): void;
	exit(code: number): void;
	flushMs?: number;
}

/** A clean stop: the requests end, the audit lines go within a bound, and the process exits either way. */
export function stopGateway(stop: GatewayStop): void {
	stop.close(() => {
		void boundedObjectOperation(() => stop.flush(), stop.flushMs ?? STOP_FLUSH_MS)
			.catch(() => stop.say("Object gateway audit lines were not written at stop\n"))
			.finally(() => stop.exit(0));
	});
}
