/**
 * SqliteEventStore — durable EventStore backed by better-sqlite3
 *
 * Architecture:
 *   - Durable storage: SQLite WAL mode (all events survive restart)
 *   - Live push: In-memory subscriber sets (same pattern as InMemoryEventStore)
 *   - Immutability: All returned events are deep-frozen
 *   - Dedup: Relies on UNIQUE constraint on event_id (no in-memory Set)
 *
 * The EventStore interface contract is identical to InMemoryEventStore.
 * All route, state machine, and middleware code is storage-agnostic.
 */

import Database from "better-sqlite3"
import type { RFQ } from "@ghost-bazaar/core"
import type { NegotiationEvent, InternalEventStore, EventType } from "../types.js"
import { deepFreeze, isEventVisibleTo, TERMINAL_EVENT_TYPES } from "./visibility.js"

// ---------------------------------------------------------------------------
// Row <-> NegotiationEvent conversion
// ---------------------------------------------------------------------------

interface EventRow {
  id: number
  event_id: string
  session_id: string
  type: string
  actor: string
  timestamp: string
  payload: string
}

function rowToEvent(row: EventRow): NegotiationEvent {
  return deepFreeze({
    event_id: row.event_id,
    rfq_id: row.session_id,
    type: row.type as EventType,
    actor: row.actor,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  })
}

// ---------------------------------------------------------------------------
// Subscriber types — identical to InMemoryEventStore
// ---------------------------------------------------------------------------

interface Subscriber {
  readonly callerDid: string
  readonly rfq: Pick<RFQ, "buyer">
  readonly listener: (event: NegotiationEvent) => void
}

// ---------------------------------------------------------------------------
// SqliteEventStore
// ---------------------------------------------------------------------------

export class SqliteEventStore implements InternalEventStore {
  private readonly db: Database.Database

  /** In-memory subscriber sets — live push, not persisted */
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly terminalSubscribers = new Map<string, Set<(state: string) => void>>()
  /** In-memory session ID set — eliminates per-tick SELECT DISTINCT full scan.
   *  Populated from DB on startup, updated on append(). */
  private readonly activeSessionIds = new Set<string>()

  // Prepared statements (compiled once, reused for performance)
  private readonly stmtInsert: Database.Statement
  private readonly stmtGetAll: Database.Statement
  private readonly stmtGetAfterCursor: Database.Statement
  private readonly stmtHasCursor: Database.Statement
  private readonly stmtSize: Database.Statement
  private readonly stmtSessionIds: Database.Statement

  constructor(dbPath: string) {
    this.db = new Database(dbPath)

    // WAL mode — concurrent reads during writes, better performance
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("synchronous = NORMAL")
    // Defense-in-depth: cap DB at ~1 GB (262144 pages × 4 KB)
    this.db.pragma("max_page_count = 262144")

    // Schema — auto-create on startup (idempotent)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id    TEXT    NOT NULL UNIQUE,
        session_id  TEXT    NOT NULL,
        type        TEXT    NOT NULL,
        actor       TEXT    NOT NULL,
        timestamp   TEXT    NOT NULL,
        payload     TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_cursor  ON events(session_id, event_id);
    `)

    // Prepare statements
    this.stmtInsert = this.db.prepare(
      `INSERT INTO events (event_id, session_id, type, actor, timestamp, payload)
       VALUES (@event_id, @session_id, @type, @actor, @timestamp, @payload)`,
    )

    this.stmtGetAll = this.db.prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY id`,
    )

    this.stmtGetAfterCursor = this.db.prepare(
      `SELECT * FROM events WHERE session_id = ? AND id > (
         SELECT id FROM events WHERE session_id = ? AND event_id = ?
       ) ORDER BY id`,
    )

    this.stmtHasCursor = this.db.prepare(
      `SELECT 1 FROM events WHERE session_id = ? AND event_id = ? LIMIT 1`,
    )

    this.stmtSize = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM events WHERE session_id = ?`,
    )

    this.stmtSessionIds = this.db.prepare(
      `SELECT DISTINCT session_id FROM events`,
    )

    // Populate activeSessionIds from DB on startup (crash recovery)
    for (const row of this.stmtSessionIds.iterate() as Iterable<{ session_id: string }>) {
      this.activeSessionIds.add(row.session_id)
    }
  }

  append(rfqId: string, event: NegotiationEvent): void {
    if (rfqId !== event.rfq_id) {
      throw new Error(
        `EventStore.append: rfqId mismatch — parameter "${rfqId}" !== event.rfq_id "${event.rfq_id}"`,
      )
    }

    // Write to SQLite (durable). UNIQUE constraint on event_id handles dedup —
    // no in-memory Set needed (eliminates unbounded memory growth).
    try {
      this.stmtInsert.run({
        event_id: event.event_id,
        session_id: rfqId,
        type: event.type,
        actor: event.actor,
        timestamp: event.timestamp,
        payload: JSON.stringify(event.payload),
      })
    } catch (err: unknown) {
      // better-sqlite3 sets err.code = "SQLITE_CONSTRAINT_UNIQUE" on duplicate key.
      // Prefer code over message text for stability across library versions.
      const sqlErr = err as { code?: string }
      if (sqlErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`EventStore.append: duplicate event_id "${event.event_id}"`)
      }
      throw err
    }

    // Track session ID in memory (O(1) — avoids SELECT DISTINCT on every enforcer tick)
    this.activeSessionIds.add(rfqId)

    // Build frozen event from extracted values (no structuredClone needed —
    // JSON.parse produces a fresh object graph, deepFreeze makes it immutable)
    const frozenEvent = deepFreeze({
      event_id: event.event_id,
      rfq_id: rfqId,
      type: event.type,
      actor: event.actor,
      timestamp: event.timestamp,
      payload: JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>,
    } as NegotiationEvent)

    // Notify live subscribers
    const subs = this.subscribers.get(rfqId)
    if (subs) {
      for (const sub of subs) {
        if (isEventVisibleTo(frozenEvent, sub.callerDid, sub.rfq)) {
          try {
            sub.listener(frozenEvent)
          } catch {
            // Subscriber failure must not affect append or other subscribers
          }
        }
      }
    }

    // Notify terminal subscribers
    if (TERMINAL_EVENT_TYPES.has(frozenEvent.type)) {
      const termSubs = this.terminalSubscribers.get(rfqId)
      if (termSubs) {
        const terminalState =
          frozenEvent.type === "QUOTE_COMMITTED" ? "COMMITTED" :
          frozenEvent.type === "NEGOTIATION_EXPIRED" ? "EXPIRED" : "CANCELLED"
        for (const listener of termSubs) {
          try {
            listener(terminalState)
          } catch {
            // Terminal subscriber failure must not affect append
          }
        }
        this.terminalSubscribers.delete(rfqId)
      }
    }
  }

  getEvents(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId?: string,
  ): readonly NegotiationEvent[] {
    let rows: EventRow[]

    if (afterId !== undefined) {
      // Check cursor exists in this session first
      if (!this.hasCursor(rfqId, afterId)) return []
      rows = this.stmtGetAfterCursor.all(rfqId, rfqId, afterId) as EventRow[]
    } else {
      rows = this.stmtGetAll.all(rfqId) as EventRow[]
    }

    const result: NegotiationEvent[] = []
    for (const row of rows) {
      const event = rowToEvent(row)
      if (isEventVisibleTo(event, callerDid, rfq)) {
        result.push(event)
      }
    }
    return result
  }

  subscribe(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    listener: (event: NegotiationEvent) => void,
  ): () => void {
    let subs = this.subscribers.get(rfqId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(rfqId, subs)
    }

    const sub: Subscriber = { callerDid, rfq, listener }
    subs.add(sub)

    return () => {
      subs!.delete(sub)
      if (subs!.size === 0) {
        this.subscribers.delete(rfqId)
      }
    }
  }

  getAllEvents(rfqId: string): readonly NegotiationEvent[] {
    const rows = this.stmtGetAll.all(rfqId) as EventRow[]
    return rows.map(rowToEvent)
  }

  size(rfqId: string): number {
    const row = this.stmtSize.get(rfqId) as { cnt: number }
    return row.cnt
  }

  hasCursor(rfqId: string, eventId: string): boolean {
    return this.stmtHasCursor.get(rfqId, eventId) !== undefined
  }

  listSessionIds(): readonly string[] {
    // O(1) from in-memory Set — no SELECT DISTINCT full scan per tick
    return [...this.activeSessionIds]
  }

  subscribeFrom(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId: string | undefined,
    listener: (event: NegotiationEvent) => void,
  ): {
    readonly replay: readonly NegotiationEvent[]
    readonly buffered: readonly NegotiationEvent[]
    readonly activate: () => void
    readonly unsubscribe: () => void
  } {
    // Phase 1: Subscribe in BUFFERING mode
    const buffer: NegotiationEvent[] = []
    let mode: "buffering" | "live" | "stopped" = "buffering"

    const unsubscribeRole = this.subscribe(rfqId, callerDid, rfq, (event) => {
      if (mode === "stopped") return
      if (mode === "buffering") {
        buffer.push(event)
        return
      }
      listener(event)
    })

    // Read historical events from SQLite
    const replay = this.getEvents(rfqId, callerDid, rfq, afterId)

    // Deduplicate buffer against replay
    const replayIds = new Set(replay.map((e) => e.event_id))
    const dedupedBuffer: NegotiationEvent[] = []
    for (const e of buffer) {
      if (!replayIds.has(e.event_id)) {
        dedupedBuffer.push(e)
      }
    }
    buffer.length = 0
    buffer.push(...dedupedBuffer)

    let activated = false
    let stopped = false

    // Snapshot + drain (Codex R3-F2 fix — prevents double-delivery)
    const bufferedSnapshot = [...dedupedBuffer]
    buffer.length = 0

    const activate = (): void => {
      if (activated || stopped) return
      activated = true

      const toFlush = [...buffer]
      buffer.length = 0
      mode = "live"

      for (const e of toFlush) {
        if (stopped) break
        listener(e)
      }
    }

    const unsubscribe = (): void => {
      stopped = true
      mode = "stopped"
      buffer.length = 0
      unsubscribeRole()
    }

    return {
      replay,
      buffered: bufferedSnapshot,
      activate,
      unsubscribe,
    }
  }

  subscribeTerminal(
    rfqId: string,
    listener: (terminalState: string) => void,
  ): () => void {
    let subs = this.terminalSubscribers.get(rfqId)
    if (!subs) {
      subs = new Set()
      this.terminalSubscribers.set(rfqId, subs)
    }
    subs.add(listener)
    return () => {
      subs!.delete(listener)
      if (subs!.size === 0) {
        this.terminalSubscribers.delete(rfqId)
      }
    }
  }

  /** Gracefully close the database connection. */
  close(): void {
    this.db.close()
  }
}
