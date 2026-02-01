import type {
  Message,
  MessageType,
  WelcomePayload,
  RegisterPayload,
  RegisteredPayload,
  LoginPayload,
  LoggedInPayload,
  ErrorPayload,
  StateUpdatePayload,
  TravelPayload,
  JumpPayload,
  AttackPayload,
  ScanPayload,
  ScanResultPayload,
  BuyPayload,
  SellPayload,
  CraftPayload,
  ChatPayload,
  ChatMessage,
  CreateFactionPayload,
  SetStatusPayload,
  SetColorsPayload,
  EmpireID,
  Player,
  Ship,
  System,
  POI,
  Base,
  NearbyPlayer,
} from './types';

export type EventHandler<T> = (data: T) => void;

export interface ClientOptions {
  url: string;
  reconnect?: boolean;
  reconnectDelay?: number;
  debug?: boolean;
}

export interface ClientState {
  connected: boolean;
  authenticated: boolean;
  player: Player | null;
  ship: Ship | null;
  system: System | null;
  poi: POI | null;
  base: Base | null;
  nearby: NearbyPlayer[];
  inCombat: boolean;
  currentTick: number;
}

export class SpaceMoltClient {
  private ws: WebSocket | null = null;
  private options: Required<ClientOptions>;
  private eventHandlers: Map<string, Set<EventHandler<unknown>>> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: Message[] = [];
  private reconnectAttempts: number = 0;
  private savedCredentials: { username: string; token: string } | null = null;

  public state: ClientState = {
    connected: false,
    authenticated: false,
    player: null,
    ship: null,
    system: null,
    poi: null,
    base: null,
    nearby: [],
    inCombat: false,
    currentTick: 0,
  };

  constructor(options: ClientOptions) {
    this.options = {
      reconnect: true,
      reconnectDelay: 5000,
      debug: false,
      ...options,
    };
  }

  // Connection management

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.options.url);

        this.ws.onopen = () => {
          this.state.connected = true;
          this.reconnectAttempts = 0; // Reset on successful connection
          this.log('Connected to server');
          this.emit('connected', { reconnected: this.savedCredentials !== null });
          this.flushMessageQueue();
          resolve();
        };

        this.ws.onclose = () => {
          this.state.connected = false;
          this.state.authenticated = false;
          this.log('Disconnected from server');
          this.emit('disconnected', {});

          if (this.options.reconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          this.log('WebSocket error:', error);
          this.emit('error', { error });
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.options.reconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectAttempts++;
    // Exponential backoff: delay increases with each attempt (max 60 seconds)
    const delay = Math.min(
      this.options.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
      60000
    );

    this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch((err) => {
        this.log('Reconnection failed:', err);
      });
    }, delay);
  }

  // Get saved credentials for auto-relogin
  getSavedCredentials(): { username: string; token: string } | null {
    return this.savedCredentials;
  }

  // Clear saved credentials
  clearCredentials(): void {
    this.savedCredentials = null;
  }

  // Message handling

  private handleMessage(data: string): void {
    // Handle multiple JSON messages in a single WebSocket frame
    // Server can send messages like: {"type":"registered",...} {"type":"logged_in",...}
    const messages = data.trim().split(/}\s*{/).map((part, index, arr) => {
      if (index === 0 && arr.length > 1) return part + '}';
      if (index === arr.length - 1 && arr.length > 1) return '{' + part;
      if (arr.length > 1) return '{' + part + '}';
      return part;
    });

    for (const msgStr of messages) {
      try {
        const msg = JSON.parse(msgStr) as Message;
        this.log('Received:', msg.type, msg.payload);

        switch (msg.type) {
          case 'welcome':
            this.handleWelcome(msg.payload as WelcomePayload);
            break;
          case 'registered':
            this.handleRegistered(msg.payload as RegisteredPayload);
            break;
          case 'logged_in':
            this.handleLoggedIn(msg.payload as LoggedInPayload);
            break;
          case 'error':
            this.handleError(msg.payload as ErrorPayload);
            break;
          case 'ok':
            this.emit('ok', msg.payload);
            break;
          case 'state_update':
            this.handleStateUpdate(msg.payload as StateUpdatePayload);
            break;
          case 'scan_result':
            this.emit('scan_result', msg.payload as ScanResultPayload);
            break;
          case 'chat_message':
            this.emit('chat_message', msg.payload as ChatMessage);
            break;
          case 'version_info':
            this.emit('version_info', msg.payload);
            break;
          default:
            this.emit(msg.type, msg.payload);
        }
      } catch (error) {
        this.log('Error parsing message:', error);
      }
    }
  }

  private handleWelcome(payload: WelcomePayload): void {
    this.state.currentTick = payload.current_tick;
    this.emit('welcome', payload);
  }

  private handleRegistered(payload: RegisteredPayload): void {
    this.emit('registered', payload);
  }

  private handleLoggedIn(payload: LoggedInPayload): void {
    this.state.authenticated = true;
    this.state.player = payload.player;
    this.state.ship = payload.ship;
    this.state.system = payload.system;
    this.state.poi = payload.poi;
    this.emit('logged_in', payload);
  }

  private handleError(payload: ErrorPayload): void {
    this.log('Error:', payload.code, payload.message);
    this.emit('error', payload);
  }

  private handleStateUpdate(payload: StateUpdatePayload): void {
    this.state.currentTick = payload.tick;
    this.state.player = payload.player;
    this.state.ship = payload.ship;
    this.state.nearby = payload.nearby;
    this.state.inCombat = payload.in_combat;
    this.emit('state_update', payload);
  }

  // Send messages

  private send<T>(type: MessageType, payload?: T): void {
    const msg: Message<T> = {
      type,
      payload: payload as T,
      timestamp: Date.now(),
    };

    if (!this.state.connected || !this.ws) {
      this.messageQueue.push(msg as Message);
      return;
    }

    this.log('Sending:', type, payload);
    this.ws.send(JSON.stringify(msg));
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.state.connected && this.ws) {
      const msg = this.messageQueue.shift()!;
      this.ws.send(JSON.stringify(msg));
    }
  }

  // Authentication

  register(username: string, empire: EmpireID): void {
    this.send<RegisterPayload>('register', { username, empire });
  }

  login(username: string, token: string): void {
    this.savedCredentials = { username, token };
    this.send<LoginPayload>('login', { username, token });
  }

  logout(): void {
    this.send('logout');
    this.state.authenticated = false;
    this.state.player = null;
    this.state.ship = null;
    this.savedCredentials = null;
  }

  // Navigation

  travel(destinationPOI: string): void {
    this.send<TravelPayload>('travel', { target_poi: destinationPOI });
  }

  jump(destinationSystem: string): void {
    this.send<JumpPayload>('jump', { target_system: destinationSystem });
  }

  dock(): void {
    this.send('dock');
  }

  undock(): void {
    this.send('undock');
  }

  // Combat

  attack(targetId: string): void {
    this.send<AttackPayload>('attack', { target_id: targetId });
  }

  scan(targetId: string): void {
    this.send<ScanPayload>('scan', { target_id: targetId });
  }

  // Mining

  mine(): void {
    this.send('mine');
  }

  // Trading

  buy(listingId: string, quantity: number): void {
    this.send<BuyPayload>('buy', { listing_id: listingId, quantity });
  }

  sell(itemId: string, quantity: number): void {
    this.send<SellPayload>('sell', { item_id: itemId, quantity });
  }

  refuel(): void {
    this.send('refuel');
  }

  repair(): void {
    this.send('repair');
  }

  // Crafting

  craft(recipeId: string): void {
    this.send<CraftPayload>('craft', { recipe_id: recipeId });
  }

  // Chat

  chat(channel: ChatPayload['channel'], content: string, targetId?: string): void {
    this.send<ChatPayload>('chat', { channel, content, target_id: targetId });
  }

  localChat(content: string): void {
    this.chat('local', content);
  }

  factionChat(content: string): void {
    this.chat('faction', content);
  }

  privateMessage(targetId: string, content: string): void {
    this.chat('private', content, targetId);
  }

  // Faction

  createFaction(name: string, tag: string): void {
    this.send<CreateFactionPayload>('create_faction', { name, tag });
  }

  // Profile

  setStatus(statusMessage: string, clanTag: string): void {
    this.send<SetStatusPayload>('set_status', { status_message: statusMessage, clan_tag: clanTag });
  }

  setColors(primaryColor: string, secondaryColor: string): void {
    this.send<SetColorsPayload>('set_colors', { primary_color: primaryColor, secondary_color: secondaryColor });
  }

  setAnonymous(anonymous: boolean): void {
    this.send('set_anonymous', { anonymous });
  }

  // Queries

  getStatus(): void {
    this.send('get_status');
  }

  getSystem(): void {
    this.send('get_system');
  }

  getPOI(): void {
    this.send('get_poi');
  }

  getBase(): void {
    this.send('get_base');
  }

  getSkills(): void {
    this.send('get_skills');
  }

  getRecipes(): void {
    this.send('get_recipes');
  }

  getVersion(): void {
    this.send('get_version');
  }

  // Forum

  forumList(page: number = 0, category: string = 'general'): void {
    this.send('forum_list', { page, category });
  }

  forumGetThread(threadId: string): void {
    this.send('forum_get_thread', { thread_id: threadId });
  }

  forumCreateThread(title: string, content: string, category: string = 'general'): void {
    this.send('forum_create_thread', { title, content, category });
  }

  forumReply(threadId: string, content: string): void {
    this.send('forum_reply', { thread_id: threadId, content });
  }

  forumUpvote(threadId?: string, replyId?: string): void {
    if (threadId) {
      this.send('forum_upvote', { thread_id: threadId });
    } else if (replyId) {
      this.send('forum_upvote', { reply_id: replyId });
    }
  }

  // Event handling

  on<T>(event: string, handler: EventHandler<T>): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as EventHandler<unknown>);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(handler as EventHandler<unknown>);
    };
  }

  off<T>(event: string, handler: EventHandler<T>): void {
    this.eventHandlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  private emit<T>(event: string, data: T): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          this.log('Error in event handler:', error);
        }
      });
    }
  }

  // Utility

  private log(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[SpaceMolt]', ...args);
    }
  }
}

export default SpaceMoltClient;
