import test from 'node:test';
import assert from 'node:assert/strict';
import { googleAllowed, parseSerpApi, searchCandidates } from '../src/search.js';
import { createFetcher } from '../src/util.js';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { MemoryKV, fakeWeb } from './helpers.js';

test('Google-Kontingent wird gleichmäßig über den Monat verteilt', () => {
  const d = new Date(Date.UTC(2026, 10, 10)); // 10. von 30 Tagen
  assert.equal(googleAllowed(80, 240, d), true);   // erlaubt bis 85
  assert.equal(googleAllowed(90, 240, d), false);
  assert.equal(googleAllowed(90, 240, d, true), true); // neues Produkt hat Vorrang
  assert.equal(googleAllowed(240, 240, d, true), false); // hartes Limit
});

test('SerpApi-Antwort: Shop-Links, keine Google-Links', () => {
  const urls = parseSerpApi({
    shopping_results: [{ link: 'https://muster.de/p/1' }, { link: 'https://www.google.de/shopping/product/1' }],
    organic_results: [{ link: 'https://elektro-zwei.de/p/2' }, { link: 'kaputt' }],
  });
  assert.deepEqual(urls, ['https://muster.de/p/1', 'https://elektro-zwei.de/p/2']);
});

test('Mit SERPAPI_KEY wird Google genutzt, sonst DuckDuckGo', async () => {
  const web = fakeWeb({
    'https://serpapi.com/search.json': { body: JSON.stringify({ organic_results: [{ link: 'https://muster.de/p/1' }, { link: 'https://idealo.de/x' }] }) },
    'https://html.duckduckgo.com/': '<a class="result__a" href="https://elektro-zwei.de/p/2">x</a>',
  });
  const env = { DB: new MemoryKV(), SERPAPI_KEY: 'k' };
  const g = await searchCandidates(createFetcher(web), env, 'Sony', DEFAULT_SETTINGS, { priority: true });
  assert.equal(g.source, 'google');
  assert.deepEqual(g.candidates.map((c) => c.domain), ['muster.de']);
  assert.match(web.calls[0].url, /google_domain=google\.de/);
  assert.equal([...env.DB.m.values()][0], '1', 'Zähler hochgezählt');

  const d = await searchCandidates(createFetcher(web), { DB: new MemoryKV() }, 'Sony', DEFAULT_SETTINGS);
  assert.equal(d.source, 'duckduckgo');
});

test('Google-Fehler -> automatisch DuckDuckGo', async () => {
  const web = fakeWeb({
    'https://serpapi.com/': { status: 401 },
    'https://html.duckduckgo.com/': '<a class="result__a" href="https://elektro-zwei.de/p/2">x</a>',
  });
  const r = await searchCandidates(createFetcher(web), { DB: new MemoryKV(), SERPAPI_KEY: 'falsch' }, 'Sony', DEFAULT_SETTINGS, { priority: true });
  assert.equal(r.source, 'duckduckgo');
  assert.equal(r.candidates.length, 1);
});
