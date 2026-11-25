import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlerts, applyOfferRules, bestOffer } from '../src/deal.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

const offer = (total, extra = {}) => ({ domain: 'muster.de', price: total, shipping: 0, total, condition: 'new', available: true, currency: 'EUR', coupons: [], ...extra });
const hist = (vals) => vals.map((v, i) => ({ t: Date.now() - (vals.length - i) * 864e5, n: v, a: v }));

test('Gutes Angebot unter Wunschpreis-Schwelle -> "nicht dein Wunschpreis"', () => {
  const p = { id: 'a', name: 'Kamera', wishPrice: 400, offers: [offer(440)], history: hist([520, 515, 525, 518, 520, 440]) };
  const a = evaluateAlerts(p, DEFAULT_SETTINGS);
  assert.equal(a.kind, 'deal');
  assert.match(a.body, /Nicht dein Wunschpreis/);
  assert.equal(evaluateAlerts(p, DEFAULT_SETTINGS), null, 'keine Wiederholung');
  p.offers = [offer(420)];
  assert.equal(evaluateAlerts(p, DEFAULT_SETTINGS).kind, 'deal', 'weiterer Preisrutsch wird gemeldet');
});

test('Wunschpreis: einmalig, erneut nach Wiederanstieg', () => {
  const p = { id: 'b', name: 'X', wishPrice: 100, offers: [offer(99)], history: [] };
  assert.equal(evaluateAlerts(p, DEFAULT_SETTINGS).kind, 'wish');
  assert.equal(evaluateAlerts(p, DEFAULT_SETTINGS), null);
  p.offers = [offer(120)]; evaluateAlerts(p, DEFAULT_SETTINGS);
  p.offers = [offer(98)];
  assert.equal(evaluateAlerts(p, DEFAULT_SETTINGS).kind, 'wish');
});

test('Gebrauchtes Angebot zählt nur, wenn erlaubt', () => {
  const p = { id: 'c', name: 'X', wishPrice: 100, allowUsed: false, offers: [offer(90, { condition: 'used' }), offer(130)], history: [] };
  assert.equal(evaluateAlerts(p, DEFAULT_SETTINGS), null);
  p.allowUsed = true;
  assert.match(evaluateAlerts(p, DEFAULT_SETTINGS).body, /gebraucht/);
});

test('Marktplatz: Fernost-Drittanbieter fliegt raus, deutscher Händler bleibt', () => {
  const p = { id: 'd', name: 'X', offers: [
    offer(80, { domain: 'amazon.de', seller: 'Shenzhen Xinda Technology Co., Ltd' }),
    offer(85, { domain: 'otto.de', seller: 'Musterhandel GmbH' }),
    offer(95, { domain: 'amazon.de', seller: 'Amazon' }),
  ] };
  applyOfferRules(p, DEFAULT_SETTINGS);
  assert.match(p.offers[0].excludedReason, /Fernost/);
  assert.equal(p.offers[1].excludedReason, undefined);
  assert.equal(bestOffer(p).domain, 'otto.de');
});
