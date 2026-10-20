# pi-openai-web-search

An opt-in [Pi](https://pi.dev) extension that enables OpenAI's hosted `web_search`
tool on the main Responses API request. It preserves Pi's local tools and adds
linked **Web sources** to the saved answer when OpenAI supplies URL citations.

No search-service account, additional API key, MCP server, or provider fork is
required. There are no runtime dependencies beyond Pi.

## Requirements

- Pi **1.0.1** (the version tested; future versions need revalidation).
- The `openai` provider using `openai-responses` at
  `https://api.openai.com/v1`.
- A model and credential that OpenAI permits to use hosted search.

The connection guard intentionally excludes OpenAI-compatible gateways/proxies,
Chat Completions, Azure, and the separate `openai-codex` provider. Matching the
connection does **not** guarantee that every model supports search. OpenAI's
normal error is surfaced if it rejects the tool; there is no silent fallback or
automatic retry without search. API-key and OAuth availability depend on OpenAI;
OAuth-backed search was verified during local development.

## Try it locally

From a checkout:

```sh
pi -e ./extensions/index.ts
```

Then:

```text
/web-search on
```

Ask for current information and explicitly request a web search when you want one.
Enabling the tool makes it available; it does not force the model to search.

### Install the package

Install into the current project's Pi configuration:

```sh
pi install . --local
```

Or install for all your projects:

```sh
pi install /absolute/path/to/pi-openai-web-search
```

Restart Pi or run `/reload`, and approve project configuration if prompted.
Avoid also loading `-e ./extensions/index.ts` when the package is already installed.

After the repository is published, another machine can install it directly from
GitHub. Replace `OWNER` and `COMMIT` with the repository owner and a reviewed full
commit SHA:

```sh
pi install git:github.com/OWNER/pi-openai-web-search@COMMIT
```

Pi installs the package's TypeScript sources directly; `npm install` and a build
step are not required for using the extension. Pinning a commit avoids taking
unreviewed upstream changes. Use `--local` for project-only installation.

## Controls

| Control | Meaning |
| --- | --- |
| `/web-search on` | Enable on future eligible model requests and save the preference. |
| `/web-search off` | Stop adding search to future requests and save the preference. |
| `/web-search status` | Report the toggle and connection eligibility. |
| `/web-search` | Same as `status`; does not silently toggle. |
| `--web-search` | Explicit process-scoped opt-in, also for print/JSON/RPC mode. |

Search is **off by default** until you save a preference. `/web-search on` and
`/web-search off` persist across restarts, reloads, session switching, and forks.
The user-wide preference is stored in `~/.pi/agent/openai-web-search.json` (or in
`PI_CODING_AGENT_DIR` when set), not in session history, and applies across projects
and modes, including print/JSON/RPC. Missing preferences default to off; unreadable
or invalid preferences default to off with a UI warning. Save failures also show
a UI warning while keeping the toggle effective for the current session.

The CLI flag remains a temporary opt-in for the process, including sessions opened
within that process, and does not overwrite the saved preference. A restored on
setting is paused on unsupported connections and resumes on a supported one.

Interactive Pi displays `Web search: on`, search progress, or a paused indicator
when switching to an incompatible connection. Turning search off cannot recall a
search already running. It also does not remove search tools configured by another
extension or through custom request settings.

For a one-shot request without local file/shell tools:

```sh
pi -e ./extensions/index.ts --web-search --no-tools \
  --provider openai --model YOUR_SUPPORTED_MODEL \
  --print 'Search for the official Node.js release page and cite it.'
```

**`--no-tools` disables Pi's declared tools, not the hosted tool explicitly enabled
with `--web-search`.** The extension does not register a local `web_search` tool,
so it will not appear in Pi's normal tool list.

## Citations and integration

Pi 1.0.1's Responses adapter discards URL citation annotations. This extension
observes `provider_stream_event`, extracts only `url_citation` annotations, and
appends a linked source list to the final assistant message using `message_end`.
This list is saved in the transcript, included in follow-up context, and visible
in print/JSON output and normal transcript rendering.

The original answer, inline citations, reasoning signatures, text signatures,
local tool calls, usage, and stop reason are preserved. The source list is a
response-level list, not a reconstruction of claim-by-claim citation offsets.
Only cited sources are listed, not every search result or visited page. Sources
are deduplicated and bounded to 100 links per response; titles are sanitized and
links must be HTTP(S) without embedded credentials.

Search runs on OpenAI's servers. There are no fabricated local tool calls/results.
Capture is cleared between requests, retries, turns, and sessions. Requests made
outside an active agent run (including idle cache warming) are not modified.

## Privacy, security, and workplace use

A public repository can safely contain this generic code, tests, and documentation.
It should **not** contain credentials, `.env` files, Pi sessions, provider payload
logs, company code, internal URLs, or real work prompts. `.gitignore` excludes
common local artifacts, but review staged files and the complete Git history
before publishing. `.gitignore` does not remove secrets already committed.

Publishing the code and using it at work are separate decisions:

- Obtain any required approval for third-party extensions, OpenAI access, and web
  search. A public repo does not bypass company software or data-handling policy.
- Extensions execute inside Pi with the same OS permissions as Pi; this is not a
  sandbox. Review the code and pin an approved commit.
- Search queries can be derived from conversation details. Internal names,
  customer data, and other sensitive information could become query text sent to
  OpenAI's search infrastructure. Do not enable it for sensitive work unless
  that use is explicitly permitted. This extension does not redact queries or
  enforce domain restrictions.
- Hosted search runs outside Pi's local `tool_call` approval/permission hooks.
  Enabling it is not per-query confirmation. Retrieved web content may contain
  prompt injection; treat it as untrusted, particularly if local tools are active.
- OpenAI's search billing/subscription rules still apply. Pi's cost display may
  omit hosted-tool fees; this extension does not impose a hard search budget.
- The extension does not read or export credentials, make its own HTTP requests,
  or log raw provider events/search queries. Cited URLs and titles are added to
  the existing Pi transcript; keep that transcript private when appropriate.
- The extension leaves request retention settings unchanged. That is not a
  guarantee about provider-side data retention; use your organization's approved
  OpenAI account and applicable data controls.

## Development

Node.js 22.19+ is required. Dependencies are pinned for development; Pi-provided
packages are peer dependencies, not bundled runtime dependencies.

```sh
npm ci --ignore-scripts
npm run check
```

Tests cover immutable request injection, connection checks, duplicate tools,
citation event variants, safe Markdown links, source limits, search progress,
preference persistence and error handling, headless operation, cancellation cleanup, retries, and model
switches. Tests do not make network/model calls or require credentials.

A manual acceptance check should also cover a real search with citations, a local
tool call alongside search, a saved-session follow-up with search off, and an
ordinary no-search request. Keep any test sessions or event logs outside the repo.

## License

MIT. See [LICENSE](LICENSE).
