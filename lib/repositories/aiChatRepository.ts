/**
 * AI Chat Repository
 *
 * Data access layer for AI builder chat history. Chats are project-scoped and
 * team-visible: the builder has no per-user identity, so every conversation is
 * shared by everyone with builder access.
 *
 * Performance notes:
 * - The history list only ever needs id/title/updated_at, so summaries are
 *   fetched without the `messages` jsonb column and full transcripts are
 *   loaded lazily per chat.
 * - Chat ids are client-generated UUIDs, so create and update share a single
 *   upsert code path (one round-trip per completed turn, never per token).
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import type { AiChat, AiChatSummary, UpsertAiChatData } from '@/types';

/** Fetch all chats without their transcripts, newest activity first. */
export async function getAllAiChatSummaries(tenantId?: string): Promise<AiChatSummary[]> {
  const client = await getSupabaseAdmin(tenantId);

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('ai_chats')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch AI chats: ${error.message}`);
  }

  return data || [];
}

/** Fetch a single chat including its full transcript. */
export async function getAiChatById(id: string, tenantId?: string): Promise<AiChat | null> {
  const client = await getSupabaseAdmin(tenantId);

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('ai_chats')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to fetch AI chat: ${error.message}`);
  }

  return data;
}

/**
 * Create or update a chat (client-generated id), replacing its transcript.
 * Deliberately returns nothing: the caller already holds the transcript it just
 * sent, and echoing the jsonb row back would double the per-save transfer on
 * long conversations.
 */
export async function upsertAiChat(chatData: UpsertAiChatData, tenantId?: string): Promise<void> {
  const client = await getSupabaseAdmin(tenantId);

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { error } = await client
    .from('ai_chats')
    .upsert(
      {
        id: chatData.id,
        title: chatData.title,
        messages: chatData.messages,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

  if (error) {
    throw new Error(`Failed to save AI chat: ${error.message}`);
  }
}

export async function deleteAiChat(id: string, tenantId?: string): Promise<void> {
  const client = await getSupabaseAdmin(tenantId);

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { error } = await client
    .from('ai_chats')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete AI chat: ${error.message}`);
  }
}
