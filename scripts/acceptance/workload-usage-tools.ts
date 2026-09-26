import { captureLxdOfficeHostNamespace } from "../../packages/runner-orchestrator/src/lxd-office-host-namespace.ts";

export { CodingComputerController, CODING_COMPUTER_RPCS } from "../../packages/runner-orchestrator/src/coding-computer-controller.ts";
export { parseCodingSessionClaim } from "../../packages/runner-orchestrator/src/coding-executor.ts";
export { lxdCodingMachinePlan } from "../../packages/runner-orchestrator/src/coding-machine.ts";
export { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
export { readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
export { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
export { RuntimeComputerController, RUNTIME_COMPUTER_RPCS } from "../../packages/runner-orchestrator/src/runtime-computer-controller.ts";
export { RuntimeNodeInventoryObserver } from "../../packages/runner-orchestrator/src/runtime-node-observer.ts";
export { exerciseRuntimeWorkloadUsage } from "./workload-usage-probe.ts";

if (process.argv[2] === "namespace") await captureLxdOfficeHostNamespace();
