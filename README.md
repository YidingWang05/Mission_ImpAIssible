# 家电小老师 · 母语数字人讲解家电面板

打开 App → 数字人老师用你的母语打招呼 → 拍一张家电控制面板 → AI 识别按钮、写出分步说明 →
在**真实照片上标出要按的按钮**，数字人**口型同步**讲解，带**双语字幕** → 每一步停下来，你可以说
"下一步""再说一遍""这个按钮是干什么的"，数字人实时回答。

## 快速开始

```bash
npm install
```

```bash
cp .env.example .env   # 填入 ANTHROPIC_API_KEY 和 ANAM_API_KEY
```

```bash
npm start              # http://localhost:8000
```

没有填密钥也能跑：自动进入**演示模式**（示例日文洗衣机面板 + Ava 形象照 + 浏览器朗读），方便先看效果。
手机上使用需要 HTTPS（相机/麦克风权限），部署到任意 HTTPS 主机，或本地用 `ngrok http 8000` 之类的隧道。

## 输入与输出

| 输入 | 用在哪 |
|---|---|
| ① 家电照片 | 识别 |
| ② 用户选的语言 | 识别（讲解词用这个语言写）+ 数字人说话/听写语言 |
| ③ 用户对这台家电的疑问 | **不参与识别**；讲解开始后交给数字人 Ava 回答 |

**识别（`POST /api/analyze`，只用 ①②）分两段：**
1. Claude 看照片认出**品牌和型号**，用 web search / web fetch 联网查**官网说明书**和**论坛解答**，写研究笔记。
2. 再看一次照片，把笔记整理成结构化的**使用步骤 JSON**（每个按钮在照片上的坐标、双语讲解、每步引用的资料来源、小贴士、安全提醒）。

前端实时显示正在搜索的关键词。JSON 存到 `output/guides/<id>.json`，讲解页可点"下载步骤 JSON"。主要字段：

```json
{
  "schema": "appliance-tutor/guide@2",
  "brand": "Panasonic", "model": "NA-F70PB15", "model_confidence": "high",
  "appliance_native": "全自动洗衣机", "appliance_en": "Washing machine",
  "buttons": [{ "id": "b1", "panel_text": "電源", "name_native": "电源键", "function_native": "…", "box": { "x": 40, "y": 400, "w": 90, "h": 150 } }],
  "steps": [{ "step": 1, "button_id": "b1", "action_native": "按电源键", "narration_native": "…", "narration_en": "…", "sources": ["https://…"] }],
  "tips": [{ "native": "…", "en": "…" }], "warnings": [{ "native": "…", "en": "…" }],
  "sources": [{ "id": 1, "title": "…取扱説明書", "url": "https://…", "kind": "web", "cited": true }]
}
```

## 数字人 Ava

已在 Anam 账号里创建保存版 persona **"Ava – Appliance Tutor"**，可以在 Anam Lab 里直接预览。

| | ID | 说明 |
|---|---|---|
| Persona | `f18ab547-696d-4787-aab3-9cc1f7644599` | Anam Lab 里的保存版 |
| 形象 Avatar | `edf6fdcb-acab-44b8-b974-ded72665ee26` | Mia – studio（写实真人），渲染模型 `cara-4`（口型同步） |
| 声音 Voice | `90313ddc-4fc0-11f1-84b0-52bacf74fa75` | Amanda – Warm Guide，美式英语（Cartesia sonic-3.6） |
| 模型 LLM | `65421f1c-c7de-4bc4-ac27-d171c16ef41f` | Qwen 3.8 27B（Anam 托管，低延迟、支持工具调用） |

都定义在 `persona.js`。选英语时用 Ava 的英文声音；选其他母语时换成该语言的女声，形象和模型不变。

App 用两段会话：
- **greet**：Ava 用 `initialMessage` 打招呼，陪用户拍照。
- **lesson**：识别完成后重连，把步骤 JSON 写进 system prompt，并给 Ava 5 个客户端工具：`next_step` / `previous_step` / `repeat_step` / `go_to_step` / `highlight_button`。用户说"下一步"时，Ava 调工具，页面翻到下一步并让 Ava 照念讲解词（和字幕、标注同步）；用户问"这个按钮是干什么的"时，Ava 先 `highlight_button` 圈出按钮，再用自己的话回答。

（Anam 不能在会话中途改 system prompt，所以讲解阶段要重新连接一次，大约 1 秒。）

| 其他功能 | 实现 |
|---|---|
| 照片标注 | 当前步骤的按钮用橙色脉冲圈 + 步骤号；Ava 讲解时指向的按钮用粉色；数字人画中画自动躲开按钮 |
| 双语字幕 | 讲解词：母语逐字点亮 + 英文；Ava 的即兴回答：说完后由 Claude 补一行英文 |
| 讲解视频 | 右上角 ● 录制，把照片、标注、数字人、字幕和声音合成为 MP4/WebM |

## 文件

- `server.js` — `/api/analyze`（识别 + 联网 + 步骤 JSON）、`/api/session-token`（Ava 会话）、`/api/translate`（字幕）
- `persona.js` — 数字人 Ava 的形象 / 声音 / 模型 ID、提示词、客户端工具
- `languages.js` — 10 种母语：中文、English、Español、Tiếng Việt、日本語、한국어、Français、العربية、हिन्दी、Português；每种配一个 Anam 母语声音 + 界面文案。加语言照着抄一项即可
- `demo.js`、`public/demo-panel.svg` — 演示模式数据
- `public/` — 前端（无构建步骤）

## 可调项（.env）

`ANAM_AVATAR_ID` 换数字人形象，`ANAM_LLM_ID` 换 Ava 的对话模型，`CLAUDE_MODEL` 换模型，`PORT` 端口。
Claude 请求开启了服务端拒答回退（`fallbacks: "default"`），被安全策略拒绝时会自动换模型重试。
