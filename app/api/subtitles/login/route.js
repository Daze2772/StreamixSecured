// ── OpenSubtitles login helper (lazy JWT acquisition + in-memory cache) ──────

let cachedToken = null;
let tokenExpiry = null;

export async function GET(request) {
  try {
    // Return cached token if still valid (with 5min buffer)
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 5 * 60 * 1000) {
      return Response.json({ 
        token: cachedToken,
        cached: true 
      });
    }

    // Acquire fresh token
    const response = await fetch('https://api.opensubtitles.com/api/v1/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.OPENSUBTITLES_API_KEY,
        'User-Agent': 'Streamix v1.0'
      },
      body: JSON.stringify({
        username: process.env.OPENSUBTITLES_USERNAME,
        password: process.env.OPENSUBTITLES_PASSWORD
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OpenSubtitles] Login failed:', response.status, errorText);
      return Response.json(
        { error: 'Login failed', details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Cache token (OpenSubtitles tokens expire after 24h)
    cachedToken = data.token;
    tokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h cache

    console.log('[OpenSubtitles] JWT acquired, expires in 23h');
    
    return Response.json({ 
      token: cachedToken,
      cached: false 
    });

  } catch (error) {
    console.error('[OpenSubtitles] Login error:', error);
    return Response.json(
      { error: 'Login request failed', message: error.message },
      { status: 500 }
    );
  }
}

// Helper function for other routes to get token
export async function getToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 5 * 60 * 1000) {
    return cachedToken;
  }

  // Acquire new token
  const response = await fetch('https://api.opensubtitles.com/api/v1/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': process.env.OPENSUBTITLES_API_KEY,
      'User-Agent': 'Streamix v1.0'
    },
    body: JSON.stringify({
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD
    })
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

  return cachedToken;
}
