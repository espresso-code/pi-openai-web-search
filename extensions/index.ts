import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendSources,
  canUseWebSearch,
  prepareSearchRequest,
  SearchCapture,
  type SearchModel,
} from "../src/search.ts";

const STATUS_KEY = "openai-web-search";
const ENABLE_NOTICE = "OpenAI web search enabled. Queries may contain conversation details and incur additional charges. Search runs on OpenAI's servers, outside Pi's local tool permission hooks. Model support is checked by OpenAI.";
const INCOMPATIBLE_NOTICE = "Web search requires the openai provider, openai-responses API, and https://api.openai.com/v1 endpoint. Proxies, Codex, Azure, and Chat Completions are not enabled by this extension.";

export default function openaiWebSearch(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "openai-web-search.json");
  let enabled = false;
  let agentRunning = false;
  let request: { model: SearchModel; capture: SearchCapture } | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const status = request?.capture.searching
      ? "Web search: searching…"
      : enabled
        ? canUseWebSearch(ctx.model) ? "Web search: on" : "Web search: paused (unsupported connection)"
        : undefined;
    ctx.ui.setStatus(STATUS_KEY, status);
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function savePreference(ctx: ExtensionContext): void {
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(temporaryPath, JSON.stringify({ enabled }) + "\n", { mode: 0o600 });
      renameSync(temporaryPath, settingsPath);
    } catch {
      notify(ctx, "Web search changed for this session, but the preference could not be saved.", "warning");
    } finally {
      try { rmSync(temporaryPath, { force: true }); } catch { /* Best-effort cleanup. */ }
    }
  }

  pi.registerFlag("web-search", {
    description: "Enable OpenAI hosted web search for this process (queries leave Pi; additional charges may apply)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("web-search", {
    description: "Control OpenAI hosted web search: /web-search on|off|status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        notify(ctx, enabled
          ? canUseWebSearch(ctx.model)
            ? "Web search is on. Available to the model, not forced; OpenAI must support the selected model."
            : "Web search is on but paused. " + INCOMPATIBLE_NOTICE
          : "Web search is off. Enable with /web-search on.");
      } else if (action === "on") {
        if (!canUseWebSearch(ctx.model)) {
          notify(ctx, INCOMPATIBLE_NOTICE, "warning");
          return;
        }
        enabled = true;
        savePreference(ctx);
        notify(ctx, ENABLE_NOTICE, "warning");
      } else if (action === "off") {
        enabled = false;
        savePreference(ctx);
        notify(ctx, "Web search disabled for future requests. A search already in progress cannot be recalled; tools added by other extensions are unaffected.");
      } else {
        notify(ctx, "Usage: /web-search on|off|status", "warning");
      }
      updateStatus(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Preferences are user-wide, not part of a conversation or its branches.
    enabled = false;
    try {
      const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof settings !== "object" || settings === null ||
        typeof (settings as { enabled?: unknown }).enabled !== "boolean") {
        throw new Error("Invalid web search preference");
      }
      enabled = (settings as { enabled: boolean }).enabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        notify(ctx, "Could not read the web search preference; defaulting to off.", "warning");
      }
    }
    // The CLI opt-in does not overwrite the saved preference.
    enabled = pi.getFlag("web-search") === true || enabled;
    agentRunning = false;
    request = undefined;
    if (enabled) notify(ctx, canUseWebSearch(ctx.model) ? ENABLE_NOTICE : INCOMPATIBLE_NOTICE, "warning");
    updateStatus(ctx);
  });

  pi.on("agent_start", () => {
    agentRunning = true;
  });

  pi.on("turn_start", (_event, ctx) => {
    request = undefined;
    updateStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    // Idle prompt-cache warming must never gain a hosted search tool.
    if (!enabled || !agentRunning) return;
    const prepared = prepareSearchRequest(event.payload, ctx.model);
    if (!prepared || !ctx.model) return;
    request = {
      model: { provider: ctx.model.provider, api: ctx.model.api, id: ctx.model.id, baseUrl: ctx.model.baseUrl },
      capture: new SearchCapture(),
    };
    return prepared.changed ? prepared.payload : undefined;
  });

  pi.on("provider_stream_event", (event, ctx) => {
    if (!request || event.provider !== request.model.provider ||
      event.api !== request.model.api || event.model !== request.model.id) return;
    const wasSearching = request.capture.searching;
    request.capture.observe(event.data);
    if (wasSearching !== request.capture.searching) updateStatus(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (!request || message.role !== "assistant" || message.provider !== request.model.provider ||
      message.api !== request.model.api || message.model !== request.model.id) return;
    const updated = appendSources(message, request.capture.sources);
    request = undefined;
    updateStatus(ctx);
    if (updated !== message) return { message: updated };
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    agentRunning = false;
    request = undefined;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    enabled = false;
    agentRunning = false;
    request = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
