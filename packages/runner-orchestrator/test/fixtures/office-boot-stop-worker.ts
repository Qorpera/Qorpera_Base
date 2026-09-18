import { companyComputerBootDirectory } from "@qorpera/contracts";
import { officeBootActivationWorkerFixture } from "./office-boot-activation-worker.ts";
import { createOfficeStopWorkerFixture } from "./office-stop-worker.ts";

export async function officeBootStopWorkerFixture(roots: string[]) {
	const activation = await officeBootActivationWorkerFixture(roots);
	await activation.run();
	const directory = companyComputerBootDirectory(activation.state.current!.request.attestation.bootId);
	const stop = await createOfficeStopWorkerFixture(
		{ ...activation, request: { intentId: activation.input.intentId } },
		"service_restart",
		`${directory}/credentials/config.json`,
		false,
	);
	for (const operation of [stop.stage, stop.readStage, stop.exec, stop.poll, stop.inspect]) operation.mockClear();
	return {
		...activation,
		...stop,
		activation,
		directory,
		run: (signal: AbortSignal = new AbortController().signal) =>
			stop.create().reconcile(activation.input.intentId, stop.request, signal),
	};
}
