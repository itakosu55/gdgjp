# stream.gdgs.jp — 配信・音響機材構成ツール 設計 (MVP)

**作成日:** 2026-08-05
**ステータス:** 設計中 (未実装)

## 1. 位置づけ

イベント配信支援の 3 機能構想のうち、2 つ目にあたる。

1. GDG CLI の機能追加 — OBS Studio と拡張機能をコマンド一発で設定
2. **stream.gdgs.jp — 機材構成の登録・表現・検査** ← 本書
3. OBS Studio 拡張 — 構成をインポートし、映像・音声フローを視覚的に確認・変更

MVP では AI による提案機能は実装しない。**配信機材の構成をどう表現するか**と、
**構成上の問題を検出する Linter** の 2 点に集中する。AI 提案は次フェーズとし、
本書のデータモデルと Linter がその土台（生成物の検証器）になるよう設計する。

新規 pnpm ワークスペース `stream/` として作成し、`stream.gdgs.jp` で公開する。
既存 RP と同じ React Router v7 + Cloudflare Workers + D1 構成、認証は `gdg-lib` の
`initializeRpAuth` による Accounts OIDC RP。

## 2. 設計上の中核アイデア

### 2.1. 空間 (Space) をグラフのノードとして扱う

本ツールで最も重要な決定。

ハウリングは「マイク → ミキサー → スピーカー → **空気** → 同じマイク」という閉路である。
配線だけをグラフ化しても検出できない。そこで**空気（音響空間）をノードとしてグラフに入れる**。

同じ構造は映像にも存在する。無限鏡は「OBS 出力 → プロジェクタ → スクリーン → **視界** →
カメラ → OBS」であり、音のハウリングと構造が完全に一致する。

したがって `Space` ノードを 2 種類持つ。

| kind | 出力する側 | 入力する側 |
| --- | --- | --- |
| `acoustic` | スピーカー | マイク |
| `visual` | ディスプレイ・プロジェクタ | カメラ |

この暗黙エッジをグラフ構築時に自動生成することで、

- ハウリング
- リモート登壇者へのエコー返り (Mix-Minus 違反)
- 配信経由の遅延ハウリング
- 無限鏡

の 4 つが、**すべて単一の閉路検出アルゴリズムで検出できる**。

空間は複数持てる（メインホール / 別室サテライト / 配信オペ席）。異なる空間のスピーカーと
マイクは結合しない。ヘッドセット・イヤモニ・カナル型は `coupling: "isolated"` として
暗黙エッジを張らない。

```mermaid
graph LR
  MIC[マイク] -->|XLR| MIXER[ミキサー]
  MIXER -->|MAIN| SPK[スピーカー]
  SPK -.->|音響結合| SPACE(("acoustic space<br/>メインホール"))
  SPACE -.->|音響結合| MIC
  MIXER -->|USB| PC[配信PC]
```

### 2.2. ミキサー内部は boolean ルーティング行列に妥協する

ミキサーの配線を本格的に表現すると、当日のセットアップと不具合修復が破綻する。
そこで**内部状態は「入力ch × バス」の boolean 行列のみ**とし、ゲイン・EQ・コンプ・
フェーダー値・パンは一切持たない。

閉路検出に必要な情報は「その信号がそのバスに乗るか否か」だけであり、dB 値は不要である。
これが表現力と記入コストの均衡点になる。

バスは `main` / `aux1..n` / `usb` / `monitor` / `sub` の種別を持つ。出力ポートは
いずれかのバスに属し、`入力ch → バス → そのバスの出力ポート` という内部エッジになる。

機材によって内部の振る舞いが違うため、型番は `internal_routing` を持つ。

| 値 | 意味 | 該当機材 |
| --- | --- | --- |
| `matrix` | 上記の boolean 行列に従う | ミキサー、オーディオ I/F、スイッチャー、OBS |
| `passthrough` | 全入力が同じ媒体の全出力へ流れる | DI、ワイヤレス受信機、会場常設 PA |
| `none` | 入力と出力は無関係 | マイク・スピーカー等の端点、および会議アプリ |

会議アプリを `none` にするのは必須である。Meet や Zoom はローカルのマイク入力をローカルの
スピーカー出力へ回さない。ここを `passthrough` にすると、存在しないエコー閉路を検出器自身が
作り出してしまう。

### 2.3. PC は内部パッチベイとして扱う

Mix-Minus 違反の大半は、機材の配線ではなく **PC 上のアプリケーションの入出力デバイス選択**で
発生する。「Meet の出力先がスピーカーになっている」「OBS のモニタリング出力が有効なまま」など。

そこで PC を単一のブラックボックスにせず、**PC 上に載るソフトウェアデバイスをノードとして
表現し、PC の物理ポートとの間に内部エッジを張る**。

- `n_pc` — 物理ポート (USB, ヘッドホン出力, HDMI) を持つ
- `n_meet` — `hostNodeId: "n_pc"`。論理ポート `audio_in` / `audio_out` を持つ
- `n_obs` — `hostNodeId: "n_pc"`。`audio_in` / `video_in` / `monitor_out` / `stream_out` を持つ

内部エッジ `n_meet.audio_out → n_pc.usb_in` が「Meet の出力先が USB オーディオ I/F」を意味する。
これにより、リモートエコーの原因が「電気的経路」なのか「音響的回り込み」なのかまで切り分けられ、
提示すべき修正手順が変わる（前者はルーティング行列、後者はヘッドセット化）。

ここで結線の向きに 1 つ例外が要る。PC の物理出力端子は、外から見れば出力だが、PC の内側から
見ればアプリが音を流し込む先である。したがってソフトウェアノードとそのホスト PC の間だけは、
`出力 → 出力`（アプリがヘッドホン端子へ再生する）と `入力 → 入力`（アプリが USB 入力から
取り込む）を許可し、グラフ構築側で正しい向きに解釈する。通常の結線は常に `出力 → 入力`。

また、ポートは必ず `in` か `out` のいずれかとし、双方向ポートは作らない。USB オーディオは
送りと戻りで 2 つのポート・2 本のリンクとして表現する。1 本の USB ケーブルを 2 リンクで書く
のは冗長に見えるが、Mix-Minus はまさにその 2 方向の非対称性の問題なので、ここは分けたほうが
正しく検出できる。UI 側で「USB オーディオ接続」として 2 本まとめて張るショートカットを出す。

## 3. データモデル

機材は 3 層に分ける。**機材台帳はチャプターに紐づけず、gdgs.jp にログインできるユーザー間で
共有する単一プール**とする（機材が複数チャプターで共有されるため）。イベントごとに
「利用可能な機材」を台帳から選択し、構成はその部分集合の範囲内で組む。

```mermaid
graph TD
  M["① device_models 型番カタログ<br/>YAMAHA MG10XU"] --> D["② devices 機材台帳（全体共有）<br/>MG10XU #1（青シール）"]
  D --> ED["event_devices<br/>このイベントで使える機材"]
  E["events 配信回"] --> ED
  ED --> S["③ setups 構成<br/>8/5 本番の結線"]
```

### 3.1. 型番カタログ

D1 にユーザーが登録する。よく使う型番は migration のシードデータとして投入し、
初期状態でも空にならないようにする。将来の AI 提案では、AI に**カタログ ID からのみ
選択させる**制約を掛け、存在しない機材の捏造を防ぐ。

```sql
CREATE TABLE device_models (
  id          TEXT NOT NULL PRIMARY KEY,
  maker       TEXT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,   -- 3.2 参照
  -- matrix | passthrough | none。2.2 参照
  internal_routing TEXT NOT NULL DEFAULT 'none',
  notes       TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE device_model_buses (
  id        TEXT NOT NULL PRIMARY KEY,
  model_id  TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,     -- "main" | "aux1" | "usb" | "monitor" | "sub1"
  label     TEXT NOT NULL,
  kind      TEXT NOT NULL,     -- main | aux | usb | monitor | sub
  UNIQUE (model_id, key)
);

CREATE TABLE device_model_ports (
  id          TEXT NOT NULL PRIMARY KEY,
  model_id    TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,   -- "ch1" | "main_out_l" | "usb" | "audio_in"
  label       TEXT NOT NULL,
  direction   TEXT NOT NULL,   -- in | out
  -- av は HDMI/SDI のように 1 本で音声と映像の両方を運ぶもの
  signal      TEXT NOT NULL,   -- audio_analog | audio_digital | video | av
  connector   TEXT,            -- xlr | trs | ts | trs_mini | rca | hdmi | sdi | usb_c | usb_b | speakon | none
  level       TEXT,            -- mic | line | instrument | speaker  (映像・論理ポートは NULL)
  channels    INTEGER NOT NULL DEFAULT 1,
  phantom     TEXT NOT NULL DEFAULT 'none',  -- provides | requires | none | damaged_by
  bus_id      TEXT REFERENCES device_model_buses(id) ON DELETE SET NULL,  -- 出力ポートのみ
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (model_id, key)
);

-- 型番レベルの既定ルーティング（構成側で上書きされる初期値）
CREATE TABLE device_model_default_routes (
  model_id    TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  in_port_id  TEXT NOT NULL REFERENCES device_model_ports(id) ON DELETE CASCADE,
  bus_id      TEXT NOT NULL REFERENCES device_model_buses(id) ON DELETE CASCADE,
  PRIMARY KEY (model_id, in_port_id, bus_id)
);
```

実際にどの ch を AUX へ送るかはイベントごとに変わるため、**ルーティング行列の実値は構成
(setup) 側が持つ**。型番側はテンプレートに徹する。

### 3.2. カテゴリと空間結合

`category` は Linter の暗黙エッジ生成規則を決める。

| category | 空間結合 | 備考 |
| --- | --- | --- |
| `mic` | acoustic → out ポート | `isolated` でピンマイク・ヘッドセットを表現 |
| `speaker` | in ポート → acoustic | 配信専用モニターは `isolated` |
| `headphone` | なし | 既定で isolated |
| `camera` | visual → out ポート | |
| `display` | in ポート → visual | プロジェクタ含む |
| `mixer` / `audio_interface` / `di` / `wireless_rx` / `switcher` / `capture` / `recorder` | なし | バスとルーティング行列を持つ |
| `computer` | なし | ソフトウェアデバイスのホスト |
| `software_broadcast` | なし | OBS 等。`hostNodeId` 必須 |
| `software_conferencing` | なし | Meet / Zoom 等。`hostNodeId` 必須 |
| `blackbox` | なし | 会場常設 PA。内部は「全入力 → 全出力」と保守的に仮定 |
| `generic` | なし | 該当なし |

会場備え付けの常設 PA は `category = 'blackbox'` の型番として登録し、入出力端子だけ
定義する。内部が不明なため Linter は安全側（結合していると仮定）に倒して警告を出す。
当日に実機を確認できたら通常の型番として作り直せる。

### 3.3. 機材台帳（全体共有プール）

```sql
CREATE TABLE devices (
  id           TEXT NOT NULL PRIMARY KEY,
  model_id     TEXT NOT NULL REFERENCES device_models(id),
  name         TEXT NOT NULL,   -- "MG10XU #1"
  identifier   TEXT,            -- 現物識別の目印（青シール、資産番号など）
  owner_note   TEXT,            -- "東京チャプター備品" / "田中さん私物"（メモ。権限とは無関係）
  created_by   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at   INTEGER
);
```

`owner_note` は自由記述のメモであり、アクセス制御には使わない。ログインユーザーは全機材を
閲覧・追加でき、編集・削除は作成者と管理者に限る。

### 3.4. イベントと構成

```sql
CREATE TABLE events (
  id            TEXT NOT NULL PRIMARY KEY,
  title         TEXT NOT NULL,
  starts_at     INTEGER,
  venue         TEXT,
  external_url  TEXT,          -- connpass 等への任意リンク
  created_by    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);

-- このイベントで利用可能な機材（台帳からの選択）
CREATE TABLE event_devices (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  note       TEXT,             -- "田中さんが持参"
  PRIMARY KEY (event_id, device_id)
);

CREATE TABLE setups (
  id          TEXT NOT NULL PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,   -- "本番構成" / "リハ構成"（MVP では時間的に排他な代替案）
  doc         TEXT NOT NULL,   -- 構成ドキュメント JSON（3.5）
  created_by  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE setup_revisions (
  id          TEXT NOT NULL PRIMARY KEY,
  setup_id    TEXT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  doc         TEXT NOT NULL,
  author_id   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 3.5. 構成ドキュメント (JSON)

構成本体は正規化せず、**単一の JSON ドキュメント**として持つ。ノード数は高々数十であり、
Linter・AI 提案・OBS 拡張へのエクスポートのすべてがこの 1 ドキュメントを入出力とするため、
この形が最も素直である。読み込み時に zod でバリデートする。

**座標を持たない。** 図は毎回自動レイアウト（dagre / ELK）で描画する。これにより、
将来 AI が生成した JSON がそのまま図になり、レイアウト情報の生成・整合という厄介な問題を
回避できる。

```jsonc
{
  "schemaVersion": 1,
  "spaces": [
    { "id": "sp_hall",   "kind": "acoustic", "label": "メインホール", "venueKey": "hall-a" },
    { "id": "sp_screen", "kind": "visual",   "label": "正面スクリーン" }
  ],
  "nodes": [
    {
      "id": "n_mic1",
      "deviceId": "dev_...",       // event_devices に含まれている必要がある
      "label": "登壇者ハンドマイク",
      "spaceId": "sp_hall",
      "coupling": "open"            // open | isolated
    },
    { "id": "n_mixer", "deviceId": "dev_mg10xu_1" },
    { "id": "n_pc",    "deviceId": "dev_pc_1", "label": "配信PC" },
    { "id": "n_obs",   "deviceId": "dev_obs",  "hostNodeId": "n_pc" },
    { "id": "n_meet",  "deviceId": "dev_meet", "hostNodeId": "n_pc" }
  ],
  "links": [
    { "id": "l1", "from": ["n_mic1", "out"],       "to": ["n_mixer", "ch1"] },
    { "id": "l2", "from": ["n_mixer", "usb_send"], "to": ["n_pc", "usb_in"] },
    // ホストの物理入力からソフトウェアへ (in → in の例外)
    { "id": "l3", "from": ["n_pc", "usb_in"],      "to": ["n_meet", "mic_in"] },
    // ソフトウェアからホストの物理出力へ (out → out の例外)
    { "id": "l4", "from": ["n_meet", "spk_out"],   "to": ["n_pc", "usb_out"] }
  ],
  "routing": [
    // ミキサー等の内部ルーティング行列。ここが「妥協」の中心。
    { "nodeId": "n_mixer", "inPort": "ch1",    "bus": "main" },
    { "nodeId": "n_mixer", "inPort": "ch1",    "bus": "aux1" },
    { "nodeId": "n_mixer", "inPort": "ch1",    "bus": "usb"  }
    // usb_in → usb を含めないことが Mix-Minus。含めると remote-echo-electrical が出る。
  ],
  "notes": "..."
}
```

`routing` は**存在する組み合わせのみを列挙**する（boolean 行列の疎表現）。UI 上は
チェックボックスの表として編集する。

`spaces[].venueKey` は物理空間の識別子で、MVP では使わない。複数トラック同時開催
（8 章）で構成ドキュメントが分割されたとき、**別ドキュメントに現れる同じ物理空間を同一と
みなす**ために必要になる。ドキュメントの自己完結性を保ったままトラック横断の音響結合を
表現できる唯一の手段であり、後付けが難しいため最初からスキーマに含めておく。

## 4. Linter

### 4.1. グラフ構築

診断の前に、以下 4 種類のエッジから有向グラフを組む。

1. **明示リンク** — `links`（ケーブル結線）
2. **デバイス内部エッジ** — `routing` から `入力ポート → バス → そのバスの出力ポート`
3. **ホスト内部エッジ** — ソフトウェアデバイスの論理ポートと、ホスト PC の物理ポートの対応
4. **空間の暗黙エッジ** — `speaker → acoustic space → mic`、`display → visual space → camera`
   （`coupling: "isolated"` のノードは除外。`blackbox` は全入力 → 全出力を仮定）

エッジは種別を保持し、閉路を報告する際に「どこが音響結合でどこが配線か」を提示できるようにする。

### 4.2. ルール

優先度は実際に GDG イベントで遭遇したトラブル（ハウリング / リモート登壇者へのエコー返り /
配信に音声が乗っていない）に合わせ、**MVP は音声系に集中**する。映像はモデルとしては
表現するが、検査は未接続チェックに留める。

#### critical

| ruleId | 内容 |
| --- | --- |
| `acoustic-feedback-loop` | acoustic space を含む閉路。ハウリング。閉路の経路と、切断候補（AUX からの除外、isolated 化）を提示 |
| `remote-echo-electrical` | 会議ソフトの `audio_out` が電気的経路のみを通って自身の `audio_in` に戻る。Mix-Minus 違反。切るべき routing の組み合わせを名指しする |
| `remote-echo-acoustic` | 会議ソフトの出力がスピーカー経由でマイクに回り込み `audio_in` に戻る。修正はヘッドセット化またはスピーカーの isolated 化 |
| `no-audio-to-stream` | 配信ソフトの `audio_in` に、どのマイクからも到達できない。無音アーカイブの最悪ケース |
| `stream-monitor-loop` | 上記のハウリング閉路が配信ソフトを経由している場合の分類。修正手順が異なる（モニタリングをオフ／ヘッドホンへ）ため別 ruleId にするが、`acoustic-feedback-loop` と重複しては報告しない |

#### error

| ruleId | 内容 |
| --- | --- |
| `level-mismatch` | line 出力 → mic 入力（PAD 必要）、speaker 出力 → line 入力（機材破損の危険） |
| `signal-mismatch` | audio ポートに video を接続するなど、信号種別が成立しない結線 |
| `link-direction` | 出力 → 入力になっていない結線（ホストとソフトウェアの間の例外を除く） |
| `phantom-missing` | `phantom: requires` の機材が、供給できない入力端子に接続されている |
| `phantom-hazard` | ファンタム供給可能なポートに `phantom: damaged_by` の機材（リボンマイク等）が接続されている |
| `device-not-in-event` | 構成が参照する機材が、そのイベントの利用可能機材に含まれていない |
| `unknown-reference` | 存在しない機材・型番・端子・空間・バスを参照している |
| `space-kind-mismatch` | 音響機材を視覚空間に割り当てている、またはその逆 |

#### warn

| ruleId | 内容 |
| --- | --- |
| `visual-feedback-loop` | 映像の閉ループ（無限鏡）。配信画面を会場スクリーンに出しカメラが写し込んでいる |
| `space-unassigned` | マイクやスピーカーがどの空間にも割り当てられておらず、ハウリング判定ができない |
| `connector-mismatch` | XLR → RCA など、変換ケーブルが必要な結線。当日の持ち物として通知 |
| `blackbox-assumption` | ブラックボックス機材を内部全通と仮定して検査していることの明示。会場での確認を促す |
| `no-backup-recording` | 配信構成にバックアップ収録機がない |

#### info

| ruleId | 内容 |
| --- | --- |
| `dangling-port` | 端点機材（マイク・スピーカー・カメラ・ディスプレイ・レコーダー）の未結線端子。ミキサーの空きチャンネルは対象外 |
| `unreachable-device` | 構成に置かれているが、どの信号経路にも参加していない機材 |
| `video-not-reaching-stream` | 映像が配信ソフトに到達していない（映像系の唯一の MVP ルール） |

#### 実装上の割り切り

- **ファンタム電源は 1 ホップのみ**判定する。マイクが直接挿さっている入力端子が供給できるかだけを見る。
  途中に挟まったパッシブ機材が +48V を通すかどうかは知りようがないため、推測しない。
- **1 つの空間・1 つの会議アプリにつき閉路は 1 件だけ**報告する。実際の閉路は大量に重複するため、
  全列挙すると本命の指摘が埋もれる。1 件直して再実行する運用にする。

### 4.3. 診断の返却形

将来の AI 提案で **Linter が生成物の検証器になる**（提案 → Lint → エラーがあれば差し戻して
自己修正）。そのため、人間向け文言だけでなく機械可読な構造を最初から返す。

エントリポイントは最初から**第 2 引数に検査文脈を取る形**にする。MVP では `siblingSetups` は
常に空だが、複数トラック同時開催（8 章）で必要になるため、後からシグネチャを変えて全ルールの
実装を触ることを避ける。

```ts
export type LintContext = {
  models: Map<string, DeviceModel>;     // 構成が参照する型番
  eventDeviceIds: Set<string>;          // イベントの利用可能機材
  siblingSetups?: SetupDoc[];           // 同時に成立する他トラックの構成（MVP では空）
};

export function lint(doc: SetupDoc, ctx: LintContext): Diagnostic[];

export type Diagnostic = {
  ruleId: string;
  severity: "critical" | "error" | "warn" | "info";
  message: string;                 // 日本語の説明
  nodeIds: string[];
  linkIds: string[];
  cycle?: GraphEdge[];             // 閉路ルールの場合、経路（エッジ種別付き）
  fixes?: Fix[];                   // 機械適用可能な修正候補
};

export type Fix =
  | { kind: "disable-route"; nodeId: string; inPort: string; bus: string }
  | { kind: "set-coupling"; nodeId: string; coupling: "isolated" }
  | { kind: "remove-link"; linkId: string }
  | { kind: "add-device"; category: string; reason: string };
```

## 5. 画面構成 (MVP)

| ルート | 内容 |
| --- | --- |
| `/events` | 配信回の一覧 |
| `/events/:id` | イベント詳細。利用可能機材の選択、構成の一覧 |
| `/events/:id/setups/:setupId` | 構成エディタ（下記タブ） |
| `/devices` | 機材台帳（全体共有プール） |
| `/models` | 型番カタログ。ポート・バス・既定ルーティングの編集 |

構成エディタのタブ:

1. **機材** — イベントの利用可能機材から構成に追加。空間の割り当て、coupling の指定
2. **結線** — 出力ポート → 入力ポートの表形式入力
3. **ルーティング** — ミキサー等の `入力ch × バス` チェックボックス表
4. **図** — 自動レイアウトによる信号フロー図（読み取り専用）
5. **JSON** — 上級者向けの直接編集。イベント間コピーや AI へのペーストに使う

Lint 結果は常時表示し、診断クリックで該当ノード・結線をハイライトする。

視覚的なドラッグ結線編集は 3 機能目の OBS 拡張に寄せ、本ツールでは実装しない。

## 6. 明示的にやらないこと

過度な複雑化を避けるための線引き。当日のセットアップと不具合修復を最優先する。

- ゲイン、フェーダー値、EQ、コンプ、パン、ディレイ
- サブグループ、マトリクスミキサー、DCA
- パッチベイ、インサート、センドリターン
- ネットワークオーディオ (Dante / AVB / NDI)
- ケーブル長、本数、在庫管理
- 電源系統、グラウンドループ
- 結線表の印刷出力、当日チェックリスト生成（今回のスコープ外と決定。次フェーズ候補）
- AI による構成提案（次フェーズ）
- 複数トラックの同時開催（8 章。拡張余地のみ確保し、実装はしない）

## 7. 実装配置

コアロジック（zod スキーマ、グラフ構築、Linter）は `stream/app/lib/av/` にピュア TS で置く。
`gdg-lib` は RP 認証と署名クッキーの責務に限定されており、リポジトリ方針も
「genuinely shared でない限りアプリローカルに保つ」であるため、現時点では切り出さない。

OBS 拡張および CLI へは API で JSON を返す。共有が実際に必要になった段階で
`gdg-lib` もしくは新パッケージへ切り出す。

```
stream/
  app/
    lib/av/
      types.ts         # 型番カタログ・機材台帳の TS 表現、空間結合の規則
      schema.ts        # zod: SetupDoc, Space, Node, Link, Route
      graph.ts         # SetupDoc + 型番情報 → 有向グラフ (cable/host/internal/space)
      paths.ts         # 媒体別の BFS。findPath / findCycle / reachableFrom
      diagnostics.ts   # Diagnostic, Fix, LintContext, 並び替えと共通ヘルパー
      rules/           # structure / connections / loops / coverage
      lint.ts          # lint(doc, ctx) — ルール実行と Diagnostic の集約
      fixtures.ts      # テスト用のミニカタログ
    routes/
  migrations/
  workers/
```

`diagnostics.ts` を `lint.ts` から分離しているのは、ルールが型だけを参照して循環 import を
避けるため。

## 8. 将来の拡張: 複数トラックの同時開催

DevFest のように 1 イベント内でホール A / ホール B / ワークショップ室が同時進行する形態は
MVP の対象外とする。ただし後から行き詰まらないよう、影響範囲を整理しておく。

### 8.1. 後付けで済むもの

- `event_tracks` テーブル（名称、開始・終了時刻、会場メモ）の追加
- `setups.track_id`、`event_devices.track_id` を nullable で追加（既存行は NULL のまま）

いずれも既存行の意味を変えないマイグレーションであり、MVP 時点で作る必要はない。

### 8.2. すでに満たされているもの

マルチトラックで最も価値が高い Linter ルールは、**同時進行する 2 トラックが同じ機材個体を
使っている**ことの検出（`device-double-booked`）である。これには機材台帳が「実物 1 台 =
1 レコード」であることが必須で、3.3 の設計はこれを満たしている。

台帳を「型番 + 数量」で持つ設計にしていた場合、どのトラックがどの個体を使うか特定できず
このルールは書けなくなる。**台帳を個体単位にする判断は、この拡張の前提条件である。**

### 8.3. MVP 時点で手当てしたもの

複数トラックでは構成ドキュメントをトラックごとに分割することになる。このとき、
`spaces` がドキュメント内に閉じているため、**別ドキュメントに現れる同じ物理空間が同一と
認識されない**。隣接する 2 部屋の仕切りが開いている、ホール A の音声をホワイエのスピーカーに
流していてそこにトラック B の受付マイクがある、といった構成でトラック横断の音響結合を
見落とす。

`spaces` を DB テーブルへ引き上げれば解決するが、構成ドキュメントの自己完結性が失われ、
OBS 拡張へのエクスポート・AI へのペースト・JSON タブでの直接編集がすべて複雑化する。
代償が大きすぎるため採らない。

代わりに `spaces[].venueKey`（3.5）を最初からスキーマに含め、**`venueKey` が一致する空間を
同一の物理空間とみなす**規則を将来追加できるようにした。文字列 1 つのコストで、
自己完結性を保ったままトラック横断の結合を表現できる。

同じ理由から `lint()` は最初から `LintContext.siblingSetups` を受け取る形にしてある（4.3）。

### 8.4. 用語の混在に注意

`setups` は「時間的に排他な代替案」（本番 / リハ / プラン B）と「同時に成立する別トラック」
（ホール A / ホール B）という異質な 2 つの意味を持ちうる。混在させると機材の二重使用判定が
書けなくなるため、**MVP では前者の意味に限定する**。トラックは `track_id` という別の軸として
導入し、`(track_id, name)` の組で一意になる形を想定する。
