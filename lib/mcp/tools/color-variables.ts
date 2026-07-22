import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getAllColorVariables,
  createColorVariable,
  updateColorVariable,
  deleteColorVariable,
  reorderColorVariables,
} from '@/lib/repositories/colorVariableRepository';
import { broadcastColorVariablesChanged } from '@/lib/mcp/broadcast';

export function registerColorVariableTools(server: McpServer) {
  server.tool(
    'list_color_variables',
    'List all color variables (design tokens). These are CSS custom properties available site-wide for consistent colors.',
    {},
    async () => {
      const variables = await getAllColorVariables();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(variables.map((v) => ({
            id: v.id,
            name: v.name,
            value: v.value,
            sort_order: v.sort_order,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'create_color_variable',
    'Create a new color variable (design token). Use format "#hex" or "#hex/opacity" (e.g. "#3b82f6/80" for 80% opacity). Reference in designs as "var(--<id>)".',
    {
      name: z.string().describe('Variable name (e.g. "Primary", "Accent", "Background")'),
      value: z.string().describe('Color value in "#hex" or "#hex/opacity" format (e.g. "#3b82f6", "#000000/50")'),
    },
    async ({ name, value }) => {
      const variable = await createColorVariable({ name, value });
      await broadcastColorVariablesChanged();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: `Created color variable "${name}"`,
            variable,
            usage: `Use var(--${variable.id}) in design properties`,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'update_color_variable',
    'Update a color variable name or value.',
    {
      variable_id: z.string().describe('The color variable ID'),
      name: z.string().optional().describe('New variable name'),
      value: z.string().optional().describe('New color value in "#hex" or "#hex/opacity" format'),
    },
    async ({ variable_id, name, value }) => {
      const updates: Record<string, string> = {};
      if (name !== undefined) updates.name = name;
      if (value !== undefined) updates.value = value;

      const variable = await updateColorVariable(variable_id, updates);
      await broadcastColorVariablesChanged();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Updated color variable "${variable.name}"`, variable }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'delete_color_variable',
    'Delete a color variable. Layers referencing it will lose the variable binding.',
    {
      variable_id: z.string().describe('The color variable ID to delete'),
    },
    async ({ variable_id }) => {
      await deleteColorVariable(variable_id);
      await broadcastColorVariablesChanged();
      return {
        content: [{ type: 'text' as const, text: `Color variable ${variable_id} deleted successfully.` }],
      };
    },
  );

  server.tool(
    'reorder_color_variables',
    'Reorder color variables by providing the full list of IDs in the desired order.',
    {
      ordered_ids: z.array(z.string()).describe('Array of all color variable IDs in desired order'),
    },
    async ({ ordered_ids }) => {
      await reorderColorVariables(ordered_ids);
      await broadcastColorVariablesChanged();
      return {
        content: [{ type: 'text' as const, text: `Reordered ${ordered_ids.length} color variables.` }],
      };
    },
  );
}
