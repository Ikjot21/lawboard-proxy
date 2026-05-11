// api/notify.js
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { playerIds, title, body, data } = req.body || {};

  if (!playerIds || playerIds.length === 0) {
    return res.status(400).json({ error: 'playerIds required' });
  }

  try {
    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,  // ← env se aata hai
      },
      body: JSON.stringify({
        app_id:             process.env.ONESIGNAL_APP_ID,
        include_player_ids: playerIds,
        headings:           { en: title },
        contents:           { en: body  },
        data:               data || {},
        priority:           10,
        ttl:                86400,
      }),
    });

    const result = await response.json();
    return res.status(200).json({ success: true, result });

  } catch (err) {
    console.error('[notify] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};