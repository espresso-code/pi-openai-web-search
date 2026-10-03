import assert from "node:assert/strict";
import { test } from "node:test";
import { appendSources, canUseWebSearch, prepareSearchRequest, SearchCapture } from "../src/search.ts";
import { answer, citation, citationEvent, messageItem, model } from "./fixtures.ts";

function payload() {
  return {
    model: model.id, stream: true, input: [], store: false,
    tools: [{ type: "function", name: "read", parameters: {} }],
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "low" },
    tool_choice: "auto",
  };
}

test("connection guard accepts only the direct OpenAI Responses connection", () => {
  assert.equal(canUseWebSearch(model), true);
  assert.equal(canUseWebSearch({ ...model, baseUrl: model.baseUrl + "/" }), true);
  for (const candidate of [
    undefined,
    { ...model, provider: "openai-codex" },
    { ...model, provider: "azure-openai" },
    { ...model, api: "openai-completions" },
    { ...model, baseUrl: "https://proxy.example.com/v1" },
    { ...model, baseUrl: "https://api.openai.com.evil.example/v1" },
    { ...model, baseUrl: "https://api.openai.com/v1?proxy=true" },
  ]) assert.equal(canUseWebSearch(candidate), false);
});

test("injection is immutable and preserves all existing tool and request settings", () => {
  const original = payload();
  const snapshot = structuredClone(original);
  const prepared = prepareSearchRequest(original, model)!;
  assert.equal(prepared.changed, true);
  assert.deepEqual(prepared.payload.tools, [...original.tools, { type: "web_search" }]);
  assert.deepEqual(original, snapshot);
  assert.equal(prepared.payload.input, original.input);
  assert.equal(prepared.payload.include, original.include);
  assert.equal(prepared.payload.reasoning, original.reasoning);
  assert.equal(prepared.payload.tool_choice, "auto");
  assert.equal(prepared.payload.store, false);
});

test("injection works when the request has no local tools", () => {
  const prepared = prepareSearchRequest({ model: model.id, stream: true, input: [] }, model)!;
  assert.deepEqual(prepared.payload.tools, [{ type: "web_search" }]);
});

test("existing hosted search declarations are not duplicated or reconfigured", () => {
  for (const type of ["web_search", "web_search_preview"]) {
    const original = { ...payload(), tools: [{ type, search_context_size: "low" }] };
    const prepared = prepareSearchRequest(original, model)!;
    assert.equal(prepared.changed, false);
    assert.equal(prepared.payload, original);
  }
});

test("malformed, differently routed, and incompatible requests are untouched", () => {
  for (const input of [null, [], "payload", {}, { ...payload(), model: "another-model" },
    { ...payload(), stream: false }, { ...payload(), tools: null },
    { ...payload(), tools: {} }, { ...payload(), input: "not-an-array" }]) {
    assert.equal(prepareSearchRequest(input, model), undefined);
  }
  assert.equal(prepareSearchRequest(payload(), { ...model, provider: "other" }), undefined);
});

test("captures annotations from incremental, item-done, and terminal events once", () => {
  const capture = new SearchCapture();
  capture.observe(citationEvent());
  capture.observe({ type: "response.output_item.done", item: messageItem() });
  capture.observe({ type: "response.completed", response: { output: [messageItem()] } });
  assert.deepEqual(capture.sources, [{ title: "Example documentation", url: "https://example.com/docs" }]);
});

test("terminal output backfills citations when incremental annotations are absent", () => {
  const capture = new SearchCapture();
  capture.observe({ type: "response.incomplete", response: { output: [messageItem()] } });
  assert.equal(capture.sources.length, 1);
});

test("ignores file citations, uncited search results, and malformed events", () => {
  const capture = new SearchCapture();
  for (const event of [null, [], "event", {}, { type: "response.output_item.done", item: null },
    { type: "response.output_item.done", item: { type: "message", content: null } },
    { type: "response.output_text.annotation.added", annotation: { type: "file_citation", url: "https://example.com" } },
    { type: "response.output_item.done", item: { type: "web_search_call", action: { sources: [{ url: "https://example.com" }] } } },
  ]) capture.observe(event);
  assert.deepEqual(capture.sources, []);
});

test("rejects unsafe links and strips control characters from source titles", () => {
  const capture = new SearchCapture();
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "not a URL",
    "https://user:password@example.com/", "https://example.com/\n", "https://example.com/\u202e", "https://example.com/" + "a".repeat(4096)]) {
    capture.observe(citationEvent(url));
  }
  assert.equal(capture.sources.length, 0);
  capture.observe(citationEvent("https://example.com/docs", "Hello\nworld\u001b\u202e"));
  assert.equal(capture.sources[0].title, "Hello world");
});

test("falls back to the hostname and bounds title length and citation count", () => {
  const capture = new SearchCapture();
  capture.observe(citationEvent("http://example.com", ""));
  capture.observe(citationEvent("https://example.com/long", "x".repeat(500)));
  assert.equal(capture.sources[0].title, "example.com");
  assert.equal(capture.sources[1].title.length, 240);
  for (let i = 0; i < 150; i++) capture.observe(citationEvent(`https://example.com/${i}`));
  assert.equal(capture.sources.length, 100);
});

test("tracks concurrent searches until all finish", () => {
  const capture = new SearchCapture();
  capture.observe({ type: "response.output_item.added", output_index: 1, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } });
  capture.observe({ type: "response.web_search_call.searching", item_id: "ws_1" });
  capture.observe({ type: "response.web_search_call.in_progress", item_id: "ws_2" });
  assert.equal(capture.searching, true);
  capture.observe({ type: "response.web_search_call.completed", item_id: "ws_1" });
  assert.equal(capture.searching, true);
  capture.observe({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_2", status: "completed" } });
  assert.equal(capture.searching, false);
});

test("failure, incomplete, completed, and error events clear search progress", () => {
  for (const type of ["response.failed", "response.incomplete", "response.completed", "error"]) {
    const capture = new SearchCapture();
    capture.observe({ type: "response.web_search_call.searching", item_id: "ws_test" });
    capture.observe({ type });
    assert.equal(capture.searching, false);
  }
});

test("appends readable source links without losing signatures, tools, or usage", () => {
  const original = answer();
  original.content.push({ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } });
  const capture = new SearchCapture();
  capture.observe(citationEvent());
  const updated = appendSources(original, capture.sources);
  assert.notEqual(updated, original);
  assert.equal(updated.content[0], original.content[0]);
  assert.equal(updated.content[2], original.content[2]);
  assert.equal(updated.usage, original.usage);
  assert.deepEqual(updated.content[1], {
    ...original.content[1], text: "An answer.\n\n### Web sources\n\n1. [Example documentation](https://example.com/docs)",
  });
  assert.equal(appendSources(updated, capture.sources), updated);
  assert.equal(original.content[1].type === "text" && original.content[1].text, "An answer.");
});

test("does not fabricate a text block or change an answer without citations", () => {
  const original = answer();
  assert.equal(appendSources(original, []), original);
  const noText = { ...original, content: original.content.slice(0, 1) };
  assert.equal(appendSources(noText, [{ title: "Example", url: "https://example.com/" }]), noText);
});

test("escapes Markdown in untrusted titles and parentheses in URLs", () => {
  const capture = new SearchCapture();
  capture.observe(citationEvent("https://example.com/a_(b)", "][bad](javascript:evil) *title*"));
  const updated = appendSources(answer(), capture.sources);
  const block = updated.content[1];
  assert.equal(block.type, "text");
  if (block.type === "text") {
    assert.ok(block.text.includes("https://example.com/a_%28b%29"));
    assert.ok(block.text.includes("\\]\\[bad\\]"));
    assert.ok(block.text.includes("\\*title\\*"));
  }
});
