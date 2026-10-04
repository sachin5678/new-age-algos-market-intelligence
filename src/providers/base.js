/**
 * Provider interface. Every provider:
 *   - has { name, kind, enabled }
 *   - implements collect(ctx) → array of normalized items (articles | snapshots)
 * Providers run independently; one failing never stops the others.
 */
export class Provider {
  constructor({ name, kind, enabled = true }) {
    this.name = name;
    this.kind = kind;
    this.enabled = enabled;
  }

  async collect(_ctx) {
    throw new Error(`Provider ${this.name} does not implement collect()`);
  }
}

/**
 * Run all enabled providers concurrently with full failure isolation.
 * Returns { items, failures, perProvider } — failures are reported, never thrown.
 */
export async function runProviders(providers, ctx, logger = null) {
  const active = providers.filter((p) => p && p.enabled !== false);
  const settled = await Promise.allSettled(active.map((p) => p.collect(ctx)));
  const items = [];
  const failures = [];
  const perProvider = {};

  settled.forEach((result, i) => {
    const provider = active[i];
    if (result.status === 'fulfilled') {
      const list = Array.isArray(result.value) ? result.value : [];
      perProvider[provider.name] = { ok: true, count: list.length };
      items.push(...list);
      logger?.info('COLLECT', `${provider.name} (${provider.kind}): ${list.length} item(s)`);
    } else {
      const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
      perProvider[provider.name] = { ok: false, error: err };
      failures.push({ provider: provider.name, kind: provider.kind, error: err });
      logger?.error('COLLECT', `${provider.name} (${provider.kind}) failed: ${err}`);
    }
  });

  logger?.info('COLLECT', `total=${items.length} providers_ok=${Object.values(perProvider).filter((p) => p.ok).length} failed=${failures.length}`);
  return { items, failures, perProvider };
}
