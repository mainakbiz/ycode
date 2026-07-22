import { NextRequest } from 'next/server';
import { z } from 'zod';

import {
  deleteAiChat,
  getAiChatById,
  upsertAiChat,
} from '@/lib/repositories/aiChatRepository';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /ycode/api/ai/chats/[id]
 *
 * GET    — full chat including its transcript.
 * PUT    — upsert (chat ids are client-generated UUIDs, so create and update
 *          share one code path). Replaces the whole transcript; called once
 *          per completed turn / chat switch, never during streaming.
 * DELETE — remove a chat from history.
 *
 * Auth is enforced by the editor proxy (all /ycode/api routes require a session).
 */

const upsertSchema = z.object({
  title: z.string().min(1).max(255),
  // Transcript entries are owned by the client store (ChatMessage); the server
  // only verifies each entry is an object and stores them as opaque JSON.
  messages: z.array(z.record(z.string(), z.unknown())),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chat = await getAiChatById(id);

    if (!chat) {
      return noCache({ error: 'Chat not found' }, 404);
    }

    return noCache({ data: chat });
  } catch (error) {
    console.error('[GET /ycode/api/ai/chats/[id]] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch AI chat' },
      500
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const parsed = upsertSchema.safeParse(body);
    if (!parsed.success) {
      return noCache({ error: 'Invalid chat payload' }, 400);
    }

    await upsertAiChat({
      id,
      title: parsed.data.title,
      messages: parsed.data.messages,
    });

    // No row echo: the client already holds the transcript it just sent, and
    // returning the jsonb would double the per-save transfer on long chats.
    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[PUT /ycode/api/ai/chats/[id]] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to save AI chat' },
      500
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    await deleteAiChat(id);

    return noCache({ data: { success: true } });
  } catch (error) {
    console.error('[DELETE /ycode/api/ai/chats/[id]] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to delete AI chat' },
      500
    );
  }
}
