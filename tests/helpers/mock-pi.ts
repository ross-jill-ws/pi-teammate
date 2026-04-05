/**
 * Mock helpers for pi-teammate testing.
 *
 * Tests run under Bun which doesn't support the native `better-sqlite3` addon.
 * We use `bun:sqlite` wrapped in a thin compatibility shim that matches
 * the `better-sqlite3` API surface used by schema.ts and db.ts.
 */
import { Database as BunDatabase } from "bun:sqlite";
import { initSchema } from "../../extensions/schema.ts";

// ── better-sqlite3 compat wrapper around bun:sqlite ─────────────

/**
 * Wraps a bun:sqlite Database to provide the subset of the better-sqlite3
 * API that schema.ts / db.ts actually use:
 *   - db.pragma(str)            -> exec PRAGMA
 *   - db.pragma(str, { simple }) -> returns scalar
 *   - db.exec(sql)
 *   - db.prepare(sql).run(...)  -> { changes, lastInsertRowid }
 *   - db.prepare(sql).get(...)  -> row | undefined
 *   - db.prepare(sql).all(...)  -> row[]
 */
/**
 * Convert @param style named parameters (better-sqlite3) to $param style (bun:sqlite).
 * Also converts object keys from { name } to { $name }.
 */
function convertSql(sql: string): string {
  return sql.replace(/@(\w+)/g, (_, name) => "$" + name);
}

function convertParams(args: any[]): any[] {
  if (args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0])) {
    const obj = args[0];
    // Check if keys already have $ prefix
    const keys = Object.keys(obj);
    if (keys.length > 0 && !keys[0].startsWith("$")) {
      const converted: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        converted["$" + k] = v;
      }
      return [converted];
    }
  }
  return args;
}

export function createBetterSqlite3Compat(inner: InstanceType<typeof BunDatabase>): any {
  const db: any = {};

  db._inner = inner;

  db.pragma = (pragmaStr: string, opts?: { simple?: boolean }) => {
    const sql = `PRAGMA ${pragmaStr}`;

    if (opts?.simple) {
      const row = inner.prepare(sql).get() as Record<string, any> | null;
      if (!row) return undefined;
      const values = Object.values(row);
      return values.length > 0 ? values[0] : undefined;
    }

    if (pragmaStr.includes("=")) {
      inner.exec(sql);
      return undefined;
    }

    const row = inner.prepare(sql).get() as Record<string, any> | null;
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : undefined;
  };

  db.exec = (sql: string) => {
    inner.exec(sql);
  };

  db.prepare = (sql: string) => {
    const convertedSql = convertSql(sql);
    const stmt = inner.prepare(convertedSql);
    return {
      run(...args: any[]) {
        return stmt.run(...convertParams(args));
      },
      get(...args: any[]) {
        return stmt.get(...convertParams(args)) ?? undefined;
      },
      all(...args: any[]) {
        return stmt.all(...convertParams(args));
      },
    };
  };

  db.close = () => inner.close();

  return db;
}

// ── MockPi ──────────────────────────────────────────────────────

export interface MockPi {
  sentUserMessages: Array<{ content: string | any; options?: any }>;
  registeredTools: Map<string, any>;
  emittedEvents: Array<{ name: string; data: any }>;
  eventHandlers: Map<string, Function[]>;
  sendUserMessage(content: string | any, options?: any): void;
  registerTool(tool: any): void;
  events: {
    emit(name: string, data: any): void;
    on(name: string, cb: Function): void;
  };
  getFlag(name: string): string | boolean | undefined;
  flags: Map<string, string | boolean>;
}

export function createMockPi(): MockPi {
  const sentUserMessages: MockPi["sentUserMessages"] = [];
  const registeredTools = new Map<string, any>();
  const emittedEvents: MockPi["emittedEvents"] = [];
  const eventHandlers = new Map<string, Function[]>();
  const flags = new Map<string, string | boolean>();

  return {
    sentUserMessages,
    registeredTools,
    emittedEvents,
    eventHandlers,
    flags,

    sendUserMessage(content: string | any, options?: any) {
      sentUserMessages.push({ content, options });
    },

    registerTool(tool: any) {
      registeredTools.set(tool.name ?? tool.tool?.name ?? "unknown", tool);
    },

    events: {
      emit(name: string, data: any) {
        emittedEvents.push({ name, data });
        const handlers = eventHandlers.get(name);
        if (handlers) {
          for (const h of handlers) h(data);
        }
      },
      on(name: string, cb: Function) {
        if (!eventHandlers.has(name)) eventHandlers.set(name, []);
        eventHandlers.get(name)!.push(cb);
      },
    },

    getFlag(name: string): string | boolean | undefined {
      return flags.get(name);
    },
  };
}

// ── MockCtx ─────────────────────────────────────────────────────

export interface MockCtx {
  cwd: string;
  notifications: Array<{ message: string; type?: string }>;
  aborted: boolean;
  idle: boolean;
  newSessionCalled: boolean;
  widgets: Map<string, any>;
  statuses: Map<string, string | undefined>;
  ui: {
    notify(msg: string, type?: string): void;
    setWidget(key: string, content: any): void;
    setStatus(key: string, text: string | undefined): void;
  };
  isIdle(): boolean;
  abort(): void;
  newSession(options?: any): Promise<any>;
  sessionManager: { getSessionId(): string };
}

export function createMockCtx(sessionId?: string): MockCtx {
  const sid = sessionId ?? `test-session-${Date.now()}`;
  const notifications: MockCtx["notifications"] = [];
  const widgets = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();

  return {
    cwd: "/tmp/test",
    notifications,
    aborted: false,
    idle: true,
    newSessionCalled: false,
    widgets,
    statuses,

    ui: {
      notify(msg: string, type?: string) {
        notifications.push({ message: msg, type });
      },
      setWidget(key: string, content: any) {
        widgets.set(key, content);
      },
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
    },

    isIdle() {
      return this.idle;
    },

    abort() {
      this.aborted = true;
    },

    async newSession(_options?: any) {
      this.newSessionCalled = true;
      return { cancelled: false };
    },

    sessionManager: {
      getSessionId() {
        return sid;
      },
    },
  };
}

// ── Test Database ───────────────────────────────────────────────

export function createTestDb(): any {
  const inner = new BunDatabase(":memory:");
  const db = createBetterSqlite3Compat(inner);
  initSchema(db);
  return db;
}
