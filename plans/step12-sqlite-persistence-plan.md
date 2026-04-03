# Step 12: SQLite Event Persistence

## Goal

Replace `InMemoryEventStore` with `SqliteEventStore` so negotiation history survives server restarts and deploys. All route, state machine, and middleware code remains unchanged — only the storage layer swaps.

## Why SQLite

- **Single-file database** — no external service to manage, ideal for Fly.io persistent volumes
- **Synchronous writes** via `better-sqlite3` — no async complexity, WAL mode for concurrent reads
- **Sub-millisecond latency** — local disk, no network round-trip (10x faster than Postgres for this use case)
- **Event sourcing fit** — append-heavy workload with sequential reads, SQLite's B-tree is perfect

## Interface Contract

`SqliteEventStore` must implement `InternalEventStore` (which extends `EventStore`):

| Method | SQLite Implementation |
|--------|----------------------|
| `append(rfqId, event)` | `INSERT INTO events` + notify in-memory subscribers |
| `getEvents(rfqId, callerDid, rfq, afterId?)` | `SELECT ... WHERE session_id = ?` + role filtering in JS |
| `getAllEvents(rfqId)` | `SELECT ... WHERE session_id = ? ORDER BY id` |
| `subscribe(rfqId, callerDid, rfq, listener)` | In-memory EventEmitter (same as current) |
| `subscribeFrom(rfqId, callerDid, rfq, afterId, listener)` | DB replay + in-memory subscribe (2-phase) |
| `subscribeTerminal(rfqId, listener)` | In-memory (same as current) |
| `hasCursor(rfqId, eventId)` | `SELECT 1 FROM events WHERE session_id = ? AND event_id = ?` |
| `size(rfqId)` | `SELECT COUNT(*) FROM events WHERE session_id = ?` |
| `listSessionIds()` | `SELECT DISTINCT session_id FROM events` |

**Key insight**: Live subscriptions (`subscribe`, `subscribeFrom` activate phase, `subscribeTerminal`) stay in-memory. SQLite handles durable storage; EventEmitter handles real-time push. This is the same architecture as the current InMemoryEventStore — the only difference is where events are stored.

## Schema

```sql
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
```

- `id` (autoincrement) provides insertion order for `ORDER BY` and `afterId` cursor resolution
- `payload` is `JSON.stringify(event.payload)` — read back with `JSON.parse`
- Schema auto-creates on startup (CREATE IF NOT EXISTS) — no migration tooling needed

## Files

| File | Action | Lines (est.) |
|------|--------|-------------|
| `src/state/sqlite-event-store.ts` | Create | ~200 |
| `src/server.ts` | Modify (1 line) | swap `new InMemoryEventStore()` → `new SqliteEventStore(...)` |
| `package.json` | Modify | add `better-sqlite3` dep |
| `fly.toml` | Modify | add `[mounts]` for persistent volume |
| `Dockerfile` | Modify | add `mkdir /data` |
| `tests/sqlite-event-store.test.ts` | Create | ~150 |

## Implementation Details

### 1. SqliteEventStore (~200 lines)

```typescript
import Database from "better-sqlite3"
import { EventEmitter } from "node:events"

export class SqliteEventStore implements InternalEventStore {
  private db: Database.Database
  private emitter = new EventEmitter()
  private terminalEmitter = new EventEmitter()

  // Prepared statements (compiled once, reused)
  private stmtInsert: Database.Statement
  private stmtGetAll: Database.Statement
  private stmtGetAfter: Database.Statement
  private stmtHasCursor: Database.Statement
  private stmtSize: Database.Statement
  private stmtSessionIds: Database.Statement
}
```

**Constructor**: Opens DB, enables WAL mode, creates schema, prepares statements.

**append()**: INSERT event → emit to subscribers (same as InMemoryEventStore but durable).

**getEvents()**: Query DB → apply role filter in JS (same `isVisibleToSeller()` logic as InMemoryEventStore). Role filtering stays in JS because the filter rules reference RFQ fields not in the events table.

**subscribeFrom()**: Same 2-phase design — query DB for replay, buffer live events, activate gates delivery. Replay comes from DB instead of in-memory array.

**Deep freeze**: All returned events are deep-frozen (same immutability guarantee).

### 2. server.ts (1-line change)

```typescript
// Before:
const eventStore = new InMemoryEventStore()

// After:
const DATA_DIR = process.env.DATA_DIR ?? "./data"
const eventStore = new SqliteEventStore(`${DATA_DIR}/engine.db`)
```

### 3. fly.toml

```toml
[mounts]
  source = "ghost_bazaar_data"
  destination = "/data"
```

### 4. Dockerfile

Add before CMD:
```dockerfile
RUN mkdir -p /data
```

### 5. Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Directory for SQLite database file |

## What Does NOT Change

- All 10 route handlers — they depend on EventStore interface, not implementation
- SessionManager — uses InternalEventStore interface
- DeadlineEnforcer — uses SessionManager
- State machine — pure function, no storage dependency
- All existing 322 tests — they use InMemoryEventStore (keep as-is)
- Authentication, ZK verification, middleware

## Testing Strategy

New test file `sqlite-event-store.test.ts`:
- Mirror existing `event-store.test.ts` test cases against SqliteEventStore
- Add persistence-specific tests: close DB → reopen → verify events survived
- Use temp file (`:memory:` for unit tests, temp dir for persistence tests)
- Verify identical behavior: same role filtering, same cursor semantics, same subscribeFrom ordering

## Rollback

If SQLite causes issues, revert `server.ts` to `new InMemoryEventStore()`. All route code is unchanged. The InMemoryEventStore still works as before — it's still in the codebase.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `better-sqlite3` native addon build in Docker | Node 22 slim includes build tools; or use prebuilt binaries |
| WAL mode file locking on Fly.io volume | Single machine — no contention. Multi-machine would need LiteFS |
| Large event logs slow queries | Session index (`idx_events_session`) + Fly.io SSD volume |
| Schema migration on upgrade | CREATE IF NOT EXISTS — safe to re-run |
