// Supabase Edge Function: classify-feedback
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-4-5-20251001";
const CATEGORIES = ["良かった点", "改善点", "トラブル", "その他"];

const SYSTEM_PROMPT = `あなたはイベント運営のフィードバック分類アシスタントです。
入力されたフィードバック文を、以下の4カテゴリのうち1つに分類してください。

- 良かった点: 好評・成功・満足・褒め言葉
- 改善点: 要望・提案・「こうしてほしい」「〜すべき」など前向きな改善提案
- トラブル: エラー・故障・クレーム・機材不良・進行事故など明確な問題発生
- その他: 上記のいずれにも当てはまらない中立的な報告・雑談・質問

皮肉・婉曲表現・方言・口語にも注意してください。
「悪くなかった」は良かった点、「〜は厳しい」は改善点、「〜が動かない」はトラブルです。

返答は必ず JSON 形式で、カテゴリ名のみを返してください:
{"category": "良かった点"} または {"category": "改善点"} または {"category": "トラブル"} または {"category": "その他"}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 有効な利用者（profiles.active）だけが呼べるようにする。anon key だけでは Claude API を使わせない。
async function isActiveUser(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth) return false;
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/is_active`, {
      method: "POST",
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: auth, "Content-Type": "application/json" },
      body: "{}",
    });
    return res.ok && (await res.json()) === true;
  } catch (_) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!(await isActiveUser(req))) {
    return new Response(JSON.stringify({ error: "ログインが必要です", category: "その他" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY not set", category: "その他" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { content } = await req.json();

    if (!content || typeof content !== "string") {
      return new Response(
        JSON.stringify({ error: "content is required", category: "その他" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 64,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `次のフィードバックを分類してください:\n\n"${content}"` },
        ],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("Anthropic API error:", errText);
      return new Response(
        JSON.stringify({ error: "API call failed", category: "その他" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiData = await apiRes.json();
    const text = apiData?.content?.[0]?.text ?? "";

    let category = "その他";
    try {
      const match = text.match(/\{[\s\S]*?\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (CATEGORIES.includes(parsed.category)) {
          category = parsed.category;
        }
      }
    } catch (_) {
      for (const c of CATEGORIES) {
        if (text.includes(c)) {
          category = c;
          break;
        }
      }
    }

    return new Response(
      JSON.stringify({ category }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: String(err), category: "その他" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
