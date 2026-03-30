const axios = require('axios');

const ECOURTS_BASE = 'https://services.ecourts.gov.in/ecourtindia_v6';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Use eCourts own getCaptcha endpoint — same as browser does
    const params = new URLSearchParams({
      'ajax_req':  'true',
      'app_token': '',
    });

    const captchaResp = await axios.post(
      `${ECOURTS_BASE}/?p=casestatus/getCaptcha`,
      params.toString(),
      {
        headers: {
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          `${ECOURTS_BASE}/`,
          'Origin':            ECOURTS_BASE,
        },
        timeout: 12000,
      }
    );

    // Extract session cookie from response
    const rawCookies = captchaResp.headers['set-cookie'] || [];
    const cookieStr  = rawCookies.map(c => c.split(';')[0]).join('; ');
    console.log('getCaptcha cookie:', cookieStr);
    console.log('getCaptcha response:', JSON.stringify(captchaResp.data).substring(0, 300));

    // Response is HTML with captcha image — extract img src token
    const html = typeof captchaResp.data === 'string'
      ? captchaResp.data
      : JSON.stringify(captchaResp.data);

    // Extract securimage token from img src
    const tokenMatch = html.match(/securimage_show\.php\?([a-f0-9]+)/);
    const captchaToken = tokenMatch ? tokenMatch[1] : '';
    console.log('Captcha token:', captchaToken);

    // Now fetch the actual CAPTCHA image using same session
    const imgResp = await axios.get(
      `${ECOURTS_BASE}/vendor/securimage/securimage_show.php?${captchaToken}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':    `${ECOURTS_BASE}/`,
          'Cookie':      cookieStr,
        },
        responseType: 'arraybuffer',
        timeout: 10000,
      }
    );

    const contentType   = imgResp.headers['content-type'] || 'image/png';
    const captchaBase64 = `data:${contentType};base64,${Buffer.from(imgResp.data).toString('base64')}`;

    return res.status(200).json({
      success: true,
      captchaBase64,
      cookieStr,
      captchaToken,
    });

  } catch (err) {
    console.error('Captcha error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};