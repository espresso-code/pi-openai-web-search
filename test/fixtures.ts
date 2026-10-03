import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

export const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test model",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  reasoning: true,
  contextWindow: 100_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function answer(): AssistantMessage {
  return {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    content: [
      { type: "thinking", thinking: "Reasoning", thinkingSignature: "opaque-signature" },
      { type: "text", text: "An answer.", textSignature: '{"v":1,"id":"msg_test"}' },
    ],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

export function citation(url = "https://example.com/docs", title = "Example documentation") {
  return { type: "url_citation", url, title, start_index: 0, end_index: 10 };
}

export function citationEvent(url?: string, title?: string) {
  return { type: "response.output_text.annotation.added", item_id: "msg_test", annotation: citation(url, title) };
}

export function messageItem(annotations: unknown[] = [citation()]) {
  return { type: "message", id: "msg_test", content: [{ type: "output_text", text: "An answer.", annotations }] };
}
