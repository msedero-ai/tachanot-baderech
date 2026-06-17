// Vercel Serverless Function — proxy to the Google Gemini API.
// Extracts a place's name, category and location from a social-media link
// plus an optional free-text description the user pasted.
//
// Required env var (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY   — from https://aistudio.google.com/apikey
// Optional:
//   GEMINI_MODEL     — defaults to "gemini-2.5-flash"

const CATEGORIES = ["hike", "coffee", "food", "view", "beach", "art"];

const SYSTEM_PROMPT = `אתה עוזר שמזהה מקומות בישראל מתוך לינקים לרשתות חברתיות (אינסטגרם, טיקטוק, פייסבוק, וואטסאפ) וטקסט חופשי.

המשתמש מדביק לינק ולפעמים גם תיאור. אינך יכול לפתוח את הלינק עצמו — הסק את המקום מתוך הכתובת (handle, מילות מפתח ב-URL) ומתוך התיאור שהמשתמש כתב.

החזר תמיד מקום אחד בישראל, כאובייקט JSON תקין בלבד (ללא טקסט נוסף, ללא סימוני code), במבנה הזה בדיוק:
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
אם אין מספיק מידע, תן את הניחוש הטוב ביותר עם confidence נמוך.`;

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
    `זהה את המקום והחזר JSON בלבד.`;

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const gemRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!gemRes.ok) {
      const errText = await gemRes.text();
      console.error("Gemini HTTP error:", gemRes.status, errText);
      res.status(502).json({ ok: false, error: "הניתוח נכשל" });
      return;
    }

    const data = await gemRes.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    if (!text) {
      console.error("Gemini empty response:", JSON.stringify(data).slice(0, 500));
      res.status(502).json({ ok: false, error: "תשובה ריקה מה-AI" });
      return;
    }

    const raw = JSON.parse(text);

    // Normalize so the client always gets a well-formed result.
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
