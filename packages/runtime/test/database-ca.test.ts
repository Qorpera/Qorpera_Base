import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Server } from "node:tls";
import { type DatabaseCaCredentials, databaseTls, SUPABASE_CA_FINGERPRINT } from "@qorpera/runtime/database-ca";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* The database's CA (database-ca.ts), which the secret broker, the shared vault and the agent exit's rules reader take
 * from their systemd credentials: Supabase's pinned CA by default; our own CA only with its sha256 pin, the two given
 * together; never a CA without a pin, and verify-full either way. The certificates here are throwaway ones made for
 * this test (openssl CLI). */

const SUPABASE_CA = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
	"utf8",
).trim();

let dir = "";
function openssl(args: string[]) {
	execFileSync("openssl", args, { stdio: "ignore" });
}
/** A throwaway P-256 key and a self-signed certificate, a CA or not. */
function selfSigned(tag: string, ca: boolean) {
	const key = join(dir, `${tag}.key`);
	const cert = join(dir, `${tag}.crt`);
	openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
	openssl([
		"req",
		"-new",
		"-x509",
		"-key",
		key,
		"-out",
		cert,
		"-days",
		"2",
		"-subj",
		`/CN=qorpera-test-${tag}`,
		"-addext",
		`basicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}`,
	]);
	return { key, cert, bytes: readFileSync(cert) };
}
/** A throwaway server certificate for `name`, signed by `issuer`. */
function serverCertificate(tag: string, issuer: { key: string; cert: string }, name: string) {
	const key = join(dir, `${tag}.key`);
	openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
	openssl(["req", "-new", "-key", key, "-out", join(dir, `${tag}.csr`), "-subj", `/CN=${name}`]);
	writeFileSync(join(dir, `${tag}.ext`), `subjectAltName=DNS:${name}\nbasicConstraints=critical,CA:FALSE\n`);
	openssl([
		"x509",
		"-req",
		"-in",
		join(dir, `${tag}.csr`),
		"-CA",
		issuer.cert,
		"-CAkey",
		issuer.key,
		"-set_serial",
		"1",
		"-days",
		"2",
		"-extfile",
		join(dir, `${tag}.ext`),
		"-out",
		join(dir, `${tag}.crt`),
	]);
	return { key: readFileSync(key), cert: readFileSync(join(dir, `${tag}.crt`)) };
}

let ownCa: ReturnType<typeof selfSigned>;
let otherCa: ReturnType<typeof selfSigned>;
let notCa: ReturnType<typeof selfSigned>;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "qorpera-database-ca-"));
	ownCa = selfSigned("own", true);
	otherCa = selfSigned("other", true);
	notCa = selfSigned("leaf", false);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const refused = (credentials: DatabaseCaCredentials) => () => databaseTls(credentials, "Test service");

describe("databaseTls", () => {
	it("by default trusts Supabase's CA, with its pinned fingerprint, as before", () => {
		expect(databaseTls({ supabaseCa: SUPABASE_CA }, "Test service")).toEqual({
			ca: SUPABASE_CA,
			rejectUnauthorized: true,
		});
		expect(SUPABASE_CA_FINGERPRINT).toBe(
			"80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
		);
		// Any other CA in Supabase's place is refused, in either mode, as before.
		expect(refused({ supabaseCa: ownCa.bytes.toString("utf8") })).toThrow("Test service database CA is invalid");
		expect(refused({ supabaseCa: "not a certificate" })).toThrow("Test service database CA is invalid");
		expect(
			refused({
				supabaseCa: ownCa.bytes.toString("utf8"),
				ownCa: ownCa.bytes,
				ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex"),
			}),
		).toThrow("Test service database CA is invalid");
	});

	it("trusts our own CA alone, only with its input: the CA file and its sha256 pin together", () => {
		expect(
			databaseTls(
				{
					supabaseCa: SUPABASE_CA,
					ownCa: ownCa.bytes,
					ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex"),
				},
				"Test service",
			),
		).toEqual({ ca: ownCa.bytes.toString("utf8"), rejectUnauthorized: true });
	});

	it("refuses half an input and a pin the file does not match", () => {
		// The CA file without its pin, the pin without its file.
		expect(refused({ supabaseCa: SUPABASE_CA, ownCa: ownCa.bytes })).toThrow("Test service database CA is invalid");
		expect(
			refused({ supabaseCa: SUPABASE_CA, ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex") }),
		).toThrow("Test service database CA is invalid");
		// A pin of another file, of the file with a byte changed, or not a sha256 at all.
		expect(
			refused({
				supabaseCa: SUPABASE_CA,
				ownCa: ownCa.bytes,
				ownCaSha256: createHash("sha256").update(otherCa.bytes).digest("hex"),
			}),
		).toThrow("Test service database CA is invalid");
		expect(
			refused({
				supabaseCa: SUPABASE_CA,
				ownCa: Buffer.concat([ownCa.bytes, Buffer.from("\n")]),
				ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex"),
			}),
		).toThrow("Test service database CA is invalid");
		for (const pin of [
			"",
			createHash("sha256").update(ownCa.bytes).digest("hex").toUpperCase(),
			createHash("sha256").update(ownCa.bytes).digest("hex").slice(1),
			"x".repeat(64),
		]) {
			expect(refused({ supabaseCa: SUPABASE_CA, ownCa: ownCa.bytes, ownCaSha256: pin })).toThrow(
				"Test service database CA is invalid",
			);
		}
	});

	it("refuses an own CA file that is not exactly one CA certificate, even with a matching pin", () => {
		const two = Buffer.concat([ownCa.bytes, otherCa.bytes]);
		const notPem = Buffer.from("not a certificate\n");
		for (const bytes of [two, notCa.bytes, notPem, Buffer.alloc(0)]) {
			expect(
				refused({
					supabaseCa: SUPABASE_CA,
					ownCa: bytes,
					ownCaSha256: createHash("sha256").update(bytes).digest("hex"),
				}),
			).toThrow("Test service database CA is invalid");
		}
	});
});

describe("verify-full with our own CA", () => {
	let server: Server;
	let port = 0;
	let wrongName: Server;
	let wrongNamePort = 0;
	const listen = async (certificate: { key: Buffer; cert: Buffer }) => {
		const listening = createServer({ key: certificate.key, cert: certificate.cert }, (socket) => socket.end());
		await new Promise<void>((resolveListen) => listening.listen(0, "127.0.0.1", resolveListen));
		return listening;
	};
	beforeAll(async () => {
		server = await listen(serverCertificate("database", ownCa, "database.qorpera.test"));
		port = (server.address() as AddressInfo).port;
		wrongName = await listen(serverCertificate("elsewhere", ownCa, "elsewhere.qorpera.test"));
		wrongNamePort = (wrongName.address() as AddressInfo).port;
	});
	afterAll(async () => {
		await new Promise((resolveClose) => server.close(resolveClose));
		await new Promise((resolveClose) => wrongName.close(resolveClose));
	});
	/** A TLS handshake as pg makes it for a host name: the given options, the name checked against the certificate. */
	const handshake = (options: { ca: string; rejectUnauthorized: true }, to: number) =>
		new Promise<string>((resolveHandshake) => {
			const socket = connect({ ...options, host: "127.0.0.1", port: to, servername: "database.qorpera.test" });
			socket.once("secureConnect", () => {
				socket.destroy();
				resolveHandshake("verified");
			});
			socket.once("error", (error: NodeJS.ErrnoException) => {
				socket.destroy();
				resolveHandshake(error.code ?? "error");
			});
		});

	it("verifies the server's certificate and name against our own CA, and only with its input", async () => {
		const own = databaseTls(
			{
				supabaseCa: SUPABASE_CA,
				ownCa: ownCa.bytes,
				ownCaSha256: createHash("sha256").update(ownCa.bytes).digest("hex"),
			},
			"Test service",
		);
		expect(await handshake(own, port)).toBe("verified");
		// Without the input the service keeps Supabase's CA, which does not vouch for this server.
		expect(await handshake(databaseTls({ supabaseCa: SUPABASE_CA }, "Test service"), port)).not.toBe("verified");
		// A certificate from our CA for another name fails the name check (verify-full).
		expect(await handshake(own, wrongNamePort)).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
		// Another CA, even pinned, does not vouch for this server either.
		const other = databaseTls(
			{
				supabaseCa: SUPABASE_CA,
				ownCa: otherCa.bytes,
				ownCaSha256: createHash("sha256").update(otherCa.bytes).digest("hex"),
			},
			"Test service",
		);
		expect(await handshake(other, port)).not.toBe("verified");
	});
});
