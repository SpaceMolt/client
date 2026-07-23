/**
 * Regression test for gh#1874 — get_wrecks output printed "undefined" for the
 * wreck id and expiry because the formatter read fields the server never emits
 * (`wreck_id`, `ticks_remaining`, `items`). The server emits `id`, `expire_tick`
 * / `expires_at`, and `cargo`.
 */

import { describe, expect, test } from 'bun:test';
import { resultFormatters } from './client';

const wrecksFormatter = resultFormatters.find((f) => f.name === 'wrecks');
if (!wrecksFormatter) throw new Error('wrecks formatter not found');

function render(result: Record<string, unknown>): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    wrecksFormatter.format(result);
  } finally {
    console.log = orig;
  }
  // Colour codes wrap whole tokens, so the asserted substrings stay contiguous.
  return lines.join('\n');
}

describe('get_wrecks formatter (gh#1874)', () => {
  test('renders the real server fields, never the literal "undefined"', () => {
    const out = render({
      wrecks: [
        {
          id: 'wreck_abc123',
          ship_class: 'eviction_notice',
          expire_tick: 0, // ship/pirate/abandoned wrecks never expire
          cargo: [{ item_id: 'titanium_ore', quantity: 12 }],
        },
      ],
    });

    expect(out).not.toContain('undefined');
    expect(out).toContain('Wreck: wreck_abc123');
    expect(out).toContain('Ship: eviction_notice');
    expect(out).toContain('Expires: never');
    expect(out).toContain('12x titanium_ore');
  });

  test('shows a finite expiry for jettisoned containers that do expire', () => {
    const out = render({
      wrecks: [
        {
          id: 'wreck_junk',
          ship_class: 'jettison',
          expire_tick: 1500,
          expires_at: '2026-07-23T00:00:00Z',
          cargo: [],
        },
      ],
    });

    expect(out).not.toContain('undefined');
    expect(out).toContain('Expires at: 2026-07-23T00:00:00Z');
  });

  test('handles the empty-wrecks case', () => {
    const out = render({ wrecks: [] });
    expect(out).toContain('No wrecks at this location');
  });
});
