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
import { resultFormatters } from './client';

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
    const { matched } = render({ ...playerResponse, riding: { ship_id: 's1', owner: 'Molt' } });
    expect(matched).toBe(null);
  });
});
