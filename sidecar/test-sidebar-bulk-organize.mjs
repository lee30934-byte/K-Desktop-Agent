// Phase 140 - Sidebar bulk conversation organize static regression test.
//
// This test keeps the manual conversation cleanup UI from regressing silently:
// selecting multiple visible conversations, opening the shared folder picker, and
// reusing the existing single-conversation move callback for every selected item.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const sidebar = readFileSync(path.join(root, "src", "components", "Sidebar.tsx"), "utf-8");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  OK ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

console.log("Sidebar bulk organize regression test\n");

check("folderPicker accepts multiple conversation ids", /convIds: string\[\];/.test(sidebar));
check("bulk selection mode state exists", /const \[bulkSelectMode, setBulkSelectMode\]/.test(sidebar));
check("selected conversation Set state exists", /const \[selectedConvIds, setSelectedConvIds\]/.test(sidebar));
check("stale selected ids are pruned when conversations change", /const liveIds = new Set\(conversations\.map\(\(c\) => c\.id\)\)/.test(sidebar));
check("toggleBulkSelection helper exists", /const toggleBulkSelection = useCallback\(\(convId: string\)/.test(sidebar));
check("visible selection helper exists", /const setBulkSelectionFor = useCallback\(\(convIds: string\[\], selected: boolean\)/.test(sidebar));
check("bulk move helper reuses onMoveConversationToFolder", /await onMoveConversationToFolder\(convIds\[i\], folderId, i\)/.test(sidebar));
check("single context-menu move uses convIds array", /setFolderPicker\(\{ convIds: \[id\], x: contextMenu\.x, y: contextMenu\.y \}\)/.test(sidebar));
check("bulk mode disables drag for conversation cards", /disabled=\{isEditing \|\| bulkSelectMode\}/.test(sidebar));
check("bulk mode renders checkboxes", /type="checkbox"[\s\S]*?checked=\{selected\}/.test(sidebar));
check("bulk organize bar exists", /className="bulk-organize-bar"/.test(sidebar));
check("visible conversations can be selected together", /setBulkSelectionFor\(visibleConvIdsInFolder, !allVisibleSelected\)/.test(sidebar));
check("bulk move button opens folder picker with selected ids", /convIds: Array\.from\(selectedConvIds\)/.test(sidebar));
check("folder picker root path uses bulk move helper", /moveConversationsToFolder\(folderPicker\.convIds, null\)/.test(sidebar));
check("folder picker target path uses bulk move helper", /moveConversationsToFolder\(folderPicker\.convIds, f\.id\)/.test(sidebar));

console.log(`\nResult: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
