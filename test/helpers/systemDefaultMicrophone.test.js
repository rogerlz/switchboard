const test = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../../src/helpers/systemDefaultMicrophone");

test("parses the helper's JSON default input line", () => {
  assert.deepEqual(helper.parseJsonResult('noise\n{"name":" Built-in Mic ","id":"BuiltInMic"}\n'), {
    name: "Built-in Mic",
    nativeId: "BuiltInMic",
  });
  assert.equal(helper.parseJsonResult('{"name":""}'), null);
});

function helperResolver({ now = () => 100, respond } = {}) {
  let calls = 0;
  const resolve = helper.createSystemDefaultMicrophoneResolver({
    now,
    resolveBinary: () => "/fake/macos-mic-listener",
    run: (command) => {
      calls += 1;
      if (command !== "/fake/macos-mic-listener") throw new Error("unexpected command");
      return respond ? respond() : '{"name":"Desk Microphone"}';
    },
  });
  return { resolve, calls: () => calls };
}

test("resolver keeps a successful lookup until asked to refresh", async () => {
  const { resolve, calls } = helperResolver();

  assert.equal((await resolve()).name, "Desk Microphone");
  assert.equal((await resolve()).name, "Desk Microphone");
  assert.equal(calls(), 1);

  await resolve({ refresh: true });
  assert.equal(calls(), 2);
});

test("resolver retries a failed lookup only after the back-off", async () => {
  let clock = 0;
  let calls = 0;
  const resolve = helper.createSystemDefaultMicrophoneResolver({
    now: () => clock,
    resolveBinary: () => "/fake/macos-mic-listener",
    run: async () => {
      calls += 1;
      throw new Error("no audio server");
    },
  });

  assert.equal((await resolve()).source, "unavailable");
  clock = 1000;
  await resolve();
  assert.equal(calls, 1, "no retry inside the back-off");
  clock = 31000;
  await resolve();
  assert.equal(calls, 2);
});

test("concurrent lookups share one process", async () => {
  let release;
  const { resolve, calls } = helperResolver({
    respond: () =>
      new Promise((done) => {
        release = () => done('{"name":"Desk Microphone"}');
      }),
  });

  const first = resolve();
  const second = resolve({ refresh: true });
  release();

  assert.equal((await first).name, "Desk Microphone");
  assert.equal((await second).name, "Desk Microphone");
  assert.equal(calls(), 1);
});
