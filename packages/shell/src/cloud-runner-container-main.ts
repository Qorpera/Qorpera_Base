import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCloudRunnerContainerJob } from "./cloud-runner-container.ts";

const MAX_REQUEST_BYTES = 128 * 1024;

export async function readCloudRunnerContainerRequest(input: AsyncIterable<Uint8Array>): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of input) {
		bytes += chunk.byteLength;
		if (!Number.isSafeInteger(bytes) || bytes > MAX_REQUEST_BYTES) {
			throw new Error("Container request exceeds its byte limit");
		}
		chunks.push(Buffer.from(chunk));
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
	} catch (error) {
		throw new Error("Container request contains invalid JSON", { cause: error });
	}
	return value;
}

export async function runCloudRunnerContainerMain(): Promise<void> {
	const request = await readCloudRunnerContainerRequest(process.stdin);
	const result = await runCloudRunnerContainerJob(request);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

const executablePath = process.argv[1];
if (executablePath && realpathSync(resolve(executablePath)) === realpathSync(fileURLToPath(import.meta.url))) {
	runCloudRunnerContainerMain().catch((error: unknown) => {
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
		process.stderr.write(`${message || "Container execution failed"}\n`);
		process.exitCode = 1;
	});
}
