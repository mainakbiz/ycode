import { SYSTEM_INSTRUCTIONS } from '@/lib/mcp/instructions';
import { DEFAULT_MAX_TOKENS, MAX_TOOL_TURNS } from '@/lib/agent/config';
import { compactToolResult } from '@/lib/agent/tools/compact-result';
import { getAgentToolMap, getAgentTools } from '@/lib/agent/tools/registry';

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
  selectedLayerIds?: string[];
  /** Selected layers with display names — preferred over bare ids when present. */
  selectedLayers?: Array<{ id: string; name?: string }>;
  /** Pages/collections/layers the user @-mentioned in the message. */
  mentions?: Array<{ type: 'page' | 'collection' | 'layer'; id: string; label: string }>;
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
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }
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
  const tools = getAgentTools();
  const toolMap = getAgentToolMap();

  const messages: AgentMessage[] = [...options.messages];
  const usage = new UsageTotals();
  let totalToolCalls = 0;
  let noOpCorrectionUsed = false;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const assistantBlocks: AgentContentBlock[] = [];
    const toolUses: AgentToolUseBlock[] = [];
    let text = '';
    let stopReason: string | null = null;

    for await (const event of provider.streamMessage({ system, messages, tools, model, maxTokens, signal })) {
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

    if (text.trim()) {
      assistantBlocks.push({ type: 'text', text });
    }
    assistantBlocks.push(...toolUses);
    messages.push({ role: 'assistant', content: assistantBlocks });
    totalToolCalls += toolUses.length;

    if (toolUses.length === 0) {
      // Safety net: the model ended the run without ever calling a tool but its
      // reply claims the work is done ("saved as drafts…"). Nudge it once to
      // actually perform the edits rather than leaving the user stuck.
      if (!noOpCorrectionUsed && totalToolCalls === 0 && claimsCompletionWithoutEdits(text)) {
        noOpCorrectionUsed = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: NO_OP_CORRECTION }] });
        continue;
      }
      usage.log(model, turn + 1);
      yield usage.toEvent();
      yield { type: 'done', stopReason };
      return;
    }

    const results: AgentToolResultBlock[] = [];
    for (const call of toolUses) {
      const result = await executeTool(toolMap, call);
      results.push(result);
      yield { type: 'tool_result', id: call.id, name: call.name, ok: !result.isError };
    }

    messages.push({ role: 'user', content: results });
  }

  usage.log(model, MAX_TOOL_TURNS);
  yield usage.toEvent();
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

  add(usage?: AgentUsage): void {
    if (!usage) return;
    this.input += usage.inputTokens;
    this.output += usage.outputTokens;
    this.cacheWrite += usage.cacheCreationInputTokens ?? 0;
    this.cacheRead += usage.cacheReadInputTokens ?? 0;
  }

  log(model: string, turns: number): void {
    const totalInput = this.input + this.cacheWrite + this.cacheRead;
    const hitRate = totalInput > 0 ? Math.round((this.cacheRead / totalInput) * 100) : 0;
    console.info(
      `[ai-agent] usage model=${model} turns=${turns} ` +
        `input=${this.input} output=${this.output} ` +
        `cache_write=${this.cacheWrite} cache_read=${this.cacheRead} ` +
        `cache_hit=${hitRate}%`,
    );
  }

  /** Serialize the totals for this user message into a client-facing event. */
  toEvent(): RuntimeEvent {
    return {
      type: 'usage',
      inputTokens: this.input,
      outputTokens: this.output,
      cacheWriteTokens: this.cacheWrite,
      cacheReadTokens: this.cacheRead,
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
 * The shared instructions tell the agent to `publish` as the final step of a
 * build. That is wrong for the in-app builder, which is draft-first: the user
 * reviews edits on the canvas and clicks Publish themselves. The `publish` tool
 * is also withheld from the in-app toolset (see registry.ts), so this is belt
 * and suspenders — it stops the agent from claiming it published.
 */
const AGENT_POLICY = [
  'Never publish. The user controls publishing — they review your changes on the canvas and click the Publish button when ready.',
  'Do not call any publish tool and do not tell the user their changes are live. Leave everything as drafts.',
  'Only describe edits you actually performed with tools. If you intend to make changes, call the tools to make them in the same turn — never reply that something is done, saved, or drafted unless you have already called the tools that did it.',
  'When you have finished making edits, briefly summarise what you changed and remind the user they can publish when ready. If you have not made any edits yet, do not send that summary — make the edits first (or ask one specific clarifying question if the request is unclear).',
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
  'To change styling, call update_layer_design with only the categories you want — it merges into existing design, so you never need to resend the full design.';

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
 * detect the no-op failure above, so it is gated on the turn having made zero
 * tool calls. The closing summary the model is told to produce after edits
 * always mentions drafts/publishing, which is the strongest tell.
 */
function claimsCompletionWithoutEdits(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b(drafts?|publish|reflow)\b/i.test(trimmed)) return true;
  if (/\b(i['’]ve|i have)\b[\s\S]{0,40}\b(added|updated|created|changed|applied|made|built|set|saved)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

function buildSystemPrompt(context?: AgentEditorContext): string {
  const lines: string[] = [];
  if (context?.pageId) {
    lines.push(`The user is currently editing page with ID "${context.pageId}". When they refer to "this page", use this ID.`);
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
    if (pages) parts.push(`page(s): ${pages}`);
    if (collections) parts.push(`collection(s): ${collections}`);
    if (layers) parts.push(`layer(s): ${layers}`);
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
