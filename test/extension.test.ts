import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "pi-web-search-"));
after(() => rmSync(testDir, { recursive: true, force: true }));
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { answer, citationEvent, model } from "./fixtures.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness({ flag = false, hasUI = true, agentDir = mkdtempSync(join(testDir, "agent-")) } = {}) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
  const ctx = {
    model: { ...model }, hasUI,
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerFlag: () => {},
    getFlag: () => flag,
    registerCommand: (_name: string, options: typeof command) => { command = options; },
  } as unknown as ExtensionAPI;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    extension(api);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  return {
    ctx, statuses, notifications, agentDir,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    command: (args: string) => command.handler(args, ctx),
    request: () => handlers.get("before_provider_request")?.({ payload: { model: model.id, stream: true, input: [] } }, ctx),
    providerEvent: (data: unknown, overrides = {}) => handlers.get("provider_stream_event")?.({
      provider: model.provider, api: model.api, model: model.id, data, ...overrides,
    }, ctx),
  };
}

test("off by default; explicit command enables search only during an agent run", async () => {
  const h = harness();
  h.emit("session_start");
  h.emit("agent_start");
  assert.equal(h.request(), undefined);
  await h.command("on");
  const payload = h.request() as { tools: unknown[] };
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);
  assert.equal(h.statuses.get("openai-web-search"), "Web search: on");
  assert.ok(h.notifications.some((message) => message.includes("conversation details")));
  h.emit("agent_end");
  assert.equal(h.request(), undefined, "idle cache warming is not modified");
});

test("CLI flag enables search without UI or stdout logging", () => {
  const h = harness({ flag: true, hasUI: false });
  h.emit("session_start");
  h.emit("agent_start");
  assert.ok(h.request());
  assert.equal(h.statuses.size, 0);
  assert.equal(h.notifications.length, 0);
  h.providerEvent(citationEvent());
  const result = h.emit("message_end", { message: answer() }) as { message: AssistantMessage };
  assert.ok(result.message.content.some((block) => block.type === "text" && block.text.includes("### Web sources")));
});

test("on and off survive restart, reload, new, resume, and fork", async () => {
  let h = harness();
  for (const enabled of [true, false]) {
    await h.command(enabled ? "on" : "off");
    assert.deepEqual(JSON.parse(readFileSync(join(h.agentDir, "openai-web-search.json"), "utf8")), { enabled });
    h.emit("session_shutdown");
    h = harness({ agentDir: h.agentDir });
    for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
      h.emit("session_start", { reason });
      h.emit("agent_start");
      assert.equal(Boolean(h.request()), enabled);
    }
  }
});

test("CLI opt-in does not overwrite the saved preference", async () => {
  const h = harness({ flag: true });
  await h.command("off");
  h.emit("session_start");
  h.emit("agent_start");
  assert.ok(h.request());
  const restarted = harness({ agentDir: h.agentDir });
  restarted.emit("session_start");
  restarted.emit("agent_start");
  assert.equal(restarted.request(), undefined);
});

test("invalid saved preferences default to off with a warning", () => {
  const h = harness();
  for (const value of ["invalid JSON", "null", '{"enabled":"true"}']) {
    writeFileSync(join(h.agentDir, "openai-web-search.json"), value);
    h.emit("session_start");
    h.emit("agent_start");
    assert.equal(h.request(), undefined);
    assert.match(h.notifications.at(-1)!, /Could not read/);
  }
});

test("save failures warn without preventing the current toggle", async () => {
  const h = harness();
  rmSync(h.agentDir, { recursive: true });
  writeFileSync(h.agentDir, "not a directory");
  await h.command("on");
  h.emit("agent_start");
  assert.ok(h.request());
  assert.ok(h.notifications.some((message) => message.includes("could not be saved")));
});

test("status and invalid commands never enable search", async () => {
  const h = harness();
  h.emit("session_start");
  h.emit("agent_start");
  await h.command("");
  await h.command("status");
  await h.command("invalid");
  assert.equal(h.request(), undefined);
  assert.ok(h.notifications.includes("Usage: /web-search on|off|status"));
});

test("an incompatible connection cannot be enabled; model switching pauses an enabled extension", async () => {
  const h = harness();
  h.ctx.model = { ...model, baseUrl: "https://proxy.example.com/v1" };
  await h.command("on");
  h.emit("agent_start");
  assert.equal(h.request(), undefined);
  h.ctx.model = { ...model };
  await h.command("on");
  h.ctx.model = { ...model, provider: "openai-codex" };
  h.emit("model_select");
  assert.match(h.statuses.get("openai-web-search")!, /paused/);
  assert.equal(h.request(), undefined);
  h.ctx.model = { ...model };
  h.emit("model_select");
  assert.ok(h.request());
});

test("search progress and citations ignore foreign provider/model events", async () => {
  const h = harness({ flag: true });
  h.emit("session_start");
  h.emit("agent_start");
  h.request();
  h.providerEvent(citationEvent(), { model: "other-model" });
  h.providerEvent(citationEvent(), { provider: "other-provider" });
  h.providerEvent({ type: "response.web_search_call.searching", item_id: "ws_test" });
  assert.equal(h.statuses.get("openai-web-search"), "Web search: searching…");
  h.providerEvent({ type: "response.web_search_call.completed", item_id: "ws_test" });
  assert.equal(h.statuses.get("openai-web-search"), "Web search: on");
  assert.equal(h.emit("message_end", { message: answer() }), undefined);
});

test("disabling mid-request does not discard citations from an already running search", async () => {
  const h = harness({ flag: true });
  h.emit("session_start");
  h.emit("agent_start");
  h.request();
  await h.command("off");
  h.providerEvent(citationEvent());
  const result = h.emit("message_end", { message: answer() }) as { message: AssistantMessage };
  assert.ok(result.message.content.some((block) => block.type === "text" && block.text.includes("### Web sources")));
  assert.equal(h.request(), undefined);
  assert.equal(h.statuses.get("openai-web-search"), undefined);
});

test("citations do not leak into a subsequent turn or across cancellation", () => {
  const h = harness({ flag: true });
  h.emit("session_start");
  h.emit("agent_start");
  h.request();
  h.providerEvent(citationEvent());
  h.emit("agent_end");
  h.emit("agent_start");
  h.emit("turn_start");
  h.request();
  assert.equal(h.emit("message_end", { message: answer() }), undefined);
  h.emit("session_shutdown");
  assert.equal(h.statuses.get("openai-web-search"), undefined);
  assert.equal(h.request(), undefined);
});

test("a retry replaces the previous request's citation capture", () => {
  const h = harness({ flag: true });
  h.emit("session_start");
  h.emit("agent_start");
  h.request();
  h.providerEvent(citationEvent());
  h.request();
  assert.equal(h.emit("message_end", { message: answer() }), undefined);
});
