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

  if (!res.ok) throw new Error(`Token error ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 120) * 1000;
  return cachedToken;
}

const EXCLUDE = /\b(keyring|key\s*ring|plush|toy|figure|figurine|poster|pin|badge|sleeve|binder|booster|pack|bundle|lot|collection|box|tin|deck|display|album|folder|playmat|costume|shirt|hoodie|mug|sticker|magnet|lanyard|backpack|bag|cap|hat)\b/i;

function parseCondition(item) {
  const title = (item.title || '').toUpperCase();
  if (/PSA\s*10/.test(title))  return 'PSA 10';
  if (/PSA\s*9\b/.test(title)) return 'PSA 9';
  const cond = (item.condition || '').toLowerCase();
  if (cond === 'new' || cond.includes('like new')) return 'Near Mint';
  if (cond.includes('very good'))                  return 'Lightly Played';
  if (cond.includes('good'))                       return 'Moderately Played';
  return item.condition || 'Used';
}

// Strips filler words so the search box gets a clean card name
function cleanQuery(title) {
  return title
    .replace(/\b(pokemon|card|holo|rare|mint|nm|near\s+mint|lightly\s+played|lp|moderately\s+played|graded|psa|bgs|cgc)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(200).json({ suggestions: [] });
  }

  try {
    const token = await getAccessToken();

    const params = new URLSearchParams({
      q: `${q.trim()} pokemon card`,
      category_ids: '183454',
      limit: '15',
      sort: 'bestMatch',
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

    if (!apiRes.ok) return res.status(200).json({ suggestions: [] });

    const data = await apiRes.json();
    const items = data.itemSummaries || [];

    // Remove merchandise, then deduplicate by the first 3 title words
    const seen = new Set();
    const suggestions = items
      .filter(item => !EXCLUDE.test(item.title || ''))
      .filter(item => {
        const key = (item.title || '').split(/\s+/).slice(0, 3).join(' ').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6)
      .map(item => ({
        name:  item.title || '',
        sub:   `${parseCondition(item)} · ${item.buyingOptions?.includes('FIXED_PRICE') ? 'Buy It Now' : 'Auction'}`,
        price: parseFloat(item.price?.value ?? 0),
        query: cleanQuery(item.title || ''),
      }));

    return res.status(200).json({ suggestions });
  } catch (err) {
    console.error('Suggest error:', err);
    return res.status(200).json({ suggestions: [] }); // fail silently — autocomplete is non-critical
  }
};
