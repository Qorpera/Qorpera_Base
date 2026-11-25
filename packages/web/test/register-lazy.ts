import { registerLazyApplicationModules } from "../src/app/application.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { registerLazyComputerModule } from "../src/app/views/computer-lazy.ts";
import { registerLazyConversationModules } from "../src/app/views/conversation.ts";
import * as lazyFounding from "../src/app/views/lazy-founding.ts";
import * as lazyOps from "../src/app/views/lazy-ops.ts";
import * as lazyQuick from "../src/app/views/lazy-quick.ts";
import * as lazySettings from "../src/app/views/lazy-settings.ts";
import { registerLazyShellModules } from "../src/app/views/shell.ts";
import * as surfaceView from "../src/app/views/surface-view.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";

registerLazyApplicationModules({
	lazyQuick,
	lazyOps,
	lazySettings,
	lazyFounding,
	surfaceView,
});

registerLazyConversationModules({
	AgentDetails: lazyOps.agentDetails.AgentDetails,
	GroupDetails: lazyQuick.groupDetails.GroupDetails,
});

registerLazyComputerModule(ComputerPanels, WebCompanyComputer);
registerLazyShellModules({
	SearchWindow: lazyQuick.searchWindow.SearchWindow,
	surfaceMigrationSheet: lazyQuick.surfaceMigrationSheet,
});
