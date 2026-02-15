import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ---- LOG
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ---- OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Shopify: client credentials token cache
let shopifyTokenCache = { token: null, expiresAt: 0 };

async function getShopifyAccessToken() {
  const store = process.env.SHOPIFY_STORE; // must be like: tuxi7x-y5.myshopify.com
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

// ---- Discount tiers (pre-created in Shopify)
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

// ---- Helpers
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

async function fetchProductsByTags(tags) {
  const store = process.env.SHOPIFY_STORE;
  if (!store) throw new Error("Missing SHOPIFY_STORE env var");

  const token = await getShopifyAccessToken();

  const url = `https://${store}/admin/api/2025-01/products.json?limit=250&fields=id,title,handle,tags,images,variants,status,published_at`;
  const resp = await axios.get(url, { headers: { "X-Shopify-Access-Token": token } });

  const products = (resp.data.products || [])
    .filter((p) => p.status === "active" && p.published_at)
    .filter((p) => {
      const ptags = (p.tags || "").split(",").map((x) => x.trim());
      return tags.every((t) => ptags.includes(t));
    })
    .slice(0, 12)
    .map((p) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      tags: p.tags,
      image: p.images?.[0]?.src || null,
      variant_id: p.variants?.[0]?.id || null,
      price: p.variants?.[0]?.price || null,
      url: p.handle ? `/products/${p.handle}` : null
    }));

  return products;
}

// ---- Prompts
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
- If user mentions severe symptoms (breathing trouble, collapse, seizures, heavy bleeding, inability to urinate, suspected poisoning), tell them to contact an emergency vet immediately, then ask a minimal safety question.

Tone:
- Warm, friend-like, supportive, concise.
`;

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
  "discount_message": string,

  "articles_available": true
}

Constraints:
- product_tags must include species_dog or species_cat.
- product_tags must be 2-6 items.
- product_usage must reference tags that exist in product_tags (where applicable).
- discount_tier must be 10/15/20/25.
- discount_message must present the discount as a personal initiative based on the situation (do NOT say random).
- Do not mention external competitor products or brands.

Allowed NEED tags (use these only when needed):
need_anxiety, need_separation, need_chewing, need_scratching, need_sleep, need_enrichment, need_boredom, need_high_energy, need_noise, need_feeding

Allowed TYPE tags (use these only when needed):
type_heartbeat, type_chew, type_puzzle, type_calming_wrap, type_scratch_post, type_feeder, type_noise_mask

Species tags (must include one):
species_dog, species_cat
`;

// ---- Health
app.get("/health", (req, res) => res.send("OK"));

// ---- Debug endpoint kept (optional)
app.get("/products-by-tags", async (req, res) => {
  try {
    const tags = (req.query.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (tags.length === 0) return res.json({ products: [] });

    const products = await fetchProductsByTags(tags);
    res.json({ products });
  } catch (err) {
    console.error("SHOPIFY ERROR:", err?.response?.status, err?.message, err?.response?.data);
    res.status(500).json({ error: "Shopify error", detail: err?.message || String(err) });
  }
});

// ---- Main: Chat endpoint (two-mode)
// Request body example:
// {
//   "mode": "chat" | "finalize",
//   "messages": [{ "role":"user"|"assistant", "content":"..." }, ...],
//   "pet": { "pet_type":"dog"|"cat"|null, "pet_name":"Jasmy"|null } // optional
// }
app.post("/chat", async (req, res) => {
  try {
    const mode = (req.body?.mode || "chat").toLowerCase();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const petTypeHint = req.body?.pet?.pet_type || "";
    const petNameHint = req.body?.pet?.pet_name || "";

    if (messages.length === 0) {
      return res.status(400).json({ error: "Bad request", detail: "messages[] is required" });
    }

    if (mode === "chat") {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: CHAT_MODE_SYSTEM.trim() },
          // Optional hint (so it uses name if we already know)
          petNameHint || petTypeHint
            ? {
                role: "system",
                content: `Known context: pet_type_hint=${petTypeHint || "unknown"}, pet_name_hint=${petNameHint || "unknown"}. Use pet_name if available.`
              }
            : null,
          ...messages
        ].filter(Boolean)
      });

      const assistant_message = completion.choices?.[0]?.message?.content?.trim() || "";
      return res.json({ mode: "chat", assistant_message });
    }

    if (mode === "finalize") {
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: FINALIZE_SYSTEM.trim() },
          petNameHint || petTypeHint
            ? {
                role: "system",
                content: `Known context: pet_type_hint=${petTypeHint || "unknown"}, pet_name_hint=${petNameHint || "unknown"}.`
              }
            : null,
          ...messages
        ].filter(Boolean)
      });

      const raw = completion.choices?.[0]?.message?.content?.trim() || "";
      const parsed = safeJsonParse(raw);

      if (!parsed) {
        return res.status(500).json({
          error: "AI error",
          detail: "Finalize returned invalid JSON",
          raw
        });
      }

      // Enforce discount code mapping
      const tier = normalizeDiscountTier(parsed.discount_tier);
      const discount_code = DISCOUNT_CODES[tier];

      // Enforce product tags sanity
      const product_tags = Array.isArray(parsed.product_tags) ? parsed.product_tags : [];
      const hasDog = product_tags.includes("species_dog");
      const hasCat = product_tags.includes("species_cat");
      if (!hasDog && !hasCat) {
        // fallback using pet_type
        const t = (parsed.pet_type || "").toLowerCase();
        if (t === "cat") product_tags.push("species_cat");
        else product_tags.push("species_dog");
      }

      // Fetch products ONLY now (finalize)
      const products = await fetchProductsByTags(product_tags);

      return res.json({
        mode: "finalize",
        assistant_message: parsed.discount_message || parsed.short_summary || "",
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
          articles_available: !!parsed.articles_available
        },
        discount: {
          percent: tier,
          code: discount_code,
          message: parsed.discount_message
        },
        products,
        // blogs intentionally NOT auto-served here; frontend later can ask and call /blogs endpoint in future step
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
