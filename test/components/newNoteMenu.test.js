const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim (no i18next instance is initialized), so
// assertions match on the raw translation key rather than resolved copy.
test("the New note button renders its label", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-new-note-menu-test-",
  });
  const mod = await vite.ssrLoadModule("/components/notes/NewNoteMenu.tsx");
  const markup = renderToStaticMarkup(createElement(mod.default, { onNewNote: () => {} }));

  assert.match(markup, /notes\.list\.newNote/);
});
