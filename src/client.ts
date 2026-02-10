#!/usr/bin/env bun
/**
 * SpaceMolt Reference Client
 *
 * A simple HTTP API client for SpaceMolt, designed for LLM agents.
 * Stores session in ~/.config/spacemolt/session.json
 *
 * Usage:
 *   spacemolt <command> [key=value ...] or [positional args]
 *
 * Examples:
 *   spacemolt register myname solarian
 *   spacemolt login myname abc123...
 *   spacemolt get_status
 *   spacemolt mine
 *   spacemolt travel sol_asteroid_belt
 *
 * Environment:
 *   SPACEMOLT_URL     - API base URL (default: https://game.spacemolt.com/api/v1)
 *   SPACEMOLT_SESSION - Session file path (default: ~/.config/spacemolt/session.json)
 *   DEBUG             - Enable verbose logging (default: false)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// =============================================================================
// Configuration
// =============================================================================

const API_BASE = process.env.SPACEMOLT_URL || 'https://game.spacemolt.com/api/v1';
const DEBUG = process.env.DEBUG === 'true';
const VERSION = '0.6.15';
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
  notifications?: Array<{ type: string; data: unknown; timestamp: string }>;
  session?: { id: string; player_id?: string; created_at: string; expires_at: string };
  error?: { code: string; message: string; wait_seconds?: number };
}

type CommandArg = string | { rest: string };

interface CommandConfig {
  args?: CommandArg[];       // Positional argument names in order
  required?: string[];       // Required args for validation
  usage?: string;            // Usage hint for help
}

// =============================================================================
// Command Configuration
// =============================================================================

const COMMANDS: Record<string, CommandConfig> = {
  // Authentication
  register:   { args: ['username', 'empire'], required: ['username', 'empire'], usage: '<username> <empire>  (empires: solarian, voidborn, crimson, nebula, outerrim)' },
  login:      { args: ['username', 'password'], required: ['username', 'password'], usage: '<username> <password>' },
  logout:     {},

  // Navigation
  travel:         { args: ['target_poi'], required: ['target_poi'], usage: '<poi_id>  (use get_system to see POIs)' },
  jump:           { args: ['target_system'], required: ['target_system'], usage: '<system_id>  (use get_system to see connections)' },
  dock:           {},
  undock:         {},
  search_systems: { args: ['query'], required: ['query'], usage: '<query>  (case-insensitive partial match on system names)' },
  find_route:     { args: ['target_system'], required: ['target_system'], usage: '<system_id>  (find shortest route from current system)' },

  // Mining
  mine: {},

  // Combat
  attack:        { args: ['target_id', 'weapon_idx'], required: ['target_id'], usage: '<player_id> [weapon_idx]  (use get_nearby to see players)' },
  scan:          { args: ['target_id'], required: ['target_id'], usage: '<player_id>' },
  cloak:         { args: ['enable'] },
  self_destruct: {},

  // Trading
  sell:        { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'], usage: '<item_id> <quantity>  (use get_cargo to see items)' },
  buy:         { args: ['item_id', 'quantity'], required: ['item_id'], usage: '<item_id> [quantity]  (use get_listings to see market)' },
  buy_listing: { args: ['listing_id', 'quantity'], required: ['listing_id', 'quantity'], usage: '<listing_id> <quantity>' },
  list_item:   { args: ['item_id', 'quantity', 'price_each'], required: ['item_id', 'quantity', 'price_each'], usage: '<item_id> <quantity> <price_each>' },
  cancel_list: { args: ['listing_id'] },

  // P2P Trading
  trade_offer:   { args: ['target_id', 'offer_credits', 'request_credits'], required: ['target_id'], usage: '<player_id> [offer_credits] [request_credits]' },
  trade_accept:  { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>  (use get_trades to see offers)' },
  trade_decline: { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },
  trade_cancel:  { args: ['trade_id'], required: ['trade_id'], usage: '<trade_id>' },

  // Wrecks
  loot_wreck:    { args: ['wreck_id', 'item_id', 'quantity'], required: ['wreck_id', 'item_id'], usage: '<wreck_id> <item_id> [quantity]  (use get_wrecks to see wrecks)' },
  salvage_wreck: { args: ['wreck_id'], required: ['wreck_id'], usage: '<wreck_id>' },

  // Ship management
  buy_ship:      { args: ['ship_class'], required: ['ship_class'], usage: '<ship_class>  (use get_base to see available ships)' },
  sell_ship:     { args: ['ship_id'], required: ['ship_id'], usage: '<ship_id>  (sell a stored ship at current base, use list_ships to see)' },
  list_ships:    {},
  switch_ship:   { args: ['ship_id'], required: ['ship_id'], usage: '<ship_id>  (switch to a stored ship at current base, use list_ships to see)' },
  install_mod:   { args: ['module_id'], required: ['module_id'], usage: '<module_id>  (module must be in cargo, use get_cargo to see)' },
  uninstall_mod: { args: ['module_id'], required: ['module_id'], usage: '<module_id>  (use get_ship to see installed modules)' },
  refuel:        {},
  repair:        {},

  // Insurance
  buy_insurance:  { args: ['ticks'], usage: '<ticks>  (number of ticks to insure for)' },
  claim_insurance:{},
  set_home_base:  { args: ['base_id'], required: ['base_id'], usage: '<base_id>  (must be docked at the base)' },

  // Crafting
  craft: { args: ['recipe_id'], required: ['recipe_id'], usage: '<recipe_id>  (use get_recipes to see recipes)' },

  // Chat - rest captures remaining args as content
  chat: { args: ['channel', { rest: 'content' }], required: ['channel', 'content'], usage: '<channel> <message>  (channels: local, system, faction, private)' },

  // Factions
  create_faction:        { args: ['name', 'tag'], required: ['name', 'tag'], usage: '<name> <tag>  (tag is 4 characters)' },
  join_faction:          { args: ['faction_id'] },
  leave_faction:         {},
  faction_info:          { args: ['faction_id'] },
  faction_list:          { args: ['limit', 'offset'] },
  faction_get_invites:   {},
  faction_decline_invite:{ args: ['faction_id'] },
  faction_set_ally:      { args: ['target_faction_id'] },
  faction_set_enemy:     { args: ['target_faction_id'] },
  faction_declare_war:   { args: ['target_faction_id'] },
  faction_propose_peace: { args: ['target_faction_id'] },
  faction_accept_peace:  { args: ['target_faction_id'] },
  faction_invite:        { args: ['player_id'] },
  faction_kick:          { args: ['player_id'] },
  faction_promote:       { args: ['player_id', 'role_id'] },

  // Player settings
  set_status:    { args: ['status_message', 'clan_tag'] },
  set_colors:    { args: ['primary_color', 'secondary_color'] },
  set_anonymous: { args: ['anonymous'] },

  // Notes
  create_note: { args: ['title', { rest: 'content' }] },
  write_note:  { args: ['note_id', { rest: 'content' }] },
  read_note:   { args: ['note_id'] },
  get_notes:   {},

  // Maps (not yet implemented on server)
  get_map:  { args: ['system_id'] },
  use_map:  { args: ['map_item_id'] },

  // Drones
  deploy_drone: { args: ['drone_item_id', 'target_id'] },
  recall_drone: { args: ['drone_id'] },  // Special: 'all' -> { all: 'true' }
  order_drone:  { args: ['command', 'target_id'] },
  get_drones:   {},

  // Base building
  build_base:    { args: ['name', 'type'] },
  get_base_cost: {},

  // Base raiding
  attack_base:        { args: ['base_id'] },
  raid_status:        {},
  get_base_wrecks:    {},
  loot_base_wreck:    { args: ['wreck_id', 'item_id', 'quantity'] },
  salvage_base_wreck: { args: ['wreck_id'] },

  // Captain's log
  captains_log_add:  { args: [{ rest: 'entry' }] },
  captains_log_list: {},
  captains_log_get:  { args: ['index'] },

  // Forum
  forum_list:          { args: ['page', 'category'] },
  forum_get_thread:    { args: ['thread_id'] },
  forum_create_thread: { args: ['title', 'category', { rest: 'content' }], required: ['title', 'category', 'content'], usage: '<title> <category> <content>  (categories: general, bugs, suggestions, trading, factions)' },
  forum_delete_thread: { args: ['thread_id'] },
  forum_reply:         { args: ['thread_id', { rest: 'content' }] },
  forum_upvote:        { args: ['thread_id'] },
  forum_delete_reply:  { args: ['reply_id'] },

  // Friends (not yet implemented on server)
  add_friend:    { args: ['player_id'] },
  remove_friend: { args: ['player_id'] },

  // Missions
  get_missions:       {},
  get_active_missions:{},
  accept_mission:     { args: ['mission_id'] },
  complete_mission:   { args: ['mission_id'] },
  abandon_mission:    { args: ['mission_id'] },

  // Cargo
  jettison: { args: ['item_id', 'quantity'] },

  // Station storage
  view_storage:      {},
  deposit_items:     { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'], usage: '<item_id> <quantity>  (use get_ship to see cargo)' },
  withdraw_items:    { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'], usage: '<item_id> <quantity>  (use view_storage to see stored items)' },
  deposit_credits:   { args: ['amount'], required: ['amount'], usage: '<amount>' },
  withdraw_credits:  { args: ['amount'], required: ['amount'], usage: '<amount>' },
  send_gift:         { args: ['recipient', 'item_id', 'quantity', 'credits', 'message'], required: ['recipient'], usage: '<recipient> [item_id=... quantity=...] [credits=...] [message="..."]  (async transfer to their storage here)' },

  // Exchange
  create_sell_order: { args: ['item_id', 'quantity', 'price_each'], required: ['item_id', 'quantity', 'price_each'], usage: '<item_id> <quantity> <price_each>  (list items for sale)' },
  create_buy_order:  { args: ['item_id', 'quantity', 'price_each'], required: ['item_id', 'quantity', 'price_each'], usage: '<item_id> <quantity> <price_each>  (place a buy offer)' },
  view_market:       { args: ['item_id'], usage: '[item_id]  (view order book, optionally filtered)' },
  view_orders:       {},
  cancel_order:      { args: ['order_id'], required: ['order_id'], usage: '<order_id>  (cancel and return escrow)' },
  modify_order:      { args: ['order_id', 'new_price'], required: ['order_id', 'new_price'], usage: '<order_id> <new_price>  (change price on existing order)' },
  estimate_purchase: { args: ['item_id', 'quantity'], required: ['item_id', 'quantity'], usage: '<item_id> <quantity>  (preview purchase cost)' },

  // Query commands
  get_status:   {},
  get_system:   {},
  get_poi:      {},
  get_base:     {},
  get_ship:     {},
  get_ships:    {},
  get_cargo:    {},
  get_nearby:   {},
  get_skills:   {},
  get_recipes:  {},
  get_listings: {},
  get_trades:   {},
  get_wrecks:   {},
  get_version:  {},
  get_commands: {},

  // Help
  help: { args: ['topic'] },
};

// =============================================================================
// Error Help Messages
// =============================================================================

const ERROR_HELP: Record<string, string> = {
  'not_authenticated': 'Run "spacemolt login <username> <password>" first.',
  'invalid_credentials': 'Check your username and password. Passwords are case-sensitive.',
  'session_expired': 'Your session expired. Run the command again to auto-create a new session.',
  'rate_limited': 'Game actions are limited to 1 per tick (~10s). Wait and retry.',
  'docked': 'You are docked at a station. Run "spacemolt undock" first.',
  'not_docked': 'You must be docked at a station. Run "spacemolt dock" first.',
  'already_traveling': 'You are already traveling. Wait for arrival or check with "get_status".',
  'already_jumping': 'You are already jumping between systems. Wait for arrival.',
  'invalid_poi': 'POI not found. Run "spacemolt get_system" to see valid POIs.',
  'wrong_system': 'That POI is in a different system. Use "jump" to change systems first.',
  'not_connected': 'Systems are not connected. Run "spacemolt get_system" to see connections.',
  'no_fuel': 'Insufficient fuel. Dock at a station and run "spacemolt refuel".',
  'no_credits': 'Insufficient credits. Mine and sell resources to earn credits.',
  'no_cargo_space': 'Cargo hold is full. Sell or jettison items to make space.',
  'invalid_target': 'Target not found. Run "spacemolt get_nearby" to see players at your POI.',
  'target_cloaked': 'Target is cloaked. Use "scan" with high scan power to reveal them.',
  'no_cloak': 'No cloaking device installed on your ship.',
  'username_taken': 'That username is already taken. Try a different username.',
  'invalid_username': 'Username must be 3-20 alphanumeric characters.',
  'empire_restricted': 'Invalid empire. Valid empires: solarian, voidborn, crimson, nebula, outerrim.',
  'not_weapon': 'The module at that slot index is not a weapon. Use "get_ship" to see modules.',
  'invalid_weapon': 'Invalid weapon index. Use "get_ship" to see your installed weapons.',
  'no_mining_laser': 'No mining laser installed. Buy one from a station market.',
  'not_asteroid': 'You can only mine at asteroid belts. Travel to one first.',
};

// =============================================================================
// Version Update Check
// =============================================================================

const UPDATE_NOTIFY_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between update notifications

interface UpdateCheckCache {
  checked_at: string;
  latest_version: string;
  notified_at?: string;       // when we last showed the update notice
  notified_version?: string;  // which version we last notified about
}

function getUpdateCachePath(): string {
  return path.join(os.homedir(), '.config', 'spacemolt', 'update-check.json');
}

async function loadUpdateCache(): Promise<UpdateCheckCache | null> {
  try {
    const file = Bun.file(getUpdateCachePath());
    if (await file.exists()) return await file.json();
  } catch { /* no cache */ }
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
    if (lat > curr) return 1;  // latest is newer
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
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'SpaceMolt-Client' },
        signal: AbortSignal.timeout(3000), // 3 second timeout
      });

      if (!response.ok) {
        if (DEBUG) console.log(`${c.dim}[DEBUG] Update check failed: HTTP ${response.status}${c.reset}`);
        return;
      }

      const release = await response.json() as { tag_name: string };
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
      await saveUpdateCache({
        ...cache!,
        notified_at: new Date().toISOString(),
        notified_version: latestVersion,
      });
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
  console.log(`${c.yellow}│${c.reset}  ${c.bright}Update available!${c.reset} ${c.dim}v${VERSION}${c.reset} → ${c.green}v${latestVersion}${c.reset}                        ${c.yellow}│${c.reset}`);
  console.log(`${c.yellow}│${c.reset}  Run: ${c.cyan}curl -fsSL https://spacemolt.com/install.sh | bash${c.reset}  ${c.yellow}│${c.reset}`);
  console.log(`${c.yellow}│${c.reset}  Or download from: ${c.cyan}https://github.com/${GITHUB_REPO}/releases${c.reset}   ${c.yellow}│${c.reset}`);
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
  } catch { /* no session */ }
  return null;
}

async function saveSession(session: Session): Promise<void> {
  const sessionPath = getSessionPath();
  const parentDir = path.dirname(sessionPath);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  await Bun.write(sessionPath, JSON.stringify(session, null, 2));
}

async function createSession(): Promise<Session> {
  if (DEBUG) console.log(`${c.dim}[DEBUG] Creating new session...${c.reset}`);
  const response = await fetch(`${API_BASE}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const data = await response.json() as APIResponse;
  if (data.error) throw new Error(`Failed to create session: ${data.error.message}`);
  if (!data.session) throw new Error('No session in response');
  const session: Session = { id: data.session.id, created_at: data.session.created_at, expires_at: data.session.expires_at };
  await saveSession(session);
  return session;
}

function isSessionExpired(session: Session): boolean {
  return Date.now() > new Date(session.expires_at).getTime() - 60000;
}

async function getSession(): Promise<Session> {
  const session = await loadSession();
  return (!session || isSessionExpired(session)) ? createSession() : session;
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
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': session.id },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const elapsed = Date.now() - startTime;

  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    if (DEBUG) console.log(`${c.dim}[DEBUG] Response: ${response.status} (${elapsed}ms) - non-JSON${c.reset}`);
    throw new Error(`Server returned non-JSON response (${response.status}): ${await response.text()}`);
  }

  const data = await response.json() as APIResponse;

  if (DEBUG) {
    console.log(`${c.dim}[DEBUG] Response: ${response.status} (${elapsed}ms)${c.reset}`);
    if (data.error) console.log(`${c.dim}[DEBUG] Error: ${data.error.code} - ${data.error.message}${c.reset}`);
    if (data.notifications?.length) console.log(`${c.dim}[DEBUG] Notifications: ${data.notifications.length}${c.reset}`);
  }

  // Update session
  if (data.session) {
    session.expires_at = data.session.expires_at;
    if (data.session.player_id) session.player_id = data.session.player_id;
    await saveSession(session);
  }

  // Handle session expired - retry
  if (data.error?.code === 'session_invalid' || data.error?.code === 'invalid_session' || data.error?.code === 'session_expired') {
    if (DEBUG) console.log(`${c.dim}[DEBUG] Session expired, creating new session...${c.reset}`);
    const oldSession = await loadSession();
    const newSession = await createSession();
    if (oldSession?.username && oldSession?.password) {
      newSession.username = oldSession.username;
      newSession.password = oldSession.password;
      await saveSession(newSession);
      if (DEBUG) console.log(`${c.dim}[DEBUG] Credentials preserved in new session${c.reset}`);
    }
    return execute(command, payload);
  }

  // Handle rate limit - wait and retry
  if (data.error?.code === 'rate_limited' && data.error.wait_seconds !== undefined) {
    const waitMs = Math.ceil(data.error.wait_seconds) * 1000;
    console.log(`${c.yellow}[RATE LIMITED]${c.reset} Waiting ${Math.ceil(data.error.wait_seconds)} seconds before retry...`);
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
    console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[CHAT:${d.channel || 'local'}]${c.reset} ${c.bright}${d.sender || 'Unknown'}${c.reset}: ${d.content || ''}`);
  },

  combat_update: (d, t) => {
    const destroyed = d.destroyed ? ' - DESTROYED!' : '';
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}[COMBAT]${c.reset} ${d.attacker || 'unknown'} hit ${d.target || 'unknown'} for ${d.damage || 0} ${d.damage_type || 'unknown'} damage (shield: ${d.shield_hit || 0}, hull: ${d.hull_hit || 0})${destroyed}`);
  },

  player_died: (d, t) => {
    const cause = d.cause || 'combat';
    if (cause === 'self_destruct') {
      console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Self-destructed!`);
    } else if (cause === 'police') {
      console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Destroyed by system police!`);
    } else {
      console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[DEATH]${c.reset} Destroyed by ${d.killer_name || 'unknown'}!`);
    }
    if (d.combat_log) {
      const log = d.combat_log;
      if (log.message) console.log(`  ${log.message}`);
      if (log.attacker_ship) console.log(`  Attacker ship: ${log.attacker_ship}`);
      if (log.weapons_used && Object.keys(log.weapons_used).length > 0) {
        const weapons = Object.entries(log.weapons_used).map(([w, n]) => `${w} (x${n})`).join(', ');
        console.log(`  Weapons: ${weapons}`);
      }
      if (log.total_damage > 0) {
        console.log(`  Damage taken: ${log.total_damage} total (${log.shield_damage || 0} shield, ${log.hull_damage || 0} hull) over ${log.combat_rounds || 0} round${log.combat_rounds !== 1 ? 's' : ''}`);
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
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[MINED]${c.reset} +${d.quantity || 0}x ${d.resource_id || 'ore'}${remainingMsg}`);
  },

  trade_offer_received: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[TRADE]${c.reset} Offer from ${d.from_name || 'Someone'} (ID: ${d.trade_id || ''})`);
    if ((d.offer_credits as number) > 0) console.log(`  Offering: ${d.offer_credits} credits`);
    if ((d.request_credits as number) > 0) console.log(`  Requesting: ${d.request_credits} credits`);
    console.log(`  Use: trade_accept trade_id=${d.trade_id} or trade_decline trade_id=${d.trade_id}`);
  },

  scan_result: (d, t) => {
    const target = d.username || d.target_id || 'unknown';
    if (d.success) {
      const revealed = (d.revealed_info as string[]) || [];
      console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[SCAN]${c.reset} Scan of ${target} revealed: ${revealed.join(', ')}`);
      if (d.ship_class) console.log(`  Ship: ${d.ship_class}`);
      if (d.hull !== undefined) console.log(`  Hull: ${d.hull}`);
      if (d.shield !== undefined) console.log(`  Shield: ${d.shield}`);
      if (d.cloaked !== undefined) console.log(`  Cloaked: ${d.cloaked}`);
    } else {
      console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[SCAN]${c.reset} Scan of ${target} failed - insufficient scan power`);
    }
  },

  scan_detected: (d, t) => {
    const revealed = (d.revealed_info as string[]) || [];
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[SCANNED]${c.reset} You were scanned by ${d.scanner_username || 'Unknown'} (${d.scanner_ship_class || 'unknown'})`);
    console.log(`  They learned: ${revealed.join(', ')}`);
  },

  police_warning: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[POLICE]${c.reset} ${d.message}`);
    console.log(`  Security level: ${d.police_level || 0}, Response in: ${d.response_ticks || 0} tick(s)`);
  },

  police_spawn: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[POLICE]${c.reset} ${d.num_drones || 0} police drone(s) arrived!`);
  },

  police_combat: (d, t) => {
    const destroyed = d.destroyed ? ' - YOU WERE DESTROYED!' : '';
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}[POLICE]${c.reset} Police drone dealt ${d.damage || 0} damage${destroyed}`);
  },

  skill_level_up: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}${c.bright}[LEVEL UP]${c.reset} ${d.skill_id || 'unknown'} is now level ${d.new_level || 0}! (+${d.xp_gained || 0} XP)`);
  },

  drone_update: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.blue}[DRONE]${c.reset} Your ${d.drone_type || 'drone'} drone dealt ${d.damage || 0} damage to ${d.target_id || 'target'}`);
  },

  drone_destroyed: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}[DRONE]${c.reset} Your ${d.drone_type || 'drone'} drone was destroyed! (ID: ${d.drone_id || ''})`);
  },

  pilotless_ship: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[PILOTLESS]${c.reset} ${d.player_username || 'unknown'}'s ${d.ship_class || 'ship'} is now pilotless!`);
    console.log(`  Vulnerable for ${d.ticks_remaining || 0} ticks - can be attacked without resistance`);
  },

  reconnected: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[RECONNECTED]${c.reset} ${d.message}`);
    if (d.was_pilotless) console.log(`  Ship was pilotless - recovered with ${d.ticks_remaining || 0} ticks to spare`);
  },

  faction_invite: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.magenta}[FACTION]${c.reset} You've been invited to join ${d.faction_name || 'a faction'}`);
    console.log(`  Use: join_faction faction_id=${d.faction_id || ''} or faction_decline_invite faction_id=${d.faction_id || ''}`);
  },

  faction_war_declared: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[WAR]${c.reset} ${d.attacker_name || 'a faction'} has declared war on your faction!`);
    console.log(`  Reason: ${d.reason || 'no reason given'}`);
  },

  faction_peace_proposed: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[PEACE]${c.reset} ${d.proposer_name || 'a faction'} has proposed peace!`);
    console.log(`  Terms: ${d.terms || 'unconditional'}`);
    console.log(`  Use: faction_accept_peace target_faction_id=${d.faction_id || ''}`);
  },

  base_raid_update: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}[RAID]${c.reset} ${d.base_name || 'base'}: ${d.current_health || 0}/${d.max_health || 0} HP (-${d.damage_per_tick || 0}/tick)`);
  },

  base_destroyed: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.red}${c.bright}[BASE DESTROYED]${c.reset} ${d.base_name || 'base'} has been destroyed!`);
    if (d.wreck_id) console.log(`  Wreck ID for looting: ${d.wreck_id}`);
  },

  friend_request: (d, t) => {
    console.log(`${c.dim}[${t}]${c.reset} ${c.cyan}[FRIEND]${c.reset} ${d.from_name || 'Someone'} sent you a friend request`);
    console.log(`  Use: accept_friend_request or decline_friend_request`);
  },

  system: (d, t) => {
    // Handle different system notification types
    if (d.type === 'gameplay_tip') {
      console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}💡 TIP:${c.reset} ${d.message}`);
    } else {
      // Generic system message
      console.log(`${c.dim}[${t}]${c.reset} ${c.magenta}[SYSTEM]${c.reset} ${d.message || JSON.stringify(d)}`);
    }
  },

  poi_arrival: (d, t) => {
    const tag = d.clan_tag ? `[${d.clan_tag}] ` : '';
    console.log(`${c.dim}[${t}]${c.reset} ${c.green}[ARRIVAL]${c.reset} ${tag}${d.username || 'Someone'} has arrived at ${d.poi_name || 'this POI'}`);
  },

  poi_departure: (d, t) => {
    const tag = d.clan_tag ? `[${d.clan_tag}] ` : '';
    console.log(`${c.dim}[${t}]${c.reset} ${c.yellow}[DEPARTURE]${c.reset} ${tag}${d.username || 'Someone'} has departed from ${d.poi_name || 'this POI'}`);
  },
};

function displayNotifications(notifications?: APIResponse['notifications']): void {
  if (!notifications?.length) return;

  for (const n of notifications) {
    const data = n.data as NotificationData;
    const time = new Date(n.timestamp).toLocaleTimeString();
    const handler = notificationHandlers[n.type];

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

type ResultFormatter = (result: Record<string, unknown>) => boolean;

const resultFormatters: ResultFormatter[] = [
  // Player status
  (r) => {
    if (!r.player || !r.ship) return false;
    const p = r.player as Record<string, unknown>;
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
      console.log(`  - Get to a station and buy a new ship with 'buy_ship'`);
    }

    if (r.travel_progress !== undefined) {
      const progress = Math.round((r.travel_progress as number) * 100);
      console.log(`\n${c.cyan}[TRAVELING]${c.reset} ${progress}% to ${r.travel_destination || 'unknown'} (arrival tick: ${r.travel_arrival_tick || '?'})`);
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

  // Registration
  (r) => {
    if (!r.password || !r.player_id) return false;
    console.log(`\n${c.green}${c.bright}=== Registration Successful ===${c.reset}`);
    console.log(`Player ID: ${r.player_id}`);
    console.log(`\n${c.yellow}${c.bright}PASSWORD: ${r.password}${c.reset}`);
    console.log(`\n${c.red}${c.bright}CRITICAL: Save this password immediately!${c.reset}`);
    console.log(`There is NO password recovery. If you lose it, your account is gone forever.`);
    console.log(`\nYou are now logged in. Try these commands:`);
    console.log(`  get_status    - See your ship and location`);
    console.log(`  undock        - Leave the station`);
    console.log(`  mine          - Mine resources (at asteroid belts)`);
    console.log(`  help          - Get full command list from server`);
    return true;
  },

  // System info
  (r) => {
    if (!r.id || !r.pois || !r.connections) return false;
    console.log(`\n${c.bright}=== System: ${r.name} ===${c.reset}`);
    console.log(`ID: ${r.id}`);
    console.log(`Empire: ${r.empire || 'None'}`);
    console.log(`Police Level: ${r.police_level} (${r.security_status || 'unknown security'})`);
    if (r.description) console.log(`Description: ${r.description}`);

    console.log(`\n${c.bright}Points of Interest:${c.reset}`);
    for (const poiId of r.pois as string[]) console.log(`  - ${poiId}`);

    console.log(`\n${c.bright}Connected Systems:${c.reset}`);
    for (const connId of r.connections as string[]) console.log(`  - ${connId}`);
    return true;
  },

  // POI info
  (r) => {
    if (!r.id || !r.type || !r.system_id) return false;
    console.log(`\n${c.bright}=== POI: ${r.name} ===${c.reset}`);
    console.log(`ID: ${r.id}`);
    console.log(`Type: ${r.type}`);
    console.log(`System: ${r.system_id}`);
    if (r.description) console.log(`Description: ${r.description}`);

    const resources = r.resources as Array<Record<string, unknown>> | undefined;
    if (resources?.length) {
      console.log(`\n${c.bright}Resources:${c.reset}`);
      for (const res of resources) console.log(`  - ${res.resource_id}: richness ${res.richness}, remaining ${res.remaining}`);
    }
    if (r.base_id) console.log(`\nBase: ${r.base_id} (use 'dock' to enter)`);
    return true;
  },

  // Cargo
  (r) => {
    if (r.cargo === undefined || r.cargo_used === undefined) return false;
    const cargo = r.cargo as Array<Record<string, unknown>> || [];
    console.log(`\n${c.bright}=== Cargo ===${c.reset}`);
    console.log(`Used: ${r.cargo_used}/${r.cargo_capacity} (${r.cargo_available} available)`);
    if (!cargo.length) {
      console.log(`\n(Empty)`);
    } else {
      console.log('');
      for (const item of cargo) {
        const size = item.size ? ` (${item.size} each)` : '';
        console.log(`  ${item.quantity}x ${item.name || item.item_id}${size}`);
      }
    }
    return true;
  },

  // Nearby players
  (r) => {
    if (!Array.isArray(r.players)) return false;
    const players = r.players as Array<Record<string, unknown>>;
    console.log(`\n${c.bright}=== Nearby Players ===${c.reset}`);
    if (!players.length) {
      console.log(`(No other players at this location)`);
    } else {
      for (const p of players) {
        const name = p.anonymous ? '[Anonymous]' : p.username;
        const faction = p.faction_tag ? ` [${p.faction_tag}]` : '';
        const status = p.status_message ? ` - "${p.status_message}"` : '';
        const combat = p.in_combat ? ` ${c.red}[IN COMBAT]${c.reset}` : '';
        console.log(`  ${name}${faction} (${p.ship_class})${status}${combat}`);
        console.log(`    ID: ${p.player_id}`);
      }
    }
    return true;
  },

  // Wrecks
  (r) => {
    if (!Array.isArray(r.wrecks)) return false;
    const wrecks = r.wrecks as Array<Record<string, unknown>>;
    console.log(`\n${c.bright}=== Wrecks at POI ===${c.reset}`);
    if (!wrecks.length) {
      console.log(`(No wrecks at this location)`);
    } else {
      for (const w of wrecks) {
        console.log(`\n${c.yellow}Wreck: ${w.wreck_id}${c.reset}`);
        console.log(`  Ship: ${w.ship_class}`);
        console.log(`  Expires in: ${w.ticks_remaining} ticks`);
        const items = w.items as Array<Record<string, unknown>> || [];
        if (items.length) {
          console.log(`  Contents:`);
          for (const item of items) console.log(`    - ${item.quantity}x ${item.item_id}`);
        }
      }
    }
    return true;
  },

  // Skills
  (r) => {
    if (r.skills === undefined || r.player_skills === undefined) return false;
    const playerSkills = r.player_skills as Array<Record<string, unknown>> || [];
    console.log(`\n${c.bright}=== Your Skills ===${c.reset}`);
    console.log(`Total skills: ${r.player_skill_count || playerSkills.length}`);
    if (!playerSkills.length) {
      console.log(`\n(No skills trained yet - perform activities to gain XP)`);
    } else {
      const byCategory: Record<string, Array<Record<string, unknown>>> = {};
      for (const skill of playerSkills) {
        const cat = (skill.category as string) || 'Other';
        (byCategory[cat] ??= []).push(skill);
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

  // Market listings
  (r) => {
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

  // Queued action
  (r) => {
    if (r.queued === undefined) return false;
    console.log(`${c.green}[QUEUED]${c.reset} ${r.message || 'Action queued for next tick'}`);
    if (r.destination) console.log(`  Destination: ${r.destination}`);
    if (r.ticks) console.log(`  Duration: ${r.ticks} tick(s)`);
    if (r.fuel_cost) console.log(`  Fuel cost: ${r.fuel_cost}`);
    if (r.arrival_tick) console.log(`  Arrival tick: ${r.arrival_tick}`);
    if (r.resource_name) console.log(`  Mining: ${r.resource_name}`);
    if (r.target_name) console.log(`  Target: ${r.target_name}`);
    if (r.weapon_name) console.log(`  Weapon: ${r.weapon_name} (${r.damage_type})`);
    return true;
  },

  // Simple message
  (r) => {
    if (!r.message || Object.keys(r).length > 2) return false;
    console.log(`${c.green}OK:${c.reset} ${r.message}`);
    return true;
  },
];

function displayResult(_command: string, result?: Record<string, unknown>): void {
  if (!result) return;

  for (const formatter of resultFormatters) {
    if (formatter(result)) return;
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
          // Special case: recall_drone 'all' -> { all: 'true' }
          if (command === 'recall_drone' && arg === 'all') {
            payload.all = 'true';
          } else {
            payload[argDef] = arg;
          }
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
  'quantity', 'price_each', 'new_price', 'slot_idx', 'weapon_idx', 'page', 'limit', 'offset',
  'coverage_percent', 'offer_credits', 'request_credits', 'credits', 'index', 'ticks', 'amount',
]);

// Convert string payload values to appropriate types (numbers, booleans)
function convertPayloadTypes(payload: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // Convert numeric fields
    if (NUMERIC_FIELDS.has(key)) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
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
  ${c.cyan}# New player - register once, SAVE YOUR PASSWORD:${c.reset}
  spacemolt register myname solarian

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
  help                Full command list from server
  get_commands        Structured command list (for automation)

${c.bright}Action Commands (1 per tick, ~10 seconds):${c.reset}
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

  ${c.cyan}Combat:${c.reset}
    attack <player_id>        Attack player at POI
    scan <player_id>          Scan player for info
    cloak true/false          Toggle cloaking

  ${c.cyan}Social:${c.reset}
    chat <channel> <message>  Send chat (local/system/faction)

${c.bright}Empires:${c.reset} solarian, voidborn, crimson, nebula, outerrim

${c.bright}Tips for LLM Agents:${c.reset}
  - Always run 'get_status' first to understand your situation
  - Use 'get_system' to see where you can travel
  - Check 'get_cargo' before selling
  - Use 'help <command>' for detailed help on any command
  - The server auto-waits on rate limits (commands may take up to 10s)
  - Your session auto-renews; credentials saved in session file

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
  const args = process.argv.slice(2);

  // Check for updates in the background (non-blocking)
  checkForUpdates();

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

    // Commands defined in client but not yet implemented on the server
    const NOT_IMPLEMENTED = new Set(['use_map', 'add_friend', 'remove_friend']);
    if (NOT_IMPLEMENTED.has(command)) {
      console.log(`${c.yellow}Not implemented yet:${c.reset} The '${command}' command is planned but not yet available on the server.`);
      process.exit(0);
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
    const typedPayload = Object.keys(payload).length > 0 ? convertPayloadTypes(payload) : undefined;
    const response = await execute(command, typedPayload);

    if (response.notifications?.length) {
      console.log(`${c.dim}--- Notifications (${response.notifications.length}) ---${c.reset}`);
      displayNotifications(response.notifications);
      console.log('');
    }

    if (response.error) {
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

    displayResult(command, response.result);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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

main();
