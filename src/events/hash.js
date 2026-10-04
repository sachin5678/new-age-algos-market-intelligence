import crypto from 'node:crypto';

const sha = (input) => crypto.createHash('sha256').update(String(input)).digest('hex');
const short = (input) => crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 16);

/** Stable content hash — same story (title+description) from any URL → same hash. */
export function contentHash({ title = '', description = '' }) {
  const normTitle = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normDesc = String(description).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);
  return sha(`${normTitle}||${normDesc}`);
}

/** Event id derived from canonical URL + source (stable across runs). */
export function eventIdFor({ canonical_url = '', source = '' }) {
  return `evt_${short(`${canonical_url}|${source}`)}`;
}

/** Cluster id for a brand-new story. */
export function newClusterId({ tokens = [], institutions = [], category = 'OTHER', publishedAt = '' }) {
  const key = [
    [...tokens].sort().join(' '),
    institutions[0] ?? '',
    category,
    // day bucket: same-day rewrites cluster together, different days don't
    String(publishedAt).slice(0, 10),
  ].join('|');
  return `clu_${short(key)}`;
}
