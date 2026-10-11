/**
 * Output under the visibility rules: get_system POIs carry ship_count only with
 * a ship scanner (the old `online` field is gone), and get_system_agents is
 * deprecated (empty list plus a warning).
 */

import { describe, expect, test } from 'bun:test';
import { resultFormatters } from './client';

function render(name: string, result: Record<string, unknown>): { matched: boolean; out: string } {
  const formatter = resultFormatters.find((f) => f.name === name);
  if (!formatter) throw new Error(`${name} formatter not found`);
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    return { matched: formatter.format(result), out: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

const system = (pois: Array<Record<string, unknown>>) => ({
  system: { id: 'sol', name: 'Sol', police_level: 100, pois, connections: [] },
});

describe('get_system ship_count', () => {
  test('prints ship_count when present, including 0', () => {
    const { out } = render(
      'system_info',
      system([
        { id: 'sol_belt', name: 'Belt', type: 'asteroid_belt', ship_count: 3 },
        { id: 'sol_moon', name: 'Moon', type: 'moon', ship_count: 0 },
      ]),
    );
    expect(out).toContain('(3 ships)');
    expect(out).toContain('(0 ships)');
  });

  test('prints no count without a scanner', () => {
    const { out } = render('system_info', system([{ id: 'sol_belt', name: 'Belt', type: 'asteroid_belt' }]));
    expect(out).not.toContain('ships)');
    expect(out).not.toContain('undefined');
  });
});

describe('get_system_agents deprecation', () => {
  test('prints the warning', () => {
    const { matched, out } = render('system_agents_deprecated', {
      agents: [],
      count: 0,
      system_id: 'sol',
      warning: 'get_system_agents is deprecated and will be removed.',
    });
    expect(matched).toBe(true);
    expect(out).toContain('get_system_agents is deprecated');
  });

  test('declines a non-empty list so the raw JSON still shows it', () => {
    const { matched } = render('system_agents_deprecated', { agents: [{ username: 'x' }], warning: 'w' });
    expect(matched).toBe(false);
  });
});
