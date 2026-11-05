// Vercel serverless function: forwards AI requests from the page to an AI provider.
// Keys stay on the server (environment variables), never in the page.
//   - Google Gemini (has a free tier): set GEMINI_API_KEY
//   - Anthropic Claude (paid credits):  set ANTHROPIC_API_KEY
// If both are set, Gemini is used unless AI_PROVIDER=anthropic.
const hits = new Map();
// Accept the key whichever way the variable was named in Vercel.
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.Gemini_API_Key || process.env.GEMINI_API_KEY_ || "";

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

async function askGemini(prompt, images) {
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const parts = images.map((im) => ({ inline_data: { mime_type: im.media_type, data: im.data } }));
  parts.push({ text: prompt });
  const generationConfig = { maxOutputTokens: 16384, temperature: 0.7 };
  // Keep "thinking" short so it does not use up the answer length (and answers come back faster).
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (/gemini-3/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: "low" };
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": geminiKey() },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "AI service error";
    if (r.status === 429) throw new Error("The free AI limit was reached. Wait a minute and try again.");
    throw new Error(msg);
  }
  if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error("The AI could not answer that request.");
  const c = j.candidates && j.candidates[0];
  const text = ((c && c.content && c.content.parts) || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("The AI returned an empty answer. Try again.");
  return text;
}

async function askAnthropic(prompt, images) {
  const content = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5", max_tokens: 6000, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "AI service error";
    if (/credit balance/i.test(msg)) throw new Error("The AI account has no credit left. Add credit, or switch to the free Gemini option.");
    throw new Error(msg);
  }
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const useGemini = !!geminiKey() && process.env.AI_PROVIDER !== "anthropic";
  if (!useGemini && !process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: "Server has no AI key. Add GEMINI_API_KEY or ANTHROPIC_API_KEY in Vercel." });

  const allowed = process.env.ALLOWED_ORIGIN; // e.g. https://studyloop.vercel.app
  if (allowed && req.headers.origin && req.headers.origin !== allowed)
    return res.status(403).json({ error: "Origin not allowed" });

  const auth = await verify(req);
  if (!auth) return res.status(401).json({ error: "Sign in required" });
  const code = process.env.ACCESS_CODE; // optional shared password (used only when sign-in is not set up)
  if (auth.mode === "open" && code && req.headers["x-access-code"] !== code)
    return res.status(401).json({ error: "Access code required" });

  // Simple per-user rate limit (best effort; resets when the function restarts)
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
  const imgs = (Array.isArray(images) ? images : []).slice(0, 4)
    .filter((im) => im && typeof im.data === "string" && /^image\/(jpeg|png|webp|gif)$/.test(im.media_type));

  try {
    const text = useGemini ? await askGemini(prompt, imgs) : await askAnthropic(prompt, imgs);
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Could not reach the AI service" });
  }
};
