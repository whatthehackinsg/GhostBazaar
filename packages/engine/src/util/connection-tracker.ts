/**
 * ConnectionTracker — manages SSE connection limits per session.
 *
 * Limits:
 * - Max 3 SSE connections per DID per session
 * - Max 10 SSE connections per session (total)
 * - 1 reserved slot for the buyer (evicts oldest non-buyer if at capacity)
 *
 * Tracks concrete connection records with identity, timestamps, and close
 * callbacks to implement eviction (Codex R2-F4).
 */

export type ConnectionId = string

interface ConnectionRecord {
  readonly connectionId: ConnectionId
  readonly rfqId: string
  readonly callerDid: string
  readonly isBuyer: boolean
  readonly openedAt: number
  readonly close: () => void
}

const MAX_PER_DID = 3
const MAX_PER_SESSION = 10

export class ConnectionTracker {
  private readonly connections = new Map<ConnectionId, ConnectionRecord>()
  private readonly bySession = new Map<string, Set<ConnectionId>>()
  private nextId = 0

  acquire(conn: {
    readonly rfqId: string
    readonly callerDid: string
    readonly isBuyer: boolean
    readonly close: () => void
  }): ConnectionId | null {
    const { rfqId, callerDid, isBuyer } = conn

    // Per-DID limit: reject if caller already has MAX_PER_DID connections
    if (this.countForDid(rfqId, callerDid) >= MAX_PER_DID) return null

    // Per-session limit: at capacity, only buyer can trigger eviction
    const sessionCount = this.countForSession(rfqId)
    if (sessionCount >= MAX_PER_SESSION) {
      if (!isBuyer) return null

      // Buyer gets priority — evict the oldest non-buyer connection
      const evicted = this.findOldestNonBuyer(rfqId)
      if (!evicted) return null

      evicted.close()
      this.removeRecord(evicted.connectionId)
    }

    const connectionId = `conn-${++this.nextId}`
    const record: ConnectionRecord = {
      connectionId,
      rfqId,
      callerDid,
      isBuyer,
      openedAt: Date.now(),
      close: conn.close,
    }

    this.connections.set(connectionId, record)
    let sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) {
      sessionSet = new Set()
      this.bySession.set(rfqId, sessionSet)
    }
    sessionSet.add(connectionId)

    return connectionId
  }

  release(connectionId: ConnectionId): void {
    this.removeRecord(connectionId)
  }

  countForDid(rfqId: string, callerDid: string): number {
    const sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) return 0
    let count = 0
    for (const id of sessionSet) {
      const rec = this.connections.get(id)
      if (rec && rec.callerDid === callerDid) count++
    }
    return count
  }

  countForSession(rfqId: string): number {
    return this.bySession.get(rfqId)?.size ?? 0
  }

  closeAll(rfqId: string): void {
    const sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) return
    // Snapshot IDs to avoid mutation during iteration
    const ids = [...sessionSet]
    for (const id of ids) {
      const rec = this.connections.get(id)
      if (rec) {
        rec.close()
        this.removeRecord(id)
      }
    }
  }

  private findOldestNonBuyer(rfqId: string): ConnectionRecord | null {
    const sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) return null
    let oldest: ConnectionRecord | null = null
    for (const id of sessionSet) {
      const rec = this.connections.get(id)
      if (rec && !rec.isBuyer) {
        if (!oldest || rec.openedAt < oldest.openedAt) {
          oldest = rec
        }
      }
    }
    return oldest
  }

  private removeRecord(connectionId: ConnectionId): void {
    const rec = this.connections.get(connectionId)
    if (!rec) return
    this.connections.delete(connectionId)
    const sessionSet = this.bySession.get(rec.rfqId)
    if (sessionSet) {
      sessionSet.delete(connectionId)
      if (sessionSet.size === 0) {
        this.bySession.delete(rec.rfqId)
      }
    }
  }
}
