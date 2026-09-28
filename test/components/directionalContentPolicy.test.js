const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("dynamic prose and identity values keep their own direction", () => {
  const expectations = [
    [
      "src/components/notes/SpacesTree.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayName\}\s*<\/span>/,
    ],
    ["src/components/notes/SpacesTree.tsx", /<span\s+dir="auto"[^>]*>\s*\{title\}\s*<\/span>/],
    [
      "src/components/notes/SpacesTree.tsx",
      /<span\s+dir="auto"[^>]*\s+title=\{workspace\.name\}[\s\S]*?\{workspace\.name\}/,
    ],
    [
      "src/components/SettingsModal.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{user\.name \|\| t\("settingsPage\.account\.user"\)\}/,
    ],
    ["src/components/SettingsModal.tsx", /<bdi dir="ltr">\{user\.email\}<\/bdi>/],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{member\.name \|\| member\.email\}/,
    ],
    [
      "src/components/settings/WorkspaceMembersTab.tsx",
      /<p\s+dir="auto"[^>]*>\s*\{request\.name \?\? request\.email\}/,
    ],
    ["src/components/settings/WorkspaceMembersTab.tsx", /<bdi dir="ltr">\{inv\.email\}<\/bdi>/],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its content-direction policy`);
  }

  const treeContainerLabels = source("src/components/notes/SpacesTree.tsx").match(
    /<span\s+dir="auto"[^>]*>[\s\S]*?\{displayName\}\s*<\/span>/g
  );
  assert.equal(
    treeContainerLabels?.length,
    2,
    "space and localized folder labels must both detect their content direction"
  );
});

test("technical output values remain LTR inside an Arabic document", () => {
  const expectations = [
    ["src/components/DeveloperSection.tsx", /<code\s+dir="ltr"[\s\S]*?\{logPath\}/],
    ["src/components/ui/TechnicalErrorDetails.tsx", /<pre\s+dir="ltr"[\s\S]*?\{text\}/],
    [
      "src/components/settings/WorkspaceBillingCard.tsx",
      /<span\s+dir="ltr"[^>]*>\s*\{seatsUsed\} \/ \{seatsTotal\}/,
    ],
    ["src/components/settings/WorkspaceMembersTab.tsx", /<bdi dir="ltr">\{member\.email\}<\/bdi>/],
    ["src/components/ui/SidebarModal.tsx", /<span\s+dir="ltr"[\s\S]*?v\{version\}/],
    ["src/components/ui/ModelCardList.tsx", /<span\s+dir="ltr"[\s\S]*?\{model\.label\}/],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost its LTR technical-output isolation`);
  }
});

test("localized sentences isolate technical interpolations without changing word order", () => {
  const expectations = [
    [
      "src/components/ControlPanel.tsx",
      /<BidiInterpolatedText[\s\S]*?updateRequiredByOrg\.description[\s\S]*?value=\{policyMinAppVersion\}/,
    ],
    [
      "src/components/SettingsPage.tsx",
      /<BidiInterpolatedText[\s\S]*?updates\.whatsNew[\s\S]*?value=\{updateInfo\.version\}/,
    ],
    [
      "src/components/MemberRoster.tsx",
      /<BidiInterpolatedText[\s\S]*?members\.inviteFooter[\s\S]*?value=\{addSearch\.trim\(\)\}/,
    ],
    [
      "src/components/notes/SpaceMembersPanel.tsx",
      /<BidiInterpolatedText[\s\S]*?members\.invited[\s\S]*?value=\{invitedEmail\}/,
    ],
    [
      "src/components/IntegrationsView.tsx",
      /<BidiInterpolatedText[\s\S]*?googleCalendar\.disconnectConfirm[\s\S]*?value=\{confirmDisconnectEmail\}/,
    ],
    [
      "src/components/IntegrationsView.tsx",
      /<BidiInterpolatedText[\s\S]*?microsoftCalendar\.disconnectConfirm[\s\S]*?value=\{confirmMsDisconnectEmail\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    const text = source(file);
    assert.match(text, pattern, `${file} lost a bidi-isolated technical interpolation`);
    assert.match(text, /BIDI_VALUE_TOKEN/, `${file} must interpolate with the stable marker`);
  }
});

test("user-authored names and previews detect direction at their display boundary", () => {
  const expectations = [
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(scopeSpace\)\}/],
    ["src/components/CommandSearch.tsx", /<span\s+dir="auto"[^>]*>\s*\{spaceLabel\(space\)\}/],
    ["src/components/CommandSearch.tsx", /<p\s+dir="auto"[^>]*>\s*\{target\.label\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{speakerLabel\}/,
    ],
    ["src/components/notes/MeetingTranscriptChat.tsx", /<span\s+dir="auto"[^>]*>\s*\{text\}/],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{segment\.suggestedName\}/,
    ],
    [
      "src/components/notes/MeetingTranscriptChat.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{displayLabel\}/,
    ],
    ["src/components/notes/CreateSpaceDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{item\.name\}/],
    ["src/components/notes/CreateSpaceDialog.tsx", /<p\s+dir="auto"[^>]*>\s*\{workspace\.name\}/],
    ["src/components/notes/CreateSpaceDialog.tsx", /<span\s+dir="auto"[^>]*>\s*\{team\.name\}/],
    ["src/components/notes/SpaceGroupsSection.tsx", /<span\s+dir="auto"[^>]*>\s*\{teamRef\.name\}/],
    ["src/components/notes/SpaceGroupsSection.tsx", /<span\s+dir="auto"[^>]*>\s*\{team\.name\}/],
    [
      "src/components/settings/WorkspaceSection.tsx",
      /<h2\s+dir="auto"[^>]*>\s*\{workspace\.name\}/,
    ],
    ["src/components/settings/WorkspaceSection.tsx", /<span\s+dir="auto"[^>]*>\s*\{w\.name\}/],
    ["src/components/notes/NoteEditor.tsx", /<span\s+dir="auto"[^>]*>\s*\{space\.name\}/],
    ["src/components/notes/NoteEditor.tsx", /<span\s+dir="auto"[^>]*>\s*\{folderName\}/],
    [
      "src/components/notes/NoteEditor.tsx",
      /<span\s+dir="auto"[^>]*>\s*\{defaultFolderDisplayName\(folder, t\)\}/,
    ],
  ];

  for (const [file, pattern] of expectations) {
    assert.match(source(file), pattern, `${file} lost a dynamic-content direction boundary`);
  }
});
