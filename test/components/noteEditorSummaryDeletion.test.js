const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Visit every element in the tree the component returned.
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node.props) return;
  visit(node);
  walk(node.props.children, visit);
}

// The segmented-control buttons by their data-segment-value.
function collectSegments(tree) {
  const out = new Map();
  walk(tree, (node) => {
    const value = node.props["data-segment-value"];
    if (value) out.set(value, node);
  });
  return out;
}

// The strip is the element the component measures through its ref; its first
// child is the sliding highlight, positioned through its inline style.
function findSegmentStrip(tree) {
  let strip = null;
  walk(tree, (node) => {
    if (strip) return;
    const children = React.Children.toArray(node.props.children);
    if (children.some((child) => child.props?.["data-segment-button"])) strip = node;
  });
  return strip;
}

function highlightStyle(tree) {
  return React.Children.toArray(findSegmentStrip(tree).props.children)[0].props.style;
}

// The harness DOM has no layout, so the tests hand the component a strip it can
// measure: tabs laid out left to right from the strip's left edge.
const TAB_BOXES = {
  transcript: { left: 2, width: 100, height: 26 },
  raw: { left: 102, width: 90, height: 26 },
  enhanced: { left: 192, width: 110, height: 26 },
};

function measurableStrip(values) {
  const buttons = values.map((value) => ({
    dataset: { segmentValue: value },
    getBoundingClientRect: () => ({ top: 0, ...TAB_BOXES[value] }),
  }));
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 310, height: 30 }),
    querySelectorAll: () => buttons,
  };
}

const NOTE = {
  id: 1,
  client_note_id: "note-1",
  cloud_id: null,
  title: "Kickoff",
  content: "plain notes body",
  enhanced_content: "AI summary body",
  transcript: "",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  space_id: null,
  folder_id: null,
};

function baseProps(enhancement) {
  return {
    note: { ...NOTE, enhanced_content: enhancement ? enhancement.content : null },
    onTitleChange() {},
    onContentChange() {},
    isSaving: false,
    isRecording: false,
    isProcessing: false,
    onStartRecording() {},
    onStopRecording() {},
    enhancement,
  };
}

async function loadNoteEditor(t) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getSpeakerProfiles: async () => [],
        getSpeakerMappings: async () => [],
      },
    },
  });
  const container = installHookDom(t);
  const resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  t.after(() => {
    delete globalThis.ResizeObserver;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-editor-summary-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        const i18n = { resolvedLanguage: "en", language: "en" };
        export function useTranslation() { return { t, i18n }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/RichTextEditor": `
        export function RichTextEditor(props) { return null; }
      `,
      "./MeetingTranscriptChat": `
        export function MeetingTranscriptChat() { return null; }
        export function SelectionBar() { return null; }
      `,
      "/EmbeddedChat": `export default function EmbeddedChat() { return null; }`,
      "/hooks/useAuth": `export function useAuth() { return { isSignedIn: false, user: null }; }`,
      "/hooks/useEmbeddedChat": `
        export function useEmbeddedChat() {
          return {
            messages: [],
            send() {},
            reset() {},
            isStreaming: false,
            containerRef: { current: null },
          };
        }
      `,
      "/services/NoteSharingService": `
        export const NoteSharingService = { fetchAcl: async () => null };
      `,
      "/hooks/useSpaceRoster": `export async function fetchSpaceRoster() { return []; }`,
    },
  });

  const mod = await vite.ssrLoadModule("/components/notes/NoteEditor.tsx");
  const NoteEditor = mod.default;

  const renders = [];
  function Harness({ enhancement }) {
    // Run the real component body + hooks under React's lifecycle without
    // mounting host elements (the harness DOM has no layout), then assert on
    // the tree it returned.
    renders.push(NoteEditor(baseProps(enhancement)));
    return null;
  }

  const root = createRoot(container);
  const render = (enhancement) =>
    React.act(async () => {
      root.render(React.createElement(Harness, { enhancement }));
    });
  const click = (value) =>
    React.act(async () => {
      collectSegments(renders.at(-1)).get(value).props.onClick();
    });
  const latest = () => renders.at(-1);
  const unmount = () => React.act(async () => root.unmount());
  return { render, click, latest, unmount, resizeCallbacks };
}

test("hides the highlight instead of freezing it when no tab matches the selection", async (t) => {
  const { render, click, latest, unmount, resizeCallbacks } = await loadNoteEditor(t);

  await render(undefined);
  const strip = findSegmentStrip(latest());
  strip.props.ref.current = measurableStrip(["transcript", "raw"]);
  await click("transcript");
  await click("raw");
  assert.equal(highlightStyle(latest()).opacity, 1);

  // The strip lost the selected tab's button: the net under the whole bug class,
  // reached through the same resize measurement the app performs.
  strip.props.ref.current = measurableStrip(["transcript"]);
  await React.act(async () => resizeCallbacks.at(-1)());
  assert.deepEqual(
    highlightStyle(latest()),
    { width: 90, height: 26, transform: "translateX(102px)", opacity: 0 },
    "the highlight fades in place rather than staying lit over nothing"
  );

  await unmount();
});
