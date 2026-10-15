/** Browser-safe SHA-256 of bytes (Web Crypto), as lowercase hex. */
export async function cloudFileBytesSha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
