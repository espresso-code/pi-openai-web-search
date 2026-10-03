import type { AssistantMessage } from "@earendil-works/pi-ai";

export interface SearchModel {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
}

export interface WebSource {
  title: string;
  url: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deliberately exclude proxies, Codex, Azure, and Chat Completions. */
export function canUseWebSearch(model: SearchModel | undefined): boolean {
  return model?.provider === "openai" &&
    model.api === "openai-responses" &&
    model.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1";
}

/** Undefined means this is not a request we can safely modify. */
export function prepareSearchRequest(
  payload: unknown,
  model: SearchModel | undefined,
): { payload: Record<string, unknown>; changed: boolean } | undefined {
  if (!canUseWebSearch(model) || !isRecord(payload)) return undefined;
  // The request hook has no model metadata. Check the payload against ctx.model
  // so a differently routed/nested request cannot inherit the selected model.
  if (payload.model !== model?.id || payload.stream !== true || !Array.isArray(payload.input)) {
    return undefined;
  }
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) return undefined;

  const tools: unknown[] = payload.tools ?? [];
  if (tools.some((tool) => isRecord(tool) &&
    (tool.type === "web_search" || tool.type === "web_search_preview"))) {
    return { payload, changed: false };
  }
  return {
    payload: { ...payload, tools: [...tools, { type: "web_search" }] },
    changed: true,
  };
}

const MAX_SOURCES = 100;
const MAX_TITLE_LENGTH = 240;

function parseSource(annotation: unknown): WebSource | undefined {
  if (!isRecord(annotation) || annotation.type !== "url_citation" ||
    typeof annotation.url !== "string" || annotation.url.length > 4096 ||
    /[\p{Cc}\p{Cf}]/u.test(annotation.url)) return undefined;

  try {
    const url = new URL(annotation.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    const title = typeof annotation.title === "string"
      ? annotation.title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()
      : "";
    return { title: (title || url.hostname).slice(0, MAX_TITLE_LENGTH), url: url.href };
  } catch {
    return undefined;
  }
}

/** Keep only cited URLs and search progress, never raw events or search queries. */
export class SearchCapture {
  private readonly sourcesByUrl = new Map<string, WebSource>();
  private readonly pendingSearches = new Set<string>();

  get sources(): WebSource[] {
    return [...this.sourcesByUrl.values()];
  }

  get searching(): boolean {
    return this.pendingSearches.size > 0;
  }

  observe(data: unknown): void {
    if (!isRecord(data)) return;
    const type = data.type;
    const id = typeof data.item_id === "string" ? data.item_id : String(data.output_index ?? "search");

    if (type === "response.web_search_call.in_progress" || type === "response.web_search_call.searching") {
      this.pendingSearches.add(id);
    } else if (type === "response.web_search_call.completed") {
      this.pendingSearches.delete(id);
    } else if (type === "response.output_text.annotation.added") {
      this.addAnnotation(data.annotation);
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = data.item;
      if (!isRecord(item)) return;
      if (item.type === "web_search_call") {
        const itemId = typeof item.id === "string" ? item.id : id;
        if (type === "response.output_item.done" || item.status === "completed" || item.status === "failed") {
          this.pendingSearches.delete(itemId);
          this.pendingSearches.delete(String(data.output_index ?? "search"));
        } else {
          this.pendingSearches.add(itemId);
        }
      }
      if (type === "response.output_item.done") this.addMessageSources(item);
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      this.pendingSearches.clear();
      if (isRecord(data.response) && Array.isArray(data.response.output)) {
        for (const item of data.response.output) this.addMessageSources(item);
      }
    } else if (type === "error") {
      this.pendingSearches.clear();
    }
  }

  private addMessageSources(item: unknown): void {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return;
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || !Array.isArray(part.annotations)) continue;
      for (const annotation of part.annotations) this.addAnnotation(annotation);
    }
  }

  private addAnnotation(annotation: unknown): void {
    const source = parseSource(annotation);
    if (source && this.sourcesByUrl.size < MAX_SOURCES && !this.sourcesByUrl.has(source.url)) {
      this.sourcesByUrl.set(source.url, source);
    }
  }
}

function sourceLink(source: WebSource): string {
  const title = source.title.replace(/[\\`*_[\]<>]/g, "\\$&");
  const url = source.url.replace(/[()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${title}](${url})`;
}

/** Preserve reasoning, tool calls, text signatures, usage, and the answer text. */
export function appendSources(message: AssistantMessage, sources: readonly WebSource[]): AssistantMessage {
  if (sources.length === 0) return message;
  const content = [...message.content];
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type !== "text") continue;
    const appendix = `\n\n### Web sources\n\n${sources.map((source, index) => `${index + 1}. ${sourceLink(source)}`).join("\n")}`;
    if (block.text.endsWith(appendix)) return message;
    content[i] = { ...block, text: block.text + appendix };
    return { ...message, content };
  }
  return message;
}
