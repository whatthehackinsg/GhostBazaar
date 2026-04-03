export class SettlementError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message?: string,
  ) {
    super(message ?? code)
    this.name = "SettlementError"
  }
}

// Step 1: Quote header decoding
export const malformedQuoteHeader = (msg?: string) =>
  new SettlementError("malformed_quote_header", 400, msg ?? "X-Ghost-Bazaar-Quote header missing or not valid base64")

// Steps 2-3: Signature verification (delegated from @ghost-bazaar/core)
export const invalidBuyerSignature = () =>
  new SettlementError("invalid_buyer_signature", 401, "Buyer signature on quote fails verification")

export const invalidSellerSignature = () =>
  new SettlementError("invalid_seller_signature", 401, "Seller signature on quote fails verification")

// Step 4: Payment signature decoding
export const invalidPaymentSignature = () =>
  new SettlementError("invalid_payment_signature", 400, "Payment-Signature header not valid base58")

// Step 5: Transaction lookup
export const transactionNotFound = () =>
  new SettlementError("transaction_not_found", 404, "Solana RPC returned null for transaction")

// Step 6: Transaction status
export const transactionFailed = () =>
  new SettlementError("transaction_failed", 422, "Transaction status is not success")

export const transactionNotConfirmed = () =>
  new SettlementError("transaction_not_confirmed", 422, "Transaction not yet confirmed")

// Step 7: SPL transfer
export const transferInstructionMissing = () =>
  new SettlementError("transfer_instruction_missing", 422, "No SPL token transfer instruction in transaction")

// Step 8: Destination
export const transferDestinationMismatch = () =>
  new SettlementError("transfer_destination_mismatch", 422, "Transfer recipient does not match quote seller")

// Step 9: Mint
export const transferMintMismatch = () =>
  new SettlementError("transfer_mint_mismatch", 422, "Token mint does not match USDC mint")

// Step 10: Amount
export const priceMismatch = () =>
  new SettlementError("price_mismatch", 422, "Transfer amount does not match final_price")

// Steps 11-12: Memo
export const memoMissing = () =>
  new SettlementError("memo_missing", 422, "Memo required but not present in transaction")

export const memoMismatch = () =>
  new SettlementError("memo_mismatch", 422, "Memo content does not match expected value")

// Step 13: Nonce format
export const invalidNonceFormat = () =>
  new SettlementError("invalid_nonce_format", 422, "Quote nonce is not 0x + 64 lowercase hex chars")

// Step 14: Nonce replay
export const nonceReplayed = () =>
  new SettlementError("nonce_replayed", 409, "Nonce already consumed")

// Step 15: Expiry
export const expiredQuote = () =>
  new SettlementError("expired_quote", 422, "Quote expires_at is in the past")

// Step 16: Execution
export const executionFailed = (msg?: string) =>
  new SettlementError("execution_failed", 500, msg ?? "Service execution failed after validation")
