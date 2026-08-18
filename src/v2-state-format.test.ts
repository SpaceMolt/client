/**
 * Regression test for gh#1961 — `v2_get_player` printed only "OK: Player status"
 * and dropped the whole player object.
 *
 * The server answers v2 query commands with a V2GameState blob that carries one
 * populated section plus a `message` string, so the wire JSON has exactly two
 * keys. The `simple_message` formatter matched anything with a `message` and at
 * most two keys, so it consumed the response, printed the status line and
 * returned true — the raw-JSON fallback in displayResult never ran.
 *
 * The same two-key shape hit `v2_get_missions` and `v2_get_queue`.
 * `v2_get_skills` was already rendered by the skills formatter; it is covered
 * here to keep it that way.
 */

import { describe, expect, test } from 'bun:test';
import { displayResult, resultFormatters } from './client';

/** Runs the formatter chain the way displayResult does and captures the output. */
function render(result: Record<string, unknown>): { out: string; matched: string | null } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  let matched: string | null = null;
  try {
    for (const formatter of resultFormatters) {
      if (formatter.format(result)) {
        matched = formatter.name;
        break;
      }
    }
  } finally {
    console.log = orig;
  }
  return { out: lines.join('\n'), matched };
}

/** Runs the real displayResult so drift warnings (console.error) are captured too. */
function display(command: string, result: Record<string, unknown>): { out: string; err: string } {
  const lines: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  console.error = (...args: unknown[]) => errs.push(args.join(' '));
  try {
    displayResult(command, result);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: lines.join('\n'), err: errs.join('\n') };
}

const playerResponse = {
  player: {
    id: 'eab8300a3ae45517f2626cc384da63a2',
    username: 'Cassia Wrenfield',
    empire: 'nebula',
    credits: 81929234,
    status_message: 'hauling',
    clan_tag: 'WREN',
    is_cloaked: false,
    home_base: 'haven_station',
    stats: { credits_earned: 91000000, ships_destroyed: 3 },
    // Real wire shape of apiresponses.EmpireStanding — reputation/baseline/
    // outstanding_bounty/jailed_until, not a made-up standing/level pair.
    standings: { nebula: { reputation: 42, baseline: 10, outstanding_bounty: 0 } },
    citizenships: ['nebula'],
  },
  message: 'Player status',
};

/** Real V2Ship wire shape (gameserver internal/handlers/v2state.go). */
const v2Ship = {
  id: 'sh_1',
  class_id: 'kestrel',
  class_name: 'Kestrel',
  name: 'Wren Runner',
  hull: 420,
  max_hull: 500,
  shield: 180,
  max_shield: 200,
  shield_recharge: 4,
  armor: 60,
  speed: 12,
  fuel: 88,
  max_fuel: 120,
  cargo_used: 40,
  cargo_capacity: 200,
  cpu_used: 30,
  cpu_capacity: 60,
  power_used: 25,
  power_capacity: 50,
  weapon_slots: 2,
  defense_slots: 2,
  utility_slots: 3,
};

/**
 * The full v2_get_state blob. Note the V2Player shape: no current_system,
 * current_poi or docked_at_base — location lives in its own `location`
 * section. Reading the v1 names off this player is what printed
 * "System: undefined" and "Docked: No" while docked at Haven Station.
 */
const fullStateResponse = {
  version: '2',
  player: playerResponse.player,
  ship: v2Ship,
  modules: [
    {
      module_id: 'm_1',
      type_id: 'mining_laser_2',
      name: 'Mining Laser II',
      type: 'mining',
      slot: 'utility',
      size: 1,
      wear: 0.1,
      wear_status: 'good',
      cpu_usage: 5,
      power_usage: 4,
    },
  ],
  cargo: [{ item_id: 'veldspar', item_name: 'Veldspar', quantity: 40, size: 1 }],
  location: {
    system_id: 'haven',
    system_name: 'Haven',
    empire: 'nebula',
    security_status: 'high',
    connections: ['drift', 'orin'],
    poi_id: 'haven_station_poi',
    poi_name: 'Haven Station',
    poi_type: 'station',
    docked_at: 'haven_station',
    resources: [],
    nearby_players: [],
    nearby_player_count: 0,
    nearby_pirates: [],
    nearby_pirate_count: 0,
    nearby_empire_npcs: [],
    nearby_empire_npc_count: 0,
  },
  missions: {
    active: [{ mission_id: 'm1', title: 'Haul ore to Haven', status: 'active', progress: '2/5' }],
    max_missions: 3,
  },
  queue: { has_pending: false },
  skills: {
    mining: { name: 'Mining', category: 'Industry', level: 37, max_level: 50, xp: 1200, next_level_xp: 1500 },
  },
  message: 'Current state',
};

describe('v2 state formatter (gh#1961)', () => {
  test('v2_get_player renders the player block instead of swallowing it', () => {
    const { out, matched } = render(playerResponse);
    expect(matched).toBe('v2_state');
    expect(out).toContain('Cassia Wrenfield');
    expect(out).toContain('81929234');
    expect(out).toContain('nebula');
    expect(out).toContain('haven_station');
    expect(out).not.toContain('undefined');
  });

  test('standings render the real reputation/baseline fields, not a placeholder', () => {
    const { out } = render(playerResponse);
    expect(out).toContain('42');
    expect(out).toContain('baseline 10');
    // The pre-fix code read s.standing/s.level, which do not exist on the wire
    // and rendered every empire as "?".
    expect(out).not.toContain('nebula: ?');
  });

  test('v2_get_missions renders active missions', () => {
    const { out, matched } = render({
      missions: {
        active: [{ mission_id: 'm1', title: 'Haul ore to Haven', status: 'active', progress: '2/5' }],
        max_missions: 3,
      },
      message: 'Active missions',
    });
    expect(matched).not.toBe('simple_message');
    expect(out).toContain('Haul ore to Haven');
    expect(out).toContain('3');
  });

  test('v2_get_queue renders the pending-action flag', () => {
    const { out, matched } = render({ queue: { has_pending: true }, message: 'Action queue' });
    expect(matched).not.toBe('simple_message');
    expect(out.toLowerCase()).toContain('pending');
  });

  test('v2_get_skills still renders through the skills formatter', () => {
    const { out, matched } = render({
      skills: {
        mining: { name: 'Mining', category: 'Industry', level: 37, max_level: 50, xp: 1200, next_level_xp: 1500 },
      },
      message: 'Skills progress',
    });
    expect(matched).not.toBe('simple_message');
    expect(out).toContain('Mining');
    expect(out).toContain('37');
  });

  test('a real bare message still uses simple_message', () => {
    const { out, matched } = render({ message: 'Docked at Haven Station' });
    expect(matched).toBe('simple_message');
    expect(out).toContain('Docked at Haven Station');
  });

  test('simple_message ignores the auto-dock flags when counting keys', () => {
    const { matched } = render({ message: 'Undocked', auto_undocked: true });
    expect(matched).toBe('simple_message');
  });

  test('simple_message no longer eats a two-key payload that carries data', () => {
    const { matched } = render({ message: 'Something', unrecognized_block: { a: 1 } });
    expect(matched).toBe(null);
  });

  test('v2_state declines a blob carrying a section it cannot render', () => {
    // A delta with player + riding must not be claimed: v2_state would print
    // the player block and silently drop `riding`, which is gh#1961 again.
    // Falling through gets the player the raw JSON plus a drift warning.
    // The fixture carries `ship` so that `player_status` is a live candidate:
    // without it the test passed for the wrong reason (player_status declined
    // on the missing ship, never exercising the allowlist).
    // `riding` is the real V2Riding wire shape — ship_id + carrier, no `owner`.
    const { matched } = render({
      ...playerResponse,
      ship: v2Ship,
      unrecognised_future_section: { a: 1 },
      riding: { ship_id: 's1', carrier: 'Molt' },
    });
    expect(matched).toBe(null);
  });

  // Regression A — every credits-changing mutation comes back through the
  // delta wrapper, which always sets `details` to the handler's own result.
  // A `details` key outside the allowlist made sell/buy/refuel/repair dump raw
  // JSON and raise a false [DRIFT WARNING], which destroys the drift signal.
  test('a delta carrying details renders cleanly with no drift warning', () => {
    const sellDelta = {
      player: { ...playerResponse.player, credits: 82000000 },
      details: { item_id: 'veldspar', quantity: 40, unit_price: 1750, total: 70000 },
      message: 'Sold 40 Veldspar for 70000 credits',
    };
    const { matched } = render(sellDelta);
    expect(matched).toBe('v2_state');

    const { out, err } = display('v2_sell', sellDelta);
    expect(err).not.toContain('DRIFT WARNING');
    expect(out).not.toContain('=== Response ===');
    expect(out).toContain('Sold 40 Veldspar');
    expect(out).toContain('70000');
    expect(out).toContain('82000000');
  });

  // Regression B — player_status ran ~750 lines before v2_state and guarded
  // only on player+ship, so it claimed the real v2_get_state blob, dropped
  // every other section and printed v1 field names that do not exist on
  // V2Player ("System: undefined", "Docked: No" while docked).
  test('the full v2_get_state blob is not claimed by player_status', () => {
    const { matched } = render(fullStateResponse);
    expect(matched).toBe('v2_state');
  });

  test('the full v2_get_state blob renders every section with no undefined', () => {
    const { out, err } = display('v2_get_state', fullStateResponse);
    expect(err).not.toContain('DRIFT WARNING');
    expect(out).not.toContain('=== Response ===');
    expect(out).not.toContain('undefined');
    // player
    expect(out).toContain('Cassia Wrenfield');
    // ship
    expect(out).toContain('Wren Runner');
    expect(out).toContain('420/500');
    // location — the docked state must be right, not "No"
    expect(out).toContain('Haven Station');
    expect(out).toContain('haven_station');
    expect(out).not.toContain('Docked: No');
    // modules, cargo, missions, queue, skills, version
    expect(out).toContain('Mining Laser II');
    expect(out).toContain('Veldspar');
    expect(out).toContain('Haul ore to Haven');
    expect(out.toLowerCase()).toContain('pending');
    expect(out).toContain('Mining');
    expect(out).toContain('Level 37');
  });

  test('v1 player_status still renders through player_status', () => {
    const { out, matched } = render({
      player: {
        username: 'Cassia Wrenfield',
        empire: 'nebula',
        credits: 500,
        current_system: 'haven',
        current_poi: 'haven_station_poi',
        docked_at_base: 'haven_station',
      },
      ship: { ...v2Ship, cargo_used: 0 },
      system: { name: 'Haven' },
      poi: { name: 'Haven Station' },
    });
    expect(matched).toBe('player_status');
    expect(out).toContain('Haven Station');
    expect(out).toContain('Docked: Yes (haven_station)');
  });
});
