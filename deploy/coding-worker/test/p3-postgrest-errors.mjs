// How PostgREST answers a call that failed, for P3's stand-in of it (p3-driver.mjs `restAnswer`), which serves the
// node's folder service and the executor's control: the status from PostgREST's error table (docs.postgrest.org,
// References → Errors), and its error body. Production's callers act on both: the control calls 55P03 busy only in a
// 500, and keeps a folder view's refusal only in a 400 or 403 (deploy/coding-worker/control.ts); the folder core takes
// a 5xx it cannot place as its dependency down (packages/object-gateway/src/folder-service/core.ts, dependency.ts).

/** SQLSTATEs (and PostgREST's own codes) whose status is not their class's. */
const CODES = new Map([
	["23503", 409], ["23505", 409], ["25006", 405], ["42501", 403], ["42883", 404], ["42P01", 404], ["42P17", 500],
	["53400", 500], ["P0001", 400],
	// PostgREST's own code for a function it cannot find, which the stand-in's database raises (p3-database.mjs).
	["PGRST202", 404],
]);
/** SQLSTATE classes (a code's first two characters); any other code is 400. */
const CLASSES = new Map([
	["08", 503], ["09", 500], ["0L", 403], ["0P", 403], ["25", 500], ["28", 403], ["2D", 500], ["38", 500], ["39", 500],
	["3B", 500], ["40", 500], ["53", 503], ["54", 500], ["55", 500], ["57", 500], ["58", 500], ["F0", 500], ["HV", 500],
	["P0", 500], ["XX", 500],
]);

/** PostgREST's HTTP status for an error with this SQLSTATE. A call always has a role here, so 42501 is 403, not 401;
 * `PTxyz` is status xyz. An error without a code is the stand-in's own failure: 500. */
export function postgrestStatus(code) {
	if (typeof code !== "string" || code === "") return 500;
	const custom = /^PT([2-5][0-9]{2})$/.exec(code);
	if (custom) return Number(custom[1]);
	return CODES.get(code) ?? CLASSES.get(code.slice(0, 2)) ?? 400;
}

/** PostgREST's answer to a call that raised `error` (its `sqlState`, `message` and `detail`): the status, and the body
 * with exactly `code`, `message`, `details` and `hint`. */
export function postgrestError(error) {
	const code = error?.sqlState ?? null;
	return {
		status: postgrestStatus(code),
		body: JSON.stringify({ code, message: String(error?.message), details: error?.detail ?? null, hint: null }),
	};
}
