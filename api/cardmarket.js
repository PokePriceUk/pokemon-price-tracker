const crypto = require('crypto');

const BASE = 'https://api.cardmarket.com/ws/v2.0/output.json';

function pEnc(s) { return encodeURIComponent(String(s)); }

function buildAuthHeader(method, url, queryParams = {}) {
  const oauthParams = {
    oauth_consumer_key:     process.env.CM_APP_TOKEN,
    oauth_token:            process.env.CM_ACCESS_TOKEN,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_nonce:            crypto.randomBytes(12).toString('hex'),
    oauth_version:          '1.0',
  };

  // OAuth 1.0a: both query params and oauth params go into the signature base string
  const allParams = { ...queryParams, ...oauthParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map(k => `${pEnc(k)}=${pEnc(allParams[k])}`)
    .join('&');

  const baseString = [method.toUpperCase(), pEnc(url), pEnc(paramString)].join('&');
  const signingKey = `${pEnc(process.env.CM_APP_SECRET)}&${pEnc(process.env.CM_ACCESS_SECRET)}`;

  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  return (
    `OAuth realm="${url}", ` +
    Object.entries({ ...oauthParams, oauth_signature: signature })
      .map(([k, v]) => `${k}="${pEnc(v)}"`)
      .join(', ')
  );
}

async function cmGet(path, queryParams = {}) {
  const url = `${BASE}${path}`;
  const qs = Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';
  const res = await fetch(`${url}${qs}`, {
    headers: { Authorization: buildAuthHeader('GET', url, queryParams) },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`CardMarket ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function mapCondition(cond) {
  const c = (cond || '').toLowerCase();
  if (c === 'mint' || c === 'near mint' || c === 'nm') return 'Near Mint';
  if (c === 'excellent' || c === 'good' || c === 'light played' || c === 'lp') return 'Lightly Played';
  if (c === 'played' || c === 'moderately played' || c === 'mp') return 'Moderately Played';
  return cond || 'Used';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Silently skip if credentials aren't configured yet
  if (!process.env.CM_APP_TOKEN || !process.env.CM_ACCESS_TOKEN) {
    return res.status(200).json({ listings: [] });
  }

  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(200).json({ listings: [] });
  }

  try {
    // Step 1: find the product
    const searchData = await cmGet('/products/find', {
      search:     q.trim(),
      idGame:     1,     // 1 = Pokémon
      idLanguage: 1,     // 1 = English
      isExact:    false,
    });

    const products = searchData.product;
    if (!products?.length) return res.status(200).json({ listings: [] });

    const product    = products[0];
    const productId  = product.idProduct;
    const productUrl = product.links?.website ?? 'https://www.cardmarket.com/en/Pokemon';
    const setName    = product.expansion?.enName ?? product.expansionName ?? '';
    const imageUrl   = product.image
      ? `https://static.cardmarket.com${product.image}`
      : null;

    // Step 2: get individual sale listings (articles)
    const articlesData = await cmGet(`/articles/${productId}`, {
      maxResults: 20,
      start:      0,
    });

    const articles = articlesData.article || [];

    const listings = articles
      .filter(a => a.quantity > 0 && !a.isPlayset)
      .map(a => ({
        id:          `cm-${a.idArticle}`,
        name:        product.enName || q.trim(),
        set:         setName,
        marketplace: 'CardMarket',
        price:       parseFloat(a.price ?? 0),
        currency:    'EUR',
        imageUrl,
        condition:   mapCondition(a.condition),
        itemUrl:     productUrl,
      }));

    // Median price as market reference (EUR)
    const prices = listings.map(l => l.price).filter(p => p > 0).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const marketPrice = prices.length === 0 ? 0
      : prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2
      : prices[mid];

    return res.status(200).json({
      listings: listings.map(l => ({ ...l, market: marketPrice })),
      total: listings.length,
    });
  } catch (err) {
    console.error('CardMarket handler error:', err.message);
    // Return empty rather than error — eBay results still show
    return res.status(200).json({ listings: [] });
  }
};
