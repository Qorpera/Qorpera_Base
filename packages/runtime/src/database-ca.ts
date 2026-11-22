import { createHash, X509Certificate } from "node:crypto";

/**
 * The CA a database connection (the secret broker, the shared vault, the agent exit's rules reader) trusts, always with
 * `sslmode=verify-full` and `rejectUnauthorized`.
 *
 * By default it is Supabase's CA (deploy/cloud-secret-broker/supabase-prod-ca-2021.crt), taken only with its pinned
 * fingerprint below. For a self-hosted database a deploy may instead supply our own CA: the CA file and its sha256 pin
 * together, as two more credentials. Then that CA alone is trusted, and only when the file's sha256 is the pin. Half an
 * input (a CA without its pin, a pin without its CA) or a pin the file does not match stops the service. There is no
 * mode without a pinned CA and none that skips verification.
 */

/** Supabase's CA, by its SHA-256 certificate fingerprint. */
export const SUPABASE_CA_FINGERPRINT =
	"80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

const SHA256 = /^[0-9a-f]{64}$/;
const ONE_PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;

export interface DatabaseCaCredentials {
	supabaseCa?: string;
	ownCa?: Uint8Array;
	ownCaSha256?: string;
}

export interface DatabaseTls {
	ca: string;
	rejectUnauthorized: true;
}

export function databaseTls(credentials: DatabaseCaCredentials, label: string): DatabaseTls {
	const invalid = new Error(`${label} database CA is invalid`);
	if (
		credentials.supabaseCa !== undefined &&
		!isPinnedCa(credentials.supabaseCa, (certificate) => certificate.fingerprint256 === SUPABASE_CA_FINGERPRINT)
	) {
		throw invalid;
	}
	const { ownCa, ownCaSha256 } = credentials;
	if (ownCa === undefined && ownCaSha256 === undefined) {
		if (credentials.supabaseCa === undefined) throw invalid;
		return { ca: credentials.supabaseCa, rejectUnauthorized: true };
	}
	if (ownCa === undefined || ownCaSha256 === undefined || !SHA256.test(ownCaSha256)) throw invalid;
	if (createHash("sha256").update(ownCa).digest("hex") !== ownCaSha256) throw invalid;
	let text: string;
	try {
		text = new TextDecoder("utf8", { fatal: true }).decode(ownCa);
	} catch {
		throw invalid;
	}
	if (!ONE_PEM_CERTIFICATE.test(text) || !isPinnedCa(text, () => true)) throw invalid;
	return { ca: text, rejectUnauthorized: true };
}

function isPinnedCa(pem: string, pinned: (certificate: X509Certificate) => boolean): boolean {
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(pem);
	} catch {
		return false;
	}
	return certificate.ca === true && pinned(certificate);
}
