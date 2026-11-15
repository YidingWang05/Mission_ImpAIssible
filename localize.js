// 把一份说明里所有“母语”字段换成另一种语言（示例数据是提前生成好的，语言不一定是用户选的那个）。
// 每个母语字段旁边都有一个英文字段（*_en / .en），所以：
//   · 目标是英文 → 直接用英文字段，不调用模型；
//   · 其他语言 → 把英文字段一次性交给 translate() 翻译，按顺序写回。
// 按钮坐标、步骤顺序、来源等其他字段原样保留。

function slots(g) {
  const out = [];
  const add = (obj, nat, en) => { if (obj && typeof obj[en] === "string" && obj[en]) out.push({ obj, nat, en }); };
  for (const k of ["appliance", "goal", "intro", "closing"]) add(g, `${k}_native`, `${k}_en`);
  for (const b of g.buttons || []) { add(b, "name_native", "name_en"); add(b, "function_native", "function_en"); }
  for (const s of g.steps || []) { add(s, "action_native", "action_en"); add(s, "narration_native", "narration_en"); }
  for (const t of [...(g.tips || []), ...(g.warnings || [])]) add(t, "native", "en");
  return out;
}

// translate(texts: string[], lang) → Promise<string[]>（长度、顺序必须一致）。返回 null 表示翻译失败。
export async function localizeGuide(guide, lang, translate) {
  const g = structuredClone(guide);
  const list = slots(g);
  let texts = list.map((s) => s.obj[s.en]);
  if (lang.code !== "en") {
    const out = await translate(texts, lang);
    if (!Array.isArray(out) || out.length !== texts.length || out.some((t) => typeof t !== "string" || !t.trim())) return null;
    texts = out;
  }
  list.forEach((s, i) => { s.obj[s.nat] = texts[i]; });
  g.language = { code: lang.code, name: lang.english };
  return g;
}
