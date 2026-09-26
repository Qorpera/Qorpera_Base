/** Closed JSON shapes used only by outage recovery contracts. */
export function outageRecord(value: unknown, keys: readonly string[], maximum = 262144): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== [...keys].sort().join() ||
		new TextEncoder().encode(JSON.stringify(value)).length > maximum
	)
		throw new Error("INVALID_OFFICE_OUTAGE_RECORD");
	return value as Record<string, unknown>;
}
export function outageUuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	)
		throw new Error("INVALID_OFFICE_OUTAGE_IDENTITY");
	return value;
}
export function outageSha(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("INVALID_OFFICE_OUTAGE_DIGEST");
	return value;
}
export function outageNumber(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new Error("INVALID_OFFICE_OUTAGE_NUMBER");
	return value as number;
}
export function outageEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b))
		return false;
	const left = a as Record<string, unknown>,
		right = b as Record<string, unknown>;
	return (
		Object.keys(left).sort().join() === Object.keys(right).sort().join() &&
		Object.keys(left).every((key) => outageEqual(left[key], right[key]))
	);
}
