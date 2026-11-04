// Vercel serverless function: forwards AI requests from the page to the Anthropic API.
// The API key stays on the server (environment variable), never in the page.
const hits = new Map();

// Checks the Supabase sign-in token. Returns {mode:"open"} when sign-in is not configured,
// {mode:"user", id} for a valid signed-in user, or null when the token is missing/invalid.
async function verify(req) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { mode: "open" };
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + t } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { mode: "user", id: u.id } : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });

  const allowed = process.env.ALLOWED_ORIGIN; // e.g. https://studyloop.vercel.app
  if (allowed && req.headers.origin && req.headers.origin !== allowed)
    return res.status(403).json({ error: "Origin not allowed" });

  const auth = await verify(req);
  if (!auth) return res.status(401).json({ error: "Sign in required" });
  const code = process.env.ACCESS_CODE; // optional shared password (used only when sign-in is not set up)
  if (auth.mode === "open" && code && req.headers["x-access-code"] !== code)
    return res.status(401).json({ error: "Access code required" });

  // Simple per-IP rate limit (best effort; resets when the function restarts)
  const ip = auth.id || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= Number(process.env.RATE_LIMIT_PER_MIN || 20))
    return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  recent.push(now);
  hits.set(ip, recent);

  const { prompt, images } = req.body || {};
  if (typeof prompt !== "string" || !prompt || prompt.length > 60000)
    return res.status(400).json({ error: "Invalid prompt" });

  const content = [];
  for (const im of Array.isArray(images) ? images.slice(0, 4) : []) {
    if (im && typeof im.data === "string" && /^image\/(jpeg|png|webp|gif)$/.test(im.media_type))
      content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  }
  content.push({ type: "text", text: prompt });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
        max_tokens: 6000,
        messages: [{ role: "user", content }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "AI service error" });
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "Could not reach the AI service" });
  }
};
