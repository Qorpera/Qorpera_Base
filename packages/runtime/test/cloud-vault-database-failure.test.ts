import { randomBytes, randomUUID } from "node:crypto";
import { CloudRequestTimeoutError } from "@qorpera/cloud-client/cloud-request";
import { PostgresCloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import {
	cloudVaultDatabaseBusy,
	cloudVaultFailureClass,
	markCloudVaultDatabaseFailure,
} from "@qorpera/runtime/cloud-vault-database-failure";
import { DatabaseError } from "pg";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.useRealTimers();
});

const SECRET = "PRIVATE_TOKEN_6f0c";
const sqlError = (code: string) =>
	Object.assign(new DatabaseError(`server said ${SECRET}`, 0, "error"), { code, severity: "FATAL" });

it("takes only a failure the database client marked for its own, and finds it under a wrapper", () => {
	const lost = markCloudVaultDatabaseFailure(sqlError("57P01"));
	expect(cloudVaultDatabaseBusy(lost)).toBe(true);
	expect(cloudVaultDatabaseBusy(new Error("wrapped", { cause: new Error("again", { cause: lost }) }))).toBe(true);
	// The same shapes that never passed the database client are not the database's.
	expect(cloudVaultDatabaseBusy(sqlError("57P01"))).toBe(false);
	expect(cloudVaultDatabaseBusy(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
	expect(cloudVaultDatabaseBusy(new CloudRequestTimeoutError())).toBe(false);
	expect(cloudVaultDatabaseBusy(undefined)).toBe(false);
	expect(markCloudVaultDatabaseFailure("not an error")).toBe("not an error");
	expect(cloudVaultDatabaseBusy("not an error")).toBe(false);
	// A refusal stays one, and a second mark changes nothing.
	const refused = markCloudVaultDatabaseFailure(sqlError("42501"));
	markCloudVaultDatabaseFailure(refused, "call deadline");
	expect(cloudVaultDatabaseBusy(refused)).toBe(false);
	expect(cloudVaultFailureClass(refused)).toBe("42501");
	// A five-letter system code is not a SQLSTATE: without a severity it is the socket's.
	const pipe = markCloudVaultDatabaseFailure(Object.assign(new Error(`write ${SECRET}`), { code: "EPIPE" }));
	expect(cloudVaultDatabaseBusy(pipe)).toBe(true);
	expect(cloudVaultFailureClass(pipe)).toBe("EPIPE");
	// The socket's code under pg's own wrapper.
	const timedOut = markCloudVaultDatabaseFailure(
		new Error("Connection terminated due to connection timeout", {
			cause: Object.assign(new Error("x"), { code: "ETIMEDOUT" }),
		}),
	);
	expect(cloudVaultFailureClass(timedOut)).toBe("connect timeout");
	expect(cloudVaultFailureClass(markCloudVaultDatabaseFailure(new Error("Query read timeout")))).toBe("query timeout");
	expect(
		cloudVaultFailureClass(markCloudVaultDatabaseFailure(new Error("Client was closed and is not queryable"))),
	).toBe("connection ended");
	expect(cloudVaultFailureClass(markCloudVaultDatabaseFailure(new Error("Connection terminated")))).toBe(
		"connection ended",
	);
	expect(
		cloudVaultFailureClass(markCloudVaultDatabaseFailure(new Error("x", { cause: new Error(`c ${SECRET}`) }))),
	).toBe("no sqlstate");
});

it("logs a class for any failure, never its text", () => {
	expect(
		cloudVaultFailureClass(
			new TypeError("fetch failed", { cause: Object.assign(new Error(SECRET), { code: "UND_ERR_SOCKET" }) }),
		),
	).toBe("UND_ERR_SOCKET");
	expect(cloudVaultFailureClass(new CloudRequestTimeoutError())).toBe("timeout");
	expect(cloudVaultFailureClass(new DOMException("late", "TimeoutError"))).toBe("timeout");
	expect(cloudVaultFailureClass(new DOMException("stopped", "AbortError"))).toBe("aborted");
	// A code that is not a fixed system name, and text shaped like one, are `other`.
	expect(cloudVaultFailureClass(Object.assign(new Error(SECRET), { code: SECRET }))).toBe("other");
	expect(cloudVaultFailureClass(Object.assign(new Error("x"), { code: "Econnreset private" }))).toBe("other");
	expect(cloudVaultFailureClass(new Error("ECONNRESET"))).toBe("other");
	expect(cloudVaultFailureClass(SECRET)).toBe("other");
});

it("marks a broker database call that passed its own 5 s, never one its caller stopped", async () => {
	vi.useFakeTimers();
	const authority = new PostgresCloudSecretBrokerAuthority({
		database: { query: () => new Promise(() => undefined) },
		brokerAuthorityId: randomUUID(),
		brokerCapability: randomBytes(32).toString("base64url"),
	});
	const binding = {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
	};
	const late = authority.issueModelLogin(binding, null, false, new AbortController().signal).catch((error) => error);
	await vi.advanceTimersByTimeAsync(5000);
	const deadline = await late;
	expect(deadline).toBeInstanceOf(CloudRequestTimeoutError);
	expect(cloudVaultDatabaseBusy(deadline)).toBe(true);
	expect(cloudVaultFailureClass(deadline)).toBe("call deadline");
	const caller = new AbortController();
	const stopped = authority.issueModelLogin(binding, null, false, caller.signal).catch((error) => error);
	caller.abort(new CloudRequestTimeoutError());
	const stop = await stopped;
	expect(stop).toBeInstanceOf(CloudRequestTimeoutError);
	expect(cloudVaultDatabaseBusy(stop)).toBe(false);
	// The client's own failures pass through as they were thrown.
	const refusal = markCloudVaultDatabaseFailure(sqlError("42501"));
	const refusing = new PostgresCloudSecretBrokerAuthority({
		database: { query: async () => Promise.reject(refusal) },
		brokerAuthorityId: randomUUID(),
		brokerCapability: randomBytes(32).toString("base64url"),
	});
	await expect(refusing.issueModelLogin(binding, null, false, new AbortController().signal)).rejects.toBe(refusal);
});
