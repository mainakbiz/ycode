import { Knex } from 'knex';

/**
 * Migration: Widen collection_fields.default from varchar(255) to text
 *
 * Rich text field defaults are stored as serialized TipTap JSON, which easily
 * exceeds 255 characters. The column must accept free-form text of any length.
 *
 * Idempotent: only alters the column when it is still length-limited.
 */
export async function up(knex: Knex): Promise<void> {
  const result = await knex.raw(`
    SELECT character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'collection_fields' AND column_name = 'default'
  `);

  const maxLength: number | null = result?.rows?.[0]?.character_maximum_length ?? null;

  if (maxLength !== null) {
    await knex.raw(`
      ALTER TABLE collection_fields
      ALTER COLUMN "default" TYPE text;
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  const result = await knex.raw(`
    SELECT character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'collection_fields' AND column_name = 'default'
  `);

  const maxLength: number | null = result?.rows?.[0]?.character_maximum_length ?? null;

  if (maxLength === null) {
    // Truncate any values longer than 255 chars so the column can shrink back.
    await knex.raw(`
      UPDATE collection_fields
      SET "default" = LEFT("default", 255)
      WHERE "default" IS NOT NULL AND LENGTH("default") > 255;
    `);

    await knex.raw(`
      ALTER TABLE collection_fields
      ALTER COLUMN "default" TYPE varchar(255);
    `);
  }
}
