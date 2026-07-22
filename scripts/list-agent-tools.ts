/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Inspect the shared agent tool registry from the CLI.
 *
 *   npm run agent:tools              # list every tool + Anthropic conversion check
 *   npm run agent:tools -- create_page   # dump one tool's Anthropic schema
 *
 * The registry pulls in `server-only` modules (the tools run in a server route
 * handler at runtime), so we neutralize `server-only` for this standalone CLI.
 */
import Module from 'module';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

// Required AFTER the patch so the server-only modules load cleanly.
const { getAgentTools, getAgentToolMap } = require('@/lib/agent/tools/registry');
const { toAnthropicTool } = require('@/lib/agent/tools/to-anthropic');
const { buildLoadToolsTool } = require('@/lib/agent/tools/deferred');

interface AgentToolLike {
  name: string;
  description: string;
  group: string;
}

const requested = process.argv[2];

if (requested) {
  const tool = getAgentToolMap().get(requested);
  if (!tool) {
    console.error(`No tool named "${requested}".`);
    process.exit(1);
  }
  console.log(JSON.stringify(toAnthropicTool(tool), null, 2));
  process.exit(0);
}

const tools: AgentToolLike[] = getAgentTools();
console.log(`Shared agent registry: ${tools.length} tools\n`);

let converted = 0;
let payloadChars = 0;
const groupChars = new Map<string, number>();
const failures: string[] = [];
for (const tool of tools) {
  try {
    const chars = JSON.stringify(toAnthropicTool(tool)).length;
    payloadChars += chars;
    groupChars.set(tool.group, (groupChars.get(tool.group) ?? 0) + chars);
    converted += 1;
  } catch (err) {
    failures.push(`${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = tool.description.split('\n')[0].slice(0, 70);
  console.log(`  ${tool.name.padEnd(34)} ${tool.group.padEnd(12)} ${summary}`);
}

console.log(`\nAnthropic schema conversion: ${converted}/${tools.length} succeeded.`);
console.log(`Total Anthropic tools payload: ${payloadChars} chars (~${Math.round(payloadChars / 4)} tokens).`);
const loadToolsChars = JSON.stringify(toAnthropicTool(buildLoadToolsTool())).length;
const coreChars = (groupChars.get('core') ?? 0) + loadToolsChars;
console.log(`Sent up front (core + load_tools): ${coreChars} chars (~${Math.round(coreChars / 4)} tokens).`);
console.log('Per group:');
for (const [group, chars] of [...groupChars.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${group.padEnd(14)} ${String(chars).padStart(7)} chars (~${Math.round(chars / 4)} tokens)`);
}
if (failures.length > 0) {
  console.log('Failures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('Tip: npm run agent:tools -- <tool_name> to see a single tool\'s Anthropic schema.');
