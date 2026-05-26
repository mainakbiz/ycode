import type { Knex } from 'knex';
import type { Layer } from '@/types';
import { getTiptapTextContent } from '@/lib/text-format-utils';
import { generatePageLayersHash } from '@/lib/hash-utils';

/**
 * Migration: Add password form layers to existing 401 error pages
 *
 * Earlier installs seeded the 401 system page with a non-editable hardcoded
 * password form (appended to the rendered output). The 401 page tree itself
 * contained only heading + description text. The renderer now expects an
 * editable form layer with `settings.form.form_type === 'password_protected'`
 * on the 401 page so users can restyle the input/button in the builder canvas.
 *
 * This migration injects the form/input/error-alert/submit-button subtree into
 * existing 401 pages (both draft + published page_layers rows). It is idempotent:
 * pages that already contain a password-protected form are skipped.
 */

interface LayerNode extends Layer {
  children?: LayerNode[];
}

function buildPasswordFormSubtree(): LayerNode {
  return {
    id: 'layer-1762789200000-pw-form',
    name: 'form',
    settings: {
      id: 'password-protected-form',
      form: { form_type: 'password_protected' },
    },
    attributes: { method: 'POST', action: '' },
    design: {
      layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '16' },
      sizing: { isActive: true, width: '100%' },
      spacing: { isActive: true, marginTop: '1rem' },
    },
    classes: 'w-full flex flex-col mt-[1rem] gap-[16px]',
    restrictions: { copy: false, delete: false },
    customName: 'Password form',
    children: [
      {
        id: 'layer-1762789200002-pw-error',
        name: 'div',
        alertType: 'error',
        hiddenGenerated: true,
        design: {
          backgrounds: { isActive: true, backgroundColor: '#fee2e2' },
          borders: { isActive: true, borderRadius: '0.75rem' },
          layout: { isActive: true, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
          sizing: { isActive: true, height: '38' },
          spacing: { isActive: true, paddingTop: '1rem', paddingBottom: '1rem', paddingLeft: '16', paddingRight: '16' },
          typography: { isActive: true, fontSize: '14px', color: '#991b1b', fontWeight: '500' },
        },
        classes: 'bg-[#fee2e2] text-[#991b1b] text-[14px] font-[500] rounded-[0.75rem] pr-[16px] pl-[16px] h-[38px] justify-center items-center flex flex-col',
        restrictions: { copy: false, delete: false },
        customName: 'Error alert',
        children: [
          {
            id: 'layer-1762789200003-pw-error-text',
            name: 'text',
            settings: { tag: 'span' },
            classes: '',
            design: {},
            children: [],
            customName: 'Message',
            restrictions: { editText: true },
            variables: {
              text: {
                type: 'dynamic_rich_text',
                data: {
                  content: getTiptapTextContent('Incorrect password. Please try again.'),
                },
              },
            },
          } as LayerNode,
        ],
      } as LayerNode,
      {
        id: 'layer-1762789200010-pw-row',
        name: 'div',
        design: {
          layout: { isActive: true, display: 'Flex', flexDirection: 'row', gap: '12', alignItems: 'stretch' },
          sizing: { isActive: true, width: '100%' },
        },
        classes: 'w-full flex flex-row items-stretch gap-[12px]',
        restrictions: { copy: false, delete: false },
        customName: 'Row',
        children: [
          {
            id: 'layer-1762789200001-pw-input',
            name: 'input',
            attributes: {
              type: 'password',
              name: 'password',
              placeholder: '',
              required: true,
              autoComplete: 'current-password',
            },
            settings: { id: 'password' },
            design: {
              sizing: { isActive: true, width: '100%', height: '38px' },
              spacing: { isActive: true, paddingLeft: '1rem', paddingRight: '1rem' },
              borders: { isActive: true, borderWidth: '1px', borderColor: 'rgba(115, 115, 115, 0.15)', borderRadius: '0.75rem' },
              typography: { isActive: true, fontSize: '14px', color: '#171717', lineHeight: '24px', letterSpacing: '0px', placeholderColor: '#a8a8a8' },
              backgrounds: { isActive: true, backgroundColor: 'rgba(212, 212, 212, 0.1)' },
            },
            classes: 'w-[100%] h-[38px] pl-[16px] pr-[16px] text-[14px] leading-[24px] tracking-[0px] text-[#171717] bg-[#d4d4d4]/10 border border-solid border-[#737373]/[0.15] rounded-[12px] placeholder:text-[#a8a8a8] focus:outline-none focus:border-[#737373]/20 disabled:opacity-50 cursor-text',
            children: [],
            restrictions: { copy: false, delete: false },
            customName: 'Password input',
          } as LayerNode,
          {
            id: 'layer-1762789200004-pw-submit',
            name: 'button',
            attributes: { type: 'submit' },
            design: {
              spacing: { isActive: true, paddingLeft: '16', paddingRight: '16' },
              backgrounds: { isActive: true, backgroundColor: '#171717' },
              typography: { isActive: true, color: '#ffffff', fontSize: '14px' },
            },
            classes: 'flex flex-row items-center justify-center text-[#FFFFFF] pr-[16px] pl-[16px] h-[38px] text-[14px] rounded-[12px] bg-[#171717] cursor-pointer',
            restrictions: { copy: false, delete: false },
            customName: 'Submit button',
            children: [
              {
                id: 'layer-1762789200005-pw-submit-text',
                name: 'text',
                settings: { tag: 'span' },
                classes: '',
                design: {},
                children: [],
                customName: 'Label',
                restrictions: { editText: true },
                variables: {
                  text: {
                    type: 'dynamic_rich_text',
                    data: {
                      content: getTiptapTextContent('Submit'),
                    },
                  },
                },
              } as LayerNode,
            ],
          } as LayerNode,
        ],
      } as LayerNode,
    ],
  } as LayerNode;
}

function hasPasswordFormLayer(layers: LayerNode[] | undefined): boolean {
  if (!layers || layers.length === 0) return false;
  for (const layer of layers) {
    if (layer.name === 'form' && (layer.settings as any)?.form?.form_type === 'password_protected') {
      return true;
    }
    if (layer.children && hasPasswordFormLayer(layer.children)) return true;
  }
  return false;
}

/**
 * Pick the deepest single-child flex container with `justifyContent: 'center'`
 * (matches the default 401 template's centred container). Falls back to the
 * 'body' layer if no such container is found so we always have a parent.
 */
function pickInsertionTarget(layers: LayerNode[]): LayerNode | null {
  let best: LayerNode | null = null;

  const walk = (nodes: LayerNode[]) => {
    for (const node of nodes) {
      const layout = (node.design as any)?.layout;
      const isCenteredFlex = layout?.display === 'Flex'
        && (layout?.justifyContent === 'center' || layout?.alignItems === 'center');
      if (isCenteredFlex) {
        best = node;
      }
      if (node.children) walk(node.children);
    }
  };
  walk(layers);

  if (best) return best;

  // Fallback: append directly under body
  const body = layers.find(l => l.id === 'body' || l.name === 'body');
  return body ?? null;
}

function injectPasswordForm(layers: LayerNode[]): LayerNode[] {
  if (hasPasswordFormLayer(layers)) return layers;

  // Deep clone so we don't mutate the input
  const cloned: LayerNode[] = JSON.parse(JSON.stringify(layers));
  const target = pickInsertionTarget(cloned);
  if (!target) return cloned;

  target.children = target.children || [];
  target.children.push(buildPasswordFormSubtree());
  return cloned;
}

export async function up(knex: Knex): Promise<void> {
  const hasPagesTable = await knex.schema.hasTable('pages');
  const hasPageLayersTable = await knex.schema.hasTable('page_layers');
  if (!hasPagesTable || !hasPageLayersTable) return;

  // Only target 401 system pages (both draft + published rows).
  const errorPages: Array<{ id: string }> = await knex('pages')
    .where({ error_page: 401 })
    .whereNull('deleted_at')
    .select('id');

  if (errorPages.length === 0) return;

  for (const page of errorPages) {
    const layerRows: Array<{ id: string; layers: any; generated_css: string | null; is_published: boolean }> =
      await knex('page_layers')
        .where({ page_id: page.id })
        .whereNull('deleted_at')
        .select('id', 'layers', 'generated_css', 'is_published');

    for (const row of layerRows) {
      let layers: LayerNode[];
      try {
        layers = typeof row.layers === 'string' ? JSON.parse(row.layers) : (row.layers as LayerNode[]);
      } catch {
        continue;
      }
      if (!Array.isArray(layers)) continue;

      if (hasPasswordFormLayer(layers)) continue; // idempotent — skip already-migrated

      const updated = injectPasswordForm(layers);
      const contentHash = generatePageLayersHash({
        layers: updated,
        generated_css: row.generated_css,
      });

      await knex('page_layers')
        .where({ id: row.id, is_published: row.is_published })
        .update({
          layers: JSON.stringify(updated),
          content_hash: contentHash,
          updated_at: knex.fn.now(),
        });
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Reversing this migration would risk wiping user customisations on top of
  // the injected form layers. Treat as forward-only.
}
