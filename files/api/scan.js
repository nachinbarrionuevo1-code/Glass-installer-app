/**
 * api/scan.js  —  Vercel Serverless Function
 *
 * POST /api/scan
 * Body:  { images: [{ base64: string, mediaType: string }] }
 * Returns: { jobs: [...], count: N }
 *
 * Calls Gemini Vision. Key is read from process.env.GEMINI_API_KEY.
 * The key is never sent to the client.
 */

export default async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const { images } = req.body || {};
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Body must include an 'images' array." });
  }
  if (images.length > 10) {
    return res.status(400).json({ error: "Maximum 10 images per request." });
  }
  for (const img of images) {
    if (!img.base64 || typeof img.base64 !== "string") {
      return res.status(400).json({ error: "Each image must have a base64 string." });
    }
    if (!img.mediaType || !img.mediaType.startsWith("image/")) {
      return res.status(400).json({ error: `Invalid mediaType: "${img.mediaType}"` });
    }
    if (img.base64.length > 2_000_000) {
      return res.status(400).json({ error: "Image too large. Max ~1.5 MB base64." });
    }
  }

  // ── API key ───────────────────────────────────────────────────────────────
  // Add this in Vercel: Settings → Environment Variables → GEMINI_API_KEY
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set.");
    return res.status(500).json({ error: "Server config error: GEMINI_API_KEY not set." });
  }

  // ── Prompt ────────────────────────────────────────────────────────────────
  const prompt = `You are analysing job sheet photos for a glass installation company called Civic Shower Screens.
Extract ALL jobs visible across ALL provided images.

Respond ONLY with a valid JSON array — no markdown, no code fences, no explanation.

Each job object must have exactly these keys (use "" for any field not visible):
- jobNumber   : job or work order number
- address     : street address including number
- suburb      : suburb, city or town
- contactName : customer full name
- phone       : phone number as written
- jobType     : type of work (e.g. "Shower Screen Installation", "Mirror Fitting")
- company     : company or builder name if visible, else ""
- notes       : measurements, access instructions, or any other relevant detail

Rules:
- Never invent or guess values
- If the same job appears in multiple images, include it only once
- Return [] if no job sheet data is found

Format (array, even for one job):
[{"jobNumber":"","address":"","suburb":"","contactName":"","phone":"","jobType":"","company":"","notes":""}]`;

  // ── Build Gemini request ──────────────────────────────────────────────────
  const parts = [
    ...images.map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.base64 },
    })),
    { text: prompt },
  ];

  const GEMINI_MODEL = "gemini-1.5-flash";
  const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // ── Call Gemini ───────────────────────────────────────────────────────────
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
    console.error("Network error calling Gemini:", netErr.message);
    return res.status(502).json({
      error: "Backend could not reach Gemini API.",
      detail: netErr.message,
    });
  }

  if (!geminiRes.ok) {
    let body = "";
    try { body = await geminiRes.text(); } catch {}
    console.error(`Gemini HTTP ${geminiRes.status}:`, body);
    return res.status(502).json({
      error: `Gemini returned HTTP ${geminiRes.status}`,
      detail: body.slice(0, 500),
    });
  }

  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch (e) {
    return res.status(502).json({ error: "Gemini response was not JSON", detail: e.message });
  }

  // ── Extract text ──────────────────────────────────────────────────────────
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
    return res.status(502).json({ error: "Gemini returned no candidates." });
  }

  const rawText = (candidate?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!rawText) {
    return res.status(502).json({
      error: "Gemini returned empty text.",
      detail: `finishReason: ${candidate?.finishReason}`,
    });
  }

  // ── Parse JSON ────────────────────────────────────────────────────────────
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let jobs;
  try {
    jobs = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("JSON parse failed. Raw:", cleaned.slice(0, 400));
    return res.status(500).json({
      error: "Could not parse job data from Gemini response.",
      detail: parseErr.message,
      raw: cleaned.slice(0, 300),
    });
  }

  if (!Array.isArray(jobs)) {
    return res.status(500).json({
      error: "Gemini response was not an array.",
      raw: cleaned.slice(0, 300),
    });
  }

  return res.status(200).json({ jobs, count: jobs.length });
}
