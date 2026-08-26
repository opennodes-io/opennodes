// Cost math shared by registry estimation, receipts, and client verification (ONP-5).

/** Cost in the offering's currency for given token counts. Only token-priced modalities in MVP. */
export function costForUsage(pricing, promptTokens, completionTokens) {
  const input = ((pricing.input_per_mtok ?? 0) * promptTokens) / 1_000_000;
  const output = ((pricing.output_per_mtok ?? 0) * completionTokens) / 1_000_000;
  return round6(input + output);
}

/** [min, max] bound for an estimate: min assumes half the estimated output, max the full amounts. */
export function estimateBounds(pricing, estInputTokens, estOutputTokens) {
  return {
    min: costForUsage(pricing, estInputTokens, Math.ceil(estOutputTokens / 2)),
    max: costForUsage(pricing, estInputTokens, estOutputTokens),
  };
}

export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
