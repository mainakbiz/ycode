import type { z } from 'zod';

/**
 * Result returned by every Ycode agent tool.
 *
 * Mirrors the shape MCP tool callbacks return (`{ content, isError? }`) so the
 * same handlers can power both the MCP server and the in-app agent runtime.
 */
export interface AgentToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

/**
 * Framework-agnostic descriptor for a single site-building tool.
 *
 * One set of descriptors powers two front doors:
 *  - the MCP server (external agents like Cursor / Claude Code), via createMcpServer
 *  - the in-app agent runtime (BYOK or hosted), called in-process
 *
 * The descriptors are collected from the existing MCP tool registration
 * functions (see registry.ts), so MCP and the in-app agent never diverge.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** Zod raw shape — the same object passed to MCP's `server.tool(...)`. */
  inputSchema: z.ZodRawShape;
  /** Validate `args` against `inputSchema`, then run the underlying handler. */
  execute: (args: Record<string, unknown>) => Promise<AgentToolResult>;
  /** Deferred-loading group. Only `core` tools are sent to the model up front. */
  group: AgentToolGroup;
}

/**
 * Tool groups for deferred loading. `core` tools are always sent to the model;
 * every other group is withheld until the agent asks for it via `load_tools`,
 * cutting the fixed tool-schema payload roughly in half for typical requests.
 */
export type AgentToolGroup = 'core' | 'cms' | 'components' | 'styles' | 'animations' | 'localization' | 'site';
