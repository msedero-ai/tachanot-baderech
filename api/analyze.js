// Vercel Serverless Function — proxy to the Anthropic API.
// Extracts a place's name, category and location from a social-media link
// plus an optional free-text description the user pasted.
//
// Set the ANTHROPIC_API_KEY environment variable in the Vercel project settings.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// The categories the app supports — the model must pick exactly one of these.
const CATEGORIES = ["hike", "coffee", "food", "view", "beach", "art"];

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "שם המקום בעברית, קצר וברור" },
    category: { type: "string", enum: CATEGORIES },
    location: {
      type: "string",
      description: "המיקום בישראל — שם המקום + עיר/אזור, למשל 'נחל דרגות, מדבר יהודה'",
    },
    description: { type: "string", description: "תיאור קצר של המקום, משפט או שניים" },
    lat: { type: "number", description: "קו רוחב משוער (ישראל ~29.5 עד 33.3)" },
    lng: { type: "number", description: "קו אורך משוער (ישראל ~34.2 עד 35.9)" },
    confidence: {
      type: "integer",
      description: "0-100 — כמה בטוח הזיהוי של המיקום הספציפי",
    },
    emoji: { type: "string", description: "אמוג'י אחד שמתאים למקום" },
  },
  required: ["name", "category", "location", "description", "lat", "lng", "confidence", "emoji"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `אתה עוזר שמזהה מקומות בישראל מתוך לינקים לרשתות חברתיות (אינסטגרם, טיקטוק, פייסבוק, וואטסאפ) וטקסט חופשי.

המשתמש מדביק לינק ולפעמים גם תיאור. אינך יכול לפתוח את הלינק עצמו — הסק את המקום מתוך הכתובת (handle, מילות מפתח ב-URL) ומתוך התיאור שהמשתמש כתב.

החזר תמיד מקום אחד בישראל:
- name: שם המקום בעברית.
- category: בחר אחת — hike (טיול/טבע), coffee (בית קפה), food (מסעדה/אוכל), view (תצפית), beach (חוף), art (אמנות/תרבות).
- location: שם המקום + עיר או אזור בישראל.
- lat/lng: הערכה גאוגרפית בתוך גבולות ישראל. אם אינך בטוח, תן הערכה סבירה לאזור.
- confidence: 0-100. אם זיהית מקום ספציפי בוודאות — גבוה. אם ניחשת לפי הקשר כללי — נמוך.
- emoji: אמוג'י מתאים.

אם אין מספיק מידע, תן את הניחוש הטוב ביותר עם confidence נמוך.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ ok: false, error: "ANTHROPIC_API_KEY חסר בהגדרות השרת" });
    return;
  }

  const { url, extraDesc } = req.body || {};
  if (!url && !extraDesc) {
    res.status(400).json({ ok: false, error: "חסר לינק או תיאור" });
    return;
  }

  const userMessage =
    `לינק: ${url || "(לא צורף)"}\n` +
    `תיאור מהמשתמש: ${extraDesc || "(אין)"}\n\n` +
    `זהה את המקום והחזר את הפרטים.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6", // matches the original; ~2x cheaper than Opus
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: RESULT_SCHEMA },
      },
      messages: [{ role: "user", content: userMessage }],
    });

    // With output_config.format the first text block is guaranteed valid JSON.
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      res.status(502).json({ ok: false, error: "תשובה ריקה מה-AI" });
      return;
    }

    const result = JSON.parse(textBlock.text);
    res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error("analyze error:", e);
    // TEMP DIAGNOSTIC: surface the real error to find the root cause.
    res.status(502).json({
      ok: false,
      error: "הניתוח נכשל",
      _debug: { message: e?.message, status: e?.status, name: e?.name },
    });
  }
}
