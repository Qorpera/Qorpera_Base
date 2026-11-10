# Every login shell on a machine (an agent's commands run in one): the Playwright the image installed, and its
# browsers, are found from any folder (require("playwright")).
export NODE_PATH=/opt/node/lib/node_modules${NODE_PATH:+:$NODE_PATH}
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
