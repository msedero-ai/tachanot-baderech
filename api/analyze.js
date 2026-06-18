// Vercel Serverless Function — proxy to the Google Gemini API.
// Identifies a place from a social-media link (+ optional pasted text).
// Uses the URL-context and Google-Search tools so Gemini can actually read the
// link and look the place up, instead of guessing from the URL alone.
//
// Required env var: GEMINI_API_KEY (from https://aistudio.google.com/apikey)
// Optional: GEMINI_MODEL (defaults to "gemini-2.5-flash")

export const maxDuration = 30; // grounding/url-context can take a few seconds

const CATEGORIES = ["hike", "coffee", "food", "view", "beach", "art"];

const SYSTEM_PROMPT = `אתה עוזר שמזהה מקומות בישראל מתוך לינקים לרשתות חברתיות (אינסטגרם, טיקטוק, פייסבוק, וואטסאפ) וטקסט חופשי.

יש לך גישה לשני כלים:
1. קריאת תוכן מ-URL — נסה תחילה לקרוא את תוכן הדף של הלינק (כיתוב, שם המקום, תיוג מיקום).
2. חיפוש גוגל — השתמש בו כדי לזהות את המקום המדויק (שם העסק, כתובת, עיר) ולאמת קואורדינטות.

אם הדף חסום או לא נגיש (אינסטגרם/טיקטוק לעיתים חוסמים) — הסק מהכתובת ומהתיאור שהמשתמש כתב, והיעזר בחיפוש גוגל.

החזר מקום אחד בישראל, כאובייקט JSON תקין **בלבד** — בלי טקסט נוסף, בלי הסברים, בלי סימוני code. המבנה המדויק:
{
  "name": "שם המקום בעברית",
  "category": "אחת מ: hike, coffee, food, view, beach, art",
  "location": "שם המקום + עיר/אזור בישראל",
  "description": "תיאור קצר, משפט או שניים",
  "lat": מספר קו רוחב (ישראל ~29.5 עד 33.3),
  "lng": מספר קו אורך (ישראל ~34.2 עד 35.9),
  "confidence": מספר שלם 0-100 — כמה בטוח זיהוי המיקום הספציפי,
  "emoji": "אמוג'י אחד שמתאים"
}

קטגוריות: hike (טיול/טבע), coffee (בית קפה), food (מסעדה/אוכל), view (תצפית), beach (חוף), art (אמנות/תרבות).
ככל שזיהית מקום ספציפי בוודאות גבוהה יותר — confidence גבוה יותר.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "GEMINI_API_KEY חסר בהגדרות השרת" });
    return;
  }

  const { url, extraDesc } = req.body || {};
  if (!url && !extraDesc) {
    res.status(400).json({ ok: false, error: "חסר לינק או תיאור" });
    return;
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const userMessage =
    `לינק: ${url || "(לא צורף)"}\n` +
    `תיאור מהמשתמש: ${extraDesc || "(אין)"}\n\n` +
    `קרא את הלינק (אם אפשר) וחפש בגוגל כדי לזהות את המקום, והחזר JSON בלבד.`;

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const gemRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        // url_context + google_search let the model actually read the link and
        // look the place up. These can't be combined with responseMimeType JSON,
        // so we ask for JSON in the prompt and parse it out of the text below.
        tools: [{ url_context: {} }, { google_search: {} }],
        generationConfig: { temperature: 0.2 },
      }),
    });

    if (!gemRes.ok) {
      const errText = await gemRes.text();
      console.error("Gemini HTTP error:", gemRes.status, errText);
      res.status(502).json({ ok: false, error: "הניתוח נכשל" });
      return;
    }

    const data = await gemRes.json();
    let text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    // The model may wrap the JSON in prose when grounding — extract the object.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }

    if (!text) {
      console.error("Gemini empty response:", JSON.stringify(data).slice(0, 500));
      res.status(502).json({ ok: false, error: "תשובה ריקה מה-AI" });
      return;
    }

    const raw = JSON.parse(text);

    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    const conf = Math.max(0, Math.min(100, Math.round(Number(raw.confidence))));
    const result = {
      name: String(raw.name || "").trim() || "מקום חדש",
      category: CATEGORIES.includes(raw.category) ? raw.category : "hike",
      location: String(raw.location || "").trim(),
      description: String(raw.description || "").trim(),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      confidence: Number.isFinite(conf) ? conf : 50,
      emoji: String(raw.emoji || "📍").trim() || "📍",
    };

    res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error("analyze error:", e);
    res.status(502).json({ ok: false, error: "הניתוח נכשל" });
  }
}
