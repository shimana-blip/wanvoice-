// 管理者がスタッフ（または管理者）を招待する。
// 招待メールのリンクから Wan!Voice を開き、本人がパスワードを決める（Wan!Voice の「パスワードを設定」画面）。
//
// - 呼び出し元のログイン（JWT）を確認し、profiles で「有効な管理者」の場合だけ実行する
// - service_role キーはこの関数の中（Supabase のサーバー側）だけで使う。フロントエンドには絶対に置かない
// - 新しいユーザーの profiles はトリガー（handle_new_user）が staff で作る。管理者として招待したときだけ role を上げる
import { createClient } from 'npm:@supabase/supabase-js@2'

const APP_URL = Deno.env.get('APP_URL') ?? 'https://shimana-blip.github.io/wanvoice-/'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST だけ受け付けます' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false }
  })

  // 呼び出し元の確認
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt)
  if (callerErr || !caller?.user) return json({ error: 'ログインが必要です' }, 401)

  const { data: me } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', caller.user.id)
    .maybeSingle()
  if (!me || !me.active || me.role !== 'admin') return json({ error: '管理者だけが招待できます' }, 403)

  // 入力の確認
  let body: { email?: string; display_name?: string; role?: string }
  try { body = await req.json() } catch { return json({ error: '入力を読めませんでした' }, 400) }
  const email = (body.email ?? '').trim().toLowerCase()
  const displayName = (body.display_name ?? '').trim()
  const role = body.role === 'admin' ? 'admin' : 'staff'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'メールアドレスの形が正しくありません' }, 400)
  if (!displayName) return json({ error: '表示名を入れてください' }, 400)

  // 招待メールを送る（ユーザーが作られ、トリガーで profiles ができる）
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { display_name: displayName },
    redirectTo: APP_URL
  })
  if (inviteErr || !invited?.user) {
    const msg = inviteErr?.message ?? '招待できませんでした'
    const already = /already|registered|exists/i.test(msg)
    return json({ error: already ? 'このメールアドレスは既に登録されています' : msg }, already ? 409 : 400)
  }

  // 表示名と役割を確定する（トリガーは staff・メールの前半で作るため）
  const { error: profErr } = await admin
    .from('profiles')
    .update({ display_name: displayName, role })
    .eq('id', invited.user.id)
  if (profErr) return json({ error: '招待は送りましたが、表示名／役割の設定に失敗しました：' + profErr.message }, 500)

  return json({ ok: true, user_id: invited.user.id, email, display_name: displayName, role })
})
