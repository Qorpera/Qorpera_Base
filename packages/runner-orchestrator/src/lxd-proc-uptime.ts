/** Exact Linux /proc/uptime format. Empty zero-stat proc responses, alternate
 * numeric syntaxes and millisecond overflow must never become lease clocks. */
export function parseLxdProcUptime(value: Buffer): number {
	if (!Buffer.isBuffer(value) || value.length > 128) throw new Error("CODING_GUEST_CLOCK_UNAVAILABLE");
	const match = /^(0|[1-9][0-9]{0,12})\.([0-9]{2}) (0|[1-9][0-9]{0,16})\.[0-9]{2}\n$/.exec(value.toString("utf8"));
	if (!match) throw new Error("CODING_GUEST_CLOCK_UNAVAILABLE");
	const milliseconds = BigInt(match[1]) * 1000n + BigInt(match[2]) * 10n;
	if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER - 60000)) throw new Error("CODING_GUEST_CLOCK_UNAVAILABLE");
	return Number(milliseconds);
}
