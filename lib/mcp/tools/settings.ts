import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAgentSecretSettingKey } from '@/lib/agent/config';
import { getAllSettings, getSettingByKey, setSetting, setSettings } from '@/lib/repositories/settingsRepository';

export function registerSettingsTools(server: McpServer) {
  server.tool(
    'get_settings',
    'Get all site settings or a specific setting by key. Settings include site_name, site_description, custom_css, redirects, etc.',
    {
      key: z.string().optional().describe('Specific setting key to retrieve. Omit to get all settings.'),
    },
    async ({ key }) => {
      if (key) {
        const value = isAgentSecretSettingKey(key) ? '[redacted]' : await getSettingByKey(key);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ key, value }, null, 2),
          }],
        };
      }

      const settings = await getAllSettings();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(settings.map((s) => ({
            key: s.key,
            value: isAgentSecretSettingKey(s.key) ? '[redacted]' : s.value,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_setting',
    'Set a site setting value. Creates the setting if it does not exist, updates it otherwise.',
    {
      key: z.string().describe('Setting key (e.g. "site_name", "site_description", "custom_css")'),
      value: z.unknown().describe('Setting value (string, number, boolean, or object)'),
    },
    async ({ key, value }) => {
      const setting = await setSetting(key, value);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Setting "${key}" saved`, setting }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'set_settings_batch',
    'Set multiple site settings at once. Pass null as value to delete a setting.',
    {
      settings: z.record(z.string(), z.unknown()).describe('Object of key-value pairs to set. Use null to delete a key.'),
    },
    async ({ settings }) => {
      const count = await setSettings(settings);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Updated ${count} setting(s)`, count }, null, 2),
        }],
      };
    },
  );
}
