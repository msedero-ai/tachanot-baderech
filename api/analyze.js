// Vercel Serverless Function — proxy to the Google Gemini API.
// Identifies a place from a social-media link (+ optional pasted text).
//
// To maximize recognition we feed Gemini three sources:
//   1. Page context we fetch ourselves server-side (TikTok oEmbed caption,
//      and og:title/og:description meta tags from any link that exposes them).
//   2. Gemini's url_context tool (the model reads the link itself).
//   3. Gemini's google_search tool (the model looks the place up).
//
// Required env var: GEMINI_API_KEY (from https://aistudio.google.com/apikey)
// Optional: GEMINI_MODEL (defaults to "gemini-2.5-flash"; set to
//           "gemini-2.5-pro" for max accuracy at higher latency)

export const maxDuration = 30;

const CATEGORIES = ["hike", "coffee", "food", "view", "beach", "art"];

const SYSTEM_PROMPT = `אתה מומחה לזיהוי מקומות בישראל מתוך לינקים לרשתות חברתיות (אינסטגרם, טיקטוק, פייסבוק, וואטסאפ) וטקסט חופשי.

מקורות המידע שלך:
- "מידע שחולץ מהדף" (אם צורף) — כיתוב הפוסט/סרטון, כותרת ותיאור הדף. זה המקור האמין ביותר — קרא אותו בעיון, הוא לרוב מכיל את שם המקום או תיוג מיקום.
- כלי קריאת URL — קרא את תוכן הדף של הלינק.
- חיפוש גוגל — זהה את המקום המדויק (שם העסק, כתובת מלאה, עיר) ואמת קואורדינטות. השתמש בו תמיד כדי לדייק.

כללי זיהוי:
- העדף את המקום הספציפי והאמיתי ביותר (שם עסק + רחוב + עיר), לא אזור כללי.
- אם בכיתוב יש שם עסק (למשל "חומוס סעיד", "קפה לנדוור") — חפש אותו בגוגל וקח את הכתובת והקואורדינטות המדויקות.
- אם הדף חסום ואין מידע שחולץ — הסק מה-handle שבכתובת ומהתיאור, והיעזר בחיפוש גוגל.
- אם יש כמה סניפים — בחר את הסביר ביותר לפי ההקשר; אם לא ידוע, ציין בעיר הראשית והורד confidence.

confidence (היה כן):
- 90-100: מצאת מקום בעל שם עם כתובת מאומתת.
- 60-85: זיהוי סביר לפי הקשר חלקי.
- פחות מ-50: ניחוש בלבד.

החזר מקום אחד בישראל, כאובייקט JSON תקין **בלבד** — בלי טקסט נוסף, בלי הסברים, בלי סימוני code. המבנה:
{
  "name": "שם המקום בעברית",
  "category": "אחת מ: hike, coffee, food, view, beach, art",
  "location": "שם המקום + עיר/אזור בישראל",
  "description": "תיאור קצר, משפט או שניים",
  "lat": מספר קו רוחב (ישראל ~29.5 עד 33.3),
  "lng": מספר קו אורך (ישראל ~34.2 עד 35.9),
  "confidence": מספר שלם 0-100,
  "emoji": "אמוג'י אחד שמתאים"
}
קטגוריות: hike (טיול/טבע), coffee (בית קפה), food (מסעדה/אוכל), view (תצפית), beach (חוף), art (אמנות/תרבות).`;

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 6000);
  return fetch(url, { ...(opts || {}), signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x?2F;/gi, "/");
}

async function tiktokOembed(url) {
  if (!/tiktok\.com/i.test(url)) return "";
  try {
    const r = await fetchWithTimeout("https://www.tiktok.com/oembed?url=" + encodeURIComponent(url), {}, 3500);
    if (!r.ok) return "";
    const j = await r.json();
    const out = [];
    if (j.title) out.push("כיתוב הסרטון: " + j.title);
    if (j.author_name) out.push("יוצר: " + j.author_name);
    return out.join("\n");
  } catch (e) { return ""; }
}

async function ogMeta(url) {
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)",
        "Accept-Language": "he,en;q=0.9",
      },
    }, 3000);
    if (!r.ok) return "";
    const html = (await r.text()).slice(0, 300000);
    const grab = (prop) => {
      const m =
        html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', "i")) ||
        html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', "i"));
      return m ? decodeEntities(m[1]).trim() : "";
    };
    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
    const out = [];
    const title = grab("og:title") || decodeEntities(titleTag || "").trim();
    const desc = grab("og:description");
    const site = grab("og:site_name");
    if (title) out.push("כותרת הדף: " + title);
    if (desc) out.push("תיאור הדף: " + desc);
    if (site) out.push("אתר: " + site);
    return out.join("\n");
  } catch (e) { return ""; }
}

async function fetchPageContext(url) {
  if (!url) return "";
  const tasks = [];
  if (/tiktok\.com/i.test(url)) tasks.push(tiktokOembed(url).catch(() => ""));
  // Skip scraping Instagram/Facebook/TikTok pages directly — they're login-walled
  // and slow; rely on oEmbed (TikTok) + Gemini's tools. og:meta only helps for
  // other sites (blogs, Google Maps links, etc.) and is usually fast there.
  if (!/instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.watch|fb\.me|tiktok\.com/i.test(url)) {
    tasks.push(ogMeta(url).catch(() => ""));
  }
  if (!tasks.length) return "";
  const parts = await Promise.all(tasks);
  return parts.filter(Boolean).join("\n");
}

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

  try {
    const pageContext = url ? await fetchPageContext(url) : "";

    const userMessage =
      `לינק: ${url || "(לא צורף)"}\n` +
      `תיאור מהמשתמש: ${extraDesc || "(אין)"}\n` +
      (pageContext ? `\nמידע שחולץ מהדף:\n${pageContext}\n` : "") +
      `\nזהה את המקום (קרא את הלינק וחפש בגוגל) והחזר JSON בלבד.`;

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const gemRes = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        tools: [{ url_context: {} }, { google_search: {} }],
        // thinkingBudget 0 disables Gemini's "thinking" step — big latency cut,
        // negligible quality loss for this extraction task.
        generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }, 12000);

    if (!gemRes.ok) {
      const errText = await gemRes.text();
      console.error("Gemini HTTP error:", gemRes.status, errText);
      const msg = gemRes.status === 429
        ? "המערכת עמוסה כרגע (מכסה חינמית) — נסה/י שוב בעוד כדקה"
        : "הניתוח נכשל";
      res.status(gemRes.status === 429 ? 429 : 502).json({ ok: false, error: msg });
      return;
    }

    const data = await gemRes.json();
    let text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) text = text.slice(start, end + 1);

    if (!text) {
      console.error("Gemini empty response:", JSON.stringify(data).slice(0, 500));
      res.status(502).json({ ok: false, error: "לא הצלחתי לזהות מהלינק — הוסף/י תיאור קצר (שם המקום/עיר) ונסה/י שוב" });
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
