// Supabase Edge Function: hot-sync
// 文字の重なりではなく意味で声を束ねる。
// 「操作説明が長い」と「説明に時間がかかりすぎ」を同じ課題として拾うのが目的。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `あなたはイベント運営の振り返りを整理するアシスタントです。
複数のスタッフが書いた声を読み、「同じことを言っている声」をグループにまとめます。

重要な判断基準:
- 表現が違っても、指している問題が同じなら同じグループにしてください。
  例:「操作説明が長い」と「説明に時間がかかりすぎた」は同じ。
- 逆に、語句が似ていても問題が違うなら別グループにしてください。
  例:「Wi-Fiが遅い」と「Wi-Fiのパスワードが分からない」は別。
- 1件しかない声を無理にグループ化しないでください。2件以上集まったものだけ返します。
- すべての声をどこかに入れようとしないでください。孤立した声は除外して構いません。

各グループには、何が問題なのかが一読で分かる短い見出し（30文字以内）を付けてください。
見出しは実際に書かれている内容だけから作り、推測で補わないでください。

返答は必ず JSON のみ。前置きや説明文を含めないでください:
{
  "clusters": [
    {
      "theme": "見出し（30文字以内）",
      "ids": [声のidの配列],
      "note": "なぜこれらを同じと判断したかを1文で"
    }
  ]
}`;

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

type Voice = { id: number; text: string; category?: string | null };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!(await isActiveUser(req))) {
    return new Response(JSON.stringify({ error: "ログインが必要です" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { voices } = (await req.json()) as { voices: Voice[] };

    if (!Array.isArray(voices) || voices.length < 2) {
      return new Response(JSON.stringify({ error: "need at least 2 voices" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const listed = voices
      .map((v) => `id=${v.id}${v.category ? ` [${v.category}]` : ""}: ${v.text}`)
      .join("\n");

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `次の声を意味で束ねてください:\n\n${listed}` }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("Anthropic API error:", errText);
      return new Response(JSON.stringify({ error: "API call failed" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiData = await apiRes.json();
    const text = apiData?.content?.[0]?.text ?? "";

    let parsed: { clusters?: { theme: string; ids: number[]; note?: string }[] } | null = null;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    } catch (_) {
      parsed = null;
    }

    if (!parsed || !Array.isArray(parsed.clusters)) {
      return new Response(JSON.stringify({ error: "unparseable model output", raw: text }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const known = new Set(voices.map((v) => v.id));
    const clusters = parsed.clusters
      .map((c) => ({
        theme: String(c.theme ?? "").slice(0, 60),
        note: String(c.note ?? ""),
        ids: (Array.isArray(c.ids) ? c.ids : []).filter((id) => known.has(id)),
      }))
      .filter((c) => c.ids.length >= 2);

    return new Response(JSON.stringify({ clusters }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
