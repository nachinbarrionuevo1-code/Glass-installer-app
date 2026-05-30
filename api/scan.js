
/**
 * api/scan.js
 * Vercel Serverless Function — deployed at: https://your-app.vercel.app/api/scan
 *
 * Receives compressed images from the mobile app, forwards them to the
 * Anthropic API using the server-side API key, and returns clean JSON.
 *
 * The Anthropic API key is stored in Vercel's environment variables.
 * It is NEVER sent to the client. The client never sees it.
 *
 * Request:  POST /api/scan
 *           Content-Type: application/json
 *           Body: { images: [{ base64: string, mediaType: string }] }
 *
 * Response: 200 { jobs: [...] }
 *           400 { error: "..." }  — bad request (missing images, wrong format)
 *           500 { error: "..." }  — Anthropic API failure
 */

export default async function handler(req, res) {
  // ── CORS headers ────────────────────────────────────────────────────────────
  // Allow requests from your deployed frontend URL.
  // During development you can set this to * but lock it down in production.
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight (browser sends OPTIONS before POST)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // ── Validate request body ────────────────────────────────────────────────────
  const { images } = req.body || {};

  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Request body must include an 'images' array." });
  }

  if (images.length > 10) {
    return res.status(400).json({ error: "Maximum 10 images per request." });
  }

  for (const img of images) {
    if (!img.base64 || typeof img.base64 !== "string") {
      return res.status(400).json({ error: "Each image must have a base64 string." });
    }
    if (!img.mediaType || !img.mediaType.startsWith("image/")) {
      return res.status(400).json({ error: `Invalid mediaType: "${img.mediaType}". Must start with "image/".` });
    }
    // Rough size check: 1.5MB base64 ≈ ~1MB image — reject oversized images
    if (img.base64.length > 2_000_000) {
      return res.status(400).json({ error: "Image too large. Please compress before uploading (max ~1.5MB base64)." });
    }
  }

  // ── API key ──────────────────────────────────────────────────────────────────
  // Set ANTHROPIC_API_KEY in Vercel dashboard → Settings → Environment Variables.
  // It is injected at runtime and never exposed to the client.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set in environment variables.");
    return res.status(500).json({ error: "Server configuration error: API key not set." });
  }

  // ── Build Anthropic request ──────────────────────────────────────────────────
  const imageContent = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));

  const prompt = `You are analysing job sheet photos for a glass installation company called Civic Shower Screens. Extract ALL jobs visible across all images.

For each job found, return a JSON array. Respond ONLY with valid JSON — no markdown, no code fences, no explanation, no preamble.

Each job object must have these exact keys:
- jobNumber: string (job/work order number if visible, else "")
- address: string (street address including number, e.g. "12 Smith Street")
- suburb: string (suburb, city, or town)
- contactName: string (customer full name)
- phone: string (phone number as written on sheet)
- jobType: string (type of work, e.g. "Shower Screen Installation", "Mirror Fitting", "Glass Balustrade", "Window Replacement")
- notes: string (any other relevant information, measurements, access instructions, special requirements)

Rules:
- If a field is not visible or not present, use empty string ""
- Do not invent or guess any field values
- Extract EVERY job visible across ALL images
- If the same job appears in multiple images, include it only once

Return format (array, even for one job):
[{"jobNumber":"...","address":"...","suburb":"...","contactName":"...","phone":"...","jobType":"...","notes":"..."}]

If no recognisable job sheet data is found, return: []`;

  // ── Call Anthropic ───────────────────────────────────────────────────────────
  let anthropicResponse;
  try {
    anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,                    // Key is on the server, never the client
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [...imageContent, { type: "text", text: prompt }],
          },
        ],
      }),
    });
  } catch (networkErr) {
    // This would mean the Vercel server itself can't reach Anthropic
    console.error("Vercel → Anthropic network error:", networkErr);
    return res.status(502).json({
      error: "Backend could not reach Anthropic API. Check server network.",
      detail: networkErr.message,
    });
  }

  // ── Handle Anthropic errors ──────────────────────────────────────────────────
  if (!anthropicResponse.ok) {
    let body = "";
    try { body = await anthropicResponse.text(); } catch {}
    console.error(`Anthropic API error ${anthropicResponse.status}:`, body);
    return res.status(502).json({
      error: `Anthropic API returned ${anthropicResponse.status}`,
      detail: body.slice(0, 500),
    });
  }

  let anthropicData;
  try {
    anthropicData = await anthropicResponse.json();
  } catch (jsonErr) {
    return res.status(502).json({ error: "Anthropic response was not valid JSON", detail: jsonErr.message });
  }

  // ── Parse jobs from response ─────────────────────────────────────────────────
  const rawText = (anthropicData.content || []).map((b) => b.text || "").join("").trim();

  // Strip any accidental markdown code fences
  const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let jobs;
  try {
    jobs = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("Could not parse jobs from Anthropic response:", cleaned.slice(0, 500));
    return res.status(500).json({
      error: "Could not parse job data from AI response",
      detail: parseErr.message,
      raw: cleaned.slice(0, 300),
    });
  }

  if (!Array.isArray(jobs)) {
    return res.status(500).json({ error: "AI response was not an array of jobs", raw: cleaned.slice(0, 300) });
  }

  // ── Return clean result ──────────────────────────────────────────────────────
  return res.status(200).json({ jobs, count: jobs.length });
}
