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

/**
 * Shopify: client credentials token cache
 * Requires:
 *  - SHOPIFY_STORE (example: tuxi7x-y5.myshopify.com)
 *  - SHOPIFY_CLIENT_ID
 *  - SHOPIFY_CLIENT_SECRET
 */
let shopifyTokenCache = { token: null, expiresAt: 0 };

async function getShopifyAccessToken() {
  const store = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!store || !clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_STORE / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars");
  }

  const now = Date.now();
  // refresh 5 minutes early
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
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Product matching: "mostly matches" (scored), not 100% tag match
 * Rules:
 *  - species tag (species_dog/species_cat) is required (if present)
 *  - type_ tags weighted more than need_ tags
 *  - rank by score, return top N
 */
async function fetchProductsByTags(requestedTags) {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("Missing SHOPIFY_STORE env var");

  const token = await getShopifyAccessToken();

  const url = `https://${store}/admin/api/2025-01/products.json?limit=250&fields=id,title,handle,tags,images,variants,status,published_at`;
  const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });

  const tags = Array.isArray(requestedTags) ? requestedTags : [];

  const speciesTag = tags.find((t) => t === "species_dog" || t === "species_cat") || null;
  const typeTags = tags.filter((t) => t.startsWith("type_"));
  const needTags = tags.filter((t) => t.startsWith("need_"));

  const products = (resp.data.products || [])
    .filter((p) => p.status === "active" && p.published_at)
    .map((p) => {
      const ptags = (p.tags || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      // Species required if we have it
      if (speciesTag && !ptags.includes(speciesTag)) return null;

      let score = 0;
      // baseline if species matches (or not provided)
      if (speciesTag) score += 3;

      for (const t of typeTags) {
        if (ptags.includes(t)) score += 4;
      }
      for (const n of needTags) {
        if (ptags.includes(n)) score += 2;
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

  // Minimum threshold so we don't show totally unrelated items.
  // If speciesTag exists, require at least 1 need/type match:
  // - species baseline 3 + at least one need (2) => 5
  // - or species baseline 3 + one type (4) => 7
  const minScore = speciesTag ? 5 : 2;

  const ranked = products
    .filter((p) => p._score >= minScore)
    .sort((a, b) => b._score - a._score)
    .slice(0, 12)
    .map(({ _score, ...rest }) => rest);

  return ranked;
}

// Discount tiers (you will create these codes in Shopify Discounts)
const DISCOUNT_CODES = {
  10: "SOULPAWY10",
  15: "SOULPAWY15",
  20: "SOULPAWY20",
  25: "SOULPAWY25"
};

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

  "daily_actions": [
    {"title": string, "steps": [string, string, string], "why": string}
  ],
  "weekly_plan": [
    {"day_range": "days 1-2" | "days 3-4" | "days 5-7", "focus": string, "steps": [string, string]}
  ],

  "product_tags": [string],
  "product_usage": [
    {"tag": string, "how_to": [string, string], "why_it_helps": string}
  ],

  "discount_tier": 10 | 15 | 20 | 25,

  "final_message": string,
  "ask_articles_question": string,
  "articles_available": true
}

Hard requirements:
- final_message MUST include:
  1) the problem in plain words (mention pet_name),
  2) a confident but friendly transition into the plan,
  3) a natural sales push: suggest adding the recommended items to cart today,
  4) discount offered as personal initiative (no "random"),
  5) mention: after purchase, we will email a copy of the plan + a summary of this chat as a thank-you.
- DO NOT mention external competitor products/brands.
- product_tags must include species_dog or species_cat.
- product_tags must be 2-6 items.
- discount_tier must be 10/15/20/25.

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

      const product_tags = Array.isArray(parsed.product_tags) ? parsed.product_tags : [];
      if (!product_tags.includes("species_dog") && !product_tags.includes("species_cat")) {
        const t = String(parsed.pet_type || "").toLowerCase();
        product_tags.push(t === "cat" ? "species_cat" : "species_dog");
      }

      const products = await fetchProductsByTags(product_tags);

      return res.json({
        mode: "finalize",
        assistant_message: parsed.final_message || parsed.short_summary || "",
        analysis: {
          pet_type: parsed.pet_type,
          pet_name: parsed.pet_name,
          problem_title: parsed.problem_title,
          urgency: parsed.urgency,
          risk_flag: parsed.risk_flag,
          short_summary: parsed.short_summary,
          daily_actions: parsed.daily_actions,
          weekly_plan: parsed.weekly_plan,
          product_tags,
          product_usage: parsed.product_usage,
          ask_articles_question: parsed.ask_articles_question,
          articles_available: !!parsed.articles_available
        },
        discount: {
          percent: tier,
          code: discount_code
        },
        products,
        blogs: []
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
