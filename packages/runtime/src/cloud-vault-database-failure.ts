/**
 * The vault's database failures (3 November 2026). Both shared vaults lose their database sessions in bursts through
 * the session pooler, and the vault used to answer every caught error with the same 403, so a run host took a lost
 * session for a refusal and the run died. An error that left the vault's one database client is marked here with its
 * class: its SQLSTATE, or, for a failure without one (the pool, the connection or its socket), a system error code or
 * a named timeout. The vault answers a request whose failure is the database's own unavailability 503 `busy`, and its
 * background passes log the class. Never the error's message: it may name a login, a company or a token.
 */

/** The vault answered 503 `busy`: its database could not serve the call, so it neither issued nor refused a login. A
 * run host takes it for a lost answer. It lives here, with no imports, so the run host and the model login helper,
 * which import the host's module, take in nothing of the vault's own. */
export class CloudSecretBrokerBusyError extends Error {
	constructor() {
		super("Cloud secret broker was busy; the model login was neither issued nor refused");
		this.name = "CloudSecretBrokerBusyError";
	}
}

interface DatabaseFailure {
	failureClass: string;
	busy: boolean;
}
const failures = new WeakMap<Error, DatabaseFailure>();

/** SQLSTATEs that say the database or its pooler could not serve the call now, never that it refused it: a lost or
 * refused connection (class 08), a server shutting down or not yet up (57P01-57P03), too many connections (53300), a
 * statement timeout (57014), and the pooler's own pool and session failures, which Supavisor reports as XX000 (Postgres
 * uses it only for an internal error, never for a refusal). */
function busySqlState(code: string): boolean {
	return code.startsWith("08") || ["57P01", "57P02", "57P03", "53300", "57014", "XX000"].includes(code);
}

/** A system error code (ECONNRESET, EAI_AGAIN, ...) or undici's (UND_ERR_SOCKET, ...): fixed names, never text. */
function systemCode(error: Error): string | undefined {
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && /^(?:E[A-Z0-9_]{2,23}|UND_ERR_[A-Z_]{1,32})$/.test(code) ? code : undefined;
}

/** What an error from the database client says. A pg DatabaseError (the server's or the pooler's answer) always has a
 * SQLSTATE and a severity; any other failure there is the pool's, the connection's or its socket's, none of which is a
 * refusal. pg's own failures carry fixed messages, read here only to pick a fixed name (pg 8.23, pg-pool 3.14). */
function databaseFailure(error: Error): DatabaseFailure {
	const { code, severity } = error as { code?: unknown; severity?: unknown };
	if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string")
		return { failureClass: code, busy: busySqlState(code) };
	const named: Record<string, string> = {
		"timeout exceeded when trying to connect": "pool timeout",
		"Connection terminated due to connection timeout": "connect timeout",
		"Query read timeout": "query timeout",
	};
	const failureClass =
		(Object.hasOwn(named, error.message) ? named[error.message] : undefined) ??
		systemCode(error) ??
		(error.cause instanceof Error ? systemCode(error.cause) : undefined) ??
		(/^Connection terminated|is not queryable$/.test(error.message) ? "connection ended" : "no sqlstate");
	return { failureClass, busy: true };
}

/** Marks an error that left the vault's database client (or, as `call deadline`, the deadline of one of its calls)
 * and returns it unchanged, so its type and any `instanceof` check stay as they were. */
export function markCloudVaultDatabaseFailure(error: unknown, deadline?: "call deadline"): unknown {
	if (error instanceof Error && !failures.has(error))
		failures.set(error, deadline ? { failureClass: deadline, busy: true } : databaseFailure(error));
	return error;
}

function markedFailure(error: unknown): DatabaseFailure | undefined {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		const marked = failures.get(current);
		if (marked) return marked;
		current = current.cause;
	}
	return undefined;
}

/** Whether a failure is the database's own unavailability, which a caller may ask again for: a marked failure without
 * a SQLSTATE (the pool, the connection, a deadline), or a SQLSTATE that says the database could not serve the call now.
 * A SQLSTATE the database raised on purpose (42501, 55000, 22023, P0001, ...) is a refusal, and so is any failure that
 * did not come from the database. */
export function cloudVaultDatabaseBusy(error: unknown): boolean {
	return markedFailure(error)?.busy === true;
}

/** The class a vault logs for a failure: the database's class (a SQLSTATE, a system error code or a named timeout),
 * else a system error code anywhere in its causes, `timeout`, `aborted` or `other`. Never its message. */
export function cloudVaultFailureClass(error: unknown): string {
	const database = markedFailure(error);
	if (database) return database.failureClass;
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		const code = systemCode(current);
		if (code) return code;
		current = current.cause;
	}
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "CloudRequestTimeoutError"))
		return "timeout";
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	return "other";
}
