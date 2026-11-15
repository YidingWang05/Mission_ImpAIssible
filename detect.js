// 本地语言检测：看用户这句话是用哪种语言写的（只在我们支持的 10 种语言里选）。
// 不调用模型，用在没有 Claude 的演示模式、红线固定话术，以及模型没给出结果时兜底。
// 认不出来（太短、只有数字、几种语言得分一样）返回 null，调用方继续用当前语言。

const WORDS = {
  en: "the is are what how do does this that can to it my and why where which button use when i you of for not",
  es: "el la los las qué que cómo como es esto este esta para por puedo un una y botón dónde sirve hace cuál cuándo no yo se del",
  fr: "le la les est que quoi comment ce cette pour je un une et bouton où quel quelle ça fait sert dois ne pas des du sur",
  pt: "o a os as que como é este esta isso para posso um uma e botão onde não faz serve você esse essa qual quando eu do da",
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(" "))]));
const VI = /[ăâêôơưđ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

export function detectLang(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const n = (re) => (t.match(re) || []).length;
  const latin = n(/[A-Za-zÀ-ɏḀ-ỿ]/g);
  // 非拉丁文字：这种文字的字数够多才算（问题里夹一个面板上的外文词不算）
  const scripts = [
    ["ja", n(/[぀-ヿ]/g) * 2], // 有假名就是日文（汉字单独出现时算中文）
    ["ko", n(/[가-힯ᄀ-ᇿ]/g)],
    ["ar", n(/[؀-ۿ]/g)],
    ["hi", n(/[ऀ-ॿ]/g)],
    ["zh", n(/[一-鿿]/g)],
  ];
  for (const [code, count] of scripts) if (count && count * 2 >= latin) return code;
  if (latin < 2) return null;
  if (VI.test(t)) return "vi";

  const score = { en: 0, es: 0, fr: 0, pt: 0 };
  for (const w of t.toLowerCase().match(/[a-zÀ-ɏ]+/g) || []) for (const k in SETS) if (SETS[k].has(w)) score[k]++;
  if (/[¿¡ñ]/i.test(t)) score.es += 2;
  if (/[ãõ]/i.test(t)) score.pt += 2;
  if (/[œèùû]|\b(qu'|l'|d'|j'|c'|n')/i.test(t)) score.fr += 2;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 && ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}
