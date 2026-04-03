/**
 * HTTP client for the Ghost Bazaar Negotiation Engine (Duty 2).
 *
 * Wraps all engine endpoints so that BuyerAgent/SellerAgent can call
 * them without managing raw HTTP. Handles auth headers for read routes
 * and control envelope signing for accept/decline.
 */

import { v4 as uuidv4 } from "uuid"
import type { Keypair } from "@solana/web3.js"
import {
  buildDid,
  objectSigningPayload,
  signEd25519,
  type RFQ,
  type SellerOffer,
  type CounterOffer,
  type SignedQuote,
  type Listing,
} from "@ghost-bazaar/core"
import type { NegotiationEvent } from "@ghost-bazaar/strategy"

type RawNegotiationEvent = {
  event_id: string | number
  rfq_id: string
  type?: string
  event_type?: string
  actor: string
  payload: unknown
  timestamp: string
}

const EVENT_TYPE_MAP: Record<string, string> = {
  RFQ_CREATED: "rfq_created",
  OFFER_SUBMITTED: "offer",
  COUNTER_SENT: "counter",
  WINNER_SELECTED: "quote_ready",
  COMMIT_PENDING: "commit_pending",
  QUOTE_SIGNED: "buyer_signed",
  QUOTE_COMMITTED: "quote_committed",
  COSIGN_DECLINED: "cosign_declined",
  COSIGN_TIMEOUT: "cosign_timeout",
  NEGOTIATION_EXPIRED: "expired",
  NEGOTIATION_CANCELLED: "cancelled",
}

function normalizeEventType(eventType?: string): string {
  if (!eventType) return "unknown"
  return EVENT_TYPE_MAP[eventType] ?? eventType.toLowerCase()
}

function normalizeEvent(event: RawNegotiationEvent): NegotiationEvent {
  return {
    event_id: event.event_id,
    rfq_id: event.rfq_id,
    event_type: event.event_type ?? normalizeEventType(event.type),
    actor: event.actor,
    payload: event.payload,
    timestamp: event.timestamp,
  }
}

export interface EngineClientConfig {
  baseUrl: string
  /** Keypair used for auth headers on read routes and control envelopes. */
  keypair?: Keypair
}

export class EngineClient {
  readonly baseUrl: string
  private readonly keypair: Keypair | undefined

  constructor(config: EngineClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "")
    this.keypair = config.keypair
  }

  // ── Auth helper ──

  private async buildAuthHeader(): Promise<Record<string, string>> {
    if (!this.keypair) return {}
    const did = buildDid(this.keypair.publicKey)
    const timestamp = new Date().toISOString()
    const payload = objectSigningPayload({
      action: "authenticate",
      did,
      timestamp,
      signature: "",
    })
    const signature = await signEd25519(payload, this.keypair)
    return {
      Authorization: `GhostBazaar-Ed25519 ${did} ${timestamp} ${signature}`,
    }
  }

  // ── Discovery (no auth) ──

  async getListings(serviceType?: string): Promise<Listing[]> {
    const url = serviceType
      ? `${this.baseUrl}/listings?service_type=${encodeURIComponent(serviceType)}`
      : `${this.baseUrl}/listings`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`GET /listings failed: ${res.status}`)
    const data = await res.json()
    return data.listings ?? data
  }

  async getListing(listingId: string): Promise<Listing> {
    const res = await fetch(`${this.baseUrl}/listings/${encodeURIComponent(listingId)}`)
    if (!res.ok) throw new Error(`GET /listings/${listingId} failed: ${res.status}`)
    return res.json()
  }

  async createListing(listing: Record<string, unknown>): Promise<Listing> {
    // Engine requires signed listing body
    const body: Record<string, unknown> = { ...listing, signature: "" }
    if (this.keypair) {
      body.signature = await signEd25519(objectSigningPayload(body), this.keypair)
    }
    const res = await fetch(`${this.baseUrl}/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`POST /listings failed: ${res.status} ${JSON.stringify(err)}`)
    }
    return res.json()
  }

  // ── RFQ ──

  async getRfqs(filters?: { serviceType?: string; listingId?: string; status?: string }): Promise<any[]> {
    const params = new URLSearchParams()
    if (filters?.serviceType) params.set("service_type", filters.serviceType)
    if (filters?.listingId) params.set("listing_id", filters.listingId)
    if (filters?.status) params.set("status", filters.status)
    const query = params.toString()
    const url = query ? `${this.baseUrl}/rfqs?${query}` : `${this.baseUrl}/rfqs`
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error(`GET /rfqs failed: ${res.status}`)
    const data = await res.json()
    return data.rfqs ?? data
  }

  async postRfq(rfq: RFQ): Promise<any> {
    const res = await fetch(`${this.baseUrl}/rfqs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })
    if (!res.ok) throw new Error(`POST /rfqs failed: ${res.status}`)
    return res.json()
  }

  // ── Offers (write, body-signed) ──

  async postOffer(rfqId: string, offer: SellerOffer): Promise<any> {
    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`POST /rfqs/${rfqId}/offers failed: ${res.status} ${JSON.stringify(err)}`)
    }
    return res.json()
  }

  // ── Counters (write, body-signed) ──

  async postCounter(rfqId: string, counter: CounterOffer): Promise<any> {
    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/counter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(counter),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`POST /rfqs/${rfqId}/counter failed: ${res.status} ${JSON.stringify(err)}`)
    }
    return res.json()
  }

  // ── Accept (control envelope) ──

  async accept(
    rfqId: string,
    sellerId: string,
    offerId: string,
    sessionRevision: string,
  ): Promise<SignedQuote> {
    if (!this.keypair) throw new Error("Keypair required for accept")

    const envelope: any = {
      envelope_id: uuidv4(),
      action: "accept",
      rfq_id: rfqId,
      session_revision: sessionRevision,
      payload: { seller: sellerId, offer_id: offerId },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "",
    }

    const payload = objectSigningPayload(envelope)
    envelope.signature = await signEd25519(payload, this.keypair)

    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`POST /rfqs/${rfqId}/accept failed: ${res.status} ${err.code ?? ""}`)
    }
    return res.json()
  }

  // ── Quote sign (just buyer_signature) ──

  async signQuote(rfqId: string, buyerSignature: string): Promise<SignedQuote> {
    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/quote/sign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyer_signature: buyerSignature }),
    })
    if (!res.ok) throw new Error(`PUT /rfqs/${rfqId}/quote/sign failed: ${res.status}`)
    return res.json()
  }

  // ── Quote read (auth header) ──

  async getQuote(rfqId: string): Promise<SignedQuote> {
    const auth = await this.buildAuthHeader()
    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/quote`, {
      headers: { ...auth, Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`GET /rfqs/${rfqId}/quote failed: ${res.status}`)
    return res.json()
  }

  // ── Cosign (just seller_signature) ──

  async cosignQuote(rfqId: string, sellerSignature: string): Promise<SignedQuote> {
    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/cosign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller_signature: sellerSignature }),
    })
    if (!res.ok) throw new Error(`PUT /rfqs/${rfqId}/cosign failed: ${res.status}`)
    return res.json()
  }

  // ── Decline (PUT, control envelope) ──

  async decline(rfqId: string, sellerDid: string, sessionRevision: string): Promise<void> {
    if (!this.keypair) throw new Error("Keypair required for decline")

    const envelope: any = {
      envelope_id: uuidv4(),
      action: "decline",
      rfq_id: rfqId,
      session_revision: sessionRevision,
      payload: { seller: sellerDid },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "",
    }

    const payload = objectSigningPayload(envelope)
    envelope.signature = await signEd25519(payload, this.keypair)

    const res = await fetch(`${this.baseUrl}/rfqs/${rfqId}/decline`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })
    if (!res.ok) throw new Error(`PUT /rfqs/${rfqId}/decline failed: ${res.status}`)
  }

  // ── Events (auth header, wrapped response) ──

  async getEvents(rfqId: string, after?: number | string): Promise<NegotiationEvent[]> {
    const auth = await this.buildAuthHeader()
    const url = after !== undefined
      ? `${this.baseUrl}/rfqs/${rfqId}/events?after=${after}`
      : `${this.baseUrl}/rfqs/${rfqId}/events`
    const res = await fetch(url, {
      headers: { ...auth, Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`GET /rfqs/${rfqId}/events failed: ${res.status}`)
    const data = await res.json()
    // Engine wraps in { events: [...], cursor }, but handle bare array too
    const events = data.events ?? data
    return Array.isArray(events) ? events.map((event) => normalizeEvent(event as RawNegotiationEvent)) : []
  }
}
