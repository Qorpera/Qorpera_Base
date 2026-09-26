import { runPaidComputerGuardMain } from "../../packages/runner-orchestrator/src/computer-paid-guard-service.ts";

// Keep the production implementation and sandbox; only its existing explicit
// LXD socket parameter is pointed through a byte-transparent fault injector.
await runPaidComputerGuardMain("coding", "/run/qorpera-paid-lxd-proxy/control.sock");
