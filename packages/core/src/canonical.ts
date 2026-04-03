function sortKeys(obj: unknown, isTopLevel: boolean): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map((item) => sortKeys(item, false))
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    const val = (obj as Record<string, unknown>)[key]
    // Omit empty extensions only at top level per v4 Section 5.7
    if (isTopLevel && key === "extensions" && typeof val === "object" && val !== null && Object.keys(val).length === 0) {
      continue
    }
    sorted[key] = sortKeys(val, false)
  }
  return sorted
}

export function canonicalJson(obj: Record<string, unknown>): Uint8Array {
  const sorted = sortKeys(obj, true)
  const json = JSON.stringify(sorted)
  return new TextEncoder().encode(json)
}
