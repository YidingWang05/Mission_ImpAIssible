// 支持的母语：语音（Anam 声音 id）+ 界面文案 + 开场问候
// 数字人 Ava 的默认声音是英文（persona.js）；用户选了其他母语时换成该语言的同风格女声，形象和模型不变。
// 新增语言：在 Anam 用 anam_options(language=xx) 挑一个声音，复制下面一项改写即可。
import { PERSONA } from "./persona.js";

export const LANGUAGES = [
  {
    code: "zh", name: "中文", english: "Chinese (Mandarin)", voiceId: "2ce35b4d-74b2-4419-9082-85ba7953e56a",
    greeting: "你好！我是 Ava，你的家电小老师。把手机对准家电的控制面板拍一张照片，我来一步一步教你怎么用。",
    ui: {
      start: "开始", takePhoto: "拍面板照片", retake: "重拍", questionPh: "你对这个家电有什么疑问？例如：怎么快速洗一次衣服（可不填）", researching: "正在识别品牌型号，并查找官网说明和论坛解答…", searching: "搜索", sources: "资料来源", json: "下载步骤 JSON", model: "型号",
      analyze: "开始讲解", analyzing: "正在识别面板…", lookingAt: "好的，让我仔细看看这个面板。",
      next: "下一步", repeat: "再说一遍", prev: "上一步", what: "这个按钮是干什么的",
      hint: "你可以说：", listening: "正在听…", thinking: "想一想…", askPh: "也可以打字提问",
      done: "全部完成！", steps: "步骤", record: "录制视频", stopRecord: "停止录制", save: "保存视频",
      sorry: "抱歉，这个我帮不上忙。我们继续看面板吧。", tapTip: "点照片上的按钮，我告诉你它是干什么的",
      micOff: "麦克风未开启，可点按钮或打字", step: "第 {n} 步",
    },
  },
  {
    code: "en", name: "English", english: "English", voiceId: PERSONA.voiceId,
    greeting: PERSONA.greeting,
    ui: {
      start: "Start", takePhoto: "Photograph the panel", retake: "Retake", questionPh: "Any question about this appliance? e.g. how do I run a quick wash (optional)", researching: "Identifying the brand and model, and looking up the official manual and forums…", searching: "Searching", sources: "Sources", json: "Download steps JSON", model: "Model",
      analyze: "Explain it", analyzing: "Reading the panel…", lookingAt: "Okay, let me take a close look at this panel.",
      next: "Next", repeat: "Say it again", prev: "Back", what: "What does this button do?",
      hint: "You can say:", listening: "Listening…", thinking: "Thinking…", askPh: "Or type a question",
      done: "All done!", steps: "Steps", record: "Record video", stopRecord: "Stop recording", save: "Save video",
      sorry: "Sorry, I can't help with that. Let's get back to the panel.", tapTip: "Tap any button in the photo to learn what it does",
      micOff: "Microphone off — tap or type instead", step: "Step {n}",
    },
  },
  {
    code: "es", name: "Español", english: "Spanish", voiceId: "9fe7d9d3-9201-4f2e-aedf-0ab4736463a5",
    greeting: "¡Hola! Soy tu profesora de electrodomésticos. Toma una foto del panel de control y te explico paso a paso cómo usarlo.",
    ui: {
      start: "Empezar", takePhoto: "Fotografiar el panel", retake: "Repetir foto", questionPh: "¿Alguna duda sobre este aparato? p. ej. cómo hacer un lavado rápido (opcional)", researching: "Identificando marca y modelo, y buscando el manual oficial y foros…", searching: "Buscando", sources: "Fuentes", json: "Descargar pasos (JSON)", model: "Modelo",
      analyze: "Explicar", analyzing: "Leyendo el panel…", lookingAt: "Muy bien, déjame mirar este panel con atención.",
      next: "Siguiente", repeat: "Repítelo", prev: "Anterior", what: "¿Para qué sirve este botón?",
      hint: "Puedes decir:", listening: "Escuchando…", thinking: "Pensando…", askPh: "O escribe una pregunta",
      done: "¡Listo!", steps: "Pasos", record: "Grabar vídeo", stopRecord: "Detener", save: "Guardar vídeo",
      sorry: "Lo siento, con eso no puedo ayudarte. Volvamos al panel.", tapTip: "Toca un botón en la foto para saber qué hace",
      micOff: "Micrófono apagado: toca o escribe", step: "Paso {n}",
    },
  },
  {
    code: "vi", name: "Tiếng Việt", english: "Vietnamese", voiceId: "acf375e5-48ae-48b2-bc9f-1497ecaa2636",
    greeting: "Xin chào! Mình là cô giáo hướng dẫn đồ gia dụng. Bạn chụp một tấm ảnh bảng điều khiển, mình sẽ chỉ bạn từng bước nhé.",
    ui: {
      start: "Bắt đầu", takePhoto: "Chụp bảng điều khiển", retake: "Chụp lại", questionPh: "Bạn có câu hỏi gì về thiết bị này? VD: giặt nhanh thế nào (không bắt buộc)", researching: "Đang nhận diện hãng và model, tìm hướng dẫn chính hãng và diễn đàn…", searching: "Đang tìm", sources: "Nguồn", json: "Tải các bước (JSON)", model: "Model",
      analyze: "Giải thích", analyzing: "Đang đọc bảng điều khiển…", lookingAt: "Được rồi, để mình xem kỹ bảng điều khiển này.",
      next: "Bước tiếp", repeat: "Nói lại", prev: "Quay lại", what: "Nút này để làm gì?",
      hint: "Bạn có thể nói:", listening: "Đang nghe…", thinking: "Đang nghĩ…", askPh: "Hoặc gõ câu hỏi",
      done: "Xong rồi!", steps: "Các bước", record: "Quay video", stopRecord: "Dừng quay", save: "Lưu video",
      sorry: "Xin lỗi, mình không giúp được việc này. Mình quay lại bảng điều khiển nhé.", tapTip: "Chạm vào nút trong ảnh để biết công dụng",
      micOff: "Micro đang tắt — hãy chạm hoặc gõ", step: "Bước {n}",
    },
  },
  {
    code: "ja", name: "日本語", english: "Japanese", voiceId: "30514b8e-d457-4e95-bbdf-92106c8acc8b",
    greeting: "こんにちは！家電の使い方を教える先生です。操作パネルの写真を撮ってくれたら、一つずつ説明しますね。",
    ui: {
      start: "はじめる", takePhoto: "パネルを撮影", retake: "撮り直す", questionPh: "この家電について質問は？例：お急ぎ洗濯のやり方（任意）", researching: "メーカーと型番を確認し、公式説明書や掲示板を調べています…", searching: "検索中", sources: "参考資料", json: "手順を JSON で保存", model: "型番",
      analyze: "説明する", analyzing: "パネルを読み取り中…", lookingAt: "はい、このパネルをよく見てみますね。",
      next: "次へ", repeat: "もう一度", prev: "前へ", what: "このボタンは何？",
      hint: "話しかけてください：", listening: "聞いています…", thinking: "考え中…", askPh: "文字で質問もできます",
      done: "完了です！", steps: "手順", record: "動画を録画", stopRecord: "録画停止", save: "動画を保存",
      sorry: "ごめんなさい、それはお手伝いできません。パネルに戻りましょう。", tapTip: "写真のボタンをタップすると説明します",
      micOff: "マイクがオフです。タップか入力で", step: "ステップ {n}",
    },
  },
  {
    code: "ko", name: "한국어", english: "Korean", voiceId: "04e5f40b-15ae-4e5a-861b-e16880a08a7d",
    greeting: "안녕하세요! 가전제품 사용법을 알려주는 선생님이에요. 조작 패널 사진을 찍어 주시면 한 단계씩 알려드릴게요.",
    ui: {
      start: "시작", takePhoto: "패널 촬영", retake: "다시 찍기", questionPh: "이 가전에 대해 궁금한 점? 예: 빠른 세탁은 어떻게 하나요 (선택)", researching: "브랜드와 모델을 확인하고 공식 설명서와 포럼을 찾는 중…", searching: "검색 중", sources: "출처", json: "단계 JSON 다운로드", model: "모델",
      analyze: "설명 시작", analyzing: "패널을 읽는 중…", lookingAt: "네, 이 패널을 자세히 볼게요.",
      next: "다음", repeat: "다시 말해 줘", prev: "이전", what: "이 버튼은 뭐예요?",
      hint: "이렇게 말해 보세요:", listening: "듣는 중…", thinking: "생각 중…", askPh: "글로 질문해도 돼요",
      done: "모두 끝났어요!", steps: "단계", record: "영상 녹화", stopRecord: "녹화 중지", save: "영상 저장",
      sorry: "죄송해요, 그건 도와드릴 수 없어요. 패널로 돌아갈게요.", tapTip: "사진 속 버튼을 누르면 기능을 알려드려요",
      micOff: "마이크가 꺼져 있어요 — 누르거나 입력하세요", step: "{n}단계",
    },
  },
  {
    code: "fr", name: "Français", english: "French", voiceId: "8d276fed-4fc0-11f1-84b0-52bacf74fa75",
    greeting: "Bonjour ! Je suis votre professeure pour les appareils ménagers. Prenez une photo du panneau de commande et je vous explique étape par étape.",
    ui: {
      start: "Commencer", takePhoto: "Photographier le panneau", retake: "Reprendre", questionPh: "Une question sur cet appareil ? ex. comment lancer un lavage rapide (facultatif)", researching: "Identification de la marque et du modèle, recherche du manuel officiel et des forums…", searching: "Recherche", sources: "Sources", json: "Télécharger les étapes (JSON)", model: "Modèle",
      analyze: "Expliquer", analyzing: "Lecture du panneau…", lookingAt: "D'accord, je regarde ce panneau attentivement.",
      next: "Suivant", repeat: "Répète", prev: "Précédent", what: "À quoi sert ce bouton ?",
      hint: "Vous pouvez dire :", listening: "J'écoute…", thinking: "Je réfléchis…", askPh: "Ou tapez une question",
      done: "Terminé !", steps: "Étapes", record: "Enregistrer", stopRecord: "Arrêter", save: "Enregistrer la vidéo",
      sorry: "Désolée, je ne peux pas aider pour ça. Revenons au panneau.", tapTip: "Touchez un bouton sur la photo pour savoir à quoi il sert",
      micOff: "Micro coupé — touchez ou tapez", step: "Étape {n}",
    },
  },
  {
    code: "ar", name: "العربية", english: "Arabic", voiceId: "8f5074b0-4fc0-11f1-84b0-52bacf74fa75", rtl: true,
    greeting: "مرحبًا! أنا معلمتك للأجهزة المنزلية. التقط صورة للوحة التحكم وسأشرح لك خطوة بخطوة.",
    ui: {
      start: "ابدأ", takePhoto: "صوّر اللوحة", retake: "إعادة التصوير", questionPh: "هل لديك سؤال عن هذا الجهاز؟ مثلاً: كيف أشغّل غسيلاً سريعًا (اختياري)", researching: "جارٍ تحديد العلامة والطراز والبحث في الدليل الرسمي والمنتديات…", searching: "بحث", sources: "المصادر", json: "تنزيل الخطوات JSON", model: "الطراز",
      analyze: "اشرح", analyzing: "جارٍ قراءة اللوحة…", lookingAt: "حسنًا، دعني أنظر إلى هذه اللوحة بعناية.",
      next: "التالي", repeat: "أعِد", prev: "السابق", what: "ما وظيفة هذا الزر؟",
      hint: "يمكنك أن تقول:", listening: "أستمع…", thinking: "أفكر…", askPh: "أو اكتب سؤالك",
      done: "انتهينا!", steps: "الخطوات", record: "سجّل فيديو", stopRecord: "إيقاف", save: "احفظ الفيديو",
      sorry: "عذرًا، لا أستطيع المساعدة في ذلك. لنعد إلى اللوحة.", tapTip: "المس أي زر في الصورة لتعرف وظيفته",
      micOff: "الميكروفون مغلق — المس أو اكتب", step: "الخطوة {n}",
    },
  },
  {
    code: "hi", name: "हिन्दी", english: "Hindi", voiceId: "a1a5faa9-ff64-4c99-ab1e-48f461250b23",
    greeting: "नमस्ते! मैं आपकी घरेलू उपकरण टीचर हूँ। कंट्रोल पैनल की एक फ़ोटो लीजिए, मैं आपको कदम-दर-कदम समझाऊँगी।",
    ui: {
      start: "शुरू करें", takePhoto: "पैनल की फ़ोटो लें", retake: "फिर से लें", questionPh: "इस उपकरण के बारे में कोई सवाल? जैसे: जल्दी धुलाई कैसे करें (वैकल्पिक)", researching: "ब्रांड और मॉडल पहचान रही हूँ, आधिकारिक मैनुअल और फ़ोरम खोज रही हूँ…", searching: "खोज", sources: "स्रोत", json: "कदम JSON डाउनलोड करें", model: "मॉडल",
      analyze: "समझाइए", analyzing: "पैनल पढ़ रही हूँ…", lookingAt: "ठीक है, मैं इस पैनल को ध्यान से देखती हूँ।",
      next: "अगला", repeat: "फिर से बताइए", prev: "पिछला", what: "यह बटन किस काम का है?",
      hint: "आप कह सकते हैं:", listening: "सुन रही हूँ…", thinking: "सोच रही हूँ…", askPh: "या सवाल लिखें",
      done: "हो गया!", steps: "कदम", record: "वीडियो रिकॉर्ड", stopRecord: "रोकें", save: "वीडियो सेव करें",
      sorry: "माफ़ कीजिए, इसमें मैं मदद नहीं कर सकती। चलिए पैनल पर लौटते हैं।", tapTip: "फ़ोटो में किसी बटन को छुएँ, मैं बताऊँगी वह क्या करता है",
      micOff: "माइक बंद है — छुएँ या लिखें", step: "कदम {n}",
    },
  },
  {
    code: "pt", name: "Português", english: "Portuguese (Brazil)", voiceId: "8d78071a-4fc0-11f1-84b0-52bacf74fa75",
    greeting: "Olá! Sou sua professora de eletrodomésticos. Tire uma foto do painel de controle e eu explico passo a passo.",
    ui: {
      start: "Começar", takePhoto: "Fotografar o painel", retake: "Tirar de novo", questionPh: "Alguma dúvida sobre este aparelho? ex.: como fazer uma lavagem rápida (opcional)", researching: "Identificando marca e modelo e buscando o manual oficial e fóruns…", searching: "Buscando", sources: "Fontes", json: "Baixar passos (JSON)", model: "Modelo",
      analyze: "Explicar", analyzing: "Lendo o painel…", lookingAt: "Certo, deixa eu olhar esse painel com atenção.",
      next: "Próximo", repeat: "Repete", prev: "Anterior", what: "Para que serve este botão?",
      hint: "Você pode dizer:", listening: "Ouvindo…", thinking: "Pensando…", askPh: "Ou digite uma pergunta",
      done: "Pronto!", steps: "Passos", record: "Gravar vídeo", stopRecord: "Parar", save: "Salvar vídeo",
      sorry: "Desculpe, não posso ajudar com isso. Vamos voltar ao painel.", tapTip: "Toque num botão da foto para saber o que ele faz",
      micOff: "Microfone desligado — toque ou digite", step: "Passo {n}",
    },
  },
];

// 讲解播放器 / 安全红线用到的补充文案（没有翻译的语言退回英文）
const EXTRA = {
  zh: { more: "还有其他问题吗？", dangerTitle: "安全提醒", play: "播放", pause: "暂停", checking: "正在做安全检查…" },
  en: { more: "Any other questions?", dangerTitle: "Safety notice", play: "Play", pause: "Pause", checking: "Running a safety check…" },
  es: { more: "¿Tienes alguna otra pregunta?", dangerTitle: "Aviso de seguridad", play: "Reproducir", pause: "Pausa", checking: "Comprobando la seguridad…" },
  vi: { more: "Bạn còn câu hỏi nào khác không?", dangerTitle: "Cảnh báo an toàn", play: "Phát", pause: "Tạm dừng", checking: "Đang kiểm tra an toàn…" },
  ja: { more: "ほかに質問はありますか？", dangerTitle: "安全上のご注意", play: "再生", pause: "一時停止", checking: "安全確認をしています…" },
  ko: { more: "다른 질문이 있으신가요?", dangerTitle: "안전 안내", play: "재생", pause: "일시정지", checking: "안전 확인 중…" },
  fr: { more: "Avez-vous d'autres questions ?", dangerTitle: "Consigne de sécurité", play: "Lecture", pause: "Pause", checking: "Vérification de sécurité…" },
  ar: { more: "هل لديك أسئلة أخرى؟", dangerTitle: "تنبيه أمان", play: "تشغيل", pause: "إيقاف مؤقت", checking: "جارٍ فحص الأمان…" },
  hi: { more: "क्या आपका कोई और सवाल है?", dangerTitle: "सुरक्षा सूचना", play: "चलाएँ", pause: "रोकें", checking: "सुरक्षा जाँच हो रही है…" },
  pt: { more: "Tem mais alguma pergunta?", dangerTitle: "Aviso de segurança", play: "Reproduzir", pause: "Pausar", checking: "Verificando a segurança…" },
};
// 会话断开待机时的提示
const STANDBY = {
  zh: "Ava 待机中 · 说话、点按钮或打字，她就回来",
  en: "Ava is on standby — speak, tap or type to bring her back",
  es: "Ava está en espera: habla, toca o escribe para que vuelva",
  vi: "Ava đang chờ — hãy nói, chạm hoặc gõ để gọi cô ấy",
  ja: "Ava は待機中です。話す・タップ・入力で戻ります",
  ko: "Ava 대기 중 — 말하거나 누르거나 입력하면 돌아옵니다",
  fr: "Ava est en veille — parlez, touchez ou écrivez pour la rappeler",
  ar: "Ava في وضع الانتظار — تحدث أو اضغط أو اكتب لتعود",
  hi: "Ava स्टैंडबाय पर है — बोलें, टैप करें या लिखें",
  pt: "Ava está em espera — fale, toque ou digite para ela voltar",
};
for (const l of LANGUAGES) Object.assign(l.ui, EXTRA.en, EXTRA[l.code], { standby: STANDBY[l.code] || STANDBY.en });
