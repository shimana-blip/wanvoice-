# Wan!Voice — Claude Code 引き継ぎメモ

リポジトリ: `shimana-blip/wanvoice-`（末尾のハイフンまでがリポジトリ名）
公開先: https://shimana-blip.github.io/wanvoice-/ （GitHub Pages。GitHub Actions で公開）
用途: A.I.KENリスキリングキャンプの現場フィードバック収集（ONE VOICE）。同じDBを Wan!Sync（`shimana-blip/wansync`, Vercel: https://sync-7bn3rvtk.vercel.app/）も使っている。

---

## 絶対ルール

1. **本番DBは東京の `ihpngacdpoynygfyxgup`（名前: wan!voice）だけ。** ムンバイの2プロジェクトは本番ではない（INACTIVE）。作業前に必ずプロジェクトIDを確認する。
2. **本番DBへの変更（DDL・RLS・データ更新・Edge Function）は、SQL／コードを提示して嶋名の承認を得てから実行する。**
3. DB変更はすべて `supabase/migrations/` に、Edge Function は `supabase/functions/` に残す。ダッシュボードで直接いじらない。
4. 作業はブランチで行い、タスクごとに別PR。本番反映（mainへのマージ・本番DBへの適用）は承認後。
5. 本番DBに手を入れる前に、対象行のバックアップ（元の値とロールバックSQL）を取る。
6. **RLSを変えると Wan!Sync にも影響が出る。** 変更後は Wan!Sync の動作も確認する。
7. `service_role` キーは絶対にフロントエンドに置かない（Edge Function の中だけ）。
8. コミットの作者メールは `shimana@a-i-ken.com`（GitHub アカウントのメール）。違うと Vercel のデプロイが "blocked" になる。

---

## 構成（2026-10-11 時点）

### 公開・接続先
- `index.html` 1ファイルの素のHTML。ビルド工程なし。
- `.github/workflows/pages.yml`：main への push で、リポジトリ Secrets（`SUPABASE_URL` / `SUPABASE_ANON_KEY`）から `config.js` を作り、`index.html` と一緒に Pages に公開する。
  - `config.js` があれば URL / Anon Key 欄を隠し、メール＋パスワードだけでログイン。無い環境（ローカル等）は従来どおり手入力。
  - anon key はブラウザに渡る公開キー。実際の守りは RLS。
- 当初案の Vercel 移行は、Vercel にログインできなかったため見送り（GitHub Pages のまま）。

### 回（開催）の管理
- 回は **`events` に一本化**（`event_id = YYMMDD_場所_種別_AI`、会場は `venue`）。`sessions` には書き込まない（テーブルは残置）。
- 同じ日に複数の回を登録でき、フィードバック入力ではその日の回が2件以上なら会場ボタンで選ぶ。選んだ回は `event_id` も保存。
- 手入力の回名は `trg_resolve_feedback_event`（INSERT 時のみ）が `session_alias` と命名規約で `event_id` を解決する。後から alias を足しても既存行は埋まらないので、必要なら UPDATE する。
- `event_id` が NULL のフィードバックは 19件（`session_alias` で excluded の分のみ）。

### 認証・権限（Step 3）
- 個人アカウント制（招待制＋メール／パスワード）。`profiles`（id, display_name, role = admin|staff, active）。新規ユーザーはトリガー `handle_new_user` で staff として作られる。
- `is_active()` / `is_admin()`（SECURITY DEFINER）を RLS で使う。
  | テーブル | 閲覧 | 追加 | 修正 | 削除 |
  |---|---|---|---|---|
  | feedbacks / actions | 有効なユーザー | 有効なユーザー（自分名義） | 管理者 or 自分の行（`created_by`） | 管理者 |
  | events / session_alias / sessions / contents / content_alias / survey_* / analyses / app_settings | 有効なユーザー | 管理者 | 管理者 | 管理者 |
  | profiles | 有効なユーザー | トリガーのみ | 管理者 | auth.users 削除に連動 |
- 最後の有効な管理者を下げる／止める変更はトリガー `keep_one_admin` で拒否。
- 共有アカウント `shimana@net-fun.co.jp` は管理者（表示名「嶋名」）。スタッフの個人アカウントに移行したら、共有アカウントのパスワードを変える。
- 招待: Wan!Voice「回の管理 → メンバー」→ Edge Function `invite-user`（管理者だけ実行可、service_role は関数内のみ）。招待メールのリンクで Wan!Voice の「パスワードを設定」画面が開く。
  - Supabase Auth の Site URL / Redirect URLs に `https://shimana-blip.github.io/wanvoice-/` が必要。
- 画面の出し分け（スタッフには管理メニュー・削除・インポートを出さない、スタッフ名は表示名に固定）は Wan!Voice / Wan!Sync とも実装済み。profiles が無い DB では管理者扱いにフォールバックする。

### Edge Function
- `invite-user`：管理者による招待。
- `classify-feedback`：有効なユーザーだけ呼べるように修正済み（`rpc/is_active` で確認）。
- `sync-analyze` / `hot-sync` / `sync-chat` / `reflect`（Wan!Sync 用）：**未修正**。ログイン無し（anon key だけ）でも呼べて Claude API の料金が発生しうる。classify-feedback と同じガードを入れる予定。

---

## 残タスク
- 招待の実地テスト（テスト用メールアドレスで、招待 → パスワード設定 → スタッフでログイン）
- Wan!Sync 用 Edge Function 4本にログインガードを追加
- スタッフを個人アカウントへ移行し、共有アカウントのパスワードを変更
- `sessions` テーブルの廃止（どちらのアプリも参照していない）

---

## デザイン
- アプリUIはライトテーマ「Calm Optimism」: 背景 `#f4f6fa`、テキスト `#0F1F3D`、ブランド `#1A4FA0` / `#14B8A6` / `#6366F1`、フォントはNoto Sans JP。
- ダークネイビー（`#0A0E1A` / `#4FD1C5`）はPDFレポート用。アプリUIには使わない。
