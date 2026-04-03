import Database from "better-sqlite3"
import type { Listing } from "@ghost-bazaar/core"
import { ListingStore, normalizeListingForStorage } from "./listing-store.js"

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  const frozen = Object.freeze(obj)
  for (const val of Object.values(frozen)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val as object)
    }
  }
  return frozen
}

const MAX_LISTINGS = 10_000
interface ListingRow {
  listing_id: string
  seller: string
  service_type: string
  payload: string
}

function rowToListing(row: ListingRow): Listing {
  return deepFreeze(JSON.parse(row.payload) as Listing)
}

export class SqliteListingStore extends ListingStore {
  private readonly db: Database.Database
  private readonly stmtInsert: Database.Statement
  private readonly stmtCount: Database.Statement
  private readonly stmtGetById: Database.Statement
  private readonly stmtGetAll: Database.Statement
  private readonly stmtByServiceType: Database.Statement
  private readonly stmtBySeller: Database.Statement

  constructor(dbPath: string) {
    super()
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("synchronous = NORMAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        listing_id    TEXT PRIMARY KEY,
        seller        TEXT NOT NULL,
        service_type  TEXT NOT NULL,
        payload       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller);
      CREATE INDEX IF NOT EXISTS idx_listings_service_type ON listings(service_type);
    `)

    this.stmtInsert = this.db.prepare(
      `INSERT INTO listings (listing_id, seller, service_type, payload)
       VALUES (@listing_id, @seller, @service_type, @payload)`,
    )
    this.stmtCount = this.db.prepare(`SELECT COUNT(*) AS cnt FROM listings`)
    this.stmtGetById = this.db.prepare(`SELECT * FROM listings WHERE listing_id = ?`)
    this.stmtGetAll = this.db.prepare(`SELECT * FROM listings ORDER BY listing_id`)
    this.stmtByServiceType = this.db.prepare(
      `SELECT * FROM listings WHERE service_type = ? ORDER BY listing_id`,
    )
    this.stmtBySeller = this.db.prepare(
      `SELECT * FROM listings WHERE seller = ? ORDER BY listing_id`,
    )
  }

  override add(listing: Listing): void {
    const countRow = this.stmtCount.get() as { cnt: number }
    if (countRow.cnt >= MAX_LISTINGS) {
      throw new Error(`ListingStore: capacity limit reached (${MAX_LISTINGS})`)
    }
    const normalized = normalizeListingForStorage(listing)

    try {
      this.stmtInsert.run({
        listing_id: normalized.listing_id,
        seller: normalized.seller,
        service_type: normalized.service_type,
        payload: JSON.stringify(structuredClone(normalized)),
      })
    } catch (err: unknown) {
      const sqlErr = err as { code?: string }
      if (sqlErr.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || sqlErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new Error(`ListingStore: duplicate listing_id "${normalized.listing_id}"`)
      }
      throw err
    }
  }

  override count(): number {
    const row = this.stmtCount.get() as { cnt: number }
    return row.cnt
  }

  override getById(listingId: string): Listing | undefined {
    const row = this.stmtGetById.get(listingId) as ListingRow | undefined
    return row ? rowToListing(row) : undefined
  }

  override getAll(): readonly Listing[] {
    const rows = this.stmtGetAll.all() as ListingRow[]
    return rows.map(rowToListing)
  }

  override filterByServiceType(serviceType: string): readonly Listing[] {
    const rows = this.stmtByServiceType.all(serviceType) as ListingRow[]
    return rows.map(rowToListing)
  }

  override findAllBySeller(sellerDid: string): readonly Listing[] {
    const rows = this.stmtBySeller.all(sellerDid) as ListingRow[]
    return rows.map(rowToListing)
  }

  override findBySellerAndId(sellerDid: string, listingId: string): Listing | undefined {
    const row = this.stmtGetById.get(listingId) as ListingRow | undefined
    if (!row || row.seller !== sellerDid) return undefined
    return rowToListing(row)
  }

  close(): void {
    this.db.close()
  }
}
