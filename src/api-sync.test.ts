/**
 * API sync test — verifies that the commands in client.ts match the live server.
 *
 * Catches two classes of drift:
 *   - Stale commands: in client.ts but not in the server API (hard fail)
 *   - Missing commands: in the server API but not in client.ts (hard fail)
 *
 * Run with: bun test src/api-sync.test.ts
 * Skip with: SKIP_API_SYNC=1 bun test
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OPENAPI_URL = 'https://game.spacemolt.com/api/openapi.json';

// Server endpoints confirmed to exist but not yet documented in the OpenAPI spec.
// Verify periodically with: curl -s https://game.spacemolt.com/api/openapi.json | jq '.paths | keys'
const UNDOCUMENTED_IN_SPEC = new Set([
  // Unified interface commands
  'get_location', // Returns rich location data despite not being in spec
  'storage', // Unified deposit/withdraw/view interface

  // Station credit management
  'deposit_credits',
  'withdraw_credits',

  // Drone commands
  'deploy_drone',
  'recall_drone',
  'order_drone',

  // v2 state commands (experimental)
  'get_state',
  'v2_get_player',
  'v2_get_ship',
  'v2_get_cargo',
  'v2_get_missions',
  'v2_get_queue',
  'v2_get_skills',
]);

/**
 * Extracts the command names from the COMMANDS block in client.ts.
 * Parses only lines within the COMMANDS const (lines 87–505), not notification
 * handlers or other objects that share the same 2-space key format.
 */
function extractClientCommands(src: string): string[] {
  // Isolate the COMMANDS block — from its opening brace to the closing `};`
  // at column 0, stopping before ERROR_HELP
  const start = src.indexOf('const COMMANDS:');
  const end = src.indexOf('\nconst ERROR_HELP');
  if (start === -1 || end === -1) throw new Error('Could not locate COMMANDS block in client.ts');

  const block = src.slice(start, end);
  // Match 2-space-indented top-level keys: `  keyname: {` or `  keyname: (`
  const matches = [...block.matchAll(/^\s{2}([a-z][a-z0-9_]+):\s*[{(]/gm)];
  return matches.map((m) => m[1]);
}

const skip = process.env.SKIP_API_SYNC === '1';

describe('api sync', () => {
  test.skipIf(skip)(
    'client.ts COMMANDS matches live OpenAPI spec',
    async () => {
      const clientPath = path.join(import.meta.dir, 'client.ts');
      const src = fs.readFileSync(clientPath, 'utf-8');
      const clientCommands = new Set(extractClientCommands(src));

      // Fetch the live OpenAPI spec
      const resp = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(10_000) });
      if (resp.status === 429) {
        console.log('[SKIP] OpenAPI spec rate-limited (429) — skipping API sync check');
        return;
      }
      expect(resp.status, `Failed to fetch OpenAPI spec: HTTP ${resp.status}`).toBe(200);
      const spec = (await resp.json()) as { paths: Record<string, unknown> };

      // All spec paths are POST endpoints at /<command>
      const apiEndpoints = new Set(Object.keys(spec.paths).map((p) => p.replace(/^\//, '')));

      // Add undocumented endpoints that we've verified exist on the server
      for (const cmd of UNDOCUMENTED_IN_SPEC) apiEndpoints.add(cmd);

      // Hard fail: commands in client that don't exist in the API
      const staleCommands = [...clientCommands].filter((cmd) => !apiEndpoints.has(cmd));
      expect(
        staleCommands,
        `Stale commands in client.ts (not in server API):\n  ${staleCommands.join('\n  ')}\n\nRemove these or move them to UNDOCUMENTED_IN_SPEC if they exist but aren't in the spec.`,
      ).toEqual([]);

      // Hard fail: API endpoints missing from client
      const missingCommands = [...apiEndpoints].filter((cmd) => !clientCommands.has(cmd));
      expect(
        missingCommands,
        `API endpoints missing from client.ts:\n  ${missingCommands.join('\n  ')}\n\nAdd these to COMMANDS in client.ts.`,
      ).toEqual([]);
    },
    15_000,
  );
});
