-- event_id が NULL のフィードバックを events に結びつける
-- 対象DB: ihpngacdpoynygfyxgup（東京）のみ。
-- 適用前バックアップ: 対象 49件の id と元の値、ロールバック SQL を保存済み（2026-10-11 01:38 JST）
--
-- event_id が NULL の 68件（2026-10-11 時点）の内訳
--   Event-10.9-23リスキャン映像制作コース青山  P : 48  → 新しい event 261009_東京_映像_NA に結びつける（B）
--   ブートキャンプ_260218_トライ               : 18  → session_alias で「分析対象外」(excluded) のため対象外
--   メンバースキルアップ                        :  1  → 同上（社内研修）
--   260828_佐賀_BA                              :  1  → alias は既にあるが、alias 作成前に入ったため未反映（A）
--   ※ trg_resolve_feedback_event は INSERT 時しか動かないので、後から alias を足しても既存行は埋まらない

begin;

-- B. 10/9 映像制作コース（青山）を event として登録し、表記ゆれ対応表に追加する
--    （sessions_date_key のせいで同日に登録できなかった回）
insert into public.events (event_id, date, area, kind, ai, venue, display_name)
values ('261009_東京_映像_NA', '2026-10-09', '東京', '映像', 'NA', '青山', '東京 映像（青山）')
on conflict (event_id) do nothing;

insert into public.session_alias (raw_session, event_id, confidence, note)
values ('Event-10.9-23リスキャン映像制作コース青山  P', '261009_東京_映像_NA', 'manual', '2026-10 整理: 同日複数会場の登録ができなかった回')
on conflict (raw_session) do update set event_id = excluded.event_id, confidence = excluded.confidence, note = excluded.note;

-- A + B. alias があるのに event_id が空のままの行を埋める（想定 49件）
update public.feedbacks f
set event_id = a.event_id
from public.session_alias a
where f.event_id is null
  and a.raw_session = f.session
  and a.event_id is not null;

commit;
