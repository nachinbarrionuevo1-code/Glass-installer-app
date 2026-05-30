/**
 * api/scan.js — Vercel Serverless Function
 *
 * Route:   POST /api/scan
 * Body:    { images: [{ base64: string, mediaType: string }] }
 * Returns: { jobs: [...], count: N }
 *
 * Sends images to Gemini Vision (gemini-1.5-flash) and returns
 * structured job data extracted from job sheet photos.
 *
 * Required env var: GEMINI_API_KEY
 * Set in Vercel → Settings → Environment Variables.
 * This key is NEVER sent to the browser.
 */

export default async function handler(req, res) {

  // ── CORS ─────────────────────────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // ── Validate request ──────────────────────────────────────────────────────────
  const { images } = req.body || {};
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Body must include a non-empty 'images' array." });
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
    if (img.base64.length > 2_000_000) {
      return res.status(400).json({ error: "Image too large. Compress before uploading (max ~1.5 MB base64)." });
    }
  }

  // ── Gemini API key ────────────────────────────────────────────────────────────
  // Add GEMINI_API_KEY in: Vercel Dashboard → Your Project → Settings → Environment Variables
  // Get the key from: https://aistudio.google.com/app/apikey
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in Vercel environment variables.");
    return res.status(500).json({
      error: "Server configuration error: GEMINI_API_KEY not set.",
      fix: "Add GEMINI_API_KEY in Vercel → Settings → Environment Variables, then redeploy."
    });
  }

  // ── Extraction prompt ─────────────────────────────────────────────────────────
  const prompt = `You are analysing job sheet photos for a glass installation company called Civic Shower Screens.
Extract ALL jobs visible across ALL provided images.

Respond ONLY with a valid JSON array. No markdown, no code fences, no explanation, no preamble.

Each job object must have exactly these keys (use "" for any field not visible):
- jobNumber   : job or work order number
- address     : street address including number (e.g. "12 Smith Street")
- suburb      : suburb, city or town
- contactName : customer full name
- phone       : phone number as written on the sheet
- jobType     : type of work (e.g. "Shower Screen Installation", "Mirror Fitting", "Glass Balustrade")
- company     : company or builder name if visible, else ""
- notes       : measurements, access instructions, or any other relevant detail

Rules:
- Never invent or guess field values
- If the same job appears in multiple images, include it only once
- Return [] if no recognisable job sheet data is found

Return format (array, even for a single job):
[{"jobNumber":"","address":"","suburb":"","contactName":"","phone":"","jobType":"","company":"","notes":""}]`;

  // ── Build Gemini request ──────────────────────────────────────────────────────
  const parts = [
    ...images.map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.base64 },
    })),
    { text: prompt },
  ];

  const GEMINI_MODEL = "gemini-1.5-flash";
  const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // ── Call Gemini ───────────────────────────────────────────────────────────────
  let geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    });
  } catch (netErr) {
    console.error("Network error reaching Gemini:", netErr.message);
    return res.status(502).json({
      error: "Backend could not reach Gemini API.",
      detail: netErr.message,
    });
  }

  // ── Handle Gemini HTTP errors ─────────────────────────────────────────────────
  if (!geminiRes.ok) {
    let body = "";
    try { body = await geminiRes.text(); } catch {}
    console.error(`Gemini API error ${geminiRes.status}:`, body);
    return res.status(502).json({
      error: `Gemini API returned HTTP ${geminiRes.status}`,
      detail: body.slice(0, 500),
    });
  }

  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch (e) {
    return res.status(502).json({
      error: "Gemini response was not valid JSON.",
      detail: e.message,
    });
  }

  // ── Check for safety blocks ───────────────────────────────────────────────────
  const blockReason = geminiData?.promptFeedback?.blockReason;
  if (blockReason) {
    return res.status(400).json({
      error: `Gemini blocked the request: ${blockReason}`,
      detail: "The image may have triggered a safety filter.",
    });
  }

  const candidate = geminiData?.candidates?.[0];
  if (!candidate) {
    console.error("No candidates in Gemini response:", JSON.stringify(geminiData).slice(0, 300));
    return res.status(502).json({
      error: "Gemini returned no response candidates.",
      detail: JSON.stringify(geminiData).slice(0, 300),
    });
  }

  // ── Extract text ──────────────────────────────────────────────────────────────
  // Gemini shape: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  const rawText = (candidate?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!rawText) {
    return res.status(502).json({
      error: "Gemini returned an empty response.",
      detail: `finishReason: ${candidate?.finishReason}`,
    });
  }

  // ── Parse JSON ────────────────────────────────────────────────────────────────
  // Strip any accidental markdown fences despite instructions
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let jobs;
  try {
    jobs = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("JSON parse failed. Raw:", cleaned.slice(0, 500));
    return res.status(500).json({
      error: "Could not parse job data from Gemini response.",
      detail: parseErr.message,
      raw: cleaned.slice(0, 300),
    });
  }

  if (!Array.isArray(jobs)) {
    return res.status(500).json({
      error: "Gemini response was not a JSON array.",
      raw: cleaned.slice(0, 300),
    });
  }

  // ── Return clean result ───────────────────────────────────────────────────────
  return res.status(200).json({ jobs, count: jobs.length });
}
