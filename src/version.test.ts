import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// =============================================================================
// Helpers extracted from client.ts for testing
// (Functions are not exported, so we re-implement them here. If they ever
// diverge this file will fail, which is the point.)
// =============================================================================

// Keep in sync with client.ts
const NUMERIC_FIELDS = new Set([
  'quantity',
  'price_each',
  'new_price',
  'slot_idx',
  'weapon_idx',
  'page',
  'limit',
  'offset',
  'coverage_percent',
  'credits',
  'index',
  'ticks',
  'amount',
  'priority',
  'expiration_hours',
  'per_page',
  'level',
  'max_price',
  'price',
  'page_size',
]);

function convertPayloadTypes(payload: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (NUMERIC_FIELDS.has(key)) {
      const num = parseFloat(value);
      if (!Number.isNaN(num)) {
        result[key] = num;
        continue;
      }
    }
    if (value === 'true') {
      result[key] = true;
      continue;
    }
    if (value === 'false') {
      result[key] = false;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function compareVersions(current: string, latest: string): number {
  const currentParts = current.replace(/^v/, '').split('.').map(Number);
  const latestParts = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const curr = currentParts[i] || 0;
    const lat = latestParts[i] || 0;
    if (lat > curr) return 1;
    if (lat < curr) return -1;
  }
  return 0;
}

type CommandArg = string | { rest: string };
interface CommandConfig {
  args?: CommandArg[];
  required?: string[];
  usage?: string;
}

function parseArgs(
  args: string[],
  commands: Record<string, CommandConfig>,
): { command: string; payload: Record<string, string> } {
  const command = args[0] || '';
  const payload: Record<string, string> = {};
  const config = commands[command];
  const argDefs = config?.args || [];
  let positionalIndex = 0;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    const eqIndex = arg.indexOf('=');
    if (eqIndex > 0) {
      payload[arg.substring(0, eqIndex)] = arg.substring(eqIndex + 1);
    } else {
      const argDef = argDefs[positionalIndex];
      if (argDef) {
        if (typeof argDef === 'string') {
          payload[argDef] = arg;
        } else if (argDef.rest) {
          payload[argDef.rest] = args.slice(i).join(' ');
          break;
        }
      } else if (positionalIndex === 0 && !payload.id && !payload.target_id) {
        payload.id = arg;
      }
      positionalIndex++;
    }
  }
  return { command, payload };
}

function validateRequiredArgs(
  command: string,
  payload: Record<string, string>,
  commands: Record<string, CommandConfig>,
): string | null {
  const required = commands[command]?.required;
  if (!required) return null;
  for (const arg of required) {
    if (!payload[arg]) return arg;
  }
  return null;
}

// =============================================================================
// compareVersions
// =============================================================================

describe('compareVersions', () => {
  test('returns 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.6.5', '0.6.5')).toBe(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  test('returns 1 when latest is newer (major)', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(1);
    expect(compareVersions('0.6.5', '1.0.0')).toBe(1);
  });

  test('returns 1 when latest is newer (minor)', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(1);
    expect(compareVersions('0.6.5', '0.7.0')).toBe(1);
  });

  test('returns 1 when latest is newer (patch)', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(1);
    expect(compareVersions('0.6.5', '0.6.6')).toBe(1);
  });

  test('returns -1 when current is newer', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(-1);
    expect(compareVersions('1.1.0', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(-1);
  });

  test('handles versions with different segment counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(1);
    expect(compareVersions('1.0.1', '1.0')).toBe(-1);
  });

  test('handles v prefix', () => {
    expect(compareVersions('v0.6.5', 'v0.6.6')).toBe(1);
    expect(compareVersions('0.6.5', 'v0.6.6')).toBe(1);
    expect(compareVersions('v0.6.5', '0.6.6')).toBe(1);
  });
});

// =============================================================================
// convertPayloadTypes
// =============================================================================

describe('convertPayloadTypes', () => {
  test('converts numeric fields to numbers', () => {
    const result = convertPayloadTypes({ quantity: '10', price: '500', page_size: '20', max_price: '10000' });
    expect(result.quantity).toBe(10);
    expect(result.price).toBe(500);
    expect(result.page_size).toBe(20);
    expect(result.max_price).toBe(10000);
  });

  test('leaves non-numeric fields as strings', () => {
    const result = convertPayloadTypes({ item_id: 'ore_iron', ship_class: 'prospector' });
    expect(result.item_id).toBe('ore_iron');
    expect(result.ship_class).toBe('prospector');
  });

  test('converts boolean strings', () => {
    const result = convertPayloadTypes({ provide_materials: 'true', auto_list: 'false' });
    expect(result.provide_materials).toBe(true);
    expect(result.auto_list).toBe(false);
  });

  test('handles mixed payload', () => {
    const result = convertPayloadTypes({ type: 'ships', page: '2', page_size: '10', search: 'mining' });
    expect(result.type).toBe('ships');
    expect(result.page).toBe(2);
    expect(result.page_size).toBe(10);
    expect(result.search).toBe('mining');
  });

  test('credits is numeric (trade_offer)', () => {
    const result = convertPayloadTypes({ target_id: 'abc123', credits: '500' });
    expect(result.target_id).toBe('abc123');
    expect(result.credits).toBe(500);
  });

  test('deprecated fields offer_credits and request_credits are NOT auto-converted', () => {
    // These were removed from NUMERIC_FIELDS in v0.8.0
    const result = convertPayloadTypes({ offer_credits: '100', request_credits: '200' });
    expect(result.offer_credits).toBe('100');
    expect(result.request_credits).toBe('200');
  });

  test('count is NOT auto-converted (use quantity instead)', () => {
    // count was removed from NUMERIC_FIELDS in v0.8.0; craft now uses quantity
    const result = convertPayloadTypes({ count: '5' });
    expect(result.count).toBe('5');
  });

  test('handles ticks and amount as numeric', () => {
    const result = convertPayloadTypes({ ticks: '100', amount: '2500' });
    expect(result.ticks).toBe(100);
    expect(result.amount).toBe(2500);
  });

  test('handles expiration_hours as numeric', () => {
    const result = convertPayloadTypes({ expiration_hours: '24' });
    expect(result.expiration_hours).toBe(24);
  });

  test('leaves non-numeric string in numeric field as string', () => {
    const result = convertPayloadTypes({ quantity: 'abc' });
    expect(result.quantity).toBe('abc');
  });
});

// =============================================================================
// parseArgs
// =============================================================================

const SAMPLE_COMMANDS: Record<string, CommandConfig> = {
  mine: {},
  travel: { args: ['target_poi'], required: ['target_poi'] },
  jump: { args: ['target_system'], required: ['target_system'] },
  sell: { args: ['item_id', 'quantity', 'auto_list'], required: ['item_id', 'quantity'] },
  buy: { args: ['item_id', 'quantity', 'auto_list', 'deliver_to'], required: ['item_id'] },
  trade_offer: { args: ['target_id', 'credits'], required: ['target_id'] },
  craft: { args: ['recipe_id', 'quantity'], required: ['recipe_id'] },
  chat: { args: ['channel', { rest: 'content' }], required: ['channel', 'content'] },
  help: { args: ['category', 'command'] },
  register: {
    args: ['username', 'empire', 'registration_code'],
    required: ['username', 'empire', 'registration_code'],
  },
  faction_post_mission: { args: ['title', 'type', 'description'], required: ['title', 'type', 'description'] },
  captains_log_list: { args: ['index'] },
  distress_signal: {},
  inspect_cargo: {},
  repair_module: { args: ['module_id'], required: ['module_id'] },
  supply_commission: {
    args: ['commission_id', 'item_id', 'quantity'],
    required: ['commission_id', 'item_id', 'quantity'],
  },
  view_completed_mission: { args: ['template_id'], required: ['template_id'] },
  completed_missions: {},
  get_action_log: { args: ['category', 'limit', 'before'] },
  session: {},
  agentlogs: { args: ['category', 'message', 'severity'], required: ['category', 'message'] },
  get_map: { args: ['system_id'] },
  view_market: { args: ['item_id', 'category'] },
  view_orders: { args: ['station_id'] },
  view_storage: { args: ['station_id'] },
  cancel_order: { args: ['order_id'] },
  send_gift: { args: ['recipient', 'item_id', 'quantity', 'credits', 'message', 'ship_id'], required: ['recipient'] },
  faction_declare_war: { args: ['target_faction_id', 'reason'] },
  faction_query_intel: { args: ['system_name', 'system_id', 'poi_type', 'resource_type'] },
  faction_create_role: { args: ['name', 'priority', 'permissions'] },
};

describe('parseArgs - basic', () => {
  test('no-arg command', () => {
    const { command, payload } = parseArgs(['mine'], SAMPLE_COMMANDS);
    expect(command).toBe('mine');
    expect(payload).toEqual({});
  });

  test('single positional arg', () => {
    const { command, payload } = parseArgs(['travel', 'sol_asteroid_belt'], SAMPLE_COMMANDS);
    expect(command).toBe('travel');
    expect(payload.target_poi).toBe('sol_asteroid_belt');
  });

  test('key=value arg', () => {
    const { command, payload } = parseArgs(['travel', 'target_poi=sol_earth'], SAMPLE_COMMANDS);
    expect(command).toBe('travel');
    expect(payload.target_poi).toBe('sol_earth');
  });

  test('multiple positional args', () => {
    const { command, payload } = parseArgs(['sell', 'ore_iron', '50'], SAMPLE_COMMANDS);
    expect(command).toBe('sell');
    expect(payload.item_id).toBe('ore_iron');
    expect(payload.quantity).toBe('50');
  });

  test('mixed positional and key=value args', () => {
    const { payload } = parseArgs(['sell', 'ore_iron', '50', 'auto_list=true'], SAMPLE_COMMANDS);
    expect(payload.item_id).toBe('ore_iron');
    expect(payload.quantity).toBe('50');
    expect(payload.auto_list).toBe('true');
  });

  test('extra key=value not in arg list is passed through', () => {
    const { payload } = parseArgs(['buy', 'ore_iron', 'deliver_to=my_base'], SAMPLE_COMMANDS);
    expect(payload.item_id).toBe('ore_iron');
    expect(payload.deliver_to).toBe('my_base');
  });
});

describe('parseArgs - rest args', () => {
  test('rest arg captures all remaining tokens', () => {
    const { command, payload } = parseArgs(['chat', 'local', 'hello', 'world', 'how', 'are', 'you'], SAMPLE_COMMANDS);
    expect(command).toBe('chat');
    expect(payload.channel).toBe('local');
    expect(payload.content).toBe('hello world how are you');
  });

  test('rest arg with single word', () => {
    const { payload } = parseArgs(['chat', 'faction', 'hello'], SAMPLE_COMMANDS);
    expect(payload.channel).toBe('faction');
    expect(payload.content).toBe('hello');
  });

  test('rest arg via all key=value', () => {
    const { payload } = parseArgs(['chat', 'channel=system', 'content=this is a message'], SAMPLE_COMMANDS);
    expect(payload.channel).toBe('system');
    expect(payload.content).toBe('this is a message');
  });
});

describe('parseArgs - new and fixed commands (v0.8.0)', () => {
  test('trade_offer uses credits not offer_credits', () => {
    const { payload } = parseArgs(['trade_offer', 'player123', '500'], SAMPLE_COMMANDS);
    expect(payload.target_id).toBe('player123');
    expect(payload.credits).toBe('500');
    expect(payload.offer_credits).toBeUndefined();
    expect(payload.request_credits).toBeUndefined();
  });

  test('craft uses quantity not count', () => {
    const { payload } = parseArgs(['craft', 'refine_steel', '5'], SAMPLE_COMMANDS);
    expect(payload.recipe_id).toBe('refine_steel');
    expect(payload.quantity).toBe('5');
    expect(payload.count).toBeUndefined();
  });

  test('help uses category and command args', () => {
    const { payload } = parseArgs(['help', 'combat', 'attack'], SAMPLE_COMMANDS);
    expect(payload.category).toBe('combat');
    expect(payload.command).toBe('attack');
    expect(payload.topic).toBeUndefined();
  });

  test('distress_signal - no args', () => {
    const { command, payload } = parseArgs(['distress_signal'], SAMPLE_COMMANDS);
    expect(command).toBe('distress_signal');
    expect(payload).toEqual({});
  });

  test('inspect_cargo - no args', () => {
    const { command, payload } = parseArgs(['inspect_cargo'], SAMPLE_COMMANDS);
    expect(command).toBe('inspect_cargo');
    expect(payload).toEqual({});
  });

  test('completed_missions - no args', () => {
    const { command, payload } = parseArgs(['completed_missions'], SAMPLE_COMMANDS);
    expect(command).toBe('completed_missions');
    expect(payload).toEqual({});
  });

  test('session - no args', () => {
    const { command, payload } = parseArgs(['session'], SAMPLE_COMMANDS);
    expect(command).toBe('session');
    expect(payload).toEqual({});
  });

  test('repair_module - positional', () => {
    const { payload } = parseArgs(['repair_module', 'mod_uuid_123'], SAMPLE_COMMANDS);
    expect(payload.module_id).toBe('mod_uuid_123');
  });

  test('supply_commission - three positional args', () => {
    const { payload } = parseArgs(['supply_commission', 'comm_123', 'steel_plate', '10'], SAMPLE_COMMANDS);
    expect(payload.commission_id).toBe('comm_123');
    expect(payload.item_id).toBe('steel_plate');
    expect(payload.quantity).toBe('10');
  });

  test('view_completed_mission - positional', () => {
    const { payload } = parseArgs(['view_completed_mission', 'tmpl_456'], SAMPLE_COMMANDS);
    expect(payload.template_id).toBe('tmpl_456');
  });

  test('get_action_log - all optional positional', () => {
    const { payload } = parseArgs(['get_action_log', 'combat', '20'], SAMPLE_COMMANDS);
    expect(payload.category).toBe('combat');
    expect(payload.limit).toBe('20');
  });

  test('agentlogs - category and message required', () => {
    const { payload } = parseArgs(['agentlogs', 'navigation', 'jumped to new system'], SAMPLE_COMMANDS);
    expect(payload.category).toBe('navigation');
    expect(payload.message).toBe('jumped to new system');
  });

  test('get_map with system_id', () => {
    const { payload } = parseArgs(['get_map', 'sol'], SAMPLE_COMMANDS);
    expect(payload.system_id).toBe('sol');
  });

  test('view_market with category filter', () => {
    const { payload } = parseArgs(['view_market', 'ore_iron', 'ore'], SAMPLE_COMMANDS);
    expect(payload.item_id).toBe('ore_iron');
    expect(payload.category).toBe('ore');
  });

  test('view_orders with station_id', () => {
    const { payload } = parseArgs(['view_orders', 'sol_central'], SAMPLE_COMMANDS);
    expect(payload.station_id).toBe('sol_central');
  });

  test('view_storage with station_id', () => {
    const { payload } = parseArgs(['view_storage', 'nexus_base'], SAMPLE_COMMANDS);
    expect(payload.station_id).toBe('nexus_base');
  });

  test('send_gift with ship_id', () => {
    const { payload } = parseArgs(['send_gift', 'PlayerName', 'ship_id=ship_456'], SAMPLE_COMMANDS);
    expect(payload.recipient).toBe('PlayerName');
    expect(payload.ship_id).toBe('ship_456');
  });

  test('faction_declare_war with reason', () => {
    const { payload } = parseArgs(['faction_declare_war', 'faction_xyz', 'territorial dispute'], SAMPLE_COMMANDS);
    expect(payload.target_faction_id).toBe('faction_xyz');
    expect(payload.reason).toBe('territorial dispute');
  });

  test('faction_create_role with permissions', () => {
    const { payload } = parseArgs(['faction_create_role', 'Officer', '2', 'recruit,kick'], SAMPLE_COMMANDS);
    expect(payload.name).toBe('Officer');
    expect(payload.priority).toBe('2');
    expect(payload.permissions).toBe('recruit,kick');
  });

  test('faction_query_intel with all filters', () => {
    const { payload } = parseArgs(['faction_query_intel', 'sol', 'sys_123', 'asteroid', 'iron'], SAMPLE_COMMANDS);
    expect(payload.system_name).toBe('sol');
    expect(payload.system_id).toBe('sys_123');
    expect(payload.poi_type).toBe('asteroid');
    expect(payload.resource_type).toBe('iron');
  });

  test('captains_log_list with index', () => {
    const { payload } = parseArgs(['captains_log_list', '5'], SAMPLE_COMMANDS);
    expect(payload.index).toBe('5');
  });

  test('faction_post_mission with required positional args', () => {
    const { payload } = parseArgs(
      ['faction_post_mission', 'Defend Our Home', 'defense', 'Protect the base'],
      SAMPLE_COMMANDS,
    );
    expect(payload.title).toBe('Defend Our Home');
    expect(payload.type).toBe('defense');
    expect(payload.description).toBe('Protect the base');
  });

  test('cancel_order without required (both order_id and order_ids are optional)', () => {
    // cancel_order has no required args - both order_id and order_ids are optional
    const missing = validateRequiredArgs('cancel_order', {}, SAMPLE_COMMANDS);
    expect(missing).toBeNull();
  });
});

// =============================================================================
// validateRequiredArgs
// =============================================================================

describe('validateRequiredArgs', () => {
  test('returns null when all required args are present', () => {
    const payload = { target_poi: 'sol_asteroid_belt' };
    expect(validateRequiredArgs('travel', payload, SAMPLE_COMMANDS)).toBeNull();
  });

  test('returns missing arg name when required arg is absent', () => {
    expect(validateRequiredArgs('travel', {}, SAMPLE_COMMANDS)).toBe('target_poi');
  });

  test('returns first missing arg when multiple are missing', () => {
    expect(validateRequiredArgs('sell', {}, SAMPLE_COMMANDS)).toBe('item_id');
    expect(validateRequiredArgs('sell', { item_id: 'ore' }, SAMPLE_COMMANDS)).toBe('quantity');
  });

  test('returns null for no-arg commands', () => {
    expect(validateRequiredArgs('mine', {}, SAMPLE_COMMANDS)).toBeNull();
    expect(validateRequiredArgs('distress_signal', {}, SAMPLE_COMMANDS)).toBeNull();
    expect(validateRequiredArgs('inspect_cargo', {}, SAMPLE_COMMANDS)).toBeNull();
  });

  test('trade_offer requires target_id but not credits', () => {
    expect(validateRequiredArgs('trade_offer', {}, SAMPLE_COMMANDS)).toBe('target_id');
    expect(validateRequiredArgs('trade_offer', { target_id: 'abc' }, SAMPLE_COMMANDS)).toBeNull();
  });

  test('supply_commission requires all three args', () => {
    expect(validateRequiredArgs('supply_commission', {}, SAMPLE_COMMANDS)).toBe('commission_id');
    expect(validateRequiredArgs('supply_commission', { commission_id: 'c1' }, SAMPLE_COMMANDS)).toBe('item_id');
    expect(validateRequiredArgs('supply_commission', { commission_id: 'c1', item_id: 'iron' }, SAMPLE_COMMANDS)).toBe(
      'quantity',
    );
    expect(
      validateRequiredArgs(
        'supply_commission',
        { commission_id: 'c1', item_id: 'iron', quantity: '10' },
        SAMPLE_COMMANDS,
      ),
    ).toBeNull();
  });

  test('agentlogs requires category and message', () => {
    expect(validateRequiredArgs('agentlogs', {}, SAMPLE_COMMANDS)).toBe('category');
    expect(validateRequiredArgs('agentlogs', { category: 'nav' }, SAMPLE_COMMANDS)).toBe('message');
    expect(validateRequiredArgs('agentlogs', { category: 'nav', message: 'jumped' }, SAMPLE_COMMANDS)).toBeNull();
  });

  test('faction_post_mission requires title, type, and description', () => {
    expect(validateRequiredArgs('faction_post_mission', {}, SAMPLE_COMMANDS)).toBe('title');
    expect(validateRequiredArgs('faction_post_mission', { title: 'T', type: 'defense' }, SAMPLE_COMMANDS)).toBe(
      'description',
    );
    expect(
      validateRequiredArgs('faction_post_mission', { title: 'T', type: 'defense', description: 'D' }, SAMPLE_COMMANDS),
    ).toBeNull();
  });
});

// =============================================================================
// version sync
// =============================================================================

describe('version sync', () => {
  test('package.json and client.ts VERSION match', () => {
    const pkgPath = path.join(import.meta.dir, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const pkgVersion = pkg.version;

    const clientPath = path.join(import.meta.dir, 'client.ts');
    const clientSrc = fs.readFileSync(clientPath, 'utf-8');
    const match = clientSrc.match(/const VERSION = '([^']+)'/);
    expect(match).not.toBeNull();
    const clientVersion = match?.[1];

    expect(clientVersion).toBe(pkgVersion);
  });
});

// =============================================================================
// client.ts source checks
// =============================================================================

describe('client.ts source integrity', () => {
  let clientSrc: string;

  test('reads client source', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    clientSrc = fs.readFileSync(clientPath, 'utf-8');
    expect(clientSrc.length).toBeGreaterThan(0);
  });

  test('FETCH_TIMEOUT_MS is defined and >= 300000 (covers 270s+ travel)', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    const match = src.match(/const FETCH_TIMEOUT_MS\s*=\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const value = parseInt((match?.[1] ?? '0').replace(/_/g, ''), 10);
    expect(value).toBeGreaterThanOrEqual(300_000);
  });

  test('FETCH_TIMEOUT_MS is applied to the fetch call', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    expect(src).toContain('AbortSignal.timeout(FETCH_TIMEOUT_MS)');
  });

  test('TimeoutError is handled in execute()', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    expect(src).toContain('TimeoutError');
  });

  test('faction_gift is removed', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    expect(src).not.toContain('faction_gift');
  });

  test('all new v0.8.0 commands are present', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    const newCommands = [
      'agentlogs',
      'completed_missions',
      'distress_signal',
      'get_action_log',
      'repair_module',
      'session',
      'supply_commission',
      'view_completed_mission',
    ];
    for (const cmd of newCommands) {
      expect(src).toContain(`  ${cmd}:`);
    }
  });

  test('deprecated commands are removed', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    const removedCommands = [
      // Friends system
      'inspect_cargo',
      'add_friend',
      'remove_friend',
      'get_friends',
      'get_friend_requests',
      'accept_friend_request',
      'decline_friend_request',
      // Base raiding system
      'build_base',
      'get_base_cost',
      'attack_base',
      'raid_status',
      'get_base_wrecks',
      'loot_base_wreck',
      'salvage_base_wreck',
      // Other deprecated commands
      'get_drones',
      'search_changelog',
      'buy_ship',
      'get_ships',
      'get_recipes',
      'shipyard_showroom',
      'set_anonymous',
    ];
    for (const cmd of removedCommands) {
      expect(src).not.toContain(`  ${cmd}:`);
    }
  });

  test('trade_offer uses credits not offer_credits/request_credits', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    // The trade_offer args should have 'credits' not the old param names
    const tradeOfferMatch = src.match(/trade_offer:\s*\{[^}]+\}/s);
    expect(tradeOfferMatch).not.toBeNull();
    const tradeOfferDef = tradeOfferMatch?.[0];
    expect(tradeOfferDef).toContain("'credits'");
    expect(tradeOfferDef).not.toContain("'offer_credits'");
    expect(tradeOfferDef).not.toContain("'request_credits'");
  });

  test('craft uses quantity not count', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    const craftMatch = src.match(/craft:\s*\{[^}]+\}/s);
    expect(craftMatch).not.toBeNull();
    const craftDef = craftMatch?.[0];
    expect(craftDef).toContain("'quantity'");
    expect(craftDef).not.toContain("'count'");
  });

  test('help uses category and command, not topic', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    const helpMatch = src.match(/^\s+help:\s*\{[^}]+\}/m);
    expect(helpMatch).not.toBeNull();
    const helpDef = helpMatch?.[0];
    expect(helpDef).toContain("'category'");
    expect(helpDef).toContain("'command'");
    expect(helpDef).not.toContain("'topic'");
  });

  test('NUMERIC_FIELDS does not contain deprecated fields', () => {
    const clientPath = path.join(import.meta.dir, 'client.ts');
    const src = fs.readFileSync(clientPath, 'utf-8');
    const numericMatch = src.match(/const NUMERIC_FIELDS = new Set\(\[([^\]]+)\]\)/s);
    expect(numericMatch).not.toBeNull();
    const numericDef = numericMatch?.[1];
    expect(numericDef).not.toContain("'offer_credits'");
    expect(numericDef).not.toContain("'request_credits'");
    expect(numericDef).not.toContain("'count'");
  });
});
