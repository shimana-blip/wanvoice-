// Supabase Edge Function: reflect
// リフレクション会議用の論点抽出。
// 一致度を採点するのではなく、「片方にしか映っていないもの」を拾い上げることが目的。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `あなたはリスキリングキャンプのリフレクション会議を支えるアシスタントです。
この会議は A.I.KEN とフランチャイズ先の合同で、開催直後1週間以内に行われ、最長35分です。

あなたの仕事は「評価」ではなく「論点の抽出」です。
運営の声と受講者の声は、そもそも性質の違うデータです。
運営の声は「問題を記録する」性質、受講者の声は「体験を振り返る」性質。
だから両者の一致度を数値化しても意味がありません。

重要なのは、片方の立場からしか見えないものを見つけることです。
例えば「Wi-Fiが遅い」は運営席からは分かりません。回線を契約した側は「仕様通り」としか認識していない。
逆に機材の段取りや会場の制約は受講者には見えません。
この非対称こそが価値です。

分類は次の4つ。
- learner_only: 受講者だけが書いている。運営が気づいていない可能性が高い
- staff_only: 運営だけが書いている。受講者の体験にはまだ出ていない
- both: 両方が同じことを指している。優先度が高い
- good: うまくいっている点。維持すべきもの

守ること:
- 実際に書かれている内容だけから作る。推測で補わない
- 論点は数を絞らない。会議で飛ばすかどうかはファシリテーターが決めるので、拾えるものは拾う
- ただし重要な順に並べる。件数が多いもの、両方から出ているものを上に
- 見出しは会議で読み上げられる短い日本語（40文字以内）
- 根拠になった発言をそのまま引用する（要約しすぎない）

返答は必ず JSON のみ。前置きや説明文を含めないでください:
{
  "topics": [
    {
      "kind": "learner_only" | "staff_only" | "both" | "good",
      "title": "見出し（40文字以内）",
      "learner_count": 受講者側の件数,
      "staff_count": 運営側の件数,
      "quotes": ["根拠になった発言をそのまま"],
      "note": "会議で何を議論すべきかを1文で"
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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

    const { eventLabel, staffVoices, learnerVoices } = await req.json();

    if (!Array.isArray(staffVoices) || !Array.isArray(learnerVoices)) {
      return new Response(JSON.stringify({ error: "staffVoices and learnerVoices must be arrays" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (staffVoices.length === 0 && learnerVoices.length === 0) {
      return new Response(JSON.stringify({ error: "no voices" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userText = [
      `対象開催: ${eventLabel ?? ""}`,
      "",
      "【運営の声】（Wan!Voice に現場スタッフが記録）",
      staffVoices.length ? staffVoices.map((v: string, i: number) => `${i + 1}. ${v}`).join("\n") : "(なし)",
      "",
      "【受講者の声】（学びの振り返りの自由記述）",
      learnerVoices.length ? learnerVoices.map((v: string, i: number) => `${i + 1}. ${v}`).join("\n") : "(なし)",
    ].join("\n");

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
        messages: [{ role: "user", content: userText }],
      }),
    });

    if (!apiRes.ok) {
      console.error("Anthropic API error:", await apiRes.text());
      return new Response(JSON.stringify({ error: "API call failed" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiData = await apiRes.json();
    const text = apiData?.content?.[0]?.text ?? "";

    let parsed: { topics?: unknown[] } | null = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (_) { parsed = null; }

    if (!parsed || !Array.isArray(parsed.topics)) {
      return new Response(JSON.stringify({ error: "unparseable model output", raw: text }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const KINDS = ["learner_only", "staff_only", "both", "good"];
    const topics = (parsed.topics as Record<string, unknown>[])
      .filter((t) => KINDS.includes(String(t.kind)))
      .map((t) => ({
        kind: String(t.kind),
        title: String(t.title ?? "").slice(0, 80),
        learner_count: Number(t.learner_count) || 0,
        staff_count: Number(t.staff_count) || 0,
        quotes: Array.isArray(t.quotes) ? t.quotes.map((q) => String(q)).slice(0, 6) : [],
        note: String(t.note ?? ""),
      }));

    return new Response(JSON.stringify({ topics }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
