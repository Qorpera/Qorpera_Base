/** Browser and Node share the existing Ed25519/SPKI presence wire format.
 * The private key stays in memory and is never exported or sent to the cloud.
 */
export class PresenceSignatures {
	readonly #keys = crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]).then((keys) => {
		if (!("publicKey" in keys)) throw new Error("Presence signing key pair unavailable");
		return keys;
	});

	async publicKey(): Promise<string> {
		return base64(await crypto.subtle.exportKey("spki", (await this.#keys).publicKey));
	}

	async sign(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
		return base64(await crypto.subtle.sign("Ed25519", (await this.#keys).privateKey, bytes));
	}

	static async verify(publicKey: string, bytes: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
		try {
			if (!/^[A-Za-z0-9+/]{40,240}={0,2}$/.test(publicKey) || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
			const key = await crypto.subtle.importKey("spki", decode(publicKey), "Ed25519", false, ["verify"]);
			return await crypto.subtle.verify("Ed25519", key, decode(signature), bytes);
		} catch {
			return false;
		}
	}
}

function base64(value: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(value)));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
	const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
	if (base64(decoded.buffer) !== value) throw new Error("Invalid presence encoding");
	return decoded;
}
