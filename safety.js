// 安全红线（danger identify）
//
// 两道关：
//   1. 照片关（/api/analyze 最先执行）：照片里的设备本身有危险（燃气、配电、被拆开…）→ 不生成教程，
//      只给出原因 + “联系厂家官方售后 / 房东”。
//   2. 提问关（/api/ask 最先执行）：问题涉及维修、拆机、燃气、电路、冒烟起火 → 不直接回答，同样建议联系厂家。
//
// 拒绝时说的话是写死的多语言模板，不让模型自由发挥，保证绝不会“顺便教一下”。
import { z } from "zod";

// ---------------------------------------------------------------- 照片关
export const TriageSchema = z.object({
  appliance_native: z.string().describe("what the photo shows, in the user's native language"),
  appliance_en: z.string(),
  brand: z.string().describe("brand if readable, else 'unknown'"),
  hazard: z.enum(["none", "gas", "electrical", "repair", "other"]),
  reason_native: z.string().describe("one short spoken sentence in the user's native language saying why this is not safe to self-teach; empty when hazard is none"),
  reason_en: z.string(),
});

// 红线清单：想调整哪些设备被拦截，改这里
export const TRIAGE_SYSTEM = `You are the safety gate of an app that teaches people to use home appliances from a photo of the control panel. Decide whether teaching from this photo crosses the red line.

Red line (hazard is not "none"):
- gas: gas boilers, gas water heaters, gas fires or heaters, gas hobs / cookers / ovens, gas meters, gas valves or pipes.
- electrical: consumer units / fuse boxes, electricity meters, exposed wiring, sockets or switches that are open or being modified.
- repair: the appliance is opened up, its casing is removed, internal parts are visible, or it is visibly burnt, melted, leaking or damaged.
- other: anything else where a mistake could plausibly cause fire, explosion, electrocution, poisoning or serious injury (for example industrial machinery).

Not on the red line (hazard "none"): everyday electric appliances operated from their normal control panel — washing machine, dryer, dishwasher, electric oven, induction or ceramic hob, microwave, electric heater, wall thermostat or heating programmer, kettle, rice cooker, air conditioner, fridge, vacuum cleaner. A photo that is not an appliance at all is also "none".

If you cannot tell whether a heating or cooking appliance is gas or electric, choose the hazard. Do not give any operating instructions.`;

// ---------------------------------------------------------------- 提问关
const DANGER_PATTERNS = {
  gas: /gas\s*(leak|smell)|smell(s|ing)?\s*(of\s*)?gas|pilot\s*light|煤气|燃气|天然气|漏气|瓦斯|ガス漏れ|ガス臭|가스\s*(누출|냄새)|fuga de gas|olor a gas|fuite de gaz|odeur de gaz|rò rỉ ga|mùi ga|vazamento de g[aá]s|cheiro de g[aá]s|تسرب الغاز|رائحة غاز|गैस (लीक|रिसाव|की गंध)/i,
  repair: /\b(repair|dismantle|disassemble|take\s+(it\s+|this\s+)?apart|unscrew|open\s+(up\s+)?the\s+(case|casing|cover|back|housing)|replace\s+the\s+(element|fuse|pcb|board|thermostat|heater|pump|belt|motor)|bypass\s+the\s+(lock|safety|sensor|interlock|door))\b|维修|修理|怎么修|自己修|修好|拆开|拆机|拆下|拆掉|拆卸|短接|绕过|分解|수리|분해|reparar|desmontar|réparer|démonter|sửa chữa|tháo rời|consertar|إصلاح|تفكيك|मरम्मत/i,
  electrical: /\b(rewire|wiring|live\s+wire|fuse\s*box|consumer\s+unit|circuit\s+breaker|short\s+circuit|electric\s+shock|electrocut\w*|sparks?|sparking)\b|电线|接线|保险丝|短路|触电|漏电|电路|跳闸|配电箱|火花|配線|感電|漏電|ブレーカー|배선|감전|누전|cableado|cortocircuito|descarga eléctrica|câblage|court-circuit|électrocution|chập điện|điện giật|curto-circuito|choque elétrico|ماس كهربائي|صعق|शॉर्ट सर्किट|करंट/i,
  other: /\b(smok(e|ing)|burning\s+smell|on\s+fire|caught\s+fire)\b|冒烟|着火|起火|烧焦|焦味|糊味|煙が出|焦げ臭|연기|타는 냄새|humo|olor a quemado|fumée|odeur de brûlé|bốc khói|mùi khét|fuma[cç]a|cheiro de queimado|دخان|حريق|धुआं|जलने की गंध/i,
};

// 返回 "gas" | "repair" | "electrical" | "other" | null
export function classifyDanger(question) {
  const q = String(question || "");
  for (const [kind, re] of Object.entries(DANGER_PATTERNS)) if (re.test(q)) return kind;
  return null;
}

// ---------------------------------------------------------------- 拒绝时说的话（写死，10 种语言）
// refuse：不教；contact：联系谁（{maker} 会换成“某品牌官方售后”或“厂家官方售后”）；gas：燃气时追加
const REPLY = {
  zh: { refuse: "为了你的安全，这个操作我不能教。", contact: "请不要自己动手，联系{maker}或房东。", maker: "厂家官方售后", branded: " {brand} 官方售后", gas: "如果闻到煤气味，请开窗、离开房间，并拨打燃气紧急电话（英国：0800 111 999）。" },
  en: { refuse: "For your safety, I can't walk you through this.", contact: "Please don't try it yourself — contact {maker} or your landlord.", maker: "the manufacturer's official support", branded: "{brand} official support", gas: "If you smell gas, open the windows, leave the room and call the gas emergency line (in the UK: 0800 111 999)." },
  es: { refuse: "Por tu seguridad, no puedo guiarte en esto.", contact: "No lo intentes por tu cuenta: contacta con {maker} o con tu casero.", maker: "el servicio técnico oficial del fabricante", branded: "el servicio técnico oficial de {brand}", gas: "Si hueles a gas, abre las ventanas, sal de la habitación y llama al teléfono de emergencias de gas (en el Reino Unido: 0800 111 999)." },
  vi: { refuse: "Vì sự an toàn của bạn, tôi không thể hướng dẫn việc này.", contact: "Xin đừng tự làm — hãy liên hệ {maker} hoặc chủ nhà.", maker: "bộ phận hỗ trợ chính hãng của nhà sản xuất", branded: "bộ phận hỗ trợ chính hãng của {brand}", gas: "Nếu ngửi thấy mùi ga, hãy mở cửa sổ, rời khỏi phòng và gọi đường dây khẩn cấp về ga (tại Anh: 0800 111 999)." },
  ja: { refuse: "安全のため、この操作はご案内できません。", contact: "ご自身では行わず、{maker}または大家さんに連絡してください。", maker: "メーカーの公式サポート", branded: "{brand}の公式サポート", gas: "ガスのにおいがする場合は、窓を開けて部屋を離れ、ガス緊急ダイヤル（英国：0800 111 999）に電話してください。" },
  ko: { refuse: "안전을 위해 이 작업은 안내해 드릴 수 없습니다.", contact: "직접 하지 마시고 {maker} 또는 집주인에게 연락하세요.", maker: "제조사 공식 고객센터", branded: "{brand} 공식 고객센터", gas: "가스 냄새가 나면 창문을 열고 방에서 나와 가스 긴급 전화(영국: 0800 111 999)로 연락하세요." },
  fr: { refuse: "Pour votre sécurité, je ne peux pas vous guider pour cela.", contact: "N'essayez pas vous-même : contactez {maker} ou votre propriétaire.", maker: "le service après-vente officiel du fabricant", branded: "le service après-vente officiel de {brand}", gas: "Si vous sentez une odeur de gaz, ouvrez les fenêtres, quittez la pièce et appelez le numéro d'urgence gaz (au Royaume-Uni : 0800 111 999)." },
  ar: { refuse: "حرصًا على سلامتك، لا أستطيع إرشادك في هذا.", contact: "لا تحاول ذلك بنفسك؛ تواصل مع {maker} أو مع مالك العقار.", maker: "الدعم الرسمي للشركة المصنّعة", branded: "الدعم الرسمي لشركة {brand}", gas: "إذا شممت رائحة غاز، افتح النوافذ وغادر الغرفة واتصل بخط طوارئ الغاز (في المملكة المتحدة: 0800 111 999)." },
  hi: { refuse: "आपकी सुरक्षा के लिए, मैं इसमें आपका मार्गदर्शन नहीं कर सकती।", contact: "कृपया इसे खुद न करें — {maker} या अपने मकान मालिक से संपर्क करें।", maker: "निर्माता की आधिकारिक सहायता सेवा", branded: "{brand} की आधिकारिक सहायता सेवा", gas: "अगर गैस की गंध आए, तो खिड़कियाँ खोलें, कमरे से बाहर निकलें और गैस आपातकालीन नंबर (यूके: 0800 111 999) पर कॉल करें।" },
  pt: { refuse: "Para a sua segurança, não posso orientar você nisso.", contact: "Não tente fazer sozinho — entre em contato com {maker} ou com o seu senhorio.", maker: "a assistência oficial do fabricante", branded: "a assistência oficial da {brand}", gas: "Se sentir cheiro de gás, abra as janelas, saia do cômodo e ligue para a linha de emergência de gás (no Reino Unido: 0800 111 999)." },
};

const knownBrand = (brand) => {
  const b = String(brand || "").replace(/\(demo\)/i, "").trim();
  return b && !/^unknown$/i.test(b) ? b : "";
};

function replyIn(code, brand, kind) {
  const t = REPLY[code] || REPLY.en;
  const b = knownBrand(brand);
  const maker = b ? t.branded.replace("{brand}", b) : t.maker;
  return [t.refuse, t.contact.replace("{maker}", maker), kind === "gas" ? t.gas : ""].filter(Boolean).join(code === "zh" || code === "ja" ? "" : " ");
}

// 拒绝话术：{ native, en }
export function dangerReply(langCode, brand, kind) {
  return { native: replyIn(langCode, brand, kind), en: replyIn("en", brand, kind) };
}

// 照片越过红线时的“完整说明”：没有按钮、没有步骤，只有原因和联系方式
export function blockedGuide({ langCode, appliance_native, appliance_en, brand, kind, reason_native = "", reason_en = "" }) {
  const reply = dangerReply(langCode, brand, kind);
  const native = [reason_native.trim(), reply.native].filter(Boolean).join(langCode === "zh" || langCode === "ja" ? "" : " ");
  const en = [reason_en.trim(), reply.en].filter(Boolean).join(" ");
  return {
    recognized: true,
    safety: "blocked",
    safety_kind: kind,
    safety_message_native: native,
    safety_message_en: en,
    contact: { brand: knownBrand(brand) || null, advice_native: reply.native, advice_en: reply.en },
    appliance_native, appliance_en,
    brand: brand || "unknown", model: "unknown", model_confidence: "low",
    goal_native: "", goal_en: "",
    intro_native: native, intro_en: en,
    buttons: [], steps: [], tips: [],
    warnings: [{ native, en }],
    sources: [],
    closing_native: "", closing_en: "",
  };
}
