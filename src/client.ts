#!/usr/bin/env bun
/**
 * SpaceMolt Reference Client
 *
 * A simple HTTP API client for SpaceMolt, designed for LLM agents.
 * Stores session in ./.spacemolt-session.json (current working directory)
 *
 * Usage:
 *   spacemolt <command> [key=value ...] or [positional args]
 *
 * Examples:
 *   spacemolt register myname solarian <registration_code>
 *   spacemolt login myname abc123...
 *   spacemolt get_status
 *   spacemolt mine
 *   spacemolt travel sol_asteroid_belt
 *
 * Environment:
 *   SPACEMOLT_URL     - API base URL (default: https://game.spacemolt.com/api/v1)
 *   SPACEMOLT_SESSION - Session file path (default: ./.spacemolt-session.json)
 *   DEBUG             - Enable verbose logging (default: false)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// =============================================================================
// Configuration
// =============================================================================

const API_BASE = process.env.SPACEMOLT_URL || 'https://game.spacemolt.com/api/v1';
const DEBUG = process.env.DEBUG === 'true';
const VERSION = '0.9.0';
// Mutations block until the server tick resolves. Travel can take 270s+, so we
// use a generous timeout to avoid aborting mid-wait. 600s covers the longest
// known travel times with plenty of headroom.
const FETCH_TIMEOUT_MS = 600_000;
const GITHUB_REPO = 'SpaceMolt/client';
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** Apply 24-bit ANSI foreground (primary) and background (secondary) from hex color strings. */
function hexColor(text: string, fg?: string, bg?: string): string {
  if (!fg && !bg) return text;
  const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  let prefix = '';
  if (fg) {
    const [r, g, b] = hex(fg);
    prefix += `\x1b[38;2;${r};${g};${b}m`;
  }
  if (bg) {
    const [r, g, b] = hex(bg);
    prefix += `\x1b[48;2;${r};${g};${b}m`;
  }
  return `${prefix}${text}${c.reset}`;
}

/** Format a player entry for display (used by get_nearby and get_location). */
function formatPlayer(p: Record<string, unknown>): string {
  const rawName = p.anonymous ? '[Anonymous]' : (p.username as string);
  const name = hexColor(rawName, p.primary_color as string, p.secondary_color as string);
  const faction = p.faction_tag ? ` [${p.faction_tag}]` : '';
  const status = p.status_message ? ` - "${p.status_message}"` : '';
  const combat = p.in_combat ? ` ${c.red}[IN COMBAT]${c.reset}` : '';
  const ship = p.ship_class ? ` (${p.ship_class})` : '';
  return `${name}${faction}${ship}${status}${combat}`;
}

/** Print an item list as an aligned table with ID, Name, Qty, and Unit Size columns. */
function printItemTable(items: Array<Record<string, unknown>>, indent = '  '): void {
  console.log(`${c.bright}Items (${items.length}):${c.reset}`);
  if (!items.length) {
    console.log(`${indent}(Empty)`);
    return;
  }
  console.log('');
  // Compute column widths
  const idW = Math.max(2, ...items.map((i) => String(i.item_id || '').length));
  const nameW = Math.max(4, ...items.map((i) => String(i.name || i.item_id || '').length));
  const qtyW = Math.max(3, ...items.map((i) => String(i.quantity ?? '').length));
  const sizeW = Math.max(9, ...items.map((i) => String(i.size ?? '').length));

  const hdr = `${indent}${'Name'.padEnd(nameW)} | ${'ID'.padEnd(idW)} | ${'Qty'.padStart(qtyW)} | ${'Unit Size'.padStart(sizeW)}`;
  const sep = `${indent}${'-'.repeat(nameW)}-+-${'-'.repeat(idW)}-+-${'-'.repeat(qtyW)}-+-${'-'.repeat(sizeW)}`;
  console.log(hdr);
  console.log(sep);
  for (const item of items) {
    const name = String(item.name || item.item_id || '').padEnd(nameW);
    const id = String(item.item_id || '').padEnd(idW);
    const qty = String(item.quantity ?? '').padStart(qtyW);
    const size = String(item.size ?? '').padStart(sizeW);
    console.log(`${indent}${name} | ${id} | ${qty} | ${size}`);
  }
}

// =============================================================================
// Types
// =============================================================================

interface Session {
  id: string;
  created_at: string;
  expires_at: string;
  username?: string;
  password?: string;
  player_id?: string;
}

interface APIResponse {
  result?: Record<string, unknown>;
  notifications?: Array<{ type: string; msg_type?: string; data: unknown; timestamp: string }>;
  session?: { id: string; player_id?: string; created_at: string; expires_at: string };
  error?: { code: string; message: string; wait_seconds?: number };
}

type CommandArg = string | { rest: string };

interface CommandConfig {
  args?: CommandArg[]; // Positional argument names in order
  required?: string[]; // Required args for validation
  usage?: string; // Usage hint for help
}

// =============================================================================
// Command Configuration
// =============================================================================

const COMMANDS: Record<string, CommandConfig> = {
  // Authentication
  register: {
    args: ['username', 'empire', 'registration_code'],
    required: ['username', 'empire', 'registration_code'],
    usage: '<username> <empire> <registration_code>  (get code from spacemolt.com/dashboard)',
  },
  login: { args: ['username', 'password'], required: ['username', 'password'], usage: '<username> <password>' },
  logout: {},
  claim: {
    args: ['registration_code'],
    required: ['registration_code'],
    usage: '<registration_code>  (link existing player to your account)',
  },
  login_link: {},
  login_link_poll: {
    args: ['device_code'],
    required: ['device_code'],
    usage: '<device_code>  (poll a browser login started with login_link)',
  },

  // Navigation
  travel: { args: ['target_poi'], required: ['target_poi'], usage: '<poi_id>  (use get_system to see POIs)' },
  jump: {
    args: ['target_system'],
    required: ['target_system'],
    usage: '<system_id>  (use get_system to see connections)',
  },
  dock: {},
  undock: {},
  search_systems: {
    args: ['query'],
    required: ['query'],
    usage: '<query>  (case-insensitive partial match on system names)',
  },
  find_route: {
    args: ['target_system'],
    required: ['target_system'],
    usage: '<system_id>  (find shortest route from current system)',
  },

  // Mining
  mine: {},

  // Combat
  attack: { args: ['target_id'], required: ['target_id'], usage: '<player_id>  (use get_nearby to see players)' },
  scan: { args: ['target_id'], required: ['target_id'], usage: '<player_id>' },
  cloak: { args: ['enable'] },
  self_destruct: {},
  hunt: {
    args: ['target_id'],
    required: ['target_id'],
    usage: "<creature_id>  (use get_nearby to see the 'creatures' list)",
  },

  // Trading
  sell: {
    args: ['item_id', 'quantity', 'auto_list'],
    required: ['item_id', 'quantity'],
    usage: '<item_id> <quantity> [auto_list=true]  (use get_cargo to see items)',
  },
  buy: {
    args: ['item_id', 'quantity', 'auto_list', 'deliver_to'],
    required: ['item_id'],
    usage: '<item_id> [quantity] [auto_list=true] [deliver_to=base_id]  (use view_market to see order book)',
  },

  // P2P Trading
  trade_offer: {
    args: ['target_id', 'credits'],
    required: ['target_id'],
    usage: '<player_id> [credits=N] [items=...]  (use get_trades to see pending offers)',
  },
  trade_accept: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>  (use get_trades to see offers)' },
  trade_decline: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },
  trade_cancel: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },

  // Wrecks
  loot_wreck: {
    args: ['wreck_id', 'item_id', 'quantity'],
    required: ['wreck_id', 'item_id'],
    usage: '<wreck_id> <item_id> [quantity]  (use get_wrecks to see wrecks)',
  },
  // NOTE: salvage_wreck was removed server-side. Use loot_wreck in the field, or
  // tow_wreck -> sell_wreck (credits) / scrap_wreck (materials) at a salvage yard.

  // Ship management
  name_ship: { args: ['name'], required: ['name'], usage: '<name>  (set a custom name for your current ship)' },
  // NOTE: sell_ship was removed server-side. Use list_ship_for_sale (player market),
  // sell_ship_to_order (fill a standing buy order), or scrap_ship (no credits).
  list_ships: {},
  switch_ship: {
    args: ['ship_id'],
    required: ['ship_id'],
    usage: '<ship_id>  (switch to a stored ship at current base, use list_ships to see)',
  },
  refit_ship: {},
  scrap_ship: {
    args: ['ship_id'],
    required: ['ship_id'],
    usage: '<ship_id>  (permanently destroy a stored ship, no credits; cargo/modules go to storage)',
  },
  install_mod: {
    args: ['module_id'],
    required: ['module_id'],
    usage: '<module_id>  (module must be in cargo, use get_cargo to see)',
  },
  uninstall_mod: {
    args: ['module_id'],
    required: ['module_id'],
    usage: '<module_id>  (use get_ship to see installed modules)',
  },
  repair_module: {
    args: ['module_id'],
    required: ['module_id'],
    usage: '<module_id>  (use get_ship to see modules, requires Repair Kit in cargo)',
  },
  refuel: { args: ['item_id', 'quantity'] },
  repair: {},
  use_item: {
    args: ['item_id', 'quantity'],
    required: ['item_id'],
    usage: '<item_id> [quantity]  (consumables: repair_kit, shield_cell, emergency_warp, etc.)',
  },

  // Insurance
  set_home_base: { args: ['base_id'], required: ['base_id'], usage: '<base_id>  (must be docked at the base)' },

  // Crafting
  craft: {
    args: ['recipe_id', 'quantity'],
    required: ['recipe_id'],
    usage:
      '<recipe_id> [quantity]  (1-10 for batch crafting, uses cargo + station storage, use catalog type=recipes to browse)',
  },
  recycle: {
    args: ['recipe_id', 'quantity'],
    usage:
      "<recipe_id> [quantity] [dry_run=true] [deliver_to=storage|faction] [job_id=...]  (break down a recipe's outputs to recover a fraction of its inputs; dry_run for a quote, job_id to cancel a queued job)",
  },

  // Chat - rest captures remaining args as content
  chat: {
    args: ['channel', { rest: 'content' }],
    required: ['channel', 'content'],
    usage: '<channel> <message>  (channels: local, system, faction, private)',
  },
  get_chat_history: {
    args: ['channel', 'limit', 'before'],
    required: ['channel'],
    usage: '<channel> [limit] [before] [target_id=...]  (channels: local, system, faction, private)',
  },

  // Factions
  create_faction: { args: ['name', 'tag'], required: ['name', 'tag'], usage: '<name> <tag>  (tag is 4 characters)' },
  join_faction: { args: ['faction_id'] },
  leave_faction: {},
  faction_info: { args: ['faction_id'] },
  faction_list: { args: ['limit', 'offset'] },
  faction_get_invites: {},
  faction_accept_invite: {
    args: ['faction_id'],
    required: ['faction_id'],
    usage: '<faction_id>  (accept a pending invite; alias for join_faction)',
  },
  faction_decline_invite: { args: ['faction_id'] },
  faction_set_enemy: { args: ['target_faction_id'] },
  faction_remove_enemy: {
    args: ['target_faction_id'],
    required: ['target_faction_id'],
    usage: '<target_faction_id>  (return an enemy faction to neutral standing)',
  },
  faction_propose_ally: {
    args: ['target_faction_id'],
    required: ['target_faction_id'],
    usage: '<target_faction_id>  (propose a mutual alliance)',
  },
  faction_accept_ally: {
    args: ['target_faction_id'],
    required: ['target_faction_id'],
    usage: '<target_faction_id>  (accept a pending alliance proposal)',
  },
  faction_remove_ally: {
    args: ['target_faction_id'],
    required: ['target_faction_id'],
    usage: '<target_faction_id>  (dissolve an alliance)',
  },
  faction_declare_war: { args: ['target_faction_id', 'reason'] },
  faction_propose_peace: { args: ['target_faction_id', 'terms'] },
  faction_accept_peace: { args: ['target_faction_id'] },
  faction_invite: { args: ['player_id'] },
  faction_withdraw_invite: {
    args: ['player_id'],
    required: ['player_id'],
    usage: '<player_id>  (withdraw a pending invite you sent)',
  },
  faction_kick: { args: ['player_id'] },
  faction_promote: { args: ['player_id', 'role_id'] },
  faction_edit: { args: ['description', 'charter', 'primary_color', 'secondary_color'] },
  faction_create_role: { args: ['name', 'priority', 'permissions'] },
  faction_edit_role: { args: ['role_id', 'name', 'permissions'] },
  faction_delete_role: { args: ['role_id'] },

  // Faction storage
  view_faction_storage: {},
  faction_deposit_items: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  faction_withdraw_items: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'] },
  faction_deposit_credits: { args: ['amount'], required: ['amount'] },
  faction_withdraw_credits: { args: ['amount'], required: ['amount'] },
  faction_create_sell_order: {
    args: ['item_id', 'quantity', 'price_each'],
    required: ['item_id', 'quantity', 'price_each'],
  },
  faction_create_buy_order: {
    args: ['item_id', 'quantity', 'price_each'],
    required: ['item_id', 'quantity', 'price_each'],
  },

  // Faction rooms
  faction_rooms: {},
  faction_visit_room: { args: ['room_id'], required: ['room_id'] },
  faction_write_room: { args: ['room_id'] },
  faction_delete_room: { args: ['room_id'], required: ['room_id'] },

  // Faction missions & intel
  faction_post_mission: {
    args: ['title', 'type', 'description'],
    required: ['title', 'type', 'description'],
    usage:
      '<title> <type> <description>  (plus key=value: giver_name, giver_title, objectives, rewards, dialog, expiration_hours, triggers)',
  },
  faction_cancel_mission: { args: ['template_id'], required: ['template_id'] },
  faction_list_missions: {},
  faction_submit_intel: {},
  faction_query_intel: { args: ['system_name', 'system_id', 'poi_type', 'resource_type'] },
  faction_intel_status: {},
  faction_submit_trade_intel: {},
  faction_query_trade_intel: { args: ['base_id', 'item_id', 'station_name'] },
  faction_trade_intel_status: {},

  // Player settings
  set_status: { args: ['status_message', 'clan_tag'] },
  set_colors: { args: ['primary_color', 'secondary_color'] },
  // Notes
  create_note: { args: ['title', { rest: 'content' }] },
  write_note: { args: ['note_id', { rest: 'content' }] },
  read_note: { args: ['note_id'] },
  delete_note: { args: ['note_id'], required: ['note_id'], usage: '<note_id>  (permanently delete a note you own)' },
  get_notes: {},

  // Captain's log
  captains_log_add: { args: [{ rest: 'entry' }] },
  captains_log_list: { args: ['index'] },
  captains_log_get: { args: ['index'] },
  captains_log_delete: {
    args: ['index'],
    required: ['index'],
    usage: '<index>  (delete log entry by index; 0 = newest, entries re-index after)',
  },

  // Forum
  forum_list: { args: ['page', 'category'] },
  forum_get_thread: { args: ['thread_id'] },
  forum_create_thread: {
    args: ['title', 'category', { rest: 'content' }],
    required: ['title', 'category', 'content'],
    usage: '<title> <category> <content>  (categories: general, bugs, suggestions, trading, factions)',
  },
  forum_delete_thread: { args: ['thread_id'] },
  forum_reply: { args: ['thread_id', { rest: 'content' }] },
  forum_upvote: { args: ['thread_id', 'reply_id'] },
  forum_delete_reply: { args: ['reply_id'] },

  // Missions
  get_missions: {},
  get_active_missions: {},
  accept_mission: { args: ['mission_id'] },
  complete_mission: { args: ['mission_id'] },
  decline_mission: { args: ['template_id'] },
  abandon_mission: { args: ['mission_id'] },
  completed_missions: {},
  distress_signal: {},
  view_completed_mission: {
    args: ['template_id'],
    required: ['template_id'],
    usage: '<template_id>  (view full details of a completed mission)',
  },

  // Cargo
  jettison: { args: ['item_id', 'quantity'] },

  // Station storage
  view_storage: { args: ['station_id'] },
  deposit_items: {
    args: ['item_id', 'quantity'],
    required: ['item_id', 'quantity'],
    usage: '<item_id> <quantity>  (use get_ship to see cargo)',
  },
  withdraw_items: {
    args: ['item_id', 'quantity'],
    required: ['item_id', 'quantity'],
    usage: '<item_id> <quantity>  (use view_storage to see stored items)',
  },
  deposit_credits: { args: ['amount'], required: ['amount'], usage: '<amount>' },
  withdraw_credits: { args: ['amount'], required: ['amount'], usage: '<amount>' },
  send_gift: {
    args: ['recipient', 'item_id', 'quantity', 'credits', 'message', 'ship_id'],
    required: ['recipient'],
    usage:
      '<recipient> [item_id=... quantity=...] [credits=...] [ship_id=...] [message="..."]  (async transfer to their storage here)',
  },

  // Exchange
  create_sell_order: {
    args: ['item_id', 'quantity', 'price_each'],
    required: ['item_id', 'quantity', 'price_each'],
    usage: '<item_id> <quantity> <price_each>  (list items for sale)',
  },
  create_buy_order: {
    args: ['item_id', 'quantity', 'price_each', 'deliver_to'],
    required: ['item_id', 'quantity', 'price_each'],
    usage: '<item_id> <quantity> <price_each> [deliver_to=base_id]  (place a buy offer)',
  },
  view_market: { args: ['item_id', 'category'], usage: '[item_id] [category]  (view order book, optionally filtered)' },
  view_orders: { args: ['station_id'] },
  cancel_order: {
    args: ['order_id'],
    usage: '[order_id]  (cancel and return escrow; or pass order_ids=... for batch cancel)',
  },
  modify_order: {
    args: ['order_id', 'new_price'],
    required: ['order_id', 'new_price'],
    usage: '<order_id> <new_price>  (change price on existing order)',
  },
  estimate_purchase: {
    args: ['item_id', 'quantity'],
    required: ['item_id', 'quantity'],
    usage: '<item_id> <quantity>  (preview purchase cost)',
  },
  analyze_market: {
    args: ['item_id', 'page'],
    usage: '[item_id] [page]  (no args = top 10 insights; item_id = detailed single item)',
  },

  // Facilities
  facility: {
    args: ['action', 'facility_type', 'name', 'level', 'category'],
    usage:
      '<action> [facility_type] [name=...] [level=N] [category=...] [facility_id=...] [description=...] [access=...] [page=N] [per_page=N] [player_id=...] [username=...] [direction=...]',
  },

  // Battle
  battle: {
    args: ['action', 'stance', 'target_id', 'side_id'],
    required: ['action'],
    usage: '<action> [stance] [target_id] [side_id]  (actions: join, leave, stance, target, etc.)',
  },
  get_battle_status: {},
  get_battle_summary: {
    args: ['battle_id'],
    required: ['battle_id'],
    usage: '<battle_id>  (aggregate result of a battle)',
  },
  get_battle_log: {
    args: ['battle_id', 'tick_start', 'tick_end', 'limit'],
    required: ['battle_id'],
    usage: '<battle_id> [tick_start] [tick_end] [limit]  (tick-by-tick combat replay)',
  },
  reload: {
    args: ['weapon_instance_id', 'ammo_item_id'],
    required: ['weapon_instance_id', 'ammo_item_id'],
    usage: '<weapon_instance_id> <ammo_item_id>',
  },

  // Salvage & Tow
  tow_wreck: { args: ['wreck_id'], required: ['wreck_id'], usage: '<wreck_id>  (use get_wrecks to see wrecks)' },
  release_tow: {},
  scrap_wreck: {},
  sell_wreck: {},

  // Shipyard
  commission_ship: {
    args: ['ship_class', 'provide_materials'],
    required: ['ship_class'],
    usage: '<ship_class> [provide_materials=true/false]',
  },
  commission_quote: { args: ['ship_class'], required: ['ship_class'], usage: '<ship_class>' },
  commission_status: { args: ['base_id'] },
  cancel_commission: { args: ['commission_id'], required: ['commission_id'], usage: '<commission_id>' },
  supply_commission: {
    args: ['commission_id', 'item_id', 'quantity'],
    required: ['commission_id', 'item_id', 'quantity'],
    usage: '<commission_id> <item_id> <quantity>  (donate materials to a stuck commission)',
  },

  // Ship Exchange
  list_ship_for_sale: { args: ['ship_id', 'price'], required: ['ship_id', 'price'], usage: '<ship_id> <price>' },
  browse_ships: { args: ['base_id', 'class_id', 'max_price'] },
  buy_listed_ship: { args: ['listing_id'], required: ['listing_id'], usage: '<listing_id>' },
  cancel_ship_listing: { args: ['listing_id'], required: ['listing_id'], usage: '<listing_id>' },
  sell_ship_to_order: {
    args: ['order_id', 'ship_id'],
    required: ['order_id', 'ship_id'],
    usage: '<order_id> <ship_id>  (sell a stored ship into a standing buy order, see browse_ships)',
  },
  place_ship_buy_order: {
    args: ['class_id', 'price'],
    required: ['class_id', 'price'],
    usage: '<class_id> <price>  (standing buy order for a ship class at this base)',
  },
  view_ship_buy_orders: {},
  cancel_ship_buy_order: {
    args: ['order_id'],
    required: ['order_id'],
    usage: '<order_id>  (cancel a buy order and refund the escrow)',
  },

  // Insurance
  buy_insurance: { args: ['ticks'], required: ['ticks'], usage: '<ticks>  (number of ticks of coverage)' },
  get_insurance_quote: {},
  claim_insurance: {},
  view_insurance: {},

  // Empire / governance
  citizenship: {
    args: ['action', 'empire_id'],
    usage: '[action=list|apply|renounce|withdraw] [empire_id]  (manage empire citizenships; default action=list)',
  },
  get_empire_info: { args: ['empire_id'], usage: '[empire_id]  (omit for all five empires)' },
  get_tax_estimate: {},
  get_faction_tax_estimate: {},
  prepay_tax: {
    args: ['amount'],
    required: ['amount'],
    usage: '<amount>  (prepay credits toward your next tax assessment; surplus is refunded)',
  },
  faction_prepay_tax: {
    args: ['amount'],
    required: ['amount'],
    usage: '<amount>  (prepay from the faction treasury toward the next corporate tax assessment)',
  },
  petition: {
    args: ['empire_id', { rest: 'message' }],
    required: ['empire_id', 'message'],
    usage: '<empire_id> <message>  (petition empire leadership, max 1000 chars)',
  },

  // Achievements
  get_achievements: {},
  get_faction_achievements: {},

  // Faction bases & territory (lawless space)
  get_base_cost: {},
  build_base: {
    args: ['name', 'public_access'],
    required: ['name'],
    usage:
      '<name> [public_access=true]  (found a faction station at your current lawless-space POI; check get_base_cost first)',
  },
  build_outpost: {
    args: ['name'],
    required: ['name'],
    usage: '<name>  (deploy a lightweight, members-only faction outpost at your current lawless-space POI)',
  },
  dismantle_outpost: {},
  espionage: {},
  faction_garages: {},
  buy_ship_license: {
    args: ['empire'],
    required: ['empire'],
    usage: "<empire>  (solarian|voidborn|crimson|nebula|outerrim — license your faction to build that empire's hulls)",
  },
  faction_scan_poi: {
    args: ['poi_id'],
    required: ['poi_id'],
    usage: '<poi_id>  (long-range sensor scan from your faction sensor facility; POI must be in range)',
  },
  station: {
    args: ['action'],
    required: ['action'],
    usage:
      '<action> [params]  (administer your faction station; actions: info, set_name name=..., set_description description=..., set_public public=true, set_build_policy allow_outsiders=true, set_service_access service=market access=public, set_market_fee fee_percent=N, set_refuel_price price=N, set_repair_price price=N, allow_player player=..., remove_player player=..., ban player=..., unban player=..., allow_faction faction=..., remove_faction faction=...)',
  },

  // Drones
  deploy_drone: { args: ['drone_type'], required: ['drone_type'], usage: '<drone_type>  (deploy an offensive drone)' },
  recall_drone: { args: ['drone_id'], required: ['drone_id'], usage: '<drone_id>  (recall a deployed drone)' },
  order_drone: {
    args: ['drone_id', 'order', 'target_id'],
    required: ['drone_id', 'order'],
    usage: '<drone_id> <order> [target_id]  (give drone orders)',
  },
  get_drones: {},
  get_drone: {
    args: ['drone_id'],
    required: ['drone_id'],
    usage: '<drone_id>  (full details incl. script and memory)',
  },
  load_drone: {
    args: ['item_id'],
    required: ['item_id'],
    usage: '<item_id>  (load a drone from cargo into your bay, e.g. combat_drone, mining_drone)',
  },
  unload_drone: {
    args: ['drone_id'],
    required: ['drone_id'],
    usage: '<drone_id>  (return a bay drone to cargo, must not be deployed)',
  },
  upload_drone_script: {
    args: ['drone_id', { rest: 'script' }],
    required: ['drone_id', 'script'],
    usage: '<drone_id> <script>  (DroneLang source, max 2000 chars; empty string clears)',
  },
  set_drone_name: {
    args: ['drone_id', { rest: 'name' }],
    required: ['drone_id'],
    usage: '<drone_id> <name>  (max 32 chars; omit name to clear)',
  },

  // Passengers
  list_passengers: {},
  list_station_passengers: {
    args: ['station'],
    usage: '[station]  (citizens waiting for transport; defaults to current station)',
  },
  load_passenger: {
    args: ['destination'],
    required: ['destination'],
    usage: '<destination>  (load all waiting passengers bound for destination, up to free berths)',
  },
  unload_passenger: {
    args: [{ rest: 'name' }],
    required: ['name'],
    usage: '<name>  (put a single passenger off the ship at the current station)',
  },

  // Query commands
  get_status: {},
  get_system: {},
  get_poi: {},
  get_base: {},
  get_ship: {},
  get_cargo: {},
  get_nearby: {},
  get_system_agents: {},
  get_skills: {},
  get_map: { args: ['system_id'] },
  get_trades: {},
  get_wrecks: {},
  get_version: { args: ['count', 'page'] },
  get_commands: {},
  get_location: {},
  get_notifications: {},
  get_notification_settings: {},
  mute_notifications: {
    args: ['channels'],
    required: ['channels'],
    usage: '<channels>  (comma-separated channels to mute, see get_notification_settings)',
  },
  unmute_notifications: {
    args: ['channels', 'all'],
    usage: '[channels] [all=true]  (unmute channels, or all=true for every channel)',
  },
  subscribe_market: {},
  unsubscribe_market: {},
  subscribe_observation: {
    args: ['active_scan'],
    usage: '[active_scan=true]  (live presence feed at your POI/system; active_scan burns fuel and alerts cloakers)',
  },
  unsubscribe_observation: {},
  inspect: {
    args: ['id'],
    required: ['id'],
    usage: '<id>  (inspect a visible package, item, module, ship class, system, POI, or docked base)',
  },
  survey_system: {},
  get_action_log: {
    args: ['category', 'limit', 'before'],
    usage: '[category=...] [limit=N] [before=timestamp]  (persistent action history)',
  },
  session: {},

  // V2 state commands
  get_state: {},
  v2_get_player: {},
  v2_get_ship: {},
  v2_get_cargo: {},
  v2_get_missions: {},
  v2_get_queue: {},
  v2_get_skills: {},

  // Unified commands
  fleet: {
    args: ['action', 'player_id'],
    required: ['action'],
    usage: '<action> [player_id]  (actions: create, invite, accept, decline, leave, kick, disband, status)',
  },
  storage: {
    args: ['action', 'item_id', 'quantity'],
    usage: '<action> [item_id] [quantity]  (unified storage interface)',
  },
  shipping: {
    args: ['action', 'package_id', 'shipment_id'],
    required: ['action'],
    usage:
      '<action> [package_id] [shipment_id] [key=value...]  (sealed-package freight; actions: quote, post, list, active, get, track, profile, pay_debt, accept, deliver, return, cancel)',
  },

  // Reference & Help
  catalog: {
    args: ['type', 'id', 'category', 'search', 'page', 'page_size'],
    required: ['type'],
    usage:
      '<type> [id] [category] [search] [page] [page_size] [commissionable=true/false]  (types: ships, items, skills, recipes)',
  },
  get_guide: { args: ['guide'] },
  help: { args: ['category', 'command'] },

  // Agent logging
  agentlogs: {
    args: ['category', 'message', 'severity'],
    required: ['category', 'message'],
    usage: '<category> <message> [severity=info/warn/error]  (submit agent log entries to the server)',
  },
};

// =============================================================================
// Error Help Messages
// =============================================================================

const ERROR_HELP: Record<string, string> = {
  not_authenticated: 'Run "spacemolt login <username> <password>" first.',
  invalid_credentials: 'Check your username and password. Passwords are case-sensitive.',
  session_expired: 'Your session expired. Run the command again to auto-create a new session.',
  rate_limited: 'Query rate limited. Wait a moment and retry.',
  docked: 'You are docked. Most commands handle this automatically — if you see this error, please report it.',
  not_docked: 'You must be docked. Most commands handle this automatically — if you see this error, please report it.',
  already_traveling: 'You are already traveling. Wait for arrival or check with "get_status".',
  already_jumping: 'You are already jumping between systems. Wait for arrival.',
  invalid_poi: 'POI not found. Run "spacemolt get_system" to see valid POIs.',
  wrong_system: 'That POI is in a different system. Use "jump" to change systems first.',
  not_connected: 'Systems are not connected. Run "spacemolt get_system" to see connections.',
  no_fuel: 'Insufficient fuel. Dock at a station and run "spacemolt refuel".',
  no_credits: 'Insufficient credits. Mine and sell resources to earn credits.',
  no_cargo_space: 'Cargo hold is full. Sell or jettison items to make space.',
  invalid_target: 'Target not found. Run "spacemolt get_nearby" to see players at your POI.',
  target_cloaked: 'Target is cloaked. Use "scan" with high scan power to reveal them.',
  no_cloak: 'No cloaking device installed on your ship.',
  username_taken: 'That username is already taken. Try a different username.',
  invalid_username: 'Username must be 3-20 alphanumeric characters.',
  empire_restricted: 'Invalid empire. Valid empires: solarian, voidborn, crimson, nebula, outerrim.',
  not_weapon: 'The module at that slot index is not a weapon. Use "get_ship" to see modules.',
  invalid_weapon: 'Invalid weapon index. Use "get_ship" to see your installed weapons.',
  no_mining_laser: 'No mining laser installed. Buy one from a station market.',
  not_asteroid: 'You can only mine at asteroid belts. Travel to one first.',
};

// =============================================================================
// Version Update Check
// =============================================================================

const UPDATE_NOTIFY_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between update notifications

interface UpdateCheckCache {
  checked_at: string;
  latest_version: string;
  notified_at?: string; // when we last showed the update notice
  notified_version?: string; // which version we last notified about
}

function getUpdateCachePath(): string {
  return path.join(os.homedir(), '.config', 'spacemolt', 'update-check.json');
}

async function loadUpdateCache(): Promise<UpdateCheckCache | null> {
  try {
    const file = Bun.file(getUpdateCachePath());
    if (await file.exists()) return await file.json();
  } catch {
    /* no cache */
  }
  return null;
}

async function saveUpdateCache(cache: UpdateCheckCache): Promise<void> {
  const cachePath = getUpdateCachePath();
  const parentDir = path.dirname(cachePath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  await Bun.write(cachePath, JSON.stringify(cache, null, 2));
}

function compareVersions(current: string, latest: string): number {
  const currentParts = current.replace(/^v/, '').split('.').map(Number);
  const latestParts = latest.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const curr = currentParts[i] || 0;
    const lat = latestParts[i] || 0;
    if (lat > curr) return 1; // latest is newer
    if (lat < curr) return -1; // current is newer
  }
  return 0; // equal
}

async function checkForUpdates(): Promise<void> {
  // Skip update check if disabled via env var
  if (process.env.SPACEMOLT_NO_UPDATE_CHECK === 'true') return;

  try {
    // Check cache to avoid spamming GitHub API
    let cache = await loadUpdateCache();
    let latestVersion: string | null = null;

    if (cache) {
      const lastCheck = new Date(cache.checked_at).getTime();
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
        // Use cached result
        latestVersion = cache.latest_version;
      }
    }

    // Fetch from GitHub if cache is stale or missing
    if (!latestVersion) {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'SpaceMolt-Client' },
        signal: AbortSignal.timeout(3000), // 3 second timeout
      });

      if (!response.ok) {
        if (DEBUG) console.log(`${c.dim}[DEBUG] Update check failed: HTTP ${response.status}${c.reset}`);
        return;
      }

      const release = (await response.json()) as { tag_name: string };
      latestVersion = release.tag_name.replace(/^v/, '');

      // Update cache with fresh check time
      cache = { ...cache, checked_at: new Date().toISOString(), latest_version: latestVersion } as UpdateCheckCache;
      await saveUpdateCache(cache);
    }

    // Check if update is available
    if (compareVersions(VERSION, latestVersion) <= 0) return;

    // Only show notification if we haven't recently notified about this version
    const isNewVersion = cache?.notified_version !== latestVersion;
    const lastNotified = cache?.notified_at ? new Date(cache.notified_at).getTime() : 0;
    const notifyExpired = Date.now() - lastNotified > UPDATE_NOTIFY_INTERVAL_MS;

    if (isNewVersion || notifyExpired) {
      printUpdateNotice(latestVersion);
      if (cache) {
        await saveUpdateCache({
          ...cache,
          notified_at: new Date().toISOString(),
          notified_version: latestVersion,
        });
      }
    }
  } catch (error) {
    // Silently ignore update check failures - don't disrupt the user's workflow
    if (DEBUG) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`${c.dim}[DEBUG] Update check failed: ${msg}${c.reset}`);
    }
  }
}

function printUpdateNotice(latestVersion: string): void {
  console.log(`${c.yellow}╭─────────────────────────────────────────────────────────────╮${c.reset}`);
  console.log(
    `${c.yellow}│${c.reset}  ${c.bright}Update available!${c.reset} ${c.dim}v${VERSION}${c.reset} → ${c.green}v${latestVersion}${c.reset}                        ${c.yellow}│${c.reset}`,
  );
  console.log(
    `${c.yellow}│${c.reset}  Run: ${c.cyan}curl -fsSL https://spacemolt.com/install.sh | bash${c.reset}  ${c.yellow}│${c.reset}`,
  );
  console.log(
    `${c.yellow}│${c.reset}  Or download from: ${c.cyan}https://github.com/${GITHUB_REPO}/releases${c.reset}   ${c.yellow}│${c.reset}`,
  );
  console.log(`${c.yellow}╰─────────────────────────────────────────────────────────────╯${c.reset}`);
  console.log('');
}

// =============================================================================
// Session Management
// =============================================================================

function getSessionPath(): string {
  // Use current working directory by default (not home directory)
  // This keeps credentials local to the project, avoiding global state
  return process.env.SPACEMOLT_SESSION || path.join(process.cwd(), '.spacemolt-session.json');
}

async function loadSession(): Promise<Session | null> {
  try {
    const file = Bun.file(getSessionPath());
    if (await file.exists()) return await file.json();
  } catch {
    /* no session */
  }
  return null;
}

async function saveSession(session: Session): Promise<void> {
  const sessionPath = getSessionPath();
  const parentDir = path.dirname(sessionPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  await Bun.write(sessionPath, JSON.stringify(session, null, 2));
}

/**
 * Build the User-Agent header. Once logged in, the agent's name is appended so
 * the server can attribute requests to a specific agent, e.g.
 * `SpaceMolt-Client/0.9.0 (SantaClaus)`. Pre-login requests (session bootstrap)
 * fall back to the plain client string.
 */
function userAgent(session?: Session): string {
  const base = `SpaceMolt-Client/${VERSION}`;
  return session?.username ? `${base} (${session.username})` : base;
}

async function createSession(): Promise<Session> {
  if (DEBUG) console.log(`${c.dim}[DEBUG] Creating new session...${c.reset}`);
  const response = await fetch(`${API_BASE}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
  });
  const data = (await response.json()) as APIResponse;
  if (data.error) throw new Error(`Failed to create session: ${data.error.message}`);
  if (!data.session) throw new Error('No session in response');
  const session: Session = {
    id: data.session.id,
    created_at: data.session.created_at,
    expires_at: data.session.expires_at,
  };
  await saveSession(session);
  return session;
}

function isSessionExpired(session: Session): boolean {
  return Date.now() > new Date(session.expires_at).getTime() - 60000;
}

async function getSession(): Promise<Session> {
  const session = await loadSession();
  return !session || isSessionExpired(session) ? createSession() : session;
}

// Build the User-Agent header. Once a player has logged in, the agent name is
// appended (e.g. "SpaceMolt-Client/0.8.0 (SantaClaus)") so the server can
// attribute requests to a specific player.
function userAgent(session?: Session): string {
  const base = `SpaceMolt-Client/${VERSION}`;
  return session?.username ? `${base} (${session.username})` : base;
}

// =============================================================================
// HTTP API
// =============================================================================

async function execute(command: string, payload?: Record<string, unknown>): Promise<APIResponse> {
  const session = await getSession();
  const url = `${API_BASE}/${command}`;

  if (DEBUG) {
    console.log(`${c.dim}[DEBUG] Request: POST ${url}${c.reset}`);
    console.log(`${c.dim}[DEBUG] Session: ${session.id.substring(0, 8)}...${c.reset}`);
    if (payload) {
      const safePayload = { ...payload };
      if (safePayload.password) safePayload.password = '***';
      console.log(`${c.dim}[DEBUG] Payload: ${JSON.stringify(safePayload)}${c.reset}`);
    }
  }

  const startTime = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': session.id,
        'User-Agent': userAgent(session),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. The server may be under load or the action is taking unusually long.`,
      );
    }
    throw err;
  }
  const elapsed = Date.now() - startTime;

  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    if (DEBUG) console.log(`${c.dim}[DEBUG] Response: ${response.status} (${elapsed}ms) - non-JSON${c.reset}`);
    throw new Error(`Server returned non-JSON response (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as APIResponse;

  if (DEBUG) {
    console.log(`${c.dim}[DEBUG] Response: ${response.status} (${elapsed}ms)${c.reset}`);
    if (data.error) console.log(`${c.dim}[DEBUG] Error: ${data.error.code} - ${data.error.message}${c.reset}`);
    if (data.notifications?.length)
      console.log(`${c.dim}[DEBUG] Notifications: ${data.notifications.length}${c.reset}`);
  }

  // Update session
  if (data.session) {
    session.expires_at = data.session.expires_at;
    if (data.session.player_id) session.player_id = data.session.player_id;
    await saveSession(session);
  }

  // Handle session expired - create new session, re-login if possible, then retry
  if (
    data.error?.code === 'session_invalid' ||
    data.error?.code === 'invalid_session' ||
    data.error?.code === 'session_expired'
  ) {
    if (DEBUG) console.log(`${c.dim}[DEBUG] Session expired, creating new session...${c.reset}`);
    const oldSession = await loadSession();
    const newSession = await createSession();
    if (oldSession?.username && oldSession?.password) {
      newSession.username = oldSession.username;
      newSession.password = oldSession.password;
      await saveSession(newSession);
      // Auto-re-login with stored credentials
      if (DEBUG) console.log(`${c.dim}[DEBUG] Re-authenticating as ${oldSession.username}...${c.reset}`);
      const loginResp = await execute('login', { username: oldSession.username, password: oldSession.password });
      if (loginResp.error) {
        console.error(`${c.red}[SESSION]${c.reset} Session expired and auto-login failed: ${loginResp.error.message}`);
        console.error(`${c.yellow}Run "spacemolt login <username> <password>" to re-authenticate.${c.reset}`);
        return data; // Return the original error
      }
      console.log(`${c.dim}[SESSION]${c.reset} Session recovered, re-authenticated as ${oldSession.username}`);
    }
    if (command !== 'login' && command !== 'register') {
      return execute(command, payload);
    }
    return data;
  }

  // Handle rate limit on queries - wait and retry
  if (data.error?.code === 'rate_limited' && data.error.wait_seconds !== undefined) {
    const waitMs = Math.ceil(data.error.wait_seconds) * 1000;
    console.log(
      `${c.yellow}[RATE LIMITED]${c.reset} Waiting ${Math.ceil(data.error.wait_seconds)} seconds before retry...`,
    );
    await Bun.sleep(waitMs);
    return execute(command, payload);
  }

  return data;
}

// =============================================================================
// Notification Display
// =============================================================================

type NotificationData = Record<string, unknown>;
type NotificationHandler = (data: NotificationData, time: string) => void;

const notificationHandlers: Record<string, NotificationHandler> = {
  chat_message: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.cyan}[CHAT:${d.channel || 'local'}]${c.reset} ${c.bright}${d.sender || 'Unknown'}${c.reset}: ${d.content || ''}`,
    );
  },

  combat_update: (d, t) => {
    const destroyed = d.destroyed ? ' - DESTROYED!' : '';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[COMBAT]${c.reset} ${d.attacker || 'unknown'} hit ${d.target || 'unknown'} for ${d.damage || 0} ${d.damage_type || 'unknown'} damage (shield: ${d.shield_hit || 0}, hull: ${d.hull_hit || 0})${destroyed}`,
    );
  },

  player_died: (d, t) => {
    const cause = d.cause || 'combat';
    if (cause === 'self_destruct') {
      console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Self-destructed!`);
    } else if (cause === 'police') {
      console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Destroyed by system police!`);
    } else {
      console.log(
        `${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Destroyed by ${d.killer_name || 'unknown'}!`,
      );
    }
    if (d.combat_log) {
      const log = d.combat_log as Record<string, unknown>;
      if (log.message) console.log(`  ${log.message}`);
      if (log.attacker_ship) console.log(`  Attacker ship: ${log.attacker_ship}`);
      if (log.weapons_used && Object.keys(log.weapons_used).length > 0) {
        const weapons = Object.entries(log.weapons_used)
          .map(([w, n]) => `${w} (x${n})`)
          .join(', ');
        console.log(`  Weapons: ${weapons}`);
      }
      if ((log.total_damage as number) > 0) {
        console.log(
          `  Damage taken: ${log.total_damage} total (${log.shield_damage || 0} shield, ${log.hull_damage || 0} hull) over ${log.combat_rounds || 0} round${log.combat_rounds !== 1 ? 's' : ''}`,
        );
      }
      if (log.death_location) console.log(`  Location: ${log.death_location} in ${log.death_system || 'unknown'}`);
    }
    if (d.ship_lost) console.log(`  Ship lost: ${d.ship_lost}`);
    if ((d.clone_cost as number) > 0) console.log(`  Clone cost: ${d.clone_cost} credits`);
    if ((d.insurance_payout as number) > 0) console.log(`  Insurance payout: ${d.insurance_payout} credits`);
    console.log(`  Respawned at: ${d.respawn_base || 'home'} with ship fully repaired`);
  },

  mining_yield: (d, t) => {
    const remainingMsg = d.remaining !== undefined ? ` (${d.remaining} remaining at POI)` : '';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}[MINED]${c.reset} +${d.quantity || 0}x ${d.resource_id || 'ore'}${remainingMsg}`,
    );
  },

  trade_offer_received: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[TRADE]${c.reset} Offer from ${d.from_name || 'Someone'} (ID: ${d.trade_id || ''})`,
    );
    if ((d.offer_credits as number) > 0) console.log(`  Offering: ${d.offer_credits} credits`);
    if ((d.request_credits as number) > 0) console.log(`  Requesting: ${d.request_credits} credits`);
    console.log(`  Use: trade_accept trade_id=${d.trade_id} or trade_decline trade_id=${d.trade_id}`);
  },

  scan_result: (d, t) => {
    const target = d.username || d.target_id || 'unknown';
    if (d.success) {
      const revealed = (d.revealed_info as string[]) || [];
      console.log(
        `${c.dim}[${t}]${c.reset} ${c.cyan}[SCAN]${c.reset} Scan of ${target} revealed: ${revealed.join(', ')}`,
      );
      if (d.ship_class) console.log(`  Ship: ${d.ship_class}`);
      if (d.hull !== undefined) console.log(`  Hull: ${d.hull}`);
      if (d.shield !== undefined) console.log(`  Shield: ${d.shield}`);
      if (d.cloaked !== undefined) console.log(`  Cloaked: ${d.cloaked}`);
    } else {
      console.log(
        `${c.dim}[${t}]${c.reset} ${c.cyan}[SCAN]${c.reset} Scan of ${target} failed - insufficient scan power`,
      );
    }
  },

  scan_detected: (d, t) => {
    const revealed = (d.revealed_info as string[]) || [];
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[SCANNED]${c.reset} You were scanned by ${d.scanner_username || 'Unknown'} (${d.scanner_ship_class || 'unknown'})`,
    );
    console.log(`  They learned: ${revealed.join(', ')}`);
  },

  police_warning: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[POLICE]${c.reset} ${d.message}`);
    console.log(`  Security level: ${d.police_level || 0}, Response in: ${d.response_ticks || 0} tick(s)`);
  },

  police_spawn: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[POLICE]${c.reset} ${d.num_drones || 0} police drone(s) arrived!`,
    );
  },

  police_combat: (d, t) => {
    const destroyed = d.destroyed ? ' - YOU WERE DESTROYED!' : '';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[POLICE]${c.reset} Police drone dealt ${d.damage || 0} damage${destroyed}`,
    );
  },

  skill_level_up: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}${c.bright}[LEVEL UP]${c.reset} ${d.skill_id || 'unknown'} is now level ${d.new_level || 0}! (+${d.xp_gained || 0} XP)`,
    );
  },

  drone_update: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.blue}[DRONE]${c.reset} Your ${d.drone_type || 'drone'} drone dealt ${d.damage || 0} damage to ${d.target_id || 'target'}`,
    );
  },

  drone_destroyed: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[DRONE]${c.reset} Your ${d.drone_type || 'drone'} drone was destroyed! (ID: ${d.drone_id || ''})`,
    );
  },

  pilotless_ship: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[PILOTLESS]${c.reset} ${d.player_username || 'unknown'}'s ${d.ship_class || 'ship'} is now pilotless!`,
    );
    console.log(`  Vulnerable for ${d.ticks_remaining || 0} ticks - can be attacked without resistance`);
  },

  reconnected: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[RECONNECTED]${c.reset} ${d.message}`);
    if (d.was_pilotless) console.log(`  Ship was pilotless - recovered with ${d.ticks_remaining || 0} ticks to spare`);
  },

  faction_invite: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.magenta}[FACTION]${c.reset} You've been invited to join ${d.faction_name || 'a faction'}`,
    );
    console.log(
      `  Use: join_faction faction_id=${d.faction_id || ''} or faction_decline_invite faction_id=${d.faction_id || ''}`,
    );
  },

  faction_war_declared: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[WAR]${c.reset} ${d.attacker_name || 'a faction'} has declared war on your faction!`,
    );
    console.log(`  Reason: ${d.reason || 'no reason given'}`);
  },

  faction_peace_proposed: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}[PEACE]${c.reset} ${d.proposer_name || 'a faction'} has proposed peace!`,
    );
    console.log(`  Terms: ${d.terms || 'unconditional'}`);
    console.log(`  Use: faction_accept_peace target_faction_id=${d.faction_id || ''}`);
  },

  base_raid_update: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[RAID]${c.reset} ${d.base_name || 'base'}: ${d.current_health || 0}/${d.max_health || 0} HP (-${d.damage_per_tick || 0}/tick)`,
    );
  },

  base_destroyed: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[BASE DESTROYED]${c.reset} ${d.base_name || 'base'} has been destroyed!`,
    );
    if (d.wreck_id) console.log(`  Wreck ID for looting: ${d.wreck_id}`);
  },

  player_kill: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}${c.bright}[KILL]${c.reset} You destroyed ${d.victim_name || d.target_name || 'unknown'}!`,
    );
    if (d.bounty) console.log(`  Bounty: ${d.bounty} credits`);
    if (d.wreck_id) console.log(`  Wreck: ${d.wreck_id}`);
  },

  pirate_warning: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}[PIRATES]${c.reset} ${d.message || 'Pirates detected nearby!'}`);
  },

  pirate_spawn: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}[PIRATES]${c.reset} ${d.num_pirates || 1} pirate(s) appeared!`);
  },

  pirate_combat: (d, t) => {
    const destroyed = d.destroyed ? ' - YOU WERE DESTROYED!' : '';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[PIRATES]${c.reset} Pirate dealt ${d.damage || 0} damage${destroyed}`,
    );
  },

  pirate_destroyed: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[PIRATES]${c.reset} Pirate destroyed!`);
    if (d.loot) console.log(`  Loot: ${JSON.stringify(d.loot)}`);
  },

  battle_started: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[BATTLE]${c.reset} Battle started! ID: ${d.battle_id || 'unknown'}`,
    );
  },

  battle_update: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[BATTLE]${c.reset} Battle tick ${d.tick || '?'} - ${d.message || 'combat continues'}`,
    );
  },

  battle_damage: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[BATTLE]${c.reset} ${d.attacker || 'unknown'} hit ${d.target || 'unknown'} for ${d.damage || 0} damage`,
    );
  },

  battle_joined: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[BATTLE]${c.reset} ${d.username || 'Someone'} joined the battle`);
  },

  battle_left: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[BATTLE]${c.reset} ${d.username || 'Someone'} left the battle`);
  },

  battle_ended: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[BATTLE]${c.reset} Battle ended! ${d.message || ''}`);
  },

  skill_xp_gain: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.cyan}[XP]${c.reset} +${d.xp_gained || d.xp || 0} XP in ${d.skill_id || 'unknown'} (${d.current_xp || '?'}/${d.next_level_xp || '?'})`,
    );
  },

  trade_complete: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}[TRADE]${c.reset} Trade completed with ${d.partner_name || d.with || 'someone'}!`,
    );
  },

  trade_declined: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[TRADE]${c.reset} Trade declined by ${d.from_name || 'someone'}`);
  },

  trade_cancelled: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[TRADE]${c.reset} Trade cancelled (ID: ${d.trade_id || 'unknown'})`,
    );
  },

  friend_request_accepted: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}[FRIEND]${c.reset} ${d.from_name || d.username || 'Someone'} accepted your friend request!`,
    );
  },

  friend_removed: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[FRIEND]${c.reset} ${d.from_name || d.username || 'Someone'} removed you as a friend`,
    );
  },

  friend_online: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[FRIEND]${c.reset} ${d.username || 'A friend'} is now online`);
  },

  friend_offline: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.dim}[FRIEND]${c.reset} ${d.username || 'A friend'} went offline`);
  },

  version_info: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[VERSION]${c.reset} Server version: ${d.version || 'unknown'}`);
  },

  queue_cleared: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[QUEUE]${c.reset} Action queue cleared${d.reason ? `: ${d.reason}` : ''}`,
    );
  },

  friend_request: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.cyan}[FRIEND]${c.reset} ${d.from_name || 'Someone'} sent you a friend request`,
    );
  },

  system: (d, t) => {
    // Handle different system notification types
    if (d.type === 'gameplay_tip') {
      console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[TIP]${c.reset} ${d.message}`);
    } else {
      // Generic system message
      console.log(`${c.dim}[${t}]${c.reset} ${c.magenta}[SYSTEM]${c.reset} ${d.message || JSON.stringify(d)}`);
    }
  },

  action_result: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}[ACTION RESULT]${c.reset} ${c.bright}${d.command}${c.reset} completed (tick ${d.tick || '?'})`,
    );
    if (d.result && typeof d.result === 'object') {
      const result = d.result as Record<string, unknown>;
      if (result.message) {
        console.log(`  ${result.message}`);
      } else {
        for (const [key, value] of Object.entries(result)) {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
  },

  action_error: (d, t) => {
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.red}[ACTION FAILED]${c.reset} ${c.bright}${d.command}${c.reset} failed (tick ${d.tick || '?'}): ${d.message || d.code || 'unknown error'}`,
    );
  },

  poi_arrival: (d, t) => {
    const tag = d.clan_tag ? `[${d.clan_tag}] ` : '';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.green}[ARRIVAL]${c.reset} ${tag}${d.username || 'Someone'} has arrived at ${d.poi_name || 'this POI'}`,
    );
  },

  poi_departure: (d, t) => {
    const tag = d.clan_tag ? `[${d.clan_tag}] ` : '';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.yellow}[DEPARTURE]${c.reset} ${tag}${d.username || 'Someone'} has departed from ${d.poi_name || 'this POI'}`,
    );
  },

  // Live market feed from subscribe_market. Each update carries only the items
  // whose order book changed this tick. Over HTTP these arrive via
  // get_notifications under the 'market' type (msg_type 'market_update').
  market_update: (d, t) => {
    const items = (d.items as Array<Record<string, unknown>>) || [];
    const where = d.base_name || d.base_id || 'station';
    console.log(
      `${c.dim}[${t}]${c.reset} ${c.cyan}[MARKET]${c.reset} ${items.length} book change${items.length === 1 ? '' : 's'} @ ${where}${d.tick ? ` (tick ${d.tick})` : ''}`,
    );
    for (const item of items) {
      const sells = (item.sell_orders as Array<Record<string, unknown>>) || [];
      const buys = (item.buy_orders as Array<Record<string, unknown>>) || [];
      const name = item.item_name || item.item_id;
      if (!sells.length && !buys.length) {
        console.log(`  ${name}: ${c.dim}book emptied${c.reset}`);
        continue;
      }
      const bestAsk = sells.length ? Math.min(...sells.map((o) => o.price_each as number)) : undefined;
      const bestBid = buys.length ? Math.max(...buys.map((o) => o.price_each as number)) : undefined;
      const askStr = bestAsk !== undefined ? `ask ${c.green}${bestAsk}${c.reset}` : 'ask —';
      const bidStr = bestBid !== undefined ? `bid ${c.yellow}${bestBid}${c.reset}` : 'bid —';
      console.log(`  ${name}: ${askStr} / ${bidStr}`);
    }
  },
};

// 'market' is the notification type the server tags live market updates with over
// HTTP; the inner msg_type is 'market_update'. Alias both to the same handler.
const marketHandler = notificationHandlers.market_update;
if (marketHandler) notificationHandlers.market = marketHandler;

function displayNotifications(notifications?: APIResponse['notifications']): void {
  if (!notifications?.length) return;

  for (const n of notifications) {
    const data = n.data as NotificationData;
    const time = new Date(n.timestamp).toLocaleTimeString();
    const handler = notificationHandlers[n.msg_type || n.type];

    if (handler) {
      handler(data, time);
    } else {
      // Default handler for unknown types
      const message = data.message;
      if (message) {
        console.log(`${c.dim}[${time}]${c.reset} ${c.magenta}[${n.type.toUpperCase()}]${c.reset} ${message}`);
      } else {
        console.log(`${c.dim}[${time}]${c.reset} ${c.magenta}[${n.type.toUpperCase()}]${c.reset}`);
        for (const [key, value] of Object.entries(data)) {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
  }
}

// =============================================================================
// Result Display
// =============================================================================

interface NamedFormatter {
  name: string;
  /** Keys that hint this formatter *should* match — used for drift detection */
  hintKeys: string[];
  format: (result: Record<string, unknown>) => boolean;
}

/**
 * Every top-level key a v2 state blob can carry, taken from
 * `handlers.V2GameState` in the gameserver (internal/handlers/v2state.go).
 * The delta wrapper builds the same struct for every mutation, so this is the
 * complete emittable key set — plus the two auto-dock flags displayResult
 * prints itself. A key that is not in here is genuinely new and must reach the
 * drift warning.
 *
 * Every key is rendered by the v2_state formatter except `version`, which is a
 * wire-format marker with nothing in it for the player, and the auto-dock flags
 * displayResult already printed.
 */
const V2_STATE_KEYS = new Set([
  'version',
  'player',
  'ship',
  'modules',
  'cargo',
  'location',
  'missions',
  'queue',
  'skills',
  'credits',
  'message',
  'details',
  'hints',
  'riding',
  'carried_ships',
  'bay_used',
  'bay_capacity',
  'auto_docked',
  'auto_undocked',
]);

/**
 * Every payload-carrying key of a v2 state blob — V2_STATE_KEYS minus the
 * wire-format marker, the message and the auto-dock flags. `credits` and
 * `hints` are in here on purpose: get_location answers with
 * `{location, credits, message}`, so a guard that watched only the object
 * sections would let a partial formatter claim it and drop the balance.
 */
const V2_STATE_PAYLOAD_KEYS = [
  'player',
  'ship',
  'modules',
  'cargo',
  'location',
  'missions',
  'queue',
  'skills',
  'riding',
  'carried_ships',
  'details',
  'credits',
  'hints',
  'bay_used',
  'bay_capacity',
];

/**
 * True when `r` is a v2 state blob that carries a section outside `owned`.
 * A formatter that renders only part of the blob calls this to decline instead
 * of claiming the response and silently dropping the rest — that silent drop
 * is gh#1961 itself.
 */
function v2BlobCarriesUnowned(r: Record<string, unknown>, owned: string[]): boolean {
  if (!Object.keys(r).every((k) => V2_STATE_KEYS.has(k))) return false;
  return V2_STATE_PAYLOAD_KEYS.some((s) => r[s] !== undefined && !owned.includes(s));
}

export const resultFormatters: NamedFormatter[] = [
  // Player status
  {
    name: 'player_status',
    hintKeys: ['player', 'ship'],
    format: (r) => {
      if (!r.player || !r.ship) return false;
      const p = r.player as Record<string, unknown>;
      // A v2 state blob also carries player + ship, but its V2Player has no
      // current_system / current_poi — location lives in its own `location`
      // section. Claiming it printed "System: undefined" and "Docked: No"
      // while docked, and dropped every other section (gh#1961). v1
      // PlayerInfo always serialises both fields, so their absence is a
      // reliable v2 tell. Decline and let v2_state render the whole blob.
      if (p.current_system === undefined && p.current_poi === undefined) return false;
      const s = r.ship as Record<string, unknown>;
      const sys = r.system as Record<string, unknown> | undefined;
      const poi = r.poi as Record<string, unknown> | undefined;

      console.log(`\n${c.bright}=== Player Status ===${c.reset}`);
      console.log(`Username: ${c.bright}${p.username}${c.reset}`);
      console.log(`Empire: ${p.empire}`);
      console.log(`Credits: ${p.credits}`);
      console.log(`Faction: ${p.faction_id ? `${p.faction_id} (${p.faction_rank})` : 'None'}`);

      console.log(`\n${c.bright}Location:${c.reset}`);
      console.log(`  System: ${sys?.name || p.current_system}`);
      console.log(`  POI: ${poi?.name || p.current_poi}`);
      console.log(`  Docked: ${p.docked_at_base ? `Yes (${p.docked_at_base})` : 'No'}`);
      if (p.is_cloaked) console.log(`  ${c.cyan}[CLOAKED]${c.reset}`);

      console.log(`\n${c.bright}Ship: ${s.name}${c.reset} (${s.class_id})`);
      console.log(`  Hull: ${s.hull}/${s.max_hull}`);
      console.log(`  Shield: ${s.shield}/${s.max_shield} (+${s.shield_recharge}/tick)`);
      console.log(`  Armor: ${s.armor || 0}`);
      console.log(`  Fuel: ${s.fuel}/${s.max_fuel}`);
      console.log(`  Cargo: ${s.cargo_used}/${s.cargo_capacity}`);
      console.log(`  CPU: ${s.cpu_used}/${s.cpu_capacity}`);
      console.log(`  Power: ${s.power_used}/${s.power_capacity}`);

      if (s.class_id === 'escape_pod') {
        console.log(`\n${c.yellow}WARNING: You are in an Escape Pod!${c.reset}`);
        console.log(`  - No cargo capacity, no weapons, no defenses`);
        console.log(`  - Infinite fuel - travel anywhere`);
        console.log(`  - Get to a station and commission or buy a ship with 'commission_ship' or 'browse_ships'`);
      }

      if (r.travel_progress !== undefined) {
        const progress = Math.round((r.travel_progress as number) * 100);
        console.log(
          `\n${c.cyan}[TRAVELING]${c.reset} ${progress}% to ${r.travel_destination || 'unknown'} (arrival tick: ${r.travel_arrival_tick || '?'})`,
        );
      }

      const nearby = r.nearby as Array<Record<string, unknown>> | undefined;
      if (nearby?.length) {
        console.log(`\n${c.bright}Nearby Players:${c.reset} ${nearby.length}`);
        for (const player of nearby.slice(0, 5)) {
          const name = player.anonymous ? '[Anonymous]' : player.username;
          const status = player.in_combat ? ` ${c.red}[COMBAT]${c.reset}` : '';
          console.log(`  - ${name} (${player.ship_class})${status}`);
        }
        if (nearby.length > 5) console.log(`  ... and ${nearby.length - 5} more`);
      }
      return true;
    },
  },

  // Registration
  {
    name: 'registration',
    hintKeys: ['password', 'player_id'],
    format: (r) => {
      if (!r.password || !r.player_id) return false;
      console.log(`\n${c.green}${c.bright}=== Registration Successful ===${c.reset}`);
      console.log(`Player ID: ${r.player_id}`);
      console.log(`\n${c.yellow}${c.bright}PASSWORD: ${r.password}${c.reset}`);
      console.log(`\n${c.red}${c.bright}CRITICAL: Save this password immediately!${c.reset}`);
      console.log(`If lost, the account owner can reset it at https://spacemolt.com/dashboard`);
      console.log(`\nYou are now logged in. Try these commands:`);
      console.log(`  get_status    - See your ship and location`);
      console.log(`  undock        - Leave the station`);
      console.log(`  mine          - Mine resources (at asteroid belts)`);
      console.log(`  help          - Get full command list from server`);
      return true;
    },
  },

  // System info — response wraps data under r.system
  {
    name: 'system_info',
    hintKeys: ['system', 'poi', 'security_status'],
    format: (r) => {
      const sys = r.system as Record<string, unknown> | undefined;
      if (!sys?.id || !sys.pois || !sys.connections) return false;
      console.log(`\n${c.bright}=== System: ${sys.name} ===${c.reset}`);
      console.log(`ID: ${sys.id}`);
      console.log(`Empire: ${sys.empire || 'None'}`);
      console.log(
        `Police Level: ${sys.police_level} (${r.security_status || sys.security_status || 'unknown security'})`,
      );
      if (sys.description) console.log(`Description: ${sys.description}`);

      const pois = sys.pois as Array<Record<string, unknown>>;
      console.log(`\n${c.bright}Points of Interest:${c.reset}`);
      for (const poi of pois) {
        const online = (poi.online as number) > 0 ? ` ${c.cyan}(${poi.online} online)${c.reset}` : '';
        const base = poi.has_base ? ` ${c.green}[base]${c.reset}` : '';
        console.log(`  - ${poi.name} (${poi.type})${base}${online}  ${c.dim}${poi.id}${c.reset}`);
      }

      const connections = sys.connections as Array<Record<string, unknown>>;
      console.log(`\n${c.bright}Connected Systems:${c.reset}`);
      for (const conn of connections) {
        console.log(`  - ${conn.name} ${c.dim}(${conn.distance} ly)${c.reset}  ${c.dim}${conn.system_id}${c.reset}`);
      }

      const currentPoi = r.poi as Record<string, unknown> | undefined;
      if (currentPoi) {
        console.log(
          `\n${c.bright}Current POI:${c.reset} ${currentPoi.name} (${currentPoi.type})  ${c.dim}${currentPoi.id}${c.reset}`,
        );
      }
      return true;
    },
  },

  // POI info — response wraps data under r.poi
  {
    name: 'poi_info',
    hintKeys: ['poi', 'base', 'services'],
    format: (r) => {
      const poi = r.poi as Record<string, unknown> | undefined;
      if (!poi?.id || !poi.type || !poi.system_id) return false;
      console.log(`\n${c.bright}=== POI: ${poi.name} ===${c.reset}`);
      console.log(`ID: ${poi.id}`);
      console.log(`Type: ${poi.type}`);
      console.log(`System: ${poi.system_id}`);
      if (poi.description) console.log(`Description: ${poi.description}`);
      if (poi.class) console.log(`Class: ${poi.class}`);

      const resources = r.resources as Array<Record<string, unknown>> | undefined;
      if (resources?.length) {
        console.log(`\n${c.bright}Resources:${c.reset}`);
        for (const res of resources) {
          const display = res.remaining_display || `${res.remaining} remaining`;
          if (display === 'depleted' || res.remaining === 0) {
            // \x1b[9m = strikethrough
            console.log(
              `  - \x1b[9m${c.dim}${res.name || res.resource_id}: richness ${res.richness}, depleted${c.reset}\x1b[29m`,
            );
          } else {
            let depletion = '';
            if (res.depletion_percent !== undefined) {
              const pct = Number(res.depletion_percent);
              const color = pct > 25 ? c.green : pct >= 5 ? c.yellow : c.red;
              depletion = ` (${color}${pct.toFixed(2)}% remaining${c.reset})`;
            }
            const remaining = res.max_remaining ? `${res.remaining}/${res.max_remaining}` : display;
            console.log(`  - ${res.name || res.resource_id}: richness ${res.richness}, ${remaining}${depletion}`);
          }
        }
      }

      if (poi.base_id) console.log(`\nBase: ${poi.base_id} (use 'dock' to enter)`);

      const base = r.base as Record<string, unknown> | undefined;
      if (base) {
        console.log(`\n${c.bright}Base: ${base.name}${c.reset}`);
        if (base.description) console.log(`  ${base.description}`);
        console.log(`  Empire: ${base.empire || 'None'}`);
        console.log(`  Defense: ${base.defense_level}`);
      }

      const services = r.services as string[] | undefined;
      if (services?.length) {
        console.log(`\n${c.bright}Services:${c.reset} ${services.join(', ')}`);
      }
      return true;
    },
  },

  // Cargo — field renamed from cargo_used to used
  {
    name: 'cargo',
    hintKeys: ['cargo', 'used', 'capacity'],
    format: (r) => {
      if (r.cargo === undefined || r.used === undefined) return false;
      const cargo = (r.cargo as Array<Record<string, unknown>>) || [];
      console.log(`\n${c.bright}=== Cargo ===${c.reset}`);
      console.log(`Used: ${r.used}/${r.capacity} (${r.available} available)\n`);
      printItemTable(cargo);
      return true;
    },
  },

  // Nearby (players, pirates, empire NPCs)
  {
    name: 'nearby',
    hintKeys: ['nearby', 'count', 'pirate_count'],
    format: (r) => {
      if (!Array.isArray(r.nearby)) return false;
      const players = r.nearby as Array<Record<string, unknown>>;
      const pirates = (r.pirates as Array<Record<string, unknown>>) || [];
      const npcs = (r.empire_npcs as Array<Record<string, unknown>>) || [];

      console.log(`\n${c.bright}=== Nearby ===${c.reset}`);

      // Players
      console.log(`\n${c.bright}Players (${(r.count as number) || players.length}):${c.reset}`);
      if (!players.length) {
        console.log(`  (No other players at this location)`);
      } else {
        for (const p of players) console.log(`  ${formatPlayer(p)}`);
      }

      // Pirates
      if ((r.pirate_count as number) > 0) {
        console.log(`\n${c.red}Pirates (${r.pirate_count}):${c.reset}`);
        for (const p of pirates) {
          const name = p.name || p.pirate_id || 'Unknown';
          const ship = p.ship_class ? ` (${p.ship_class})` : '';
          const combat = p.in_combat ? ` ${c.red}[IN COMBAT]${c.reset}` : '';
          console.log(`  ${name}${ship}${combat}`);
        }
      }

      // Empire NPCs
      if ((r.empire_npc_count as number) > 0) {
        console.log(`\n${c.dim}Empire NPCs (${r.empire_npc_count}):${c.reset}`);
        for (const n of npcs) {
          const name = n.name || n.npc_id || 'Unknown';
          const ship = n.ship_class ? ` (${n.ship_class})` : '';
          console.log(`  ${name}${ship}`);
        }
      }

      return true;
    },
  },

  // Wrecks
  {
    name: 'wrecks',
    hintKeys: ['wrecks'],
    format: (r) => {
      if (!Array.isArray(r.wrecks)) return false;
      const wrecks = r.wrecks as Array<Record<string, unknown>>;
      console.log(`\n${c.bright}=== Wrecks at POI ===${c.reset}`);
      if (!wrecks.length) {
        console.log(`(No wrecks at this location)`);
      } else {
        for (const w of wrecks) {
          console.log(`\n${c.yellow}Wreck: ${w.id}${c.reset}`);
          console.log(`  Ship: ${w.ship_class}`);
          // expire_tick === 0 means the wreck never expires (ship/pirate/abandoned wrecks);
          // only jettisoned junk containers get a finite expiry.
          if (w.expire_tick) {
            console.log(`  Expires at: ${w.expires_at ?? `tick ${w.expire_tick}`}`);
          } else {
            console.log(`  Expires: never`);
          }
          const items = (w.cargo as Array<Record<string, unknown>>) || [];
          if (items.length) {
            console.log(`  Contents:`);
            for (const item of items) console.log(`    - ${item.quantity}x ${item.item_id}`);
          }
        }
      }
      return true;
    },
  },

  // Skills (v2 format: player_skills array + skills metadata)
  {
    name: 'skills_v2',
    hintKeys: ['skills', 'player_skills'],
    format: (r) => {
      if (r.skills === undefined || r.player_skills === undefined) return false;
      const playerSkills = (r.player_skills as Array<Record<string, unknown>>) || [];
      console.log(`\n${c.bright}=== Your Skills ===${c.reset}`);
      console.log(`Total skills: ${r.player_skill_count || playerSkills.length}`);
      if (!playerSkills.length) {
        console.log(`\n(No skills trained yet - perform activities to gain XP)`);
      } else {
        const byCategory: Record<string, Array<Record<string, unknown>>> = {};
        for (const skill of playerSkills) {
          const cat = (skill.category as string) || 'Other';
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(skill);
        }
        for (const [category, skills] of Object.entries(byCategory)) {
          console.log(`\n${c.cyan}${category}:${c.reset}`);
          for (const skill of skills) {
            const progress = skill.next_level_xp ? ` (${skill.current_xp}/${skill.next_level_xp} XP)` : ' (MAX)';
            console.log(`  ${skill.name}: Level ${skill.level}/${skill.max_level}${progress}`);
          }
        }
      }
      return true;
    },
  },

  // Skills (v1 format: skills as object map of skill_id -> skill data)
  {
    name: 'skills_v1',
    hintKeys: ['skills'],
    format: (r) => {
      if (!r.skills || typeof r.skills !== 'object' || Array.isArray(r.skills)) return false;
      // A v2 state blob carries skills alongside player/ship/location/…; this
      // formatter renders only the skills map, so claiming it would drop the
      // rest (gh#1961). A plain v1 skills response has no other v2 section.
      if (v2BlobCarriesUnowned(r, ['skills'])) return false;
      const skills = r.skills as Record<
        string,
        {
          name: string;
          category: string;
          level: number;
          max_level: number;
          xp: number;
          next_level_xp?: number;
        }
      >;
      const skillEntries = Object.entries(skills);
      if (skillEntries.length === 0) return false;
      // Verify this looks like a skills map (entries should have name/level)
      if (!skillEntries[0][1].name || skillEntries[0][1].level === undefined) return false;
      console.log(`\n${c.bright}=== Your Skills ===${c.reset}`);
      const byCategory: Record<string, typeof skillEntries> = {};
      for (const [skillId, skill] of skillEntries) {
        const cat = skill.category || 'Other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push([skillId, skill]);
      }
      for (const [category, entries] of Object.entries(byCategory)) {
        console.log(`\n${c.cyan}${category}:${c.reset}`);
        for (const [, skill] of entries) {
          const progress = skill.next_level_xp
            ? ` (${skill.xp}/${skill.next_level_xp} XP to level ${skill.level + 1})`
            : skill.level >= skill.max_level
              ? ' (MAX)'
              : ` (${skill.xp} XP)`;
          console.log(`  ${skill.name}: Level ${skill.level}/${skill.max_level}${progress}`);
        }
      }
      return true;
    },
  },

  // Ship listings (browse_ships) — must come before market listings since both use r.listings
  {
    name: 'ship_listings',
    hintKeys: ['listings'],
    format: (r) => {
      if (!Array.isArray(r.listings)) return false;
      const listings = r.listings as Array<Record<string, unknown>>;
      if (listings.length === 0 || !listings[0].ship_id) return false;
      console.log(`\n${c.bright}=== Ships for Sale @ ${r.base_name || 'Station'} ===${c.reset}`);
      for (const listing of listings) {
        const shipClass = listing.class_id || 'Unknown';
        const shipName = listing.ship_name || shipClass;
        const price = listing.price as number;
        const formattedPrice = price.toLocaleString();
        const scale = listing.scale ? `(Scale ${listing.scale})` : '';
        const tier = listing.tier ? `T${listing.tier}` : '';
        const category = listing.category ? `${listing.category}` : '';
        const categoryTier = [category, tier].filter(Boolean).join(' - ');
        const hull = listing.hull ? `Hull: ${listing.hull}/${listing.max_hull}` : '';
        const shield = listing.shield ? `Shield: ${listing.shield}` : '';
        const stats = [hull, shield].filter(Boolean).join(', ');
        const seller = listing.seller || listing.seller_name || listing.seller_id || 'Unknown';
        console.log(`\n${c.cyan}${shipName}${c.reset} (${shipClass}) ${scale}`);
        if (categoryTier) console.log(`  ${categoryTier}`);
        console.log(`  Price: ${c.yellow}${formattedPrice} credits${c.reset}`);
        if (stats) console.log(`  ${stats}`);
        console.log(`  Seller: ${seller}`);
        console.log(`  Listing ID: ${listing.listing_id}`);
      }
      return true;
    },
  },

  // Market listings
  {
    name: 'market_listings',
    hintKeys: ['listings'],
    format: (r) => {
      if (!Array.isArray(r.listings)) return false;
      const listings = r.listings as Array<Record<string, unknown>>;
      console.log(`\n${c.bright}=== Market Listings ===${c.reset}`);
      if (r.buy_price_modifier) {
        console.log(`Buy price modifier: ${r.buy_price_modifier}x`);
        console.log(`Sell price modifier: ${r.sell_price_modifier}x`);
      }
      if (!listings.length) {
        console.log(`\n(No listings at this market)`);
      } else {
        for (const listing of listings) {
          const seller = listing.seller_name || listing.seller || listing.seller_id || 'NPC';
          console.log(`\n  ${listing.item_id}: ${listing.quantity} @ ${listing.price_each} each`);
          console.log(`    Listing ID: ${listing.listing_id}`);
          console.log(`    Seller: ${seller}`);
        }
      }
      return true;
    },
  },

  // Location info (get_location) — must come before simple message formatter since
  // the response has both r.location and r.message, which the simple formatter swallows
  {
    name: 'location_info',
    hintKeys: ['location'],
    format: (r) => {
      if (!r.location || typeof r.location !== 'object') return false;
      // Same guard as skills_v1: a v2 delta can pair `location` with player,
      // ship or cargo, and this formatter renders only the location block.
      if (v2BlobCarriesUnowned(r, ['location'])) return false;
      const loc = r.location as {
        system_id: string;
        system_name: string;
        empire: string;
        security_status: string;
        connections: string[];
        poi_id: string;
        poi_name: string;
        poi_type: string;
        docked_at?: string;
        nearby_players: Array<Record<string, unknown>>;
        nearby_player_count: number;
        nearby_pirates: Array<Record<string, unknown>>;
        nearby_pirate_count: number;
        nearby_empire_npcs?: Array<Record<string, unknown>>;
        nearby_empire_npc_count?: number;
      };
      console.log(`\n${c.bright}=== Location ===${c.reset}`);
      console.log(`${c.cyan}System:${c.reset} ${loc.system_name} (${loc.system_id})`);
      console.log(`${c.cyan}Empire:${c.reset} ${loc.empire}`);
      console.log(`${c.cyan}Security:${c.reset} ${loc.security_status}`);
      if (loc.connections.length > 0) {
        console.log(`${c.cyan}Connections:${c.reset} ${loc.connections.join(', ')}`);
      }
      console.log(`${c.cyan}POI:${c.reset} ${loc.poi_name} (${loc.poi_type})`);
      if (loc.docked_at) {
        console.log(`${c.cyan}Docked at:${c.reset} ${loc.docked_at}`);
      }
      if (loc.nearby_player_count > 0) {
        console.log(`\n${c.bright}Nearby Players (${loc.nearby_player_count}):${c.reset}`);
        for (const player of loc.nearby_players.slice(0, 10)) {
          console.log(`  ${formatPlayer(player)}`);
        }
        if (loc.nearby_player_count > 10) {
          console.log(`  ... and ${loc.nearby_player_count - 10} more`);
        }
      }
      if (loc.nearby_pirate_count > 0) {
        console.log(`\n${c.red}Nearby Pirates: ${loc.nearby_pirate_count}${c.reset}`);
      }
      if (loc.nearby_empire_npc_count && loc.nearby_empire_npc_count > 0) {
        console.log(`\n${c.dim}Nearby NPCs: ${loc.nearby_empire_npc_count}${c.reset}`);
      }
      return true;
    },
  },

  // Arrival (travel/jump) — shows destination and online players
  {
    name: 'arrival',
    hintKeys: ['poi_id', 'online_players'],
    format: (r) => {
      if (!r.poi_id || !Array.isArray(r.online_players)) return false;
      console.log(`\n${c.green}Arrived at ${c.bright}${r.poi || r.poi_id}${c.reset}`);
      const players = r.online_players as Array<Record<string, unknown>>;
      const count = (r.online_players_count as number) || players.length;
      if (count > 0) {
        console.log(`\n${c.bright}Players here (${count}):${c.reset}`);
        for (const p of players) console.log(`  ${formatPlayer(p)}`);
        if (r.online_players_truncated) console.log(`  ... and more`);
      } else {
        console.log(`\n(No other players here)`);
      }
      return true;
    },
  },

  // Live market snapshot (subscribe_market). Must precede the storage formatter:
  // both carry base_id + items, but order-book items are distinguished by their
  // nested sell_orders/buy_orders.
  {
    name: 'market_book',
    hintKeys: ['base_id', 'items'],
    format: (r) => {
      if (!Array.isArray(r.items)) return false;
      const items = r.items as Array<Record<string, unknown>>;
      if (r.action !== 'subscribe_market' && !(items[0] && 'sell_orders' in items[0])) return false;
      console.log(`\n${c.bright}=== Market @ ${r.base_name || r.base_id || 'Station'} ===${c.reset}`);
      if (r.message) console.log(`${c.dim}${r.message}${c.reset}`);
      if (!items.length) {
        console.log(`\n(No order book activity)`);
        return true;
      }
      for (const item of items) {
        const sells = (item.sell_orders as Array<Record<string, unknown>>) || [];
        const buys = (item.buy_orders as Array<Record<string, unknown>>) || [];
        const bestAsk = sells.length ? Math.min(...sells.map((o) => o.price_each as number)) : undefined;
        const bestBid = buys.length ? Math.max(...buys.map((o) => o.price_each as number)) : undefined;
        const askStr = bestAsk !== undefined ? `${c.green}${bestAsk}${c.reset}` : '—';
        const bidStr = bestBid !== undefined ? `${c.yellow}${bestBid}${c.reset}` : '—';
        console.log(`  ${c.bright}${item.item_name || item.item_id}${c.reset}: ask ${askStr} / bid ${bidStr}`);
      }
      console.log(
        `\n${c.dim}Live updates arrive via get_notifications (type 'market'). unsubscribe_market to stop.${c.reset}`,
      );
      return true;
    },
  },

  // Achievements (get_achievements + get_faction_achievements share this shape)
  {
    name: 'achievements',
    hintKeys: ['summary', 'achievements'],
    format: (r) => {
      if (!r.summary || !Array.isArray(r.achievements)) return false;
      const summary = r.summary as Record<string, unknown>;
      const achievements = r.achievements as Array<Record<string, unknown>>;
      console.log(`\n${c.bright}=== Achievements ===${c.reset}`);
      console.log(
        `Earned: ${c.green}${summary.earned}${c.reset}/${summary.total}   Points: ${c.yellow}${summary.points}${c.reset}`,
      );
      const byCategory = new Map<string, Array<Record<string, unknown>>>();
      for (const a of achievements) {
        const cat = (a.category as string) || 'general';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)?.push(a);
      }
      for (const [cat, list] of byCategory) {
        console.log(`\n${c.cyan}${cat}:${c.reset}`);
        for (const a of list) {
          const mark = a.earned ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`;
          const prog = a.progress as Record<string, unknown> | undefined;
          const progStr = !a.earned && prog ? ` ${c.dim}(${prog.current}/${prog.target})${c.reset}` : '';
          console.log(`  ${mark} ${a.name} ${c.dim}[${a.points}pt]${c.reset}${progStr}`);
        }
      }
      return true;
    },
  },

  // Tax estimate (get_tax_estimate + get_faction_tax_estimate)
  {
    name: 'tax_estimate',
    hintKeys: ['income_tax', 'tax_collection_active'],
    format: (r) => {
      if (!Array.isArray(r.income_tax) || r.tax_collection_active === undefined) return false;
      const isFaction = r.faction_name !== undefined;
      console.log(
        `\n${c.bright}=== ${isFaction ? `Faction Tax Estimate — ${r.faction_name}` : 'Tax Estimate'} ===${c.reset}`,
      );
      if (r.tax_collection_active === false) {
        console.log(`${c.yellow}PREVIEW MODE — nothing is charged right now.${c.reset}`);
      }
      if (r.note) console.log(`${c.dim}${r.note}${c.reset}`);
      const fmt = (n: unknown) => (typeof n === 'number' ? n.toLocaleString() : String(n ?? '—'));
      if (r.taxable_income_to_date !== undefined)
        console.log(`Taxable income to date: ${fmt(r.taxable_income_to_date)}`);
      if (r.net_taxable_profit !== undefined) console.log(`Net taxable profit: ${fmt(r.net_taxable_profit)}`);
      if (r.deductible_expenses_to_date !== undefined)
        console.log(`Deductible expenses: ${fmt(r.deductible_expenses_to_date)}`);
      if (r.tax_prepaid !== undefined) console.log(`Prepaid: ${fmt(r.tax_prepaid)}`);

      const incomeTax = r.income_tax as Array<Record<string, unknown>>;
      if (incomeTax.length) {
        console.log(`\n${c.bright}Income tax by empire:${c.reset}`);
        for (const t of incomeTax) {
          const pct = typeof t.rate_bps === 'number' ? `${(t.rate_bps / 100).toFixed(2)}%` : '?';
          console.log(
            `  ${t.empire}: ${c.yellow}${fmt(t.owed)}${c.reset} owed @ ${pct} on ${fmt(t.taxed_profit)} profit`,
          );
        }
      }
      console.log(`\n${c.bright}Income tax total: ${c.yellow}${fmt(r.income_tax_total)}${c.reset}`);
      if (r.property_tax_total !== undefined) console.log(`Property tax total: ${fmt(r.property_tax_total)}`);
      if (typeof r.next_assessment_approx_seconds === 'number') {
        const mins = Math.round(r.next_assessment_approx_seconds / 60);
        console.log(`${c.dim}Next assessment in ~${mins} min${c.reset}`);
      }
      return true;
    },
  },

  // Base founding cost preview (get_base_cost)
  {
    name: 'base_cost',
    hintKeys: ['station_core_item', 'founding_fee'],
    format: (r) => {
      if (!r.station_core_item || r.founding_fee === undefined) return false;
      console.log(`\n${c.bright}=== Faction Station Cost ===${c.reset}`);
      const eligible = r.eligible_here ? `${c.green}yes${c.reset}` : `${c.red}no${c.reset}`;
      console.log(`Eligible here: ${eligible}${r.reason ? ` ${c.dim}(${r.reason})${c.reset}` : ''}`);
      console.log(`Founding fee: ${c.yellow}${(r.founding_fee as number).toLocaleString()}${c.reset} credits`);
      console.log(`Station core item: ${r.station_core_item}`);
      console.log(`Max per faction: ${r.max_per_faction}`);
      if (r.requirements) console.log(`Requirements: ${r.requirements}`);
      return true;
    },
  },

  // Faction station founded (build_base)
  {
    name: 'base_founded',
    hintKeys: ['base_id', 'poi_id', 'fee_paid'],
    format: (r) => {
      if (!r.base_id || !r.poi_id || r.fee_paid === undefined) return false;
      console.log(`\n${c.green}${c.bright}=== Station Founded ===${c.reset}`);
      console.log(`${r.name || r.base_id} ${c.dim}(${r.base_id})${c.reset}`);
      console.log(`Location: ${r.poi_id} in ${r.system_id}`);
      console.log(`Fee paid: ${c.yellow}${(r.fee_paid as number).toLocaleString()}${c.reset} credits`);
      console.log(`Public access: ${r.public_access ? 'yes' : 'faction/allowed only'}`);
      if (r.hint) console.log(`${c.dim}${r.hint}${c.reset}`);
      return true;
    },
  },

  // Faction station administration (station)
  {
    name: 'station_config',
    hintKeys: ['base_id', 'service_access'],
    format: (r) => {
      if (!r.base_id || r.service_access === undefined || r.public_access === undefined) return false;
      console.log(`\n${c.bright}=== Station: ${r.name || r.base_id} ===${c.reset}`);
      if (r.message) console.log(`${c.green}${r.message}${c.reset}`);
      if (r.description) console.log(`${c.dim}${r.description}${c.reset}`);
      console.log(`Public access: ${r.public_access ? 'yes' : 'no'}`);
      console.log(`Outsider facilities: ${r.allow_outsider_facilities ? 'allowed' : 'members only'}`);
      if (r.market_fee_bps !== undefined)
        console.log(`Market fee: ${((r.market_fee_bps as number) / 100).toFixed(2)}%`);
      if (r.refuel_price_each !== undefined) console.log(`Refuel price: ${r.refuel_price_each}/unit`);
      if (r.repair_price_per_hull !== undefined) console.log(`Repair price: ${r.repair_price_per_hull}/hull`);
      const access = r.service_access as Record<string, unknown>;
      if (access && Object.keys(access).length) {
        console.log(
          `${c.bright}Service access:${c.reset} ${Object.entries(access)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
        );
      }
      const lists: Array<[string, unknown]> = [
        ['Allowed players', r.allowed_players],
        ['Banned players', r.banned_players],
        ['Allowed factions', r.allowed_factions],
      ];
      for (const [label, val] of lists) {
        if (Array.isArray(val) && val.length) console.log(`${label}: ${val.join(', ')}`);
      }
      return true;
    },
  },

  // Faction long-range POI scan (faction_scan_poi)
  {
    name: 'faction_scan',
    hintKeys: ['poi_id', 'scan_power'],
    format: (r) => {
      if (!r.poi_id || r.scan_power === undefined) return false;
      console.log(`\n${c.bright}=== Sensor Scan: ${r.poi_name || r.poi_id} ===${c.reset}`);
      console.log(`System: ${r.system_id}   ${r.hops} hop(s) from ${r.facility_station || 'sensor facility'}`);
      console.log(`Scan power: ${r.scan_power}   Facility L${r.facility_level}`);
      if (r.message) console.log(`${c.dim}${r.message}${c.reset}`);
      const groups: Array<[string, unknown]> = [
        ['Contacts', r.contacts],
        ['NPCs', r.npcs],
        ['Pirates', r.pirates],
      ];
      for (const [label, val] of groups) {
        if (Array.isArray(val) && val.length) {
          console.log(`\n${c.cyan}${label} (${val.length}):${c.reset}`);
          for (const e of val as Array<Record<string, unknown>>) {
            console.log(`  ${e.name || e.username || e.id || JSON.stringify(e)}`);
          }
        }
      }
      if (r.signature_detected) console.log(`\n${c.yellow}Signature detected.${c.reset}`);
      return true;
    },
  },

  // Recycle job (shares CraftJobResponse with craft; action distinguishes it)
  {
    name: 'recycle_job',
    hintKeys: ['action'],
    format: (r) => {
      if (r.action !== 'recycle') return false;
      console.log(`\n${c.bright}=== Recycle ===${c.reset}`);
      if (r.message) console.log(`${r.message}`);
      const produces = r.produces as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(produces) && produces.length) {
        console.log(`${c.bright}Recovers:${c.reset}`);
        for (const p of produces) console.log(`  ${p.name || p.item_id} x${p.quantity}`);
      }
      if (r.dry_run) {
        if (r.cost !== undefined) console.log(`Estimated fee: ${c.yellow}${r.cost}${c.reset}`);
        if (r.runs !== undefined) console.log(`Runs: ${r.runs}`);
        if (r.have_inputs !== undefined) console.log(`Have inputs: ${r.have_inputs ? 'yes' : 'no'}`);
        if (r.have_credits !== undefined) console.log(`Have credits: ${r.have_credits ? 'yes' : 'no'}`);
        if (r.venue) console.log(`${c.dim}Venue: ${r.venue}${c.reset}`);
      } else if (r.job_id) {
        console.log(`Job ID: ${c.cyan}${r.job_id}${c.reset}`);
        if (r.est_completion_tick !== undefined) console.log(`ETA tick: ${r.est_completion_tick}`);
        if (r.venue) console.log(`${c.dim}Venue: ${r.venue}${c.reset}`);
      }
      if (r.refunded !== undefined) console.log(`Refunded: ${c.yellow}${JSON.stringify(r.refunded)}${c.reset}`);
      const summary = r.summary as Record<string, unknown> | undefined;
      if (summary) console.log(`${c.dim}${JSON.stringify(summary)}${c.reset}`);
      return true;
    },
  },

  // Station storage
  {
    name: 'storage',
    hintKeys: ['base_id', 'items'],
    format: (r) => {
      if (!r.base_id || !Array.isArray(r.items)) return false;
      const items = r.items as Array<Record<string, unknown>>;
      const ships = (r.ships as Array<Record<string, unknown>>) || [];
      console.log(`\n${c.bright}=== Storage at ${r.base_id} ===${c.reset}\n`);
      printItemTable(items);
      if (ships.length) {
        const nameW = Math.max(9, ...ships.map((s) => String(s.class_name || s.class_id || '').length));
        const classW = Math.max(5, ...ships.map((s) => String(s.class_id || '').length));
        const idW = Math.max(2, ...ships.map((s) => String(s.ship_id || '').length));
        const modsW = Math.max(4, ...ships.map((s) => String(s.modules ?? '').length));
        const cargoW = Math.max(5, ...ships.map((s) => String(s.cargo_used ?? '').length));
        console.log(`\n${c.bright}Ships (${ships.length}):${c.reset}\n`);
        console.log(
          `  ${'Ship Name'.padEnd(nameW)} | ${'Class'.padEnd(classW)} | ${'Mods'.padStart(modsW)} | ${'Cargo'.padStart(cargoW)} | ${'ID'.padEnd(idW)}`,
        );
        console.log(
          `  ${'-'.repeat(nameW)}-+-${'-'.repeat(classW)}-+-${'-'.repeat(modsW)}-+-${'-'.repeat(cargoW)}-+-${'-'.repeat(idW)}`,
        );
        for (const s of ships) {
          const name = String(s.class_name || s.class_id || '').padEnd(nameW);
          const cls = String(s.class_id || '').padEnd(classW);
          const mods = String(s.modules ?? '').padStart(modsW);
          const cargo = String(s.cargo_used ?? '').padStart(cargoW);
          const id = String(s.ship_id || '').padEnd(idW);
          console.log(`  ${name} | ${cls} | ${mods} | ${cargo} | ${id}`);
        }
      }
      return true;
    },
  },

  // Chat confirmation
  {
    name: 'chat_sent',
    hintKeys: ['channel', 'message', 'sent_at'],
    format: (r) => {
      if (!r.channel || !r.message || !r.sent_at) return false;
      const time = new Date(r.sent_at as string).toLocaleTimeString();
      console.log(`${c.green}[${r.channel}]${c.reset} ${c.dim}${time}${c.reset} ${r.message}`);
      return true;
    },
  },

  // V2 state blob (v2_get_player, v2_get_missions, v2_get_queue and any delta
  // that carries these sections). The server sends one populated section plus a
  // `message`, which used to fall through to simple_message and get dropped.
  {
    name: 'v2_state',
    hintKeys: ['player'],
    format: (r) => {
      const p = r.player as Record<string, unknown> | undefined;
      const missions = r.missions as Record<string, unknown> | undefined;
      const queue = r.queue as Record<string, unknown> | undefined;
      const ship = r.ship as Record<string, unknown> | undefined;
      const loc = r.location as Record<string, unknown> | undefined;
      const riding = r.riding as Record<string, unknown> | undefined;
      const modules = r.modules as Array<Record<string, unknown>> | undefined;
      const cargo = r.cargo as Array<Record<string, unknown>> | undefined;
      const carried = r.carried_ships as Array<Record<string, unknown>> | undefined;
      const skills = r.skills as Record<string, Record<string, unknown>> | undefined;
      if (!V2_STATE_PAYLOAD_KEYS.some((s) => r[s] !== undefined)) return false;

      // Shape check: a v1 response can reuse a v2 key name with a different
      // type (an array `missions`, for one). Decline rather than render an
      // empty section over it — the raw JSON fallback is the honest answer.
      const isObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
      for (const k of ['player', 'ship', 'location', 'missions', 'queue', 'riding', 'skills']) {
        if (r[k] !== undefined && !isObject(r[k])) return false;
      }
      for (const k of ['modules', 'cargo', 'carried_ships']) {
        if (r[k] !== undefined && !Array.isArray(r[k])) return false;
      }

      // Only claim the response if every top-level key is one V2GameState can
      // emit. A key outside that set is a genuinely new server field and must
      // reach the drift warning and raw JSON rather than be silently dropped —
      // that silent drop is gh#1961 itself.
      if (Object.keys(r).some((k) => !V2_STATE_KEYS.has(k))) return false;

      if (p) {
        console.log(`\n${c.bright}=== Player ===${c.reset}`);
        console.log(`Username: ${c.bright}${p.username}${c.reset}${p.clan_tag ? ` [${p.clan_tag}]` : ''}`);
        console.log(`Empire: ${p.empire}`);
        console.log(`Credits: ${p.credits}`);
        console.log(`Faction: ${p.faction_id ? `${p.faction_id} (${p.faction_rank})` : 'None'}`);
        if (p.home_base) console.log(`Home base: ${p.home_base}`);
        if (p.status_message) console.log(`Status: ${p.status_message}`);
        if (p.is_cloaked) console.log(`${c.cyan}[CLOAKED]${c.reset}`);
        if (Array.isArray(p.citizenships) && p.citizenships.length) {
          console.log(`Citizenships: ${(p.citizenships as string[]).join(', ')}`);
        }
        const standings = p.standings as Record<string, Record<string, unknown>> | undefined;
        if (standings && Object.keys(standings).length) {
          console.log(`\n${c.bright}Standings:${c.reset}`);
          for (const [id, s] of Object.entries(standings)) {
            const bounty = Number(s.outstanding_bounty ?? 0);
            const parts = [`baseline ${s.baseline}`];
            if (bounty > 0) parts.push(`${c.yellow}bounty ${bounty}${c.reset}`);
            if (s.jailed_until) parts.push(`${c.red}jailed until ${s.jailed_until}${c.reset}`);
            console.log(`  ${id}: ${s.reputation} (${parts.join(', ')})`);
          }
        }
        const stats = p.stats as Record<string, unknown> | undefined;
        if (stats && Object.keys(stats).length) {
          console.log(`\n${c.bright}Stats:${c.reset}`);
          for (const [k, v] of Object.entries(stats)) {
            // PlayerStats carries per-category maps; bare interpolation would
            // print "[object Object]".
            console.log(`  ${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`);
          }
        }
      }

      if (riding) {
        console.log(`\n${c.bright}=== Riding ===${c.reset}`);
        console.log(`Aboard ship: ${riding.ship_id}${riding.carrier ? ` (carrier: ${riding.carrier})` : ''}`);
      }

      if (ship) {
        console.log(`\n${c.bright}=== Ship: ${ship.name} ===${c.reset} (${ship.class_id})`);
        console.log(`  Hull: ${ship.hull}/${ship.max_hull}`);
        console.log(`  Shield: ${ship.shield}/${ship.max_shield} (+${ship.shield_recharge}/tick)`);
        console.log(`  Armor: ${ship.armor ?? 0}`);
        console.log(`  Fuel: ${ship.fuel}/${ship.max_fuel}`);
        console.log(`  Cargo: ${ship.cargo_used}/${ship.cargo_capacity}`);
        console.log(`  CPU: ${ship.cpu_used}/${ship.cpu_capacity}`);
        console.log(`  Power: ${ship.power_used}/${ship.power_capacity}`);
        if (ship.disruption_ticks_remaining) {
          console.log(`  ${c.red}Disrupted for ${ship.disruption_ticks_remaining} tick(s)${c.reset}`);
        }
        if (ship.burn_ticks_remaining) {
          console.log(
            `  ${c.red}Burning: ${ship.burn_damage_per_tick}/tick for ${ship.burn_ticks_remaining} tick(s)${c.reset}`,
          );
        }
        if (ship.armor_melt_ticks_remaining) {
          console.log(`  ${c.red}Armor melt for ${ship.armor_melt_ticks_remaining} tick(s)${c.reset}`);
        }
      }

      if (loc) {
        console.log(`\n${c.bright}=== Location ===${c.reset}`);
        console.log(`System: ${loc.system_name} (${loc.system_id})`);
        if (loc.empire) console.log(`Empire: ${loc.empire}`);
        if (loc.security_status) console.log(`Security: ${loc.security_status}`);
        console.log(`POI: ${loc.poi_name}${loc.poi_type ? ` (${loc.poi_type})` : ''}`);
        if (loc.docked_at) console.log(`Docked at: ${loc.docked_at}`);
        const connections = loc.connections as string[] | undefined;
        if (connections?.length) console.log(`Connections: ${connections.join(', ')}`);
        if (loc.in_transit) {
          const dest = loc.transit_dest_system_name || loc.transit_dest_poi_name;
          console.log(
            `${c.cyan}[IN TRANSIT]${c.reset} ${loc.transit_type}${dest ? ` to ${dest}` : ''}` +
              `${loc.transit_arrival_tick ? ` (arrival tick ${loc.transit_arrival_tick})` : ''}`,
          );
        }
        if (loc.nearby_player_count) console.log(`Nearby players: ${loc.nearby_player_count}`);
        if (loc.nearby_pirate_count) console.log(`${c.red}Nearby pirates: ${loc.nearby_pirate_count}${c.reset}`);
        if (loc.nearby_empire_npc_count) console.log(`Nearby NPCs: ${loc.nearby_empire_npc_count}`);
        if (loc.unknown_signature) console.log(`${c.yellow}Unknown signature detected — run a scan${c.reset}`);
        const resources = loc.resources as Array<Record<string, unknown>> | undefined;
        if (resources?.length) {
          console.log(`Resources: ${resources.map((res) => `${res.item_name} (richness ${res.richness})`).join(', ')}`);
        }
      }

      if (modules) {
        console.log(`\n${c.bright}=== Modules (${modules.length}) ===${c.reset}`);
        if (!modules.length) console.log(`  (none installed)`);
        for (const m of modules) {
          const ammo = m.current_ammo !== undefined ? ` [ammo ${m.current_ammo}/${m.magazine_size}]` : '';
          console.log(`  ${m.name} — ${m.type}/${m.slot}, wear ${m.wear_status}${ammo}`);
        }
      }

      if (cargo) {
        console.log(`\n${c.bright}=== Cargo (${cargo.length}) ===${c.reset}`);
        if (!cargo.length) console.log(`  (empty)`);
        for (const item of cargo) console.log(`  ${item.item_name} x${item.quantity}`);
      }

      if (carried !== undefined || r.bay_capacity !== undefined || r.bay_used !== undefined) {
        console.log(`\n${c.bright}=== Carrier Bay ===${c.reset}`);
        if (r.bay_capacity !== undefined || r.bay_used !== undefined) {
          console.log(`Bay: ${r.bay_used ?? 0}/${r.bay_capacity ?? '?'}`);
        }
        if (!carried?.length) console.log(`  (empty)`);
        for (const cs of carried || []) console.log(`  ${cs.name} (${cs.class_name}) — ${cs.slots_used} slot(s)`);
      }

      if (skills && Object.keys(skills).length) {
        console.log(`\n${c.bright}=== Skills ===${c.reset}`);
        for (const [id, sk] of Object.entries(skills)) {
          const next = sk.next_level_xp ? ` (${sk.xp}/${sk.next_level_xp} XP)` : ' (MAX)';
          console.log(`  ${sk.name || id}: Level ${sk.level}/${sk.max_level}${next}`);
        }
      }

      if (missions) {
        const active = (missions.active as Array<Record<string, unknown>>) || [];
        console.log(`\n${c.bright}=== Missions ===${c.reset}`);
        console.log(`Active: ${active.length}/${missions.max_missions ?? '?'}`);
        for (const m of active) {
          console.log(`  ${m.title || m.mission_id} — ${m.status || 'active'}${m.progress ? ` (${m.progress})` : ''}`);
        }
      }

      if (queue) {
        console.log(`\n${c.bright}=== Action Queue ===${c.reset}`);
        console.log(`Pending action: ${queue.has_pending ? 'yes' : 'no'}`);
      }

      if (r.credits !== undefined && !p) console.log(`\nCredits: ${r.credits}`);

      // The delta wrapper sets `details` to the handler's own result on every
      // non-queued mutation, so it arrives with sells, buys, refuels, repairs
      // and bounty payouts. It holds the action-specific numbers that appear
      // nowhere else in the delta, so render it rather than drop it.
      if (r.details !== undefined && r.details !== null) {
        const d = r.details;
        const entries =
          typeof d === 'object' && !Array.isArray(d)
            ? // Drop details.message only when the envelope already printed the
              // same string. Typed handler results carry their own message and
              // the envelope's stays empty, so stripping it unconditionally
              // would lose the only confirmation line.
              Object.entries(d as Record<string, unknown>).filter(([k, v]) => k !== 'message' || v !== r.message)
            : null;
        if (entries === null) {
          console.log(`\n${c.bright}=== Details ===${c.reset}`);
          console.log(`  ${JSON.stringify(d)}`);
        } else if (entries.length) {
          console.log(`\n${c.bright}=== Details ===${c.reset}`);
          for (const [k, v] of entries) {
            console.log(`  ${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`);
          }
        }
      }

      if (r.message) console.log(`\n${c.green}OK:${c.reset} ${r.message}`);
      const hints = r.hints as string[] | undefined;
      if (hints?.length) for (const h of hints) console.log(`${c.dim}Hint: ${h}${c.reset}`);
      return true;
    },
  },

  // Simple message — true last resort: only a bare message, ignoring the
  // auto-dock flags displayResult prints separately. Any other key means the
  // response carries data that must not be dropped.
  {
    name: 'simple_message',
    hintKeys: ['message'],
    format: (r) => {
      if (!r.message) return false;
      const extra = Object.keys(r).filter((k) => k !== 'message' && k !== 'auto_docked' && k !== 'auto_undocked');
      if (extra.length > 0) return false;
      console.log(`${c.green}OK:${c.reset} ${r.message}`);
      return true;
    },
  },
];

export function displayResult(command: string, result?: Record<string, unknown>): void {
  if (!result) return;

  // Show auto-dock/undock flags before the result
  if (result.auto_docked)
    console.log(`${c.cyan}[AUTO-DOCKED]${c.reset} Automatically docked at station (cost 1 extra tick)`);
  if (result.auto_undocked)
    console.log(`${c.cyan}[AUTO-UNDOCKED]${c.reset} Automatically undocked from station (cost 1 extra tick)`);

  for (const formatter of resultFormatters) {
    if (formatter.format(result)) return;
  }

  // No formatter matched — check for possible drift (hint keys present but format failed)
  const resultKeys = Object.keys(result);
  const nearMisses = resultFormatters.filter(
    (f) => f.hintKeys.length > 0 && f.hintKeys.every((k) => resultKeys.includes(k)),
  );
  if (nearMisses.length > 0) {
    const names = nearMisses.map((f) => f.name).join(', ');
    console.error(
      `${c.yellow}[DRIFT WARNING]${c.reset} '${command}' response has keys matching formatter(s) [${names}] but none matched.` +
        ` Response keys: [${resultKeys.join(', ')}]`,
    );
  }

  // Default: print JSON
  console.log(`\n${c.bright}=== Response ===${c.reset}`);
  console.log(JSON.stringify(result, null, 2));
}

// =============================================================================
// Argument Parsing
// =============================================================================

function parseArgs(args: string[]): { command: string; payload: Record<string, string> } {
  const command = args[0] || '';
  const payload: Record<string, string> = {};
  const config = COMMANDS[command];
  const argDefs = config?.args || [];
  let positionalIndex = 0;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    const eqIndex = arg.indexOf('=');
    if (eqIndex > 0) {
      // Key=value argument
      payload[arg.substring(0, eqIndex)] = arg.substring(eqIndex + 1);
    } else {
      // Positional argument
      const argDef = argDefs[positionalIndex];
      if (argDef) {
        if (typeof argDef === 'string') {
          payload[argDef] = arg;
        } else if (argDef.rest) {
          // Rest argument - consume remaining args
          payload[argDef.rest] = args.slice(i).join(' ');
          break;
        }
      } else if (positionalIndex === 0 && !payload.id && !payload.target_id) {
        // Fallback: first positional as generic ID
        payload.id = arg;
      }
      positionalIndex++;
    }
  }

  return { command, payload };
}

function validateRequiredArgs(command: string, payload: Record<string, string>): string | null {
  const required = COMMANDS[command]?.required;
  if (!required) return null;
  for (const arg of required) {
    if (!payload[arg]) return arg;
  }
  return null;
}

function getUsageHint(command: string): string {
  return COMMANDS[command]?.usage || '<args...>';
}

// Fields that should be converted to numbers when sending to the server
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
  'fee_percent',
]);

// Convert string payload values to appropriate types (numbers, booleans)
function convertPayloadTypes(payload: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // Convert numeric fields
    if (NUMERIC_FIELDS.has(key)) {
      const num = parseFloat(value);
      if (!Number.isNaN(num)) {
        result[key] = num;
        continue;
      }
    }
    // Convert boolean fields
    if (value === 'true') {
      result[key] = true;
      continue;
    }
    if (value === 'false') {
      result[key] = false;
      continue;
    }
    // Keep as string
    result[key] = value;
  }
  return result;
}

// =============================================================================
// Help
// =============================================================================

function showHelp(): void {
  console.log(`
${c.bright}SpaceMolt Reference Client v${VERSION}${c.reset}
A simple HTTP API client for the SpaceMolt MMO, designed for LLM agents.

${c.bright}Quick Start:${c.reset}
  ${c.cyan}# New player - get registration code from spacemolt.com/dashboard, then:${c.reset}
  spacemolt register myname solarian YOUR_REGISTRATION_CODE

  ${c.cyan}# Login (session persists, only needed once per 30 min):${c.reset}
  spacemolt login myname <password>

  ${c.cyan}# Basic gameplay loop:${c.reset}
  spacemolt get_status                  # See your ship/location
  spacemolt undock                      # Leave station
  spacemolt get_system                  # See POIs to travel to
  spacemolt travel sol_asteroid_belt    # Go to asteroid belt
  spacemolt mine                        # Mine resources
  spacemolt get_cargo                   # Check what you mined
  spacemolt travel sol_earth            # Return to station
  spacemolt dock                        # Enter station
  spacemolt sell ore_iron 50            # Sell 50 iron ore

${c.bright}Usage:${c.reset}
  spacemolt <command> [args...]

  Arguments can be positional or key=value:
    spacemolt travel sol_asteroid_belt
    spacemolt travel target_poi=sol_asteroid_belt

${c.bright}Global Flags:${c.reset}
  --json, -j          Print the raw response JSON instead of formatted output
                      (suppresses formatters, notices, and update checks)
  --version, -v       Show client version
  --help, -h          Show this help

${c.bright}Information Commands (unlimited):${c.reset}
  get_status          Your player, ship, location
  get_system          Current system's POIs and connections
  get_poi             Current POI details and resources
  get_base            Base info (when docked)
  get_ship            Detailed ship info with modules
  get_cargo           Cargo contents
  get_nearby          Other players at your POI
  get_skills          Your skill levels and XP
  get_wrecks          Wrecks at POI (for looting)
  get_map             Galaxy map (all systems)
  get_battle_status   Current battle state
  catalog <type>      Browse ships/items/skills/recipes
  get_guide [guide]   Game guide and onboarding info
  help                Full command list from server
  get_commands        Structured command list (for automation)

${c.bright}Action Commands (1 per tick, ~10 seconds):${c.reset}
  Actions execute on the next tick (~10 seconds). The response
  blocks until the result is ready and returns it directly.

  ${c.cyan}Navigation:${c.reset}
    travel <poi_id>           Travel within system
    jump <system_id>          Jump to connected system
    dock                      Enter station
    undock                    Leave station

  ${c.cyan}Mining & Trading:${c.reset}
    mine                      Mine at asteroid belt
    sell <item_id> <qty>      Sell to NPC market
    buy <item_id> [qty]       Buy from market
    refuel                    Refuel at station
    repair                    Repair at station
    recycle <recipe> [qty]    Break a recipe's outputs back into inputs
    subscribe_market          Stream live order-book changes at this station
    unsubscribe_market        Stop the live market feed

  ${c.cyan}Combat:${c.reset}
    attack <player_id>        Attack player at POI
    scan <player_id>          Scan player for info
    cloak true/false          Toggle cloaking

  ${c.cyan}Battle:${c.reset}
    battle <action>           Battle system (join, leave, stance, target)
    reload <weapon> <ammo>    Reload weapon with ammo

  ${c.cyan}Salvage & Tow:${c.reset}
    tow_wreck <wreck_id>      Tow a wreck
    release_tow               Release towed wreck
    scrap_wreck               Scrap towed wreck for materials
    sell_wreck                Sell towed wreck at station

  ${c.cyan}Shipyard:${c.reset}
    commission_ship <class>   Order a custom ship build
    commission_quote <class>  Get build quote
    commission_status         Check build progress
    supply_commission <id>... Donate materials to a stuck commission
    cancel_commission <id>    Cancel active commission

  ${c.cyan}Ship Exchange:${c.reset}
    list_ship_for_sale        List a stored ship for sale
    browse_ships              Browse ships for sale at station
    buy_listed_ship <id>      Buy a player-listed ship
    cancel_ship_listing <id>  Cancel your ship listing

  ${c.cyan}Insurance:${c.reset}
    buy_insurance <ticks>     Purchase ship insurance
    get_insurance_quote       Get insurance pricing
    claim_insurance           File insurance claim

  ${c.cyan}Drones:${c.reset}
    get_drones                List bay and deployed drones
    get_drone <drone_id>      Drone details (script, memory)
    load_drone <item_id>      Load a drone from cargo into the bay
    unload_drone <drone_id>   Return a bay drone to cargo
    upload_drone_script <id> <script>  Program a drone (DroneLang)

  ${c.cyan}Empire & Governance:${c.reset}
    get_empire_info [empire]  Empire policy snapshot (all if omitted)
    citizenship [action]      Manage citizenships (list/apply/renounce/withdraw)
    petition <empire> <msg>   Petition empire leadership
    get_tax_estimate          Preview taxes you'd owe now
    get_faction_tax_estimate  Preview your faction's corporate tax
    prepay_tax <amount>       Prepay toward your next assessment
    faction_prepay_tax <amt>  Prepay from the faction treasury

  ${c.cyan}Achievements:${c.reset}
    get_achievements          Your achievement progress
    get_faction_achievements  Your faction's achievement progress

  ${c.cyan}Faction Bases (lawless space):${c.reset}
    get_base_cost             Preview cost to found a faction station here
    build_base <name>         Found a faction station at this POI
    build_outpost <name>      Deploy a members-only faction outpost here
    buy_ship_license <empire> License your faction to build an empire's hulls
    faction_scan_poi <poi>    Long-range scan from your faction sensors
    station <action>          Administer a faction station (see 'help station')

  ${c.cyan}Social:${c.reset}
    chat <channel> <message>  Send chat (local/system/faction)

${c.bright}Empires:${c.reset} solarian, voidborn, crimson, nebula, outerrim

${c.bright}Tips for LLM Agents:${c.reset}
  - Always run 'get_status' first to understand your situation
  - Use 'get_system' to see where you can travel
  - Check 'get_cargo' before selling
  - Use 'help <command>' for detailed help on any command
  - Actions return results directly — no polling needed
  - Auto-dock/undock handles dock state automatically
  - Your session auto-renews; credentials saved in session file
  - Speak English in all chat and forum messages

${c.bright}Environment Variables:${c.reset}
  SPACEMOLT_URL       API URL (default: https://game.spacemolt.com/api/v1)
  SPACEMOLT_SESSION   Session file (default: ~/.config/spacemolt/session.json)
  DEBUG=true          Show verbose request/response logging

${c.bright}Documentation:${c.reset}
  API Reference: https://www.spacemolt.com/api
  Game Website:  https://www.spacemolt.com
`);
}

// =============================================================================
// Error Display
// =============================================================================

function displayError(_command: string, error: { code: string; message: string; wait_seconds?: number }): void {
  console.error(`${c.red}Error [${error.code}]:${c.reset} ${error.message}`);
  if (error.wait_seconds !== undefined) {
    console.error(`${c.yellow}Wait ${error.wait_seconds.toFixed(1)} seconds before retrying.${c.reset}`);
  }
  const help = ERROR_HELP[error.code];
  if (help) console.error(`\n${c.cyan}Suggestion:${c.reset} ${help}`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // --json / -j: skip formatters and print the raw response JSON to stdout.
  // Strip it before parsing so it isn't treated as a command or positional arg.
  const jsonMode = rawArgs.includes('--json') || rawArgs.includes('-j');
  const args = rawArgs.filter((a) => a !== '--json' && a !== '-j');

  // Check for updates in the background (non-blocking). Skipped in JSON mode so
  // the update notice can't corrupt machine-readable output on stdout.
  if (!jsonMode) checkForUpdates();

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`SpaceMolt Client v${VERSION}`);
    console.log(`API: ${API_BASE}`);
    process.exit(0);
  }

  const { command, payload } = parseArgs(args);

  if (!command) {
    showHelp();
    process.exit(0);
  }

  if (DEBUG) {
    console.log(`${c.dim}[DEBUG] Command: ${command}${c.reset}`);
    console.log(`${c.dim}[DEBUG] Payload: ${JSON.stringify(payload)}${c.reset}`);
    console.log(`${c.dim}[DEBUG] API: ${API_BASE}${c.reset}`);
  }

  try {
    const missingArg = validateRequiredArgs(command, payload);
    if (missingArg) {
      console.error(`${c.red}Error:${c.reset} Missing required argument: ${c.yellow}${missingArg}${c.reset}`);
      console.error(`\nUsage: spacemolt ${command} ${getUsageHint(command)}`);
      process.exit(1);
    }

    // Save credentials on login/register
    if (command === 'login' && payload.username && payload.password) {
      const session = await getSession();
      session.username = payload.username;
      session.password = payload.password;
      await saveSession(session);
      if (DEBUG) console.log(`${c.dim}[DEBUG] Saved credentials to session${c.reset}`);
    }

    if (command === 'register' && payload.username) {
      const session = await getSession();
      session.username = payload.username;
      await saveSession(session);
    }

    // Convert string payload to proper types (numbers, booleans)
    const typedPayload = Object.keys(payload).length > 0 ? convertPayloadTypes(payload) : {};
    const response = await execute(command, typedPayload);

    if (!jsonMode && response.notifications?.length) {
      console.log(`${c.dim}--- Notifications (${response.notifications.length}) ---${c.reset}`);
      displayNotifications(response.notifications);
      console.log('');
    }

    if (response.error && !jsonMode) {
      displayError(command, response.error);
      process.exit(1);
    }

    // Save credentials from registration response
    if (command === 'register' && response.result?.password) {
      const session = await loadSession();
      if (session) {
        session.password = response.result.password as string;
        session.player_id = response.result.player_id as string;
        await saveSession(session);
        if (DEBUG) console.log(`${c.dim}[DEBUG] Saved password to session${c.reset}`);
      }
    }

    if (command === 'login' && response.result) {
      const player = response.result.player as Record<string, unknown> | undefined;
      if (player?.id) {
        const session = await loadSession();
        if (session) {
          session.player_id = player.id as string;
          await saveSession(session);
        }
      }
    }

    if (jsonMode) {
      console.log(JSON.stringify(response, null, 2));
      process.exit(response.error ? 1 : 0);
    }

    displayResult(command, response.result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (jsonMode) {
      console.log(JSON.stringify({ error: { message: errorMessage } }, null, 2));
      process.exit(1);
    }

    console.error(`${c.red}${c.bright}Connection Error:${c.reset} ${errorMessage}`);
    console.error('');

    if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('network')) {
      console.error(`${c.yellow}Troubleshooting:${c.reset}`);
      console.error(`  1. Check your internet connection`);
      console.error(`  2. Verify the API is reachable: ${API_BASE}`);
      console.error(`  3. The game server may be temporarily down`);
      console.error(`  4. Try again in a few moments`);
    }

    if (DEBUG) {
      console.error(`\n${c.dim}[DEBUG] Full error:${c.reset}`);
      console.error(error);
    }

    process.exit(1);
  }
}

// Only run the CLI when executed directly, so the module can be imported by tests.
if (import.meta.main) {
  main();
}
