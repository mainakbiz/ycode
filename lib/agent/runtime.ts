import { SYSTEM_INSTRUCTIONS } from '@/lib/mcp/instructions';
import { DEFAULT_MAX_TOKENS, MAX_HISTORY_CHARS, MAX_HISTORY_MESSAGES, MAX_TOOL_TURNS } from '@/lib/agent/config';
import { compactToolResult } from '@/lib/agent/tools/compact-result';
import { buildLoadToolsTool, deferredGroupOf, LOAD_TOOLS_NAME } from '@/lib/agent/tools/deferred';
import { getAgentToolMap, getAgentTools } from '@/lib/agent/tools/registry';
import { estimateCostUsd } from '@/lib/agent/models';
import { getCachedLayers } from '@/lib/mcp/page-layers';
import { generateCSSForPage } from '@/lib/server/cssGenerator';
import { getComponentById } from '@/lib/repositories/componentRepository';

import type { AgentToolGroup } from '@/lib/agent/tools/types';
import type { Component, ComponentVariant, Layer } from '@/types';
import type {
  AgentContentBlock,
  AgentMessage,
  AgentProvider,
  AgentToolResultBlock,
  AgentToolUseBlock,
  AgentUsage,
} from './providers/types';

/** Editor context threaded into the system prompt so "this section" resolves. */
export interface AgentEditorContext {
  pageId?: string | null;
  /** When the user is editing a component, its id/variant so "this component"
   * resolves and edits are routed through the component tools. */
  componentId?: string | null;
  variantId?: string | null;
  selectedLayerIds?: string[];
  /** Selected layers with display names — preferred over bare ids when present. */
  selectedLayers?: Array<{ id: string; name?: string }>;
  /** Pages/collections/layers/components the user @-mentioned in the message. */
  mentions?: Array<{ type: 'page' | 'collection' | 'layer' | 'component'; id: string; label: string }>;
  /** URLs the user referenced in the message. */
  referenceUrls?: string[];
}

export interface RunAgentOptions {
  provider: AgentProvider;
  model: string;
  messages: AgentMessage[];
  context?: AgentEditorContext;
  signal?: AbortSignal;
  maxTokens?: number;
}

/** High-level events streamed to the client for one user message. */
export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean }
  // `costUsd` is the approximate list-price cost for this user message, or null
  // when the model has no pricing entry (custom ANTHROPIC_MODEL override).
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; costUsd: number | null }
  // Authoritative post-turn snapshot of a page the agent edited, computed from
  // the server cache so the client never has to race the realtime broadcast to
  // build the Changes card or screenshot the right state. `layersBefore` is the
  // pre-turn tree (only sent when something changed) so the client can offer a
  // one-click Undo of the whole turn.
  // `generatedCss` is the server-compiled Tailwind stylesheet for the page,
  // sent so the editor canvas can inject it directly (the canvas's Tailwind CDN
  // JIT is too flaky to reliably style large AI-built pages on its own).
  | { type: 'page_changed'; pageId: string; layerCount: number; layers: Layer[]; layersBefore?: Layer[]; generatedCss?: string }
  // Authoritative post-turn snapshot of a component the agent edited, so the
  // client can sync its component drafts (the open canvas) without racing the
  // realtime broadcast, which ignores the acting user's own edits.
  | { type: 'component_changed'; componentId: string; name: string; variants: ComponentVariant[] }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string };

/**
 * Run the agent tool-calling loop for one user turn.
 *
 * Streams the assistant's text and tool activity, executes tool calls in-process
 * via the shared registry, feeds results back to the model, and repeats until the
 * model stops requesting tools (or the turn ceiling is hit).
 */
export async function* runAgent(options: RunAgentOptions): AsyncIterable<RuntimeEvent> {
  const { provider, model, signal } = options;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const system = buildSystemPrompt(options.context);
  const allTools = getAgentTools();
  const toolMap = getAgentToolMap();

  // Deferred tool loading: only core tools ship up front (~half the schema
  // payload); the rest join when the model calls load_tools or calls a
  // deferred tool directly. When the user is editing a component, the
  // component tools are the primary editing surface, so preload them.
  const activeGroups = new Set<AgentToolGroup>(['core']);
  if (options.context?.componentId) activeGroups.add('components');
  const loadToolsTool = buildLoadToolsTool();
  const activeTools = () => [
    ...allTools.filter((tool) => activeGroups.has(tool.group)),
    loadToolsTool,
  ];

  // Bound the cross-turn history before anything else so a long chat can't push
  // the request past the model's context window.
  const messages: AgentMessage[] = trimConversation([...options.messages]);
  const snapshotPageId = await injectActivePageSnapshot(messages, options.context?.pageId);
  await injectActiveComponentSnapshot(messages, options.context?.componentId, options.context?.variantId);
  // While no mutating tool has run, the injected snapshot is still the live
  // truth, so a get_layers call for that page can be answered with a stub
  // instead of a second copy of the same tree.
  let snapshotIsFresh = snapshotPageId !== null;

  // One-time snapshot of the fixed per-call prefix so the logs show how much of
  // each turn is static (system + tools) vs. accumulating history. ~4 chars/token.
  const initialMessageChars = messages.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);
  console.info(
    `[ai-agent] fixed-prefix system≈${Math.round(system.length / 4)}tok ` +
      `active_tools=${activeTools().length} ` +
      `initial_messages=${messages.length} (≈${Math.round(initialMessageChars / 4)}tok incl. page snapshot)`,
  );

  const usage = new UsageTotals();
  let totalMutatingToolCalls = 0;
  let noOpCorrectionUsed = false;
  let hardTrimUsed = false;

  // Per-page pre-edit layer trees (captured the first time a tool touches a page,
  // before it runs) and the set of pages the agent edited. Used to emit an
  // authoritative page_changed event per page at the end of the run, including
  // the before-tree so the client can offer a one-click Undo.
  const beforeLayersByPage = new Map<string, Layer[]>();
  const editedPageIds = new Set<string>();

  // Components the agent edited this turn. Used to stream an authoritative
  // component_changed event per component so the client can sync its drafts.
  const editedComponentIds = new Set<string>();

  /** Stream one authoritative page_changed event per edited page, diffing the
   * post-turn cache against the captured before-snapshot. */
  async function* emitPageChanges(): AsyncIterable<RuntimeEvent> {
    for (const pageId of editedPageIds) {
      try {
        const after = await getCachedLayers(pageId);
        const before = beforeLayersByPage.get(pageId) ?? [];
        const layerCount = countChangedLayers(layerSignatures(before), layerSignatures(after));
        // Compile the page's Tailwind CSS once per turn so the client canvas can
        // inject the same stylesheet published pages use. This is what makes
        // AI-built pages actually show their colors/styles on the canvas rather
        // than relying on the flaky in-iframe Tailwind CDN JIT. Best-effort:
        // never block the authoritative snapshot on a CSS failure.
        let generatedCss: string | undefined;
        try {
          generatedCss = (await generateCSSForPage(pageId)) ?? undefined;
        } catch (cssError) {
          console.error('[ai-agent] failed to generate page CSS:', cssError);
        }
        yield {
          type: 'page_changed',
          pageId,
          layerCount,
          layers: after,
          layersBefore: layerCount > 0 ? before : undefined,
          generatedCss,
        };
      } catch (error) {
        console.error('[ai-agent] failed to compute page change snapshot:', error);
      }
    }
  }

  /** Stream one authoritative component_changed event per edited component,
   * re-fetching the persisted component so the client can rebuild its drafts. */
  async function* emitComponentChanges(): AsyncIterable<RuntimeEvent> {
    for (const componentId of editedComponentIds) {
      try {
        const component = await getComponentById(componentId);
        if (!component) continue;
        yield {
          type: 'component_changed',
          componentId,
          name: component.name,
          variants: variantsOf(component),
        };
      } catch (error) {
        console.error('[ai-agent] failed to compute component change snapshot:', error);
      }
    }
  }

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const assistantBlocks: AgentContentBlock[] = [];
    const toolUses: AgentToolUseBlock[] = [];
    let text = '';
    let stopReason: string | null = null;

    try {
      for await (const event of provider.streamMessage({ system, messages, tools: activeTools(), model, maxTokens, signal })) {
        if (event.type === 'text_delta') {
          text += event.text;
          yield { type: 'text', text: event.text };
        } else if (event.type === 'tool_use') {
          const block: AgentToolUseBlock = {
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          };
          toolUses.push(block);
          yield { type: 'tool_call', id: event.id, name: event.name, input: event.input };
        } else if (event.type === 'message_stop') {
          stopReason = event.stopReason;
          usage.add(event.usage);
        }
      }
    } catch (error) {
      // The prompt is too long for the model's context window. It's rejected
      // before any output, so retrying is safe. Only re-trim on the first turn,
      // where the history is all plain text/image turns — trimming mid-loop could
      // orphan a tool_result from its tool_use and make the request invalid. If
      // it still overflows, tell the user to start a new chat rather than fail
      // silently.
      if (isContextOverflowError(error)) {
        if (!hardTrimUsed && turn === 0) {
          hardTrimUsed = true;
          hardTrimConversation(messages);
          continue;
        }
        yield { type: 'error', message: OVERFLOW_MESSAGE };
        return;
      }
      throw error;
    }

    if (text.trim()) {
      assistantBlocks.push({ type: 'text', text });
    }
    assistantBlocks.push(...toolUses);
    messages.push({ role: 'assistant', content: assistantBlocks });

    if (toolUses.length === 0) {
      // Safety net: the run ended with a "the work is done" reply but no editing
      // tool ever ran (reads like get_layers don't count). Nudge it once to
      // actually perform the edits rather than leaving the user stuck.
      if (!noOpCorrectionUsed && totalMutatingToolCalls === 0 && claimsCompletionWithoutEdits(text)) {
        noOpCorrectionUsed = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: NO_OP_CORRECTION }] });
        continue;
      }
      usage.log(model, turn + 1);
      yield* emitPageChanges();
      yield* emitComponentChanges();
      yield usage.toEvent(model);
      yield { type: 'done', stopReason };
      return;
    }

    const results: AgentToolResultBlock[] = [];
    for (const call of toolUses) {
      // Deferred tool loading: honor explicit load_tools calls, and auto-load
      // the right group when the model calls a deferred tool directly (the
      // system instructions document those tools, so it often knows the name).
      if (call.name === LOAD_TOOLS_NAME) {
        const requested = Array.isArray(call.input.groups) ? call.input.groups : [];
        for (const group of requested) {
          if (typeof group === 'string') activeGroups.add(group as AgentToolGroup);
        }
        const loaded = activeTools().map((tool) => tool.name).join(', ');
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: `Loaded. Tools now available: ${loaded}`,
        });
        yield { type: 'tool_result', id: call.id, name: call.name, ok: true };
        continue;
      }
      const neededGroup = deferredGroupOf(call.name);
      if (neededGroup && !activeGroups.has(neededGroup)) {
        activeGroups.add(neededGroup);
      }

      if (!isReadOnlyTool(call.name)) {
        totalMutatingToolCalls += 1;
        // Any mutation may change what get_layers would return (including
        // component edits, which affect instances), so stop stubbing.
        snapshotIsFresh = false;
      }

      // The page snapshot injected into the user message is still current —
      // don't pay for a second copy of the same tree.
      if (snapshotIsFresh && call.name === 'get_layers' && call.input.page_id === snapshotPageId) {
        const stub: AgentToolResultBlock = {
          type: 'tool_result',
          toolUseId: call.id,
          content:
            'Unchanged: this page still matches the snapshot included with the user\'s message — use that snapshot. ' +
            'Call get_layers again after making edits if you need the updated tree.',
        };
        results.push(stub);
        yield { type: 'tool_result', id: call.id, name: call.name, ok: true };
        continue;
      }
      // Snapshot each touched page's pre-edit layer tree once, before the tool
      // mutates it, so we can diff it after the run for the Changes card.
      for (const pageId of collectPageIdsFromInput(call.input)) {
        editedPageIds.add(pageId);
        if (!beforeLayersByPage.has(pageId)) {
          try {
            beforeLayersByPage.set(pageId, await getCachedLayers(pageId));
          } catch (error) {
            console.error('[ai-agent] failed to snapshot page before edit:', error);
          }
        }
      }
      // Track edited components (mutating tools only) so we can stream an
      // authoritative snapshot back for the client to sync its drafts.
      // Instance tools reference a component_id but edit the PAGE, not the
      // master, so they must not be treated as component edits.
      if (!isReadOnlyTool(call.name) && !COMPONENT_INSTANCE_TOOLS.has(call.name)) {
        for (const componentId of collectComponentIdsFromInput(call.input)) {
          editedComponentIds.add(componentId);
        }
      }
      const result = await executeTool(toolMap, call);
      results.push(result);
      yield { type: 'tool_result', id: call.id, name: call.name, ok: !result.isError };
    }

    messages.push({ role: 'user', content: results });
  }

  usage.log(model, MAX_TOOL_TURNS);
  yield* emitPageChanges();
  yield* emitComponentChanges();
  yield usage.toEvent(model);
  yield { type: 'error', message: `Reached the tool-call limit (${MAX_TOOL_TURNS}) without finishing.` };
}

/**
 * Accumulates token usage across all turns of one user message and logs a
 * summary, including how much of the input was served from the prompt cache.
 * The cache-hit rate is the key signal for whether prompt caching (system,
 * tools, and the rolling conversation breakpoint) is actually paying off.
 */
class UsageTotals {
  private input = 0;
  private output = 0;
  private cacheWrite = 0;
  private cacheRead = 0;
  /** Per-turn deltas, for a granular breakdown of where tokens accumulate. */
  private turns: Array<{ input: number; output: number; cacheWrite: number; cacheRead: number }> = [];

  add(usage?: AgentUsage): void {
    if (!usage) return;
    this.input += usage.inputTokens;
    this.output += usage.outputTokens;
    this.cacheWrite += usage.cacheCreationInputTokens ?? 0;
    this.cacheRead += usage.cacheReadInputTokens ?? 0;
    this.turns.push({
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheWrite: usage.cacheCreationInputTokens ?? 0,
      cacheRead: usage.cacheReadInputTokens ?? 0,
    });
  }

  log(model: string, turns: number): void {
    const totalInput = this.input + this.cacheWrite + this.cacheRead;
    const hitRate = totalInput > 0 ? Math.round((this.cacheRead / totalInput) * 100) : 0;
    const total = this.input + this.output + this.cacheWrite + this.cacheRead;
    const cost = estimateCostUsd(model, {
      inputTokens: this.input,
      outputTokens: this.output,
      cacheWriteTokens: this.cacheWrite,
      cacheReadTokens: this.cacheRead,
    });
    console.info(
      `[ai-agent] usage model=${model} turns=${turns} total_tokens=${total} ` +
        `input=${this.input} output=${this.output} ` +
        `cache_write=${this.cacheWrite} cache_read=${this.cacheRead} ` +
        `cache_hit=${hitRate}%` +
        (cost !== null ? ` est_cost=$${cost.toFixed(4)}` : ''),
    );
    // Per-turn breakdown: shows how fast context (cache_read) grows per round-trip
    // and which turns emit the expensive output tokens.
    this.turns.forEach((t, i) => {
      console.info(
        `[ai-agent]   turn ${i + 1}: input=${t.input} output=${t.output} ` +
          `cache_write=${t.cacheWrite} cache_read=${t.cacheRead}`,
      );
    });
  }

  /** Serialize the totals for this user message into a client-facing event. */
  toEvent(model: string): RuntimeEvent {
    return {
      type: 'usage',
      inputTokens: this.input,
      outputTokens: this.output,
      cacheWriteTokens: this.cacheWrite,
      cacheReadTokens: this.cacheRead,
      costUsd: estimateCostUsd(model, {
        inputTokens: this.input,
        outputTokens: this.output,
        cacheWriteTokens: this.cacheWrite,
        cacheReadTokens: this.cacheRead,
      }),
    };
  }
}

async function executeTool(
  toolMap: ReturnType<typeof getAgentToolMap>,
  call: AgentToolUseBlock,
): Promise<AgentToolResultBlock> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return { type: 'tool_result', toolUseId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
  }

  try {
    const result = await tool.execute(call.input);
    const content = result.content
      .map((part) => (typeof part.text === 'string' ? part.text : JSON.stringify(part)))
      .join('\n');
    const compacted = compactToolResult(call.name, content || 'OK');
    return { type: 'tool_result', toolUseId: call.id, content: compacted, isError: result.isError };
  } catch (error) {
    return {
      type: 'tool_result',
      toolUseId: call.id,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

/**
 * Standing policy for the in-app agent, appended to the shared MCP instructions.
 *
 * The in-app builder is draft-first: the user reviews edits on the canvas and
 * clicks Publish themselves. The shared instructions carry no publishing
 * guidance (the MCP server appends MCP_PUBLISHING_INSTRUCTIONS separately) and
 * the `publish` tool is withheld from the in-app toolset (see registry.ts), so
 * this is belt and suspenders — it stops the agent from claiming it published.
 */
const AGENT_POLICY = [
  'Never publish. The user controls publishing — they review your changes on the canvas and click the Publish button when ready.',
  'Do not call any publish tool and do not tell the user their changes are live. Leave everything as drafts.',
  'Only describe edits you actually performed with tools. If you intend to make changes, call the tools to make them in the same turn — never reply that something is done, saved, or drafted unless you have already called the tools that did it.',
  'A snapshot of the active page\'s current contents is included with the user\'s message. Treat it as the single source of truth for what currently exists. Never claim an element exists or was already added based on earlier conversation — if you are unsure, check the snapshot or call get_layers before answering.',
  'Keep all chat replies short and plain. Write for someone who will skim, not read. Never explain your reasoning, justify design choices, list every property you set, or narrate your steps. No preamble like "Great!" or "Sure", no headings, no bullet-point breakdowns of what you did unless the user explicitly asks for detail.',
  'Do not think out loud or pre-announce actions. Never write running commentary such as "Let me look at…", "I\'ll check…", "I\'ll add…", "The selected layer is…", "Now I\'ll…", or any step-by-step description before, between, or about your tool calls. Call the tools silently and let your work speak for itself.',
  'Refer to layers by their name or role in plain language (e.g. "the header", "the call-to-action button"). Never paste raw layer ids (the "lyr-..." strings) into your chat replies, and do not wrap them in backticks — they are noise to the user.',
  'When you finish making edits, send ONE short closing sentence describing the end result the user will see on the canvas, in plain language (e.g. "Your Home page is now a clean coming-soon page with a centered headline and a subtle dark background."). Hard limit: one or two sentences, no headings, no sections (never write "Looks great:", "Fixed this turn:", "Publish and refresh", or similar), no lists, no recap of the steps you took or problems you found along the way. The user already sees the list of changed pages and layer counts separately, so do not restate them. Do not remind them to publish unless they ask. If you made no edits yet, do not send that message — make the edits first, or ask one specific clarifying question if the request is unclear.',
].join(' ');

/**
 * Tells the model how to read get_layers, which we compact before returning it
 * (see tools/compact-result.ts). Without this it may look for a `design` field
 * that we strip; the compiled `classes` string is the source of truth instead.
 */
const TOOL_OUTPUT_NOTE =
  'get_layers returns a compact tree: each node has id, type, optional name (custom name), ' +
  'text (current text content), classes (the live Tailwind classes — your source of truth for current styling), ' +
  'tag, hidden, componentInstance, and children. The verbose `design` object is omitted; read current styling from `classes`. ' +
  'To change styling, call update_layer_design with only the categories you want — it merges into existing design, so you never need to resend the full design. ' +
  'Only the core building tools are attached up front. Tools for CMS/collections, components, shared styles, animations, localization, and site settings ' +
  'load on demand — call load_tools with the group(s) you need (its description lists every group and tool) as soon as you know the task requires them, then use the loaded tools normally.';

/**
 * Sent back to the model when it ends a turn claiming the work is done but never
 * called a single tool — a recurring failure where it jumps straight to the
 * "saved as drafts…" summary having changed nothing. Forces it to either do the
 * work or ask, instead of leaving the user stuck with a false completion.
 */
const NO_OP_CORRECTION =
  'You replied as if the work is finished, but you have not called any tools, so nothing has actually changed on the page. ' +
  'Perform the requested edits now using the appropriate tools (e.g. add_layout, batch_operations, update_layer_design, update_layer_text). ' +
  'If you genuinely need to inspect the page first, call get_layers or list_pages; if the request is unclear, ask one specific clarifying question instead of summarising. ' +
  'Never say anything was saved, drafted, or changed until you have actually made the change with a tool.';

/**
 * Whether assistant text reads like a "the work is done" claim. Used only to
 * detect the no-op failure above, so it is gated on the turn having made no
 * mutating tool calls. The closing summary the model is told to produce after
 * edits always mentions drafts/publishing, which is the strongest tell.
 */
function claimsCompletionWithoutEdits(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b(drafts?|publish|reflow)\b/i.test(trimmed)) return true;
  if (/\b(here you go|all set|all done|good to go|you're all set|done!)\b/i.test(trimmed)) return true;
  if (/\b(i['’]ve|i have)\b[\s\S]{0,40}\b(added|updated|created|changed|applied|made|built|set|saved)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

/** Read-only tools that inspect state without changing it. Mirrors the client's
 * READONLY_TOOL_PREFIXES so the no-op guard only treats edits as "work done". */
function isReadOnlyTool(name: string): boolean {
  return ['get_', 'list_', 'export_', 'search_'].some((prefix) => name.startsWith(prefix));
}

/** Shown to the user when the chat is too large to fit the model's context even
 * after an aggressive trim — their pages are untouched; a new chat resets it. */
const OVERFLOW_MESSAGE =
  'This chat got too long for the model. Start a new chat to keep going — your pages are unchanged.';

/** Rough char-count proxy for a message's token cost (estimated ~chars/4). */
function estimateMessageChars(message: AgentMessage): number {
  let total = 0;
  for (const block of message.content) {
    if (block.type === 'text') total += block.text.length;
    else if (block.type === 'image') total += block.data.length;
    else if (block.type === 'tool_use') total += JSON.stringify(block.input).length;
    else if (block.type === 'tool_result') total += block.content.length;
  }
  return total;
}

/** Drop leading non-user messages so the conversation starts with a user turn
 * (Anthropic rejects histories that begin with an assistant message). */
function dropLeadingAssistants(messages: AgentMessage[]): AgentMessage[] {
  let start = 0;
  while (start < messages.length && messages[start].role !== 'user') start += 1;
  return start > 0 ? messages.slice(start) : messages;
}

/**
 * Bound the cross-turn history to a recent window: always keep the latest user
 * message, then walk backwards adding older messages until the message-count or
 * char budget is hit. Keeps the request well under the model's context window so
 * a long chat can't make the agent silently stop editing.
 */
function trimConversation(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= 1) return messages;

  const kept: AgentMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const isLast = i === messages.length - 1;
    const size = estimateMessageChars(messages[i]);
    if (!isLast && (kept.length >= MAX_HISTORY_MESSAGES || chars + size > MAX_HISTORY_CHARS)) {
      break;
    }
    kept.push(messages[i]);
    chars += size;
  }
  kept.reverse();
  return dropLeadingAssistants(kept);
}

/** Last-resort trim used after a context-overflow error: keep only the latest
 * exchange (mutates in place, preserving the snapshot on the final user turn). */
function hardTrimConversation(messages: AgentMessage[]): void {
  const trimmed = dropLeadingAssistants(messages.slice(Math.max(0, messages.length - 3)));
  messages.length = 0;
  messages.push(...trimmed);
}

/** Whether an error is the model rejecting the request because the prompt
 * exceeds its context window (a non-retryable 400 from Anthropic). */
function isContextOverflowError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('prompt is too long') || message.includes('context window')) return true;
  if (message.includes('too long') && message.includes('maximum')) return true;

  const status = (error as { status?: number })?.status;
  const type =
    (error as { error?: { type?: string } })?.error?.type ?? (error as { type?: string })?.type;
  return status === 400 && type === 'invalid_request_error' && message.includes('token');
}

/**
 * Prepend a compact snapshot of the active page's current layer tree to the
 * latest user message, so the agent always grounds its answer in what actually
 * exists on the page instead of trusting its own prior-turn claims (the failure
 * where it insisted a section existed that it never created).
 *
 * Injected into the user message (not the cached system prompt) so the large
 * static system block stays cache-friendly, and scoped to this turn only — it is
 * never folded back into the persisted conversation history.
 */
async function injectActivePageSnapshot(
  messages: AgentMessage[],
  pageId?: string | null,
): Promise<string | null> {
  if (!pageId) return null;

  let snapshot: string;
  try {
    const layers = await getCachedLayers(pageId);
    snapshot = compactToolResult('get_layers', JSON.stringify(layers));
  } catch (error) {
    console.error('[ai-agent] failed to load active page snapshot:', error);
    return null;
  }

  // Attach to the most recent user turn (the message we're responding to).
  const lastUserIndex = findLastIndex(messages, (message) => message.role === 'user');
  if (lastUserIndex === -1) return null;

  const block: AgentContentBlock = {
    type: 'text',
    text:
      `Current contents of the active page (id: ${pageId}) — this is the live source of truth right now. ` +
      `Trust it over anything said earlier in this conversation; do not claim an element exists or was already added unless it appears here:\n` +
      snapshot,
  };

  const target = messages[lastUserIndex];
  messages[lastUserIndex] = { ...target, content: [block, ...target.content] };
  return pageId;
}

/** A component's variants, backfilling a single "Default" entry for legacy
 * components that pre-date the variants migration (mirrors the client). */
function variantsOf(component: Component): ComponentVariant[] {
  if (component.variants && component.variants.length > 0) return component.variants;
  return [{ id: 'default', name: 'Default', layers: component.layers ?? [] }];
}

/**
 * Attach a compact snapshot of the component the user is currently editing to
 * the latest user turn, mirroring injectActivePageSnapshot. Gives the agent the
 * component's live layer tree so "this component" resolves and it edits the
 * right variant instead of guessing or touching the page.
 */
async function injectActiveComponentSnapshot(
  messages: AgentMessage[],
  componentId?: string | null,
  variantId?: string | null,
): Promise<void> {
  if (!componentId) return;

  let component: Component | null;
  try {
    component = await getComponentById(componentId);
  } catch (error) {
    console.error('[ai-agent] failed to load active component snapshot:', error);
    return;
  }
  if (!component) return;

  const variants = variantsOf(component);
  const activeVariant = variants.find((v) => v.id === variantId) ?? variants[0];
  // A component variant's `layers` is the same layer-tree shape as get_layers,
  // so reuse that compaction to project it down to id/type/name/text/classes.
  const snapshot = compactToolResult('get_layers', JSON.stringify(activeVariant.layers ?? []));

  const lastUserIndex = findLastIndex(messages, (message) => message.role === 'user');
  if (lastUserIndex === -1) return;

  const block: AgentContentBlock = {
    type: 'text',
    text:
      `Current contents of the "${component.name}" component (id: ${componentId}), variant "${activeVariant.name}" (id: ${activeVariant.id}) — this is the live source of truth right now. ` +
      `Trust it over anything said earlier in this conversation; do not claim an element exists unless it appears here:\n` +
      snapshot,
  };

  const target = messages[lastUserIndex];
  messages[lastUserIndex] = { ...target, content: [block, ...target.content] };
}

/** Array.prototype.findLastIndex isn't available on every runtime target. */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

/**
 * Stable per-node signature (excludes `children` so each layer is compared on
 * its own, not rolled up through its descendants). Mirrors the client helper so
 * the server and client count "changed layers" the same way.
 */
function layerSignatures(layers: Layer[], map = new Map<string, string>()): Map<string, string> {
  for (const layer of layers) {
    const { children, ...rest } = layer;
    map.set(layer.id, JSON.stringify(rest));
    if (children) layerSignatures(children, map);
  }
  return map;
}

/** Recursively collect every `page_id` referenced by a tool call's input
 * (handles nested `operations` arrays from `batch_operations`). */
function collectPageIdsFromInput(input: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'page_id' && typeof child === 'string') {
          ids.add(child);
        } else {
          walk(child);
        }
      }
    }
  };
  walk(input);
  return [...ids];
}

/** Tools that place a component instance on a page. They reference a
 * `component_id` but mutate the page tree, not the component definition, so they
 * are excluded from component-edit tracking. */
const COMPONENT_INSTANCE_TOOLS = new Set(['add_component_instance', 'replace_layer_with_component']);

/** Recursively collect every `component_id` referenced by a tool call's input
 * (handles nested `operations` arrays from update_component_layers). */
function collectComponentIdsFromInput(input: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'component_id' && typeof child === 'string') {
          ids.add(child);
        } else {
          walk(child);
        }
      }
    }
  };
  walk(input);
  return [...ids];
}

/** Diff two signature maps and count how many layers in `after` differ from
 * (or didn't exist in) `before`. */
function countChangedLayers(before: Map<string, string>, after: Map<string, string>): number {
  let count = 0;
  for (const [layerId, sig] of after) {
    if (before.get(layerId) !== sig) count += 1;
  }
  return count;
}

function buildSystemPrompt(context?: AgentEditorContext): string {
  const lines: string[] = [];
  if (context?.componentId) {
    lines.push(
      `The user is currently editing the component with ID "${context.componentId}"${context.variantId ? ` (variant "${context.variantId}")` : ''}. ` +
        `This is the active editing target — when they say "this component", "this", or "this section", they mean this component. ` +
        `Apply edits to it with the component tools (get_component, update_component_layers), NOT the page tools — page/layer tools cannot edit a component definition. ` +
        `A snapshot of this component's current layers is included with the user's message; treat it as the single source of truth and never claim an element exists unless it appears there. ` +
        `Only edit a page instead if the user explicitly asks to work on a page.`,
    );
  } else if (context?.pageId) {
    lines.push(
      `The user is currently editing the page with ID "${context.pageId}". This is the active page — apply all edits here by default and when they refer to "this page", use this ID. ` +
        `A snapshot of this page's current contents is included with the user's message. Treat that snapshot as the single source of truth for what exists right now. ` +
        `Never claim an element exists or was already added unless it appears in that snapshot — do not rely on what earlier messages in this conversation said you did. ` +
        `Only edit a different page if the user explicitly names another one.`,
    );
  }
  const selected = context?.selectedLayers?.length
    ? context.selectedLayers
    : context?.selectedLayerIds?.map((id) => ({ id, name: undefined }));

  if (selected && selected.length > 0) {
    const refs = selected
      .map((layer) => (layer.name ? `"${layer.name}" (id: ${layer.id})` : `id: ${layer.id}`))
      .join(', ');
    lines.push(
      `The user currently has these layer(s) selected: ${refs}. When they say "this", "this section", or "the selected element", they mean these layer(s). ` +
        `A selected layer is often a container/wrapper, not the exact element a change applies to — call get_layers and inspect its subtree, then apply each change to the descendant the property actually belongs to (e.g. text color/typography goes on the text/heading/button layer inside, not the wrapping div). ` +
        `If a change applies to several descendants, update all of them in one batch. Never ask the user to re-select a deeper element.`,
    );
  }

  if (context?.mentions && context.mentions.length > 0) {
    const byType = (type: string) =>
      context
        .mentions!.filter((mention) => mention.type === type)
        .map((mention) => `"${mention.label}" (id: ${mention.id})`)
        .join(', ');
    const parts: string[] = [];
    const pages = byType('page');
    const collections = byType('collection');
    const layers = byType('layer');
    const components = byType('component');
    if (pages) parts.push(`page(s): ${pages}`);
    if (collections) parts.push(`collection(s): ${collections}`);
    if (layers) parts.push(`layer(s): ${layers}`);
    if (components) parts.push(`component(s): ${components}`);
    if (parts.length > 0) {
      lines.push(`The user referenced ${parts.join('; ')}. Use these ids directly with the relevant tools.`);
    }
  }

  if (context?.referenceUrls && context.referenceUrls.length > 0) {
    const urls = context.referenceUrls.join(', ');
    lines.push(`The user referenced these URLs: ${urls}. You cannot browse the web, so do not invent their contents — use them as link destinations or literal content. If the user wants you to replicate a design from a URL, ask them to paste a screenshot instead.`);
  }

  let prompt = `${SYSTEM_INSTRUCTIONS}\n\n## In-app agent policy\n\n${AGENT_POLICY}\n\n## Tool output format\n\n${TOOL_OUTPUT_NOTE}`;
  if (lines.length > 0) {
    prompt += `\n\n## Current editor context\n\n${lines.join('\n')}`;
  }
  return prompt;
}
