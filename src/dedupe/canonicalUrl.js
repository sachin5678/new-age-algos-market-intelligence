const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|igshid|ref|ref_src|ref_url|cmpid|mc_cid|mc_eid|output|s|ito|from|tag|source)$/;
const DEFAULT_PROTOCOL = 'https:';

/** Canonical URL for URL-level dedup: lowercase host, www stripped, tracking params removed, sorted query. */
export function canonicalUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  let url;
  try {
    url = new URL(value.includes('://') ? value : `${DEFAULT_PROTOCOL}//${value}`);
  } catch {
    return value.toLowerCase();
  }
  url.protocol = url.protocol.toLowerCase();
  url.hash = '';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const search = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '') pathname = '';
  return `${url.protocol}//${host}${port}${pathname}${search}`;
}
