import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, eventIdFor, newClusterId } from '../src/events/hash.js';

test('contentHash is stable across case and punctuation', () => {
  const h1 = contentHash({ title: 'SEBI hikes F&O limits!', description: 'The board met today.' });
  const h2 = contentHash({ title: 'sebi hikes f o limits', description: 'the board met today.' });
  assert.equal(h1, h2);
});

test('contentHash changes when the story changes', () => {
  const base = { title: 'SEBI hikes F&O limits', description: 'Same story' };
  const other = { title: 'SEBI cuts F&O limits', description: 'Same story' };
  const otherDesc = { title: 'SEBI hikes F&O limits', description: 'Completely different body' };
  assert.notEqual(contentHash(base), contentHash(other));
  assert.notEqual(contentHash(base), contentHash(otherDesc));
});

test('eventIdFor is stable per URL+source and differs across sources', () => {
  const a = eventIdFor({ canonical_url: 'https://x.test/story', source: 'Moneycontrol' });
  const b = eventIdFor({ canonical_url: 'https://x.test/story', source: 'Moneycontrol' });
  const c = eventIdFor({ canonical_url: 'https://x.test/story', source: 'Livemint' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith('evt_'));
});

test('newClusterId is stable for the same story but day-scoped', () => {
  const base = {
    tokens: ['sebi', 'fo', 'limit'],
    institutions: ['SEBI'],
    category: 'SEBI',
    publishedAt: '2026-10-02T06:00:00.000Z',
  };
  const same = newClusterId({ ...base });
  assert.equal(same, newClusterId({ ...base }));
  assert.ok(same.startsWith('clu_'));

  // token order must not matter
  assert.equal(same, newClusterId({ ...base, tokens: ['limit', 'sebi', 'fo'] }));

  // different publication day → different cluster scope
  assert.notEqual(same, newClusterId({ ...base, publishedAt: '2026-10-05T06:00:00.000Z' }));
});
