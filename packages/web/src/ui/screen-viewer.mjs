// The desktop's screen renderer and its licensed noVNC, copied unchanged
// (member-web/ui/SOURCE.json); importing it defines window.qorperaScreenViewer.
// Only computer-viewer.ts imports this file, on demand, so esbuild makes it a
// chunk of its own that the first screen never downloads.
import "../../../member-web/ui/screen-viewer.js";
