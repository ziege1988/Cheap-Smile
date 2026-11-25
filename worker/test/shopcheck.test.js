import test from 'node:test';
import assert from 'node:assert/strict';
import { checkShop, analyseReturns, detectRegions, parseTrustpilot } from '../src/shopcheck.js';
import { DEFAULT_SETTINGS } from '../src/config.js';
import { createFetcher } from '../src/util.js';
import { fakeWeb, trustpilotPage, homePage, impressumDE, impressumCN, widerrufOK } from './helpers.js';

const S = DEFAULT_SETTINGS;
const goodShop = (d, extra = {}) => ({
  [`https://de.trustpilot.com/review/${d}`]: trustpilotPage(4.5, 2300, 'Muster Elektronik'),
  [`https://${d}/`]: homePage(d),
  [`https://${d}/impressum`]: impressumDE,
  [`https://${d}/widerruf`]: widerrufOK,
  [`https://rdap.org/domain/${d}`]: { body: JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2009-03-01T00:00:00Z' }] }), headers: { 'Content-Type': 'application/json' } },
  ...extra,
});

test('Seriöser deutscher Shop wird akzeptiert', async () => {
  const v = await checkShop('muster.de', createFetcher(fakeWeb(goodShop('muster.de'))), S);
  assert.equal(v.ok, true, v.reasons.join(', '));
  assert.equal(v.trustpilot.score, 4.5);
  assert.equal(v.impressum.country, 'DE');
  assert.equal(v.returns.days, 14);
});

test('Schlechte Trustpilot-Bewertung -> ausgeschlossen', async () => {
  const web = goodShop('mies.de', { 'https://de.trustpilot.com/review/mies.de': trustpilotPage(2.1, 800) });
  const v = await checkShop('mies.de', createFetcher(fakeWeb(web)), S);
  assert.equal(v.ok, false);
  assert.match(v.reasons[0], /Trustpilot 2.1/);
});

test('Zu wenige Bewertungen / kein Profil -> ausgeschlossen', async () => {
  const w1 = goodShop('neu.de', { 'https://de.trustpilot.com/review/neu.de': trustpilotPage(4.9, 7) });
  assert.match((await checkShop('neu.de', createFetcher(fakeWeb(w1)), S)).reasons.join(), /Nur 7/);
  const w2 = goodShop('ohne.de', { 'https://de.trustpilot.com/review/ohne.de': { status: 404 } });
  const v2 = await checkShop('ohne.de', createFetcher(fakeWeb(w2)), S);
  assert.match(v2.reasons.join(), /Kein Trustpilot-Profil/);
  assert.ok(!v2.retryable);
});

test('Trustpilot blockiert -> vorläufig ausgeschlossen, kurzer Cache', async () => {
  const w = goodShop('x.de', { 'https://de.trustpilot.com/review/x.de': { status: 403 } });
  const v = await checkShop('x.de', createFetcher(fakeWeb(w)), S);
  assert.equal(v.ok, false);
  assert.equal(v.retryable, true);
});

test('Impressum in China -> ausgeschlossen', async () => {
  const w = goodShop('happy-deals.de', { 'https://happy-deals.de/impressum': impressumCN });
  const v = await checkShop('happy-deals.de', createFetcher(fakeWeb(w)), S);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(), /Fernost \(CN/);
});

test('Kein Impressum -> ausgeschlossen', async () => {
  const w = goodShop('anonym.de', { 'https://anonym.de/': '<html><a href="/agb">AGB</a></html>' });
  assert.match((await checkShop('anonym.de', createFetcher(fakeWeb(w)), S)).reasons.join(), /Kein Impressum/);
});

test('Junge Domain -> ausgeschlossen', async () => {
  const w = goodShop('frisch.de', { 'https://rdap.org/domain/frisch.de': { body: JSON.stringify({ events: [{ eventAction: 'registration', eventDate: new Date(Date.now() - 40 * 864e5).toISOString() }] }) } });
  assert.match((await checkShop('frisch.de', createFetcher(fakeWeb(w)), S)).reasons.join(), /Domain erst 40 Tage/);
});

test('Rückgabebedingungen: Gebühren, Fernost-Adresse, kurze Frist', () => {
  const r = analyseReturns('Widerrufsrecht: Sie können innerhalb von 7 Tagen widerrufen. Bitte senden Sie die Ware zurück an unser Lager in Guangzhou, China. Es fällt eine Bearbeitungsgebühr von 15 % an. Die Rücksendekosten betragen 25,00 €.', S.blockedRegions, S);
  assert.ok(r.issues.some((i) => /7 Tage/.test(i)));
  assert.ok(r.issues.some((i) => /Bearbeitungsgebühr/.test(i)));
  assert.ok(r.issues.some((i) => /Rücksendung nach CN/.test(i)));
  assert.equal(r.returnCost, 25);
  const none = analyseReturns('Lieferung in 2-3 Tagen.', S.blockedRegions, S);
  assert.ok(none.issues.includes('Keine Widerrufsbelehrung gefunden'));
});

test('Sperrliste und Fernost-TLD sofort raus, ohne Requests', async () => {
  const web = fakeWeb({}); const raw = web;
  assert.equal((await checkShop('aliexpress.com', createFetcher(raw), S)).ok, false);
  assert.equal((await checkShop('shop.cn', createFetcher(raw), S)).ok, false);
  assert.equal(web.calls.length, 0);
});

test('Positivliste umgeht Trustpilot-Schwelle', async () => {
  const w = goodShop('otto.de', { 'https://de.trustpilot.com/review/otto.de': trustpilotPage(2.0, 50000) });
  const v = await checkShop('otto.de', createFetcher(fakeWeb(w)), S);
  assert.equal(v.ok, true);
  assert.equal(v.allowlisted, true);
});

test('Hilfsfunktionen', () => {
  assert.deepEqual(detectRegions('Sitz: Kowloon, Hong Kong', S.blockedRegions), ['HK']);
  assert.deepEqual(detectRegions('Sitz: München, Deutschland', S.blockedRegions), []);
  assert.equal(parseTrustpilot('<script>{"trustScore":4.3,"numberOfReviews":{"total":1200}}</script>').score, 4.3);
});
