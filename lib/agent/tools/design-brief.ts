import { z } from 'zod';

import type { AgentTool } from './types';

/**
 * Plan-first creative direction for the in-app agent.
 *
 * Models produce a narrow band of safe, samey designs when they start building
 * immediately — committing to a direction BEFORE generating layers measurably
 * widens variety (the model can't fall back into its default groove mid-build).
 * `design_brief` makes that commitment an explicit, cheap tool call: the runtime
 * intercepts it (nothing is persisted) and, for full builds on a blank page,
 * refuses the first build call until a brief has been recorded (see runtime.ts).
 *
 * Agent-only, like load_tools — external MCP clients never see this tool.
 */

export const DESIGN_BRIEF_NAME = 'design_brief';

export function buildDesignBriefTool(): AgentTool {
  return {
    name: DESIGN_BRIEF_NAME,
    description:
      'Record your creative brief BEFORE building a new design from scratch (blank page / new site). '
      + 'Commit to one clear direction and then hold every section to it. '
      + 'Required before add_layout / batch_operations on a blank page.',
    inputSchema: {
      personality: z.string().describe('One-line personality, e.g. "bold brutalist", "warm editorial", "quiet luxury"'),
      palette: z.string().describe('Concrete colors: background, text, accent (hex values), and how they derive from the personality — not default gray'),
      typography: z.string().describe('Display + body font pairing and hero scale, e.g. "Clash Display 88px heroes / Inter 17px body"'),
      signature_move: z.string().describe('ONE recurring distinctive device (oversized type, asymmetry, overlap, full-bleed imagery, bordered grid) used 2-3 times across the page'),
      composition: z.string().describe('How at least TWO named sections break the standard centered-container pattern — e.g. "hero: asymmetric 60/40 split with overflowing image; pricing: middle card offset upward, full-bleed dark band". Templates cannot satisfy this — these sections must be hand-built'),
      sections: z.array(z.string()).optional().describe('Planned page sections in order'),
    },
    group: 'core',
    // Placeholder — the runtime intercepts design_brief calls and answers
    // directly (there is nothing to execute or persist).
    execute: async () => ({
      content: [{ type: 'text', text: 'Brief recorded.' }],
    }),
  };
}
