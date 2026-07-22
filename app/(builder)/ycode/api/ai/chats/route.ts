import { getAllAiChatSummaries } from '@/lib/repositories/aiChatRepository';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/ai/chats
 *
 * Lists all saved AI chats as lightweight summaries (id, title, updated_at) —
 * transcripts are fetched lazily per chat via /ycode/api/ai/chats/[id].
 * Auth is enforced by the editor proxy (all /ycode/api routes require a session).
 */
export async function GET() {
  try {
    const chats = await getAllAiChatSummaries();

    return noCache({ data: chats });
  } catch (error) {
    console.error('[GET /ycode/api/ai/chats] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch AI chats' },
      500
    );
  }
}
