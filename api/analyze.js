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

import crypto from "node:crypto";

export const maxDuration = 30;

const CATEGORIES = ["hike", "coffee", "food", "view", "beach", "art"];
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "tachanot-baderech";

// Verify a Firebase ID token so only signed-in users can use the AI. Pure
// Node crypto (no SDK): fetch Google's public x509 certs, verify the RS256
// signature, then check issuer/audience/expiry.
let _certs = null, _certsExp = 0;
async function googleSecureTokenCerts() {
  if (_certs && Date.now() < _certsExp) return _certs;
  const r = await fetchWithTimeout("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com", {}, 4000);
  _certs = await r.json();
  _certsExp = Date.now() + 55 * 60 * 1000;
  return _certs;
}
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
async function verifyFirebaseToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8"));
    if (header.alg !== "RS256" || !header.kid) return null;
    const certs = await googleSecureTokenCerts();
    const pem = certs[header.kid];
    if (!pem) return null;
    // crypto.verify needs a PUBLIC KEY, not a certificate — extract it from the x509 cert.
    const pubKey = new crypto.X509Certificate(pem).publicKey;
    const ok = crypto.createVerify("RSA-SHA256").update(parts[0] + "." + parts[1]).verify(pubKey, b64urlToBuf(parts[2]));
    if (!ok) return null;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now) return null;
    if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID) return null;
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (!payload.sub) return null;
    return { uid: payload.sub, email: payload.email || "" };
  } catch (e) { return null; }
}

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

// SSRF guard: only allow fetching public http(s) hosts (block localhost,
// private/loopback/link-local IPs, and cloud metadata endpoints).
function isPublicHttpUrl(u) {
  let host;
  try {
    const x = new URL(String(u));
    if (x.protocol !== "http:" && x.protocol !== "https:") return false;
    host = x.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch (e) { return false; }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host === "metadata.google.internal") return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
      host.startsWith("fe80") || host.startsWith("::")) return false;
  return true;
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
    // Follow redirects manually, re-validating each hop, so a public URL can't
    // 302-pivot to an internal/metadata address (SSRF). Cap at 4 hops.
    let target = url, r = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!isPublicHttpUrl(target)) return "";
      r = await fetchWithTimeout(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)",
          "Accept-Language": "he,en;q=0.9",
        },
        redirect: "manual",
      }, 3000);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return "";
        target = new URL(loc, target).toString();
        continue;
      }
      break;
    }
    if (!r || !r.ok) return "";
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

// Geocode a place to coordinates via OpenStreetMap Nominatim (Israel only).
// LLMs are unreliable at exact coordinates, so we resolve them ourselves.
async function geocodeIL(query) {
  if (!query) return null;
  try {
    const u = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=il&accept-language=he&q=" + encodeURIComponent(query);
    const r = await fetchWithTimeout(u, { headers: { "User-Agent": "tachanot-baderech/1.0 (https://tachanot-baderech.vercel.app)", "Accept-Language": "he,en" } }, 4500);
    if (!r.ok) return null;
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length) {
      const la = parseFloat(arr[0].lat), lo = parseFloat(arr[0].lon);
      if (Number.isFinite(la) && Number.isFinite(lo)) return [la, lo];
    }
  } catch (e) {}
  return null;
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

  // Same-origin gate: the app's own fetch sends an Origin/Referer matching the
  // serving host. Reject anything else (raises the bar against scripted abuse of
  // this unauthenticated, billed proxy). Works across vercel.app/preview/custom
  // domains since it compares to the actual host, not a hard-coded value.
  const host = req.headers.host || "";
  const origin = req.headers.origin || req.headers.referer || "";
  let originHost = "";
  try { originHost = origin ? new URL(origin).host : ""; } catch (e) {}
  if (!host || originHost !== host) {
    res.status(403).json({ ok: false, error: "גישה נדחתה" });
    return;
  }

  // Auth gate: AI recognition is for signed-in users only.
  const authz = req.headers.authorization || "";
  const idToken = authz.startsWith("Bearer ") ? authz.slice(7) : ((req.body && req.body.idToken) || "");
  const user = await verifyFirebaseToken(idToken);
  if (!user) {
    res.status(401).json({ ok: false, error: "יש להתחבר עם Google כדי לזהות מקומות" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "GEMINI_API_KEY חסר בהגדרות השרת" });
    return;
  }

  // Coerce + bound user input — public endpoint, so limit type/length/scheme abuse.
  let { url, extraDesc } = req.body || {};
  url = url == null ? "" : String(url).trim().slice(0, 2048);
  extraDesc = extraDesc == null ? "" : String(extraDesc).trim().slice(0, 2000);
  if (!url && !extraDesc) {
    res.status(400).json({ ok: false, error: "חסר לינק או תיאור" });
    return;
  }
  // Normalize a scheme-less link (e.g. pasted "instagram.com/...") to https so
  // downstream URL parsing / SSRF checks work; keep everything http(s)-only.
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;

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

    const reqBody = JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      tools: [{ url_context: {} }, { google_search: {} }],
      // thinkingBudget 0 disables Gemini's "thinking" step — big latency cut,
      // negligible quality loss for this extraction task.
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    });

    // Retry transient failures (503/500/502 AND timeouts/network errors).
    // Kept within maxDuration: 2 attempts × 9s + short backoff + page fetch < 30s.
    const ATTEMPTS = 2, PER_TRY_MS = 9000;
    let gemRes = null, errText = "";
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        gemRes = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: reqBody,
        }, PER_TRY_MS);
      } catch (e) {
        // Abort (timeout) or network error — treat as a transient failure.
        gemRes = null;
        if (attempt < ATTEMPTS - 1) { await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
        break;
      }
      if (gemRes.ok) break;
      errText = await gemRes.text();
      const transient = gemRes.status === 503 || gemRes.status === 500 || gemRes.status === 502;
      if (transient && attempt < ATTEMPTS - 1) { await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); continue; }
      break;
    }

    if (!gemRes || !gemRes.ok) {
      const status = gemRes ? gemRes.status : 0;
      console.error("Gemini error:", status || "(timeout/network)", errText);
      const busy = status === 0 || status === 503 || status === 500 || status === 502;
      const retryAfter = gemRes ? gemRes.headers.get("retry-after") : null;
      const msg = status === 429
        ? (retryAfter && /^\d+$/.test(retryAfter)
            ? `המערכת עמוסה כרגע (מכסה חינמית) — נסה/י שוב בעוד ${retryAfter} שניות`
            : "המערכת עמוסה כרגע (מכסה חינמית) — נסה/י שוב בעוד כדקה")
        : busy
          ? "המערכת עמוסה כרגע — נסה/י שוב בעוד רגע"
          : "הניתוח נכשל";
      res.status(status === 429 ? 429 : 502).json({ ok: false, error: msg });
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

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      console.error("Gemini JSON parse failed:", text.slice(0, 500));
      res.status(502).json({ ok: false, error: "לא הצלחתי לזהות מהלינק — הוסף/י תיאור קצר (שם המקום/עיר) ונסה/י שוב" });
      return;
    }
    let lat = Number(raw.lat);
    let lng = Number(raw.lng);
    const name = String(raw.name || "").trim() || "מקום חדש";
    const location = String(raw.location || "").trim();
    // The model often returns a place name but no/garbage coordinates — resolve
    // them ourselves via Nominatim so the place actually lands on the map.
    if (!(Number.isFinite(lat) && Number.isFinite(lng))) {
      const tries = [];
      if (name && location) tries.push(name + ", " + location);
      if (location) tries.push(location);
      if (name) tries.push(name + ", ישראל");
      for (const q of tries) {
        const g = await geocodeIL(q);
        if (g) { lat = g[0]; lng = g[1]; break; }
      }
    }
    const conf = Math.max(0, Math.min(100, Math.round(Number(raw.confidence))));
    const result = {
      name,
      category: CATEGORIES.includes(raw.category) ? raw.category : "hike",
      location,
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
