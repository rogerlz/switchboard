const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { runSystemTar } = require("../../src/helpers/systemTar");

function makeChild({ closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  // killProcess() treats a non-null exitCode as an already-dead process
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (closeOnKill) setImmediate(() => child.emit("close", null, "SIGKILL"));
    return true;
  };
  return child;
}

test("runs PATH tar with relative arguments from the archive directory", async () => {
  const child = makeChild();
  let invocation;
  await runSystemTar("/cache/model.tar.gz", "/cache/extract", {
    timeoutMs: 100,
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      setImmediate(() => child.emit("close", 0));
      return child;
    },
  });

  assert.equal(invocation.command, "tar");
  assert.deepEqual(invocation.args, ["-xzf", "model.tar.gz", "-C", "extract"]);
  assert.equal(invocation.options.cwd, "/cache");
  assert.equal(child.killed, false);
});

test("derives tar flags from the archive extension", async () => {
  for (const [archive, flags] of [
    ["model.tar.gz", "-xzf"],
    ["binary.zip", "-xf"],
  ]) {
    const child = makeChild();
    let args;
    await runSystemTar(`/cache/${archive}`, "/cache/extract", {
      spawnImpl: (_command, spawnArgs) => {
        args = spawnArgs;
        setImmediate(() => child.emit("close", 0));
        return child;
      },
    });
    assert.equal(args[0], flags);
  }
});

test("kills and rejects a tar process that does not exit before the timeout", async () => {
  const child = makeChild();

  await assert.rejects(
    runSystemTar("/cache/model.tar.bz2", "/cache/extract", {
      timeoutMs: 10,
      spawnImpl: () => child,
    }),
    /tar extraction timed out after 10ms/
  );
  assert.equal(child.killed, true);
});

test("rejects after the kill grace period when the killed process never closes", async () => {
  const child = makeChild({ closeOnKill: false });

  await assert.rejects(
    runSystemTar("/cache/model.tar.bz2", "/cache/extract", {
      timeoutMs: 10,
      killGraceMs: 20,
      spawnImpl: () => child,
    }),
    /tar extraction timed out after 10ms/
  );
  assert.equal(child.killed, true);
});
