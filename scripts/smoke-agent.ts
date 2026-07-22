/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Smoke-test the in-app AI agent end to end from the CLI.
 *
 *   npm run agent:smoke                 # provider + streaming check (no DB writes)
 *   npm run agent:smoke -- --full <pageId>   # full tool-calling loop (reads via tools)
 *
 * Requires ANTHROPIC_API_KEY in the environment or .env. Mirrors the runtime path
 * used by app/(builder)/ycode/api/ai/chat/route.ts so a green run here means the
 * live panel should work too.
 *
 * The agent pulls in `server-only` modules, so we neutralize that for the CLI.
 */
import fs from 'fs';
import Module from 'module';
import path from 'path';

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'server-only') return {};
  return origLoad.call(this, request, parent, isMain);
};

// Minimal .env loader (no dotenv dependency). Only fills vars that aren't set.
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnv();

const { getAgentProvider, AgentConfigurationError } = require('@/lib/agent/providers');
const { runAgent } = require('@/lib/agent/runtime');

async function providerCheck(): Promise<void> {
  console.log('→ Resolving provider...');
  const { provider, model } = await getAgentProvider();
  console.log(`✓ Provider "${provider.id}" ready (model: ${model})`);

  console.log('→ Streaming a minimal no-tools message...');
  const controller = new AbortController();
  let text = '';
  let stopReason: string | null = null;

  for await (const event of provider.streamMessage({
    system: 'You are a test harness. Follow instructions exactly.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Respond with exactly the word PONG and nothing else.' }] }],
    tools: [],
    model,
    maxTokens: 64,
    signal: controller.signal,
  })) {
    if (event.type === 'text_delta') {
      text += event.text;
      process.stdout.write(event.text);
    } else if (event.type === 'message_stop') {
      stopReason = event.stopReason;
    }
  }

  process.stdout.write('\n');
  console.log(`✓ Stream complete (stopReason: ${stopReason}). Received ${text.length} chars.`);
  if (!text.trim()) {
    throw new Error('Provider returned no text — check the model id and API key.');
  }
  console.log('\n✅ Provider + streaming OK.');
}

async function fullLoop(pageId: string | undefined): Promise<void> {
  console.log('→ Resolving provider...');
  const { provider, model } = await getAgentProvider();
  console.log(`✓ Provider "${provider.id}" ready (model: ${model})`);

  const prompt = pageId
    ? 'List the layers on the current page using the available tools, then reply with a one-sentence summary. Do not modify anything.'
    : 'List all pages in this project using the available tools, then reply with how many pages there are. Do not modify anything.';

  console.log(`→ Running full agent loop${pageId ? ` (pageId: ${pageId})` : ''}...\n`);

  const controller = new AbortController();
  let toolCalls = 0;
  for await (const event of runAgent({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    context: { pageId: pageId ?? null },
    signal: controller.signal,
  })) {
    switch (event.type) {
      case 'text':
        process.stdout.write(event.text);
        break;
      case 'tool_call':
        toolCalls += 1;
        console.log(`\n  [tool_call] ${event.name} ${JSON.stringify(event.input)}`);
        break;
      case 'tool_result':
        console.log(`  [tool_result] ${event.name} → ${event.ok ? 'ok' : 'ERROR'}`);
        break;
      case 'done':
        console.log(`\n\n✓ Done (stopReason: ${event.stopReason}, tool calls: ${toolCalls}).`);
        break;
      case 'error':
        throw new Error(event.message);
    }
  }
  console.log('\n✅ Full agent loop OK.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const pageId = args.find((a) => !a.startsWith('--'));

  try {
    if (full) {
      await fullLoop(pageId);
    } else {
      await providerCheck();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AgentConfigurationError) {
      console.error(`\n✗ ${message}`);
    } else {
      console.error(`\n✗ Smoke test failed: ${message}`);
    }
    process.exit(1);
  }
}

void main();
