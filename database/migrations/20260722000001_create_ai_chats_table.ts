import { Knex } from 'knex';

/**
 * Migration: Create ai_chats table
 *
 * Server-side storage for AI builder chat history, replacing the previous
 * per-browser localStorage persistence. Chats are project-scoped and visible
 * to everyone with builder access, survive browser data clearing, and are
 * wiped by a project reset (which drops all public tables).
 *
 * `messages` holds the stripped chat transcript (text, tool calls, parts,
 * mentions — no image data or revert checkpoints) as a JSON array, mirroring
 * what the client previously persisted locally. No `is_published` column:
 * chats aren't publishable content and never appear on the live site.
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('ai_chats');
  if (exists) {
    return;
  }

  await knex.schema.createTable('ai_chats', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('title', 255).notNullable().defaultTo('New chat');
    table.jsonb('messages').notNullable().defaultTo('[]');
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    // History list is ordered by most recent activity
    table.index('updated_at');
  });

  // Enable Row Level Security
  await knex.schema.raw('ALTER TABLE ai_chats ENABLE ROW LEVEL SECURITY');

  // Authenticated-only for every operation — chat history must never be
  // readable through the public anon key.
  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can view ai chats"
      ON ai_chats FOR SELECT
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can insert ai chats"
      ON ai_chats FOR INSERT
      WITH CHECK ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can update ai chats"
      ON ai_chats FOR UPDATE
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);

  await knex.schema.raw(`
    CREATE POLICY "Authenticated users can delete ai chats"
      ON ai_chats FOR DELETE
      USING ((SELECT auth.uid()) IS NOT NULL)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can view ai chats" ON ai_chats');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can insert ai chats" ON ai_chats');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can update ai chats" ON ai_chats');
  await knex.schema.raw('DROP POLICY IF EXISTS "Authenticated users can delete ai chats" ON ai_chats');

  await knex.schema.dropTableIfExists('ai_chats');
}
