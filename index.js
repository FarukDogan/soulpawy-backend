import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let shopifyTokenCache = { token: null, expiresAt: 0 };

async function getShopifyAccessToken() {
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!store || !clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_STORE / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars");
  }

  const now = Date.now();
  if (shopifyTokenCache.token && now < shopifyTokenCache.expiresAt - 5 * 60 * 1000) {
    return shopifyTokenCache.token;
  }

  const url = `https://${store}/admin/oauth/access_token`;
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const resp = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  const token = resp.data?.access_token;
  const expiresIn = resp.data?.expires_in || 86399;

  if (!token) throw new Error("No access_token returned from Shopify");

  shopifyTokenCache.token = token;
  shopifyTokenCache.expiresAt = now + expiresIn * 1000;

  return token;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ------------------------
// TAG WHITELISTS
// ------------------------
const ALLOWED_SPECIES = new Set(["species_dog", "species_cat"]);
const ALLOWED_TYPE = new Set([
  "type_heartbeat",
  "type_chew",
  "type_puzzle",
  "type_calming_wrap",
  "type_scratch_post",
  "type_feeder",
  "type_noise_mask"
]);
const ALLOWED_NEED = new Set([
  "need_anxiety",
  "need_separation",
  "need_chewing",
  "need_scratching",
  "need_sleep",
  "need_enrichment",
  "need_boredom",
  "need_high_energy",
  "need_noise",
  "need_feeding"
]);

function uniq(arr) { return [...new Set(arr)]; }

function normalizeProductTags(rawTags, pet_type) {
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : [];
  const cleaned = tags.map(t => t.trim()).filter(Boolean);

  let species = cleaned.filter(t => ALLOWED_SPECIES.has(t));
  let types = cleaned.filter(t => ALLOWED_TYPE.has(t));
  let needs = cleaned.filter(t => ALLOWED_NEED.has(t));

  if (species.length === 0) {
    const t = String(pet_type || "").toLowerCase();
    species = [t === "cat" ? "species_cat" : "species_dog"];
  } else {
    species = [species[0]];
  }

  if (types.length === 0) {
    types = ["type_calming_wrap"];
  } else {
    types = [types[0]];
  }

  if (needs.length === 0) {
    needs = ["need_anxiety"];
  } else {
    needs = needs.slice(0, 4);
  }

  return uniq([...species, ...types, ...needs]).slice(0, 6);
}

/**
 * Product matching (scored)
 */
async function fetchProductsByTags(requestedTags) {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("Missing SHOPIFY_STORE env var");

  const token = await getShopifyAccessToken();
  const url = `https://${store}/admin/api/2025-01/products.json?limit=250&fields=id,title,handle,tags,images,variants,status,published_at`;
  const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });

  const tags = Array.isArray(requestedTags) ? requestedTags : [];
  const speciesTag = tags.find(t => t === "species_dog" || t === "species_cat") || null;
  const typeTags = tags.filter(t => t.startsWith("type_"));
  const needTags = tags.filter(t => t.startsWith("need_"));

  const products = (resp.data.products || [])
    .filter(p => p.status === "active" && p.published_at)
    .map(p => {
      const ptags = (p.tags || "").split(",").map(x => x.trim()).filter(Boolean);
      if (!ptags.length) return null;
      if (speciesTag && !ptags.includes(speciesTag)) return null;

      let score = 0;
      let matchedNonSpecies = 0;

      if (speciesTag) score += 3;

      for (const t of typeTags) {
        if (ptags.includes(t)) { score += 4; matchedNonSpecies++; }
      }
      for (const n of needTags) {
        if (ptags.includes(n)) { score += 2; matchedNonSpecies++; }
      }

      if (speciesTag && matchedNonSpecies === 0) return null;

      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        tags: p.tags,
        image: p.images?.[0]?.src || null,
        variant_id: p.variants?.[0]?.id || null,
        price: p.variants?.[0]?.price || null,
        url: p.handle ? `/products/${p.handle}` : null,
        _score: score
      };
    })
    .filter(Boolean);

  return products
    .sort((a, b) => b._score - a._score)
    .slice(0, 12)
    .map(({ _score, ...rest }) => rest);
}

async function fetchProductsFallbackBySpecies(speciesTag) {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("Missing SHOPIFY_STORE env var");

  const token = await getShopifyAccessToken();
  const url = `https://${store}/admin/api/2025-01/products.json?limit=250&fields=id,title,handle,tags,images,variants,status,published_at`;
  const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });

  const all = (resp.data.products || [])
    .filter(p => p.status === "active" && p.published_at)
    .map(p => {
      const ptags = (p.tags || "").split(",").map(x => x.trim()).filter(Boolean);
      if (!ptags.length) return null;
      if (speciesTag && !ptags.includes(speciesTag)) return null;

      let score = 0;
      for (const t of ptags) {
        if (t.startsWith("type_")) score += 2;
        if (t.startsWith("need_")) score += 1;
      }

      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        tags: p.tags,
        image: p.images?.[0]?.src || null,
        variant_id: p.variants?.[0]?.id || null,
        price: p.variants?.[0]?.price || null,
        url: p.handle ? `/products/${p.handle}` : null,
        _score: score
      };
    })
    .filter(Boolean);

  return all.sort((a,b)=>b._score-a._score).slice(0, 8).map(({_score, ...r})=>r);
}

// --- BLOG/ARTICLE ---
let blogCache = { blogs: null, expiresAt: 0 };
let articleCache = { items: null, expiresAt: 0 };

async function getBlogsCached() {
  const now = Date.now();
  if (blogCache.blogs && now < blogCache.expiresAt) return blogCache.blogs;

  const store = process.env.SHOPIFY_STORE;
  const token = await getShopifyAccessToken();

  const url = `https://${store}/admin/api/2025-01/blogs.json?limit=250&fields=id,handle`;
  const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });

  const blogs = (resp.data.blogs || []).map(b => ({ id: b.id, handle: b.handle }));
  blogCache.blogs = blogs;
  blogCache.expiresAt = now + 15 * 60 * 1000;
  return blogs;
}

function stripHtmlToExcerpt(html, maxLen = 180) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

async function getAllArticlesCached() {
  const now = Date.now();
  if (articleCache.items && now < articleCache.expiresAt) return articleCache.items;

  const store = process.env.SHOPIFY_STORE;
  const token = await getShopifyAccessToken();
  const blogs = await getBlogsCached();

  const all = [];
  for (const b of blogs) {
    const url = `https://${store}/admin/api/2025-01/blogs/${b.id}/articles.json?limit=250&fields=id,title,handle,tags,summary_html,image,published_at`;
    const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });

    const items = (resp.data.articles || [])
      .filter(a => !!a.published_at)
      .map(a => {
        const tags = (a.tags || "").split(",").map(x => x.trim()).filter(Boolean);
        return {
          id: a.id,
          title: a.title,
          handle: a.handle,
          url: (b.handle && a.handle) ? `/blogs/${b.handle}/${a.handle}` : null,
          tags,
          excerpt: stripHtmlToExcerpt(a.summary_html, 180),
          image: a.image?.src || null,
          published_at: a.published_at
        };
      });

    all.push(...items);
  }

  articleCache.items = all;
  articleCache.expiresAt = now + 15 * 60 * 1000;
  return all;
}

async function fetchArticlesByTags(product_tags) {
  const tags = Array.isArray(product_tags) ? product_tags : [];
  const speciesTag = tags.find(t => t === "species_dog" || t === "species_cat") || null;
  const typeTags = tags.filter(t => t.startsWith("type_"));
  const needTags = tags.filter(t => t.startsWith("need_"));

  const articles = await getAllArticlesCached();

  const scored = articles
    .map(a => {
      let score = 0;
      if (speciesTag && a.tags.includes(speciesTag)) score += 1;
      for (const t of typeTags) if (a.tags.includes(t)) score += 4;
      for (const n of needTags) if (a.tags.includes(n)) score += 2;
      return { ...a, _score: score };
    })
    .filter(a => a._score > 0);

  return scored
    .sort((x, y) => y._score - x._score)
    .slice(0, 6)
    .map(({ _score, ...rest }) => rest);
}

// Discount tiers
const DISCOUNT_CODES = { 10: "SOULPAWY10", 15: "SOULPAWY15", 20: "SOULPAWY20", 25: "SOULPAWY25" };
function normalizeDiscountTier(x) {
  const n = Number(x);
  if ([10, 15, 20, 25].includes(n)) return n;
  return 10;
}

// --- Prompts
const CHAT_MODE_SYSTEM = `
You are Soulpawy's friendly, empathetic AI pet assistant.
Goal: Understand the pet’s situation through natural conversation (not a form).
You must guide the user back on track if they drift away from the pet topic.

Rules:
- DO NOT output JSON.
- DO NOT recommend products yet.
- DO NOT mention discounts yet.
- Ask 1–2 focused follow-up questions at a time.
- Use the pet’s name if provided.
- If user message is vague, ask clarifying questions.
- If severe symptoms (breathing trouble, collapse, seizures, heavy bleeding, inability to urinate, suspected poisoning),
  tell them to contact an emergency vet immediately, then ask one minimal safety question.
- When you have enough info to produce a full plan, end your message with EXACTLY:
  I’m ready to create your plan.

Tone:
- Warm, friend-like, supportive, concise.
`.trim();

const FINALIZE_SYSTEM = `
You are Soulpawy's AI pet assistant. Now it's time to finalize.
Return ONLY valid JSON with this schema (no markdown, no extra text):

{
  "pet_type": "dog" | "cat" | "unknown",
  "pet_name": string,
  "problem_title": string,
  "urgency": "low" | "medium" | "high",
  "risk_flag": "none" | "urgent_vet" | "behavior_pro",
  "short_summary": string,

  "product_tags": [string],

  "daily_actions": [
    {
      "title": string,
      "steps": [string, string, string, string],
      "why": string,
      "product_hooks": [{ "tag": string, "instruction": string }]
    }
  ],

  "weekly_plan": [
    {
      "day_range": "days 1-2" | "days 3-4" | "days 5-7",
      "focus": string,
      "steps": [string, string, string],
      "product_hooks": [{ "tag": string, "instruction": string }]
    }
  ],

  "discount_tier": 10 | 15 | 20 | 25,

  "final_message": string,
  "ask_articles_question": string,
  "articles_available": true
}

Hard requirements:
- product_tags must include species_dog or species_cat.
- product_tags must be 2-6 items and only from allowed lists below.
- discount_tier must be 10/15/20/25.

Quality requirements (IMPORTANT):
- Make the plan feel real, caring, and specific.
- daily_actions.steps MUST be 4 items (longer, more helpful).
- weekly_plan.steps MUST be 3 items (more detailed).
- product_hooks must reference tags in product_tags and include practical use instructions.

final_message rules:
- DO NOT include the discount code itself (frontend will show it).
- Tone: warm, reassuring, genuinely concerned.
- Must address the pet by name (if unknown, say "your pet").
- Must mention we’re worried, want to help, and the next step is to add recommended items to cart today.
- Must mention: after purchase, we will email a copy of the plan + a summary of this chat as a thank-you.

Default ask_articles_question (friendly):
"Would you like to see a few related articles from our Learn blog? (Reply: yes / no)"

Allowed NEED tags:
need_anxiety, need_separation, need_chewing, need_scratching, need_sleep, need_enrichment, need_boredom, need_high_energy, need_noise, need_feeding

Allowed TYPE tags:
type_heartbeat, type_chew, type_puzzle, type_calming_wrap, type_scratch_post, type_feeder, type_noise_mask

Species tags (must include one):
species_dog, species_cat
`.trim();

app.get("/health", (req, res) => res.send("OK"));

app.post("/chat", async (req, res) => {
  try {
    const mode = String(req.body?.mode || "chat").toLowerCase();
    const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];

    if (msgs.length === 0) {
      return res.status(400).json({ error: "Bad request", detail: "messages[] is required" });
    }

    if (mode === "chat") {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "system", content: CHAT_MODE_SYSTEM }, ...msgs]
      });

      const assistant_message = completion.choices?.[0]?.message?.content?.trim() || "";
      return res.json({ mode: "chat", assistant_message });
    }

    if (mode === "finalize") {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "system", content: FINALIZE_SYSTEM }, ...msgs]
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || "";
      const parsed = safeJsonParse(raw);

      if (!parsed) {
        return res.status(500).json({ error: "AI error", detail: "Finalize returned invalid JSON", raw });
      }

      const tier = normalizeDiscountTier(parsed.discount_tier);
      const discount_code = DISCOUNT_CODES[tier];

      const product_tags = normalizeProductTags(parsed.product_tags, parsed.pet_type);

      let products = await fetchProductsByTags(product_tags);
      if (!products.length) {
        const speciesTag = product_tags.find(t => ALLOWED_SPECIES.has(t)) || null;
        products = await fetchProductsFallbackBySpecies(speciesTag);
      }

      const articles = await fetchArticlesByTags(product_tags);

      const askQ =
        String(parsed.ask_articles_question || "").trim() ||
        "Would you like to see a few related articles from our Learn blog? (Reply: yes / no)";

      const analysis = {
        pet_type: parsed.pet_type,
        pet_name: parsed.pet_name,
        problem_title: parsed.problem_title,
        urgency: parsed.urgency,
        risk_flag: parsed.risk_flag,
        short_summary: parsed.short_summary,
        product_tags,
        daily_actions: parsed.daily_actions,
        weekly_plan: parsed.weekly_plan,
        ask_articles_question: askQ,
        articles_available: true
      };

      return res.json({
        mode: "finalize",
        assistant_message: parsed.final_message || parsed.short_summary || "",
        analysis,
        discount: { percent: tier, code: discount_code },
        products,
        articles
      });
    }

    return res.status(400).json({ error: "Bad request", detail: "mode must be chat or finalize" });
  } catch (err) {
    console.error("CHAT ERROR:", err?.status, err?.message, err?.response?.data);
    res.status(500).json({ error: "AI error", detail: err?.message || String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
