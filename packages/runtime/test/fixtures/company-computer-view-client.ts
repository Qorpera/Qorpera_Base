import { connect, type Socket } from "node:net";
import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	assertPrivateCompanyComputerAddress,
	COMPANY_COMPUTER_VIEW_SCHEMA,
	COMPANY_COMPUTER_VIEW_TOKEN,
	readCompanyComputerViewLine,
} from "@qorpera/cloud-client/node/company-computer-view-protocol";

interface ConnectedScreenView {
	socket: Socket;
	binding: CompanyComputerScreenBinding;
	mode: "watch" | "shared" | "control";
	remainder: Buffer;
}

export async function connectCompanyComputerScreenView(input: {
	host: string;
	port: number;
	capability: string;
	binding: CompanyComputerScreenBinding;
	mode: "watch" | "shared" | "control";
	signal: AbortSignal;
}): Promise<ConnectedScreenView> {
	assertPrivateCompanyComputerAddress(input.host);
	assertCompanyComputerScreenBinding(input.binding, input.binding);
	if (
		!Number.isSafeInteger(input.port) ||
		input.port < 1 ||
		input.port > 65_535 ||
		!COMPANY_COMPUTER_VIEW_TOKEN.test(input.capability) ||
		!["watch", "shared", "control"].includes(input.mode)
	) {
		throw new Error("INVALID_VIEW_REQUEST");
	}
	input.signal.throwIfAborted();
	const socket = connect({ host: input.host, port: input.port });
	const abort = (): void => {
		socket.destroy();
	};
	input.signal.addEventListener("abort", abort, { once: true });
	socket.once("close", () => input.signal.removeEventListener("abort", abort));
	socket.on("error", abort);
	try {
		await companyComputerRequest(
			(signal) =>
				new Promise<void>((resolve, reject) => {
					const cleanup = (): void => {
						socket.off("connect", ready);
						socket.off("close", failed);
						signal.removeEventListener("abort", failed);
					};
					const ready = (): void => {
						cleanup();
						resolve();
					};
					const failed = (): void => {
						cleanup();
						reject(new Error("VIEW_UNAVAILABLE"));
					};
					socket.once("connect", ready);
					socket.once("close", failed);
					signal.addEventListener("abort", failed, { once: true });
					if (signal.aborted || socket.destroyed) failed();
				}),
			input.signal,
		);
		const reply = readCompanyComputerViewLine(socket, input.signal);
		socket.write(`${JSON.stringify({ schema: COMPANY_COMPUTER_VIEW_SCHEMA, capability: input.capability })}\n`);
		const { value, remainder } = await reply;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("VIEW_UNAVAILABLE");
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).sort().join() !== "binding,mode,ok" ||
			record.ok !== true ||
			record.mode !== input.mode ||
			!record.binding ||
			typeof record.binding !== "object"
		)
			throw new Error("VIEW_UNAVAILABLE");
		assertCompanyComputerScreenBinding(record.binding as CompanyComputerScreenBinding, input.binding);
		input.signal.throwIfAborted();
		return { socket, binding: structuredClone(input.binding), mode: input.mode, remainder };
	} catch {
		socket.destroy();
		throw new Error("VIEW_UNAVAILABLE");
	}
}
