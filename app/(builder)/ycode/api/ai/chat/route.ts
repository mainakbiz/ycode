import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getAgentProvider, AgentConfigurationError } from '@/lib/agent/providers';
import { runAgent } from '@/lib/agent/runtime';
import { getAuthUser } from '@/lib/supabase-auth';
import type { AgentContentBlock, AgentMessage } from '@/lib/agent/providers/types';

/**
 * POST /ycode/api/ai/chat
 *
 * Runs the in-app AI builder for one user turn and streams the result as SSE.
 * Tool mutations are applied in-process via the shared registry and propagate to
 * the live canvas through the existing MCP broadcast channels.
 *
 * Auth is enforced by the editor proxy (all /ycode/api routes require a session).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Lightweight in-process rate limiter. The editor is single-tenant per instance,
 * so a global sliding window is enough to bound runaway cost from rapid-fire
 * requests. (Cloud applies its own per-tenant limits in the overlay.)
 */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT_MAX) return true;
  requestTimestamps.push(now);
  return false;
}

const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mediaType: z.string(), data: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('tool_result'), toolUseId: z.string(), content: z.string(), isError: z.boolean().optional() }),
]);

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1),
  pageId: z.string().nullish(),
  componentId: z.string().nullish(),
  variantId: z.string().nullish(),
  selectedLayerIds: z.array(z.string()).optional(),
  selectedLayers: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional(),
  mentions: z
    .array(z.object({ type: z.enum(['page', 'collection', 'layer', 'component']), id: z.string(), label: z.string() }))
    .optional(),
  referenceUrls: z.array(z.string()).optional(),
  model: z.string().optional(),
});

export async function POST(request: Request): Promise<Response> {
  if (isRateLimited()) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment and try again.' },
      { status: 429 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request body' },
      { status: 400 },
    );
  }

  // Resolve the provider before streaming so a missing key returns a clean 400
  // (once the stream starts, the HTTP status can no longer change). The
  // client-chosen model is honored only if it's allowed, enabled, and served
  // by a provider with a key — getAgentProvider falls back to the default
  // model (and its provider) otherwise.
  let provider, model;
  try {
    // Resolve keys as the requesting user so personal (only-me) keys apply.
    const auth = await getAuthUser();
    ({ provider, model } = await getAgentProvider(parsed.model, auth?.user.id));
  } catch (error) {
    if (error instanceof AgentConfigurationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to initialize AI provider' }, { status: 500 });
  }

  const messages: AgentMessage[] = parsed.messages.map((message) => ({
    role: message.role,
    content: normalizeContent(message.content),
  }));

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  request.signal.addEventListener('abort', () => abortController.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of runAgent({
          provider,
          model,
          messages,
          context: {
            pageId: parsed.pageId,
            componentId: parsed.componentId,
            variantId: parsed.variantId,
            selectedLayerIds: parsed.selectedLayerIds,
            selectedLayers: parsed.selectedLayers,
            mentions: parsed.mentions,
            referenceUrls: parsed.referenceUrls,
          },
          signal: abortController.signal,
        })) {
          send(event);
        }
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Agent run failed' });
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function normalizeContent(content: string | AgentContentBlock[]): AgentContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}
