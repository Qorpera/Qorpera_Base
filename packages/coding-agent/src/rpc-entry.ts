#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { installModelBrokerFetch } from "./core/model-broker-client.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
// Electron has already consumed this bootstrap flag. Do not leak it into
// host commands: it can make Electron-based applications start as Node.
delete process.env.ELECTRON_RUN_AS_NODE;
process.env.QORPERA_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();
installModelBrokerFetch();

main(["--mode", "rpc", ...process.argv.slice(2)]);
