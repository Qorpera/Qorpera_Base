import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";

/** The office account's private door to the root plumber (qorpera-computer-plumb.socket). */
export const COMPANY_COMPUTER_PLUMB_SOCKET = "/run/qorpera-computer-network/plumb.sock";

/** The node's agent exit: the gateway and name server behind the machine's agent card. */
export const COMPANY_COMPUTER_AGENT_EXIT_DNS = "10.210.0.1";

/** Name servers of a computer's own network: the agent exit's, the one address of
 * the agents' network its filters let it reach (port 53 only). */
export const COMPANY_COMPUTER_RESOLV_CONF = `nameserver ${COMPANY_COMPUTER_AGENT_EXIT_DNS}\noptions timeout:2 attempts:2\n`;

/**
 * The address of the machine's agent card (`qagent`), which qorpera-computer-plumb
 * takes from the MAC the node's plug tool gave it. The browser's relay binds its
 * lookups and connections to it, so they leave by the agent exit; without exactly
 * one such address it carries nothing.
 */
export function companyComputerAgentPlugAddress(interfaces = networkInterfaces()): string {
	const addresses = (interfaces.qagent ?? []).filter((entry) => entry.family === "IPv4");
	const address = addresses.length === 1 ? addresses[0]!.address : "";
	const match = /^10\.210\.([1-9][0-9]{0,2})\.([1-9][0-9]{0,2})$/.exec(address);
	if (!match || Number(match[1]) > 255 || Number(match[2]) > 254) throw new Error("OFFICE_BROWSER_EGRESS_UNAVAILABLE");
	return address;
}

/** `localhost` without DNS, inside a computer's namespace. */
export const COMPANY_COMPUTER_HOSTS = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n";

/**
 * Ask the root plumber to give one computer's fresh shell or desktop network
 * namespace its own filtered way out. Best effort: without an answer (an image
 * without the plumber, a refusal, a timeout) the namespace starts with only
 * loopback, never with an unfiltered network. Resolves to its address, if any.
 */
export function plumbCompanyComputerNetwork(input: {
	ordinal: number;
	role: "shell" | "desktop";
	pid: number;
	socket?: string;
	timeoutMs?: number;
}): Promise<string | undefined> {
	if (
		!Number.isSafeInteger(input.ordinal) ||
		input.ordinal < 1 ||
		input.ordinal > 32 ||
		!Number.isSafeInteger(input.pid) ||
		input.pid < 1
	)
		return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const socket = createConnection(input.socket ?? COMPANY_COMPUTER_PLUMB_SOCKET);
		let answer = "";
		const finish = (address: string | undefined): void => {
			clearTimeout(timer);
			socket.destroy();
			resolve(address);
		};
		const timer = setTimeout(() => finish(undefined), input.timeoutMs ?? 10000);
		socket.setEncoding("utf8");
		socket.on("error", () => finish(undefined));
		socket.on("data", (text: string) => {
			answer += text;
			const newline = answer.indexOf("\n");
			if (newline < 0) {
				if (answer.length > 256) finish(undefined);
				return;
			}
			const match = /^ok (10\.253\.[0-9]{1,2}\.[0-9])$/.exec(answer.slice(0, newline));
			finish(match?.[1]);
		});
		socket.on("end", () => finish(undefined));
		socket.once("connect", () => socket.write(`plumb ${input.ordinal} ${input.role} ${input.pid}\n`));
	});
}
