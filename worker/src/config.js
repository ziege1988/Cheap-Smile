// Zentrale Standardwerte. Alles, was hier steht, kann über /api/settings
// (Einstellungen in der App) überschrieben werden.

export const DEFAULT_SETTINGS = {
  // Trustpilot
  minTrustScore: 3.5,          // TrustScore 1–5; darunter wird der Shop ausgeschlossen
  minReviewCount: 30,          // weniger Bewertungen = nicht glaubwürdig genug
  requireTrustpilot: true,     // kein Trustpilot-Profil -> ausschließen (außer Positivliste)

  // Domain-Alter (über RDAP, falls die Registry es unterstützt)
  minDomainAgeDays: 365,

  // Fernost-Regionen (ISO-Codes), deren Shops grundsätzlich gemieden werden
  blockedRegions: ['CN', 'HK', 'MO', 'TW', 'VN', 'TH', 'MY', 'ID', 'PH', 'KH', 'MM', 'LA'],

  // Rücksendung
  minWithdrawalDays: 14,       // gesetzliches Minimum in der EU
  maxReturnCostRatio: 0.2,     // Rücksendekosten > 20 % des Preises = unverhältnismäßig

  // Versand, wenn nichts erkennbar ist (konservative Schätzung, wird markiert)
  fallbackShipping: 5.95,

  // „Sehr gutes Angebot“-Erkennung
  goodDealDropPct: 12,         // mind. 12 % unter dem 30-Tage-Median
  goodDealMinHistory: 4,       // so viele Messpunkte braucht es mindestens
  fakePriceRatio: 0.55,        // < 55 % des Medians anderer Shops = Fake-Shop-Indiz

  // Positivliste: bekannte, seriöse Händler. Trustpilot-Schwelle entfällt hier,
  // weil große Händler auf Trustpilot oft schlechter bewertet sind als ihr Ruf.
  allowlist: [
    'amazon.de', 'otto.de', 'mediamarkt.de', 'saturn.de', 'galaxus.de', 'cyberport.de',
    'alternate.de', 'notebooksbilliger.de', 'mindfactory.de', 'thomann.de', 'conrad.de',
    'expert.de', 'euronics.de', 'tchibo.de', 'baur.de', 'bader.de', 'jacob.de',
    'computeruniverse.net', 'proshop.de', 'coolblue.de', 'bol.com', 'apple.com',
    'bergfreunde.de', 'zalando.de', 'douglas.de', 'dm.de', 'rossmann.de', 'obi.de',
    'hornbach.de', 'bauhaus.info', 'ikea.com', 'decathlon.de', 'lidl.de', 'aldi-onlineshop.de',
    'rebuy.de', 'backmarket.de', 'asgoodasnew.de',
  ],

  // Sperrliste: Fernost-Marktplätze, bekannte Billig-Plattformen
  blocklist: [
    'aliexpress.com', 'aliexpress.us', 'temu.com', 'shein.com', 'wish.com', 'banggood.com',
    'gearbest.com', 'dhgate.com', 'alibaba.com', 'joom.com', 'lightinthebox.com',
    'tomtop.com', 'geekbuying.com', 'miniinthebox.com', 'cdiscount.com', 'shopee.com',
    'lazada.com', 'tmall.com', 'taobao.com', 'jd.com',
  ],
};

// Keine Shops, sondern Vergleichsportale, Magazine, Foren, Videos …
export const NON_SHOP_DOMAINS = [
  'idealo.de', 'geizhals.de', 'geizhals.at', 'billiger.de', 'guenstiger.de', 'check24.de',
  'preis.de', 'mydealz.de', 'youtube.com', 'wikipedia.org', 'reddit.com', 'chip.de',
  'computerbild.de', 'testberichte.de', 'test.de', 'heise.de', 'golem.de', 'netzwelt.de',
  'techstage.de', 'facebook.com', 'instagram.com', 'tiktok.com', 'pinterest.com',
  'trustpilot.com', 'duckduckgo.com', 'google.com', 'bing.com', 'stiftung-warentest.de',
  'pricerunner.de', 'shopping.com', 'kelkoo.de', 'ladenzeile.de',
];

// Regionen -> Erkennungsmuster für Impressum/Rücksendeadresse
export const REGION_PATTERNS = {
  CN: /\b(?:china|p\.\s?r\.\s?c\.|prc|volksrepublik|shenzhen|guangzhou|guangdong|shanghai|beijing|peking|hangzhou|zhejiang|yiwu|dongguan|fujian|xiamen|jiangsu|suzhou|ningbo|foshan|tianjin|chengdu|wuhan)\b|中国|深圳|广州|上海|北京|\+\s?86[\s-]/i,
  HK: /\b(?:hong\s?kong|kowloon|wan\s?chai|tsim\s?sha\s?tsui)\b|香港|\+\s?852[\s-]/i,
  MO: /\b(?:macau|macao)\b|澳门|\+\s?853[\s-]/i,
  TW: /\b(?:taiwan|taipei|kaohsiung|taichung)\b|台灣|台湾|\+\s?886[\s-]/i,
  VN: /\b(?:vietnam|viet\s?nam|hanoi|ho\s?chi\s?minh)\b|\+\s?84[\s-]/i,
  TH: /\b(?:thailand|bangkok)\b|\+\s?66[\s-]/i,
  MY: /\b(?:malaysia|kuala\s?lumpur)\b|\+\s?60[\s-]/i,
  ID: /\b(?:indonesia|indonesien|jakarta)\b|\+\s?62[\s-]/i,
  PH: /\b(?:philippines|philippinen|manila)\b|\+\s?63[\s-]/i,
  KH: /\b(?:cambodia|kambodscha|phnom\s?penh)\b|\+\s?855[\s-]/i,
  MM: /\b(?:myanmar|yangon)\b|\+\s?95[\s-]/i,
  LA: /\b(?:laos|vientiane)\b|\+\s?856[\s-]/i,
};

export const SHOP_CACHE_DAYS = 30;
export const SEARCH_INTERVAL_HOURS = 24;   // neue Shops suchen
export const PRICE_INTERVAL_HOURS = 4;     // bekannte Angebote neu prüfen
export const MAX_CANDIDATES = 8;           // max. neue Shop-Seiten pro Suche
