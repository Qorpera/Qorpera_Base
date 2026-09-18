import { spawn } from "node:child_process";
import {
	assertCompanyComputerImageArtifact,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";
import { readCompanyComputerPreparationProtected } from "./cloud-company-computer-preparation-control.ts";

// Fixed unit inspection shared by preparation and ordinary-service control.
export const unit = "qorpera-company-computer-preparation.service";
export const office = "qorpera-company-computer.service";
export const base = [
	"Id",
	"LoadState",
	"ActiveState",
	"SubState",
	"MainPID",
	"ControlPID",
	"Job",
	"FragmentPath",
	"DropInPaths",
	"NeedDaemonReload",
];
export const preparation = [
	...base,
	"Type",
	"RemainAfterExit",
	"InvocationID",
	"Result",
	"ExecMainCode",
	"ExecMainStatus",
];
export function properties(text: string, expected: string[]): Record<string, string> {
	if (typeof text !== "string" || Buffer.byteLength(text) > 16384 || /[\x00-\x09\x0b-\x1f\x7f]/.test(text))
		throw new Error("OFFICE_SYSTEMD_STATE_UNCONFIRMED");
	const result: Record<string, string> = {};
	for (const line of text.split("\n").filter(Boolean)) {
		const at = line.indexOf("=");
		const key = line.slice(0, at);
		if (at < 1 || !expected.includes(key) || Object.hasOwn(result, key))
			throw new Error("OFFICE_SYSTEMD_STATE_UNCONFIRMED");
		result[key] = line.slice(at + 1);
	}
	if (Object.keys(result).length !== expected.length) throw new Error("OFFICE_SYSTEMD_STATE_UNCONFIRMED");
	return result;
}
export function checkLoaded(value: Record<string, string>, name: string): void {
	if (
		value.Id !== name ||
		value.LoadState !== "loaded" ||
		value.FragmentPath !== `/etc/systemd/system/${name}` ||
		value.DropInPaths !== "" ||
		value.NeedDaemonReload !== "no"
	)
		throw new Error("OFFICE_SYSTEMD_UNIT_UNCONFIRMED");
}
export function integer(value: string, maximum = 2147483647): number {
	if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
		throw new Error("OFFICE_SYSTEMD_STATE_UNCONFIRMED");
	return Number(value);
}
export async function systemctl(args: readonly string[], maximumMs: number, caller: AbortSignal): Promise<string> {
	const signal = AbortSignal.any([caller, AbortSignal.timeout(maximumMs)]);
	signal.throwIfAborted();
	return new Promise<string>((resolve, reject) => {
		const child = spawn("/usr/bin/systemctl", ["--system", "--no-pager", "--no-ask-password", ...args], {
			cwd: "/",
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let length = 0,
			failed = false;
		const stop = () => {
			failed = true;
			child.kill("SIGKILL");
		};
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		child.stdout.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length > 16384) stop();
			else chunks.push(chunk);
		});
		child.once("error", () => {
			signal.removeEventListener("abort", stop);
			reject(new Error("OFFICE_SYSTEMD_UNAVAILABLE"));
		});
		child.once("close", (code) => {
			signal.removeEventListener("abort", stop);
			if (failed || signal.aborted || code !== 0) reject(new Error("OFFICE_SYSTEMD_UNAVAILABLE"));
			else {
				try {
					resolve(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
				} catch {
					reject(new Error("OFFICE_SYSTEMD_UNAVAILABLE"));
				}
			}
		});
	});
}

export async function assertCompanyComputerSystemdImage() {
	if ((await readCompanyComputerLinuxMetadata("/proc/1/comm", 64)).trim() !== "systemd")
		throw new Error("OFFICE_SYSTEMD_REQUIRED");
	await assertCompanyComputerImageArtifact("/usr/bin/systemctl");
	for (const name of [unit, office]) {
		const installed = await readCompanyComputerPreparationProtected(`/etc/systemd/system/${name}`, 16384);
		const packaged = await readCompanyComputerPreparationProtected(`/opt/qorpera-office/${name}`, 16384);
		if (!installed.length || !installed.equals(packaged)) throw new Error("OFFICE_SYSTEMD_UNIT_CHANGED");
	}
}
