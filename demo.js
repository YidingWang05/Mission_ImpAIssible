// 演示模式：没有 ANTHROPIC_API_KEY 时使用的示例数据（日文洗衣机面板，public/demo-panel.svg）
import { blockedGuide } from "./safety.js";
const T = {
  zh: {
    appliance: "全自动洗衣机", goal: "快速洗一次衣服（お急ぎ 快洗模式）",
    intro: "这是一台日本的全自动洗衣机，面板上都是日文。别担心，我们一起用快洗模式洗一次衣服，一共四步。",
    closing: "好啦，洗衣机已经开始工作了，大约 38 分钟后就洗好。有问题随时问我！",
    buttons: {
      power: ["电源键", "打开或关闭洗衣机。按一下开机，再按一下关机。"],
      dial: ["洗衣程序旋钮", "转动选择洗衣程序：标准、快洗、毛毯、洗槽清洁、轻柔洗、漂洗、单脱水。"],
      temp: ["水温键", "选择洗涤水温，按一次换一档。"],
      spin: ["脱水键", "调整脱水的强度和时间，按一次换一档。"],
      timer: ["预约键", "设置几个小时后自动开始洗衣。"],
      lock: ["童锁键", "锁住面板，防止小孩误操作。长按三秒开启或解除。"],
      start: ["启动 / 暂停键", "开始洗衣；洗的过程中再按一下就是暂停。"],
    },
    steps: [
      ["power", "按一下电源键", "先开机。看面板最左边，有一个圆形按钮，上面有红色的开机图标，下面写着日文「電源」。按一下它，屏幕会亮起来。"],
      ["dial", "把旋钮转到「お急ぎ」", "接下来选洗衣程序。中间那个大圆旋钮，把蓝色的指示线转到右上方写着「お急ぎ」的位置，这就是快洗模式。"],
      ["spin", "按「脱水」调脱水强度", "如果衣服比较厚，可以按右上角写着「脱水」的白色按钮，多按几次可以加强脱水。衣服薄的话这一步可以跳过。"],
      ["start", "按蓝色的启动键", "最后，按右下角那个最大的蓝色按钮，上面写着「スタート」，就是启动。听到「哔」一声，洗衣机就开始工作了。"],
    ],
    tip: "衣服不多时用快洗最省时间；厚衣服记得加强脱水。",
    warn: "洗衣机运转时不要打开盖子，也不要把手伸进去。",
    ui: { next: "好的，我们看下一步。", repeat: "好，我再说一遍。", unknown: "演示模式下我只能解释按钮。接上 Anam 数字人之后，这类问题由 Ava 直接回答。", which: "这个按钮是" },
  },
  en: {
    appliance: "Washing machine", goal: "Run a quick wash (お急ぎ mode)",
    intro: "This is a Japanese washing machine, so the panel is all in Japanese. Don't worry — we'll run a quick wash together in four steps.",
    closing: "That's it — the machine is running and will finish in about 38 minutes. Ask me anything!",
    buttons: {
      power: ["Power button", "Turns the washer on or off."],
      dial: ["Program dial", "Turn it to choose a program: normal, quick, blanket, drum clean, delicates, rinse, spin only."],
      temp: ["Temperature button", "Chooses the water temperature; each press moves one level."],
      spin: ["Spin button", "Sets spin strength and time; each press moves one level."],
      timer: ["Delay timer button", "Starts the wash automatically after a few hours."],
      lock: ["Child lock button", "Locks the panel. Hold for three seconds to turn on or off."],
      start: ["Start / Pause button", "Starts the wash; press again during a wash to pause."],
    },
    steps: [
      ["power", "Press the power button", "First, turn it on. On the far left there's a round button with a red power symbol, labelled 電源. Press it once and the display lights up."],
      ["dial", "Turn the dial to お急ぎ", "Next, choose the program. Turn the big round dial in the middle so the blue line points to お急ぎ at the upper right — that's quick wash."],
      ["spin", "Press 脱水 to set the spin", "If your clothes are heavy, press the white 脱水 button at the top right a few times for a stronger spin. For light clothes you can skip this."],
      ["start", "Press the blue start button", "Finally, press the big blue button at the bottom right labelled スタート. You'll hear a beep and the wash begins."],
    ],
    tip: "Quick wash saves time for small loads; use a stronger spin for heavy clothes.",
    warn: "Don't open the lid or reach inside while the drum is moving.",
    ui: { next: "Okay, on to the next step.", repeat: "Sure, here it is again.", unknown: "In demo mode I can only explain buttons. With the Anam avatar connected, Ava answers questions like this.", which: "This is the" },
  },
};

const BOX = {
  power: { x: 48, y: 430, w: 84, h: 140, panel: "電源" },
  dial: { x: 495, y: 333, w: 190, h: 317, panel: "コース" },
  temp: { x: 770, y: 292, w: 90, h: 93, panel: "温度" },
  spin: { x: 875, y: 292, w: 90, h: 93, panel: "脱水" },
  timer: { x: 770, y: 417, w: 90, h: 93, panel: "予約" },
  lock: { x: 875, y: 417, w: 90, h: 93, panel: "ロック" },
  start: { x: 770, y: 567, w: 195, h: 167, panel: "スタート / 一時停止" },
};

const pick = (lang) => (lang === "zh" ? T.zh : T.en);

// 示例：燃气锅炉面板（public/demo-boiler.svg）—— 演示安全红线，不生成任何步骤
export function DEMO_DANGER_GUIDE(lang) {
  const zh = lang === "zh";
  return {
    demoImage: "/demo-boiler.svg",
    ...blockedGuide({
      langCode: lang,
      appliance_native: zh ? "燃气锅炉" : "Gas boiler",
      appliance_en: "Gas boiler",
      brand: "Vexa (demo)",
      kind: "gas",
      reason_native: zh ? "这是一台燃气锅炉，操作不当可能引起漏气或一氧化碳中毒。" : "This is a gas boiler; a mistake can cause a gas leak or carbon monoxide poisoning.",
      reason_en: "This is a gas boiler; a mistake can cause a gas leak or carbon monoxide poisoning.",
    }),
  };
}

export function DEMO_GUIDE(lang) {
  const n = pick(lang), e = T.en;
  return {
    demoImage: "/demo-panel.svg",
    recognized: true,
    appliance_native: n.appliance, appliance_en: e.appliance,
    brand: "AQUA (demo)", model: "AW-7G (demo)", model_confidence: "high",
    goal_native: n.goal, goal_en: e.goal,
    intro_native: n.intro, intro_en: e.intro,
    buttons: Object.entries(BOX).map(([id, b]) => ({
      id, panel_text: b.panel,
      name_native: n.buttons[id][0], name_en: e.buttons[id][0],
      function_native: n.buttons[id][1], function_en: e.buttons[id][1],
      box: { x: b.x, y: b.y, w: b.w, h: b.h },
    })),
    steps: n.steps.map(([id, action, narration], i) => ({
      step: i + 1,
      button_id: id,
      action_native: action, action_en: e.steps[i][1],
      narration_native: narration, narration_en: e.steps[i][2],
      sources: [],
    })),
    tips: [{ native: n.tip, en: e.tip }],
    warnings: [{ native: n.warn, en: e.warn }],
    sources: [], // 演示数据没有联网检索
    closing_native: n.closing, closing_en: e.closing,
  };
}
