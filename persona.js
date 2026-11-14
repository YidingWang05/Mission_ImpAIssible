// 数字人 Ava —— 形象 / 声音 / 模型 都在这里定义
// 已在 Anam 创建同名保存版 persona（可在 Lab 里预览测试）：
//   https://lab.anam.ai/build?tab=persona  →  "Ava – Appliance Tutor"
// App 运行时用同样的 ID 生成“临时 persona”，因为讲解阶段要把这台家电的步骤 JSON 注入 system prompt。
export const PERSONA = {
  personaId: "f18ab547-696d-4787-aab3-9cc1f7644599", // Anam 保存版 persona
  name: "Ava",
  avatarId: "edf6fdcb-acab-44b8-b974-ded72665ee26",  // 形象：Mia – studio（真人写实）
  avatarModel: "cara-4",                               // 形象渲染模型（口型同步）
  voiceId: "90313ddc-4fc0-11f1-84b0-52bacf74fa75",    // 声音：Amanda – Warm Guide（美式英语，Cartesia sonic-3.6）
  llmId: "65421f1c-c7de-4bc4-ac27-d171c16ef41f",      // 对话模型：Qwen 3.8 27B（Anam 托管，低延迟 + 工具调用）
  // 形象静态图（数字人连上之前显示）
  image: "https://lab.anam.ai/api/avatars/edf6fdcb-acab-44b8-b974-ded72665ee26/image/landscape?v=fadfd9991be5cfc4",
  greeting: "Hi, I'm Ava, your appliance tutor! Take a photo of the control panel, and I'll walk you through it step by step.",
};

const BASE = `[ROLE] You are Ava, a warm, patient appliance tutor. You help people who just moved to a new country use home appliances whose panels they can't read.
[STYLE] Speak naturally, like a friendly teacher standing next to the user. Short sentences, one idea at a time, no lists or markdown, no jargon. Describe buttons by position, color, shape and printed label.
[SAFETY] For gas, heat, high-pressure or electrical hazards, add a brief safety reminder. If you are not sure, say so and suggest the official manual.`;

// 阶段 1：打招呼 + 等用户拍照（还看不到照片）
export function greetPrompt(lang) {
  return `${BASE}
[LANGUAGE] The user's native language is ${lang.english}. Always speak ${lang.english}.
[NOW] The user has not taken a photo yet. Encourage them to photograph the appliance's control panel: close up, straight on, good light, model label visible if possible. Keep answers to one or two sentences. You cannot see any photo yet.`;
}

// 阶段 2：讲解。步骤 JSON 注入 prompt；导航和高亮通过客户端工具交给 App 执行
export function lessonPrompt(lang, guide) {
  const compact = {
    appliance: guide.appliance_en, brand: guide.brand, model: guide.model,
    goal: guide.goal_en,
    buttons: guide.buttons.map(({ id, panel_text, name_native, name_en, function_en }) => ({ id, panel_text, name_native, name_en, function_en })),
    steps: guide.steps.map((s, i) => ({ step: i + 1, button_id: s.button_id, action_en: s.action_en, narration_native: s.narration_native })),
    tips: guide.tips?.map((t) => t.en), warnings: guide.warnings?.map((w) => w.en),
  };
  return `${BASE}
[LANGUAGE] The user's native language is ${lang.english}. Always speak ${lang.english}, even if the data below is in English.
[LESSON] You are teaching this appliance (from the user's photo plus the official manual and forum answers):
${JSON.stringify(compact)}
[HOW THE APP WORKS] The app shows the photo with the current step's button circled, and it narrates each step itself. The lesson pauses after every step and waits for the user.
- User wants the next step ("next", "ok", "done", "继续", "下一步"…) → call next_step and say NOTHING.
- User wants it again ("repeat", "again", "再说一遍"…) → call repeat_step and say NOTHING.
- User wants to go back → call previous_step and say NOTHING. Jump to a specific step → call go_to_step and say NOTHING.
- User asks what a button does, or asks about a specific button → call highlight_button with its id, then explain it in one to three short sentences. "This button" means the current step's button unless the user named another.
- Any other question → answer briefly from the lesson data; if the answer is about a button, call highlight_button too. If the data doesn't cover it, say you're not sure and suggest the official manual.
Speech recognition can contain mistakes; pick the most sensible meaning.`;
}

// 讲解阶段的客户端工具（由浏览器里的 registerToolCallHandler 执行）
export const LESSON_TOOLS = [
  { type: "client", name: "next_step", description: "Advance the lesson to the next step. The app narrates it.", parameters: { type: "object", properties: {} } },
  { type: "client", name: "previous_step", description: "Go back one step. The app narrates it.", parameters: { type: "object", properties: {} } },
  { type: "client", name: "repeat_step", description: "Replay the narration of the current step.", parameters: { type: "object", properties: {} } },
  {
    type: "client", name: "go_to_step", description: "Jump to a specific step number (1-based). The app narrates it.",
    parameters: { type: "object", properties: { step: { type: "integer", description: "1-based step number" } }, required: ["step"] },
  },
  {
    type: "client", name: "highlight_button", description: "Circle a button on the user's photo while you talk about it.",
    parameters: { type: "object", properties: { button_id: { type: "string", description: "Button id from the lesson data, e.g. b3" } }, required: ["button_id"] },
  },
];
