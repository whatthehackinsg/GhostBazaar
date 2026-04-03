import { didToPublicKey, type SignedQuote } from "@ghost-bazaar/core"

export interface DealReceipt {
  quote_id: string
  final_price: string
  buyer_pubkey: string
  seller_pubkey: string
  settled_at: string
}

export interface SettlementResponse {
  receipt: DealReceipt
  explorer_tx: string
  settlement_ms: number
}

export interface ReceiptOptions {
  /** Solana cluster for explorer URL. Defaults to "devnet". */
  cluster?: "mainnet-beta" | "devnet" | "testnet"
}

export function buildReceipt(
  quote: SignedQuote,
  txSignature: string,
  settlementMs: number,
  opts?: ReceiptOptions,
): SettlementResponse {
  const cluster = opts?.cluster ?? "devnet"
  const clusterParam = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`

  // Resolve DIDs to actual Solana public keys
  const buyerPk = didToPublicKey(quote.buyer)
  const sellerPk = didToPublicKey(quote.seller)

  return {
    receipt: {
      quote_id: quote.quote_id,
      final_price: quote.final_price,
      buyer_pubkey: buyerPk?.toBase58() ?? quote.buyer,
      seller_pubkey: sellerPk?.toBase58() ?? quote.seller,
      settled_at: new Date().toISOString(),
    },
    explorer_tx: `https://explorer.solana.com/tx/${txSignature}${clusterParam}`,
    settlement_ms: settlementMs,
  }
}
