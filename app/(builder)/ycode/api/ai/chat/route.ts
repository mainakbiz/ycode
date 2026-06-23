import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getAgentProvider, AgentConfigurationError } from '@/lib/agent/providers';
import { runAgent } from '@/lib/agent/runtime';
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
  selectedLayerIds: z.array(z.string()).optional(),
  selectedLayers: z.array(z.object({ id: z.string(), name: z.string().optional() })).optional(),
});

export async function POST(request: Request): Promise<Response> {
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
  // (once the stream starts, the HTTP status can no longer change).
  let provider, model;
  try {
    ({ provider, model } = await getAgentProvider());
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
            selectedLayerIds: parsed.selectedLayerIds,
            selectedLayers: parsed.selectedLayers,
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
