// api/captcha.js
const axios = require('axios');

const ECOURTS_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';
const CAPTCHA_URL  = `${ECOURTS_BASE}/vendor/securimage/securimage_show.php`;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'same-origin',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Step 1: Get session from homepage
    const homeResp = await axios.get(`${ECOURTS_BASE}/`, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    // Extract session cookie
    const rawCookies = homeResp.headers['set-cookie'] || [];
    const cookieStr = rawCookies.map(c => c.split(';')[0]).join('; ');
    const sessMatch = rawCookies.join('').match(/PHPSESSID=([^;]+)/);
    const sessionId = sessMatch ? sessMatch[1] : Date.now().toString();

    // Step 2: Fetch CAPTCHA image with session
    const captchaResp = await axios.get(CAPTCHA_URL, {
      headers: {
        ...BROWSER_HEADERS,
        'Referer': `${ECOURTS_BASE}/`,
        'Cookie': cookieStr || `PHPSESSID=${sessionId}`,
      },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const imageBuffer = Buffer.from(captchaResp.data);
    const contentType = captchaResp.headers['content-type'] || 'image/png';
    const captchaBase64 = `data:${contentType};base64,${imageBuffer.toString('base64')}`;

    return res.status(200).json({
      success: true,
      captchaBase64,
      sessionId,
      cookieStr,
    });

  } catch (err) {
    console.error('Captcha fetch error:', err.message);
    // Return error details for debugging
    return res.status(500).json({
      success: false,
      error: err.message,
      status: err.response?.status,
      details: err.response?.data?.toString()?.substring(0, 200),
    });
  }
};