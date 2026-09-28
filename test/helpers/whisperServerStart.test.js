const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const { shouldRetryAfterServerReplaced } = WhisperServerManager;

function createManager() {
  const manager = new WhisperServerManager();
  const doStartCalls = [];
  manager._doStart = async (modelPath, options) => {
    doStartCalls.push({ modelPath, options });
    manager.modelPath = modelPath;
    manager.process = {};
    manager.ready = true;
  };
  manager.stop = async () => {
    manager.process = null;
    manager.ready = false;
    manager.modelPath = null;
  };
  return { manager, doStartCalls };
}

test("an identical repeat start() no-ops", async () => {
  const { manager, doStartCalls } = createManager();

  await manager.start("/tmp/model.bin", {});
  await manager.start("/tmp/model.bin", {});
  assert.equal(doStartCalls.length, 1);
});

test("a model change restarts the server", async () => {
  const { manager, doStartCalls } = createManager();

  await manager.start("/tmp/a.bin", {});
  await manager.start("/tmp/b.bin", {});
  assert.equal(doStartCalls.length, 2);
});

const replacedBase = {
  isConnectionError: true,
  stopRequested: false,
  ready: true,
  sameModel: true,
};

test("retries against the server a concurrent caller already restarted", () => {
  assert.equal(shouldRetryAfterServerReplaced(replacedBase), true);
});

test("skips the replaced-server retry unless it is safe", () => {
  for (const override of [
    { isConnectionError: false },
    { stopRequested: true },
    { ready: false },
    { sameModel: false },
  ]) {
    assert.equal(shouldRetryAfterServerReplaced({ ...replacedBase, ...override }), false);
  }
});
