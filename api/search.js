let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const credentials = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
  ).toString('base64');

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token request failed ${res.status}: ${txt}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 120) * 1000; // 2-min buffer
  return cachedToken;
}

function parseCondition(item) {
  const title = (item.title || '').toUpperCase();
  if (/PSA\s*10/.test(title))  return 'PSA 10';
  if (/PSA\s*9\b/.test(title)) return 'PSA 9';
  if (/PSA\s*8\b/.test(title)) return 'PSA 8';
  const cond = (item.condition || '').toLowerCase();
  if (cond === 'new')                  return 'Near Mint';
  if (cond.includes('like new'))       return 'Near Mint';
  if (cond.includes('very good'))      return 'Lightly Played';
  if (cond.includes('good'))           return 'Moderately Played';
  return item.condition || 'Used';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query too short' });
  }

  try {
    const token = await getAccessToken();

    // Request extra results so there's plenty left after client-side filtering
    const params = new URLSearchParams({
      q: `${q.trim()} pokemon card`,
      category_ids: '183454', // eBay UK: Pokémon TCG → Individual Cards
      limit: '50',
      sort: 'price',
    });

    const apiRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
          'Content-Type': 'application/json',
        },
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('eBay API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'eBay API error', status: apiRes.status });
    }

    const data = await apiRes.json();
    const items = data.itemSummaries || [];

    const EXCLUDE = /\b(keyring|key\s*ring|plush|toy|figure|figurine|poster|pin|badge|sleeve|binder|booster|pack|bundle|lot|collection|box|tin|deck|display|album|folder|playmat|costume|shirt|hoodie|mug|sticker|magnet|lanyard|backpack|bag|cap|hat)\b/i;

    const listings = items
      .filter(item => !EXCLUDE.test(item.title || ''))
      .slice(0, 24)
      .map(item => ({
        id:          item.itemId,
        name:        item.title || 'Unknown Card',
        set:         item.buyingOptions?.includes('FIXED_PRICE') ? 'Buy It Now' : 'Auction',
        marketplace: 'eBay',
        price:       parseFloat(item.price?.value ?? 0),
        currency:    item.price?.currency ?? 'GBP',
        imageUrl:    item.thumbnailImages?.[0]?.imageUrl ?? item.image?.imageUrl ?? null,
        condition:   parseCondition(item),
        itemUrl:     item.itemWebUrl ?? null,
      }));

    // Median is more stable than mean for skewed price sets
    const prices = listings.map(l => l.price).filter(p => p > 0).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const marketPrice = prices.length === 0 ? 0
      : prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2
      : prices[mid];

    const withMarket = listings.map(l => ({ ...l, market: marketPrice }));

    return res.status(200).json({ listings: withMarket, total: data.total ?? 0 });
  } catch (err) {
    console.error('Search handler error:', err);
    return res.status(500).json({ error: 'Search failed', detail: err.message });
  }
};
