import Decimal from "decimal.js"
import type { SellerOffer } from "@ghost-bazaar/core"
import type { SellerRegistrySignal } from "./interfaces.js"

const NEAR_TIE_THRESHOLD = new Decimal("1.00")

function compareSignals(
  sellerA: string,
  sellerB: string,
  sellerRegistry: Record<string, SellerRegistrySignal>,
): number {
  const signalA = sellerRegistry[sellerA]
  const signalB = sellerRegistry[sellerB]

  const scoreA = signalA?.reputationScore ?? -1
  const scoreB = signalB?.reputationScore ?? -1
  if (scoreA !== scoreB) return scoreB - scoreA

  const feedbacksA = signalA?.totalFeedbacks ?? -1
  const feedbacksB = signalB?.totalFeedbacks ?? -1
  return feedbacksB - feedbacksA
}

export function selectBestBuyerOffer(
  offers: readonly SellerOffer[],
  sellerRegistry: Record<string, SellerRegistrySignal>,
): SellerOffer {
  const sorted = [...offers].sort((a, b) =>
    new Decimal(a.price).minus(new Decimal(b.price)).toNumber()
  )

  const best = sorted[0]
  const bestPrice = new Decimal(best.price)
  const nearTies = sorted.filter((offer) =>
    new Decimal(offer.price).minus(bestPrice).lte(NEAR_TIE_THRESHOLD)
  )

  if (nearTies.length <= 1) return best

  return [...nearTies].sort((a, b) => {
    const signalCmp = compareSignals(a.seller, b.seller, sellerRegistry)
    if (signalCmp !== 0) return signalCmp
    return new Decimal(a.price).minus(new Decimal(b.price)).toNumber()
  })[0]
}

export function selectLowestPricedBuyerOffer(
  offers: readonly SellerOffer[],
): SellerOffer {
  return [...offers].sort((a, b) =>
    new Decimal(a.price).minus(new Decimal(b.price)).toNumber()
  )[0]
}
