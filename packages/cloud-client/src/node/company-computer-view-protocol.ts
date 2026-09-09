import type { Duplex } from "node:stream";
import { companyComputerRequest } from "../cloud-company-computer-contract.ts";

export { COMPANY_COMPUTER_VIEW_SCHEMA, COMPANY_COMPUTER_VIEW_TOKEN } from "../cloud-company-computer-view-channel.ts";

export function assertPrivateCompanyComputerAddress(host: string): void {
	if (host === "::1") return;
	const octets = host.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
		octets.join(".") !== host
	) {
		throw new Error("PRIVATE_VIEWER_ADDRESS_REQUIRED");
	}
	if (
		octets[0] === 127 ||
		octets[0] === 10 ||
		(octets[0] === 192 && octets[1] === 168) ||
		(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
	)
		return;
	throw new Error("PRIVATE_VIEWER_ADDRESS_REQUIRED");
}

/** Strict bounded line framing reused by the member/gateway legs; retains coalesced initial RFB bytes. */
export function readCompanyComputerViewLine(
	socket: Duplex,
	signal: AbortSignal,
): Promise<{ value: unknown; remainder: Buffer }> {
	return companyComputerRequest(
		(requestSignal) =>
			new Promise((resolve, reject) => {
				let buffered = Buffer.alloc(0);
				const cleanup = (): void => {
					socket.off("data", data);
					socket.off("error", failed);
					socket.off("close", failed);
					socket.off("end", failed);
					requestSignal.removeEventListener("abort", failed);
				};
				const failed = (): void => {
					cleanup();
					reject(new Error("VIEW_HANDSHAKE_FAILED"));
				};
				const data = (bytes: Buffer): void => {
					buffered = Buffer.concat([buffered, bytes]);
					const newline = buffered.indexOf(10);
					if (newline > 4096 || (newline < 0 && buffered.length > 4096) || buffered.length > 256 * 1024) {
						failed();
						return;
					}
					if (newline < 0) return;
					socket.pause();
					cleanup();
					try {
						resolve({
							value: JSON.parse(buffered.subarray(0, newline).toString("utf8")) as unknown,
							remainder: Buffer.from(buffered.subarray(newline + 1)),
						});
					} catch {
						reject(new Error("VIEW_HANDSHAKE_FAILED"));
					}
				};
				socket.on("data", data);
				socket.once("error", failed);
				socket.once("close", failed);
				socket.once("end", failed);
				requestSignal.addEventListener("abort", failed, { once: true });
				if (requestSignal.aborted) failed();
				else socket.resume();
			}),
		signal,
	);
}
