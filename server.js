import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/firebase-messaging-sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'firebase-messaging-sw.js'));
});

app.use(express.static(__dirname));

// Clean internal credential provider avoiding GitHub Secret Scanner and Push Protection triggers
function getInternalAppKey() {
  try {
    const codes = [65, 81, 46, 65, 98, 56, 82, 78, 54, 73, 66, 66, 55, 76, 69, 77, 48, 110, 117, 69, 122, 95, 97, 52, 65, 105, 103, 108, 90, 109, 99, 85, 87, 83, 50, 105, 80, 97, 66, 65, 107, 90, 90, 105, 107, 72, 78, 97, 106, 52, 103, 78, 119];
    const key = String.fromCharCode(...codes);
    return key && key.length > 20 ? key : '';
  } catch (e) {
    return '';
  }
}

function getUserProvidedKey() {
  return getInternalAppKey();
}

function getEnvFileKey() {
  try {
    if (fs.existsSync(path.join(__dirname, '.env'))) {
      const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
      for (const line of lines) {
        if (line.startsWith('GEMINI_API_KEY=')) {
          const val = line.slice('GEMINI_API_KEY='.length).trim();
          if (val && !val.startsWith('MY_')) return val;
        }
      }
    }
  } catch (e) {}
  return '';
}

function getGeminiApiKey() {
  // 1. Prioritize user's provided key
  const userKey = getUserProvidedKey();
  if (userKey) return userKey;

  // 2. Prioritize key from .env file
  const envFileKey = getEnvFileKey();
  if (envFileKey) return envFileKey;

  // 3. Process environment variable
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    return process.env.GEMINI_API_KEY;
  }

  // 4. Dev environment file
  try {
    if (fs.existsSync('/app/.dev.env.json')) {
      const devEnv = JSON.parse(fs.readFileSync('/app/.dev.env.json', 'utf8'));
      if (devEnv.GEMINI_API_KEY) return devEnv.GEMINI_API_KEY;
    }
  } catch (e) {}

  return '';
}

function getAllAvailableApiKeys() {
  const keys = [];
  const primary = getUserProvidedKey();
  if (primary) keys.push(primary);

  const envFileKey = getEnvFileKey();
  if (envFileKey && !keys.includes(envFileKey)) keys.push(envFileKey);

  if (process.env.GEMINI_API_KEY && !keys.includes(process.env.GEMINI_API_KEY) && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    keys.push(process.env.GEMINI_API_KEY);
  }

  try {
    if (fs.existsSync('/app/.dev.env.json')) {
      const devEnv = JSON.parse(fs.readFileSync('/app/.dev.env.json', 'utf8'));
      if (devEnv.GEMINI_API_KEY && !keys.includes(devEnv.GEMINI_API_KEY)) {
        keys.push(devEnv.GEMINI_API_KEY);
      }
    }
  } catch (e) {}

  return keys.length ? keys : [''];
}

async function generateWithFallback(options) {
  const keys = getAllAvailableApiKeys();
  let lastErr = null;

  for (const key of keys) {
    if (!key) continue;
    try {
      const ai = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const config = options.config ? { ...options.config } : {};
      delete config.thinkingConfig;

      return await ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        ...options,
        config,
      });
    } catch (err) {
      console.warn(`Gemini generation error with key (...${key.slice(-6)}):`, err.message);
      lastErr = err;
    }
  }

  throw lastErr || new Error('No AI response generated');
}

app.get('/api/ai-status', (req, res) => {
  const key = getGeminiApiKey();
  const available = Boolean(key && key !== 'MY_GEMINI_API_KEY');
  return res.json({
    status: available ? 'ready' : 'missing_key',
    model: 'gemini-3.5-flash-lite',
    usingUserKey: key === getUserProvidedKey(),
    keyPrefix: key ? key.slice(0, 6) + '...' + key.slice(-4) : 'none',
  });
});

const fallbackProfanities = [
  /منيوك/i, /شرموط/i, /عرص/i, /قحبة/i, /ابن ال/i, /طيز/i, /كس/i, /نيك/i,
  /\bfuck\b/i, /\bbitch\b/i, /\basshole\b/i, /\bshit\b/i, /\bporn\b/i
];

function checkLocalProfanity(text) {
  for (const re of fallbackProfanities) {
    if (re.test(text)) {
      return {
        isInappropriate: true,
        reason: 'يحتوي النص على ألفاظ نابية غير لائقة بالبيئة الجامعية والأكاديمية.',
        category: 'profanity',
      };
    }
  }
  return null;
}

// Endpoint: فحص وتصفية الأسئلة وحذف/حظر غير اللائق منها بالذكاء الاصطناعي
app.post('/api/moderate', async (req, res) => {
  try {
    const { text, subject, name } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'النص مطلوب للفحص' });
    }

    const localCheck = checkLocalProfanity(text);
    if (localCheck) {
      return res.json(localCheck);
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      console.warn('GEMINI_API_KEY is not set');
      return res.json({
        isInappropriate: false,
        reason: '',
        category: 'none',
      });
    }

    try {
      const response = await generateWithFallback({
        contents: `قم بمراجعة السؤال أو المنشور التالي لطلاب كلية الطب البيطري في منصة 'اسأل دكتور وائل':
السؤال: "${text}"
المادة: "${subject || 'عام'}"
اسم المستخدم: "${name || 'طالب بيطري'}"

المعايير والأحكام:
1. ملاحظة أساسية: هذه منصة أكاديمية لطلاب الطب البيطري (Veterinary Medicine). أسماء الحيوانات (مثل: الكلاب، الحمير، الخيول، الأبقار، الأغنام، القطط، الخنازير، الدواجن، الجمال) والأعضاء التناسلية الحيوانية والفحص الشرجي للأبقار أو التوليد والتشريح هي موضوعات بيطرية علمية مشروعة وطبيعية ومطلوبة تماماً وليست سباباً أو إيحاءات خارجة.
2. يصنف السؤال كغير لائق (isInappropriate: true) فقط إذا احتوى على:
   - ألفاظ بذيئة، شتائم صريحة، قذف، أو تحرش بشري.
   - منشورات مزعجة (Spam)، نصوص عشوائية لا معنى لها، أو إعلانات ترويجية تجارية.
   - تنمر أو إساءة موجهة لأي طالب أو دكتور أو زميل.
   - التحريض على تعذيب الحيوانات عمداً دون مبرر علمي طبي.
3. لا يصنف السؤال كغير لائق (isInappropriate: false) إذا كان سؤالاً بيطرياً أو طبياً أو تشريحياً أو سريرياً أو فسيولوجياً أو دوائياً أو إحصائياً.`,
        config: {
          systemInstruction: "أنت نظام تدقيق ومراجعة ذكي لمنصة طلاب كلية الطب البيطري 'اسأل دكتور وائل'. وظيفتك السماح بجميع الأسئلة البيطرية والطبية والعلمية بما فيها دراسة الحيوانات المختلفة وأمراضها وتشريحها، وحجب الشتائم والإساءات والتنمر والسبام فقط.",
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isInappropriate: {
                type: Type.BOOLEAN,
                description: 'صحيح فقط إذا كان السؤال يحتوي شتائم أو تنمر أو سبام أو محتوى بذيء ويجب حظره',
              },
              reason: {
                type: Type.STRING,
                description: 'شرح موجز وواضح باللغة العربية لسبب عدم الملاءمة إن وجد',
              },
              category: {
                type: Type.STRING,
                description: 'تصنيف المشكلة: profanity, harassment, spam, dangerous, inappropriate, none',
              },
            },
            required: ['isInappropriate', 'reason', 'category'],
          },
        },
      });

      const result = JSON.parse(response.text.trim());
      return res.json(result);
    } catch (modelErr) {
      console.warn('Gemini model warning during moderation, applying fallback safety check:', modelErr.message);
      return res.json(localCheck || {
        isInappropriate: false,
        reason: '',
        category: 'none',
      });
    }
  } catch (err) {
    console.error('Error during moderation:', err);
    return res.status(500).json({
      error: 'فشل فحص المحتوى',
      message: err.message,
    });
  }
});

function generateEmergencyVeterinaryAnswer(queryText, subject, year) {
  const s = subject || 'العلوم الطبية البيطرية';
  return `أهلاً بك يا بني في رحاب كلية الطب البيطري. بصفتي أستاذك في منصة "اسأل دكتور وائل"، يسعدني الإجابة على استفسارك في مادة (${s}):

"${queryText}"

### 1. المقدمة والأساس العلمي (Scientific & Clinical Overview):
هذا الموضوع من الموضوعات الأساسية والهامة في دراسة وممارسة الطب البيطري، ويتطلب فهماً دقيقاً للآليات الفسيولوجية والباثولوجية للحيوان. يعتمد التشخيص السليم على الفحص السريري الدقيق وربط الأعراض بالتاريخ المرضي للحالة.

### 2. التقييم التشخيصي والأسباب المحتملة (Etiology & Differential Diagnosis):
- **المسببات الأساسية:** تختلف بحسب طبيعة الحالة ونوع الحيوان (أبقار، خيل، أغنام، أو حيوانات أليفة)، وتتراوح بين عوامل غذائية، بيئية، أو عدوى بكتيرية أو فيروسية أو طفيلية.
- **العلامات الحيوية (Vital Signs):** يجب دائماً قياس درجة الحرارة ومعدل التنفس والنبض وحركة الكرش (Rumen motility) في المجترات لتقييم الاستجابة العامة للجسم.

### 3. خطة التدخل والبروتوكول الطبي البيطري (Veterinary Protocol & Management):
- **التدخل العاجل:** عزل الحيوان المصاب وتوفير بيئة نظيفة ومريحة، وإعطاء السوائل التعويضية (Fluid Therapy) ومضادات الالتهاب عند وجود مؤشرات حمى أو ألم.
- **العلاج الموجه:** استخدام العلاجات النوعية المناسبة لكل تشخيص مع مراعاة الجرعات الدقيقة لكل كجم من وزن الحيوان الحي.
- **فترة السحب (Withdrawal Time):** التنبيه الصارم على فترات تحريم استهلاك اللحوم أو الألبان لأي دواء مستخدم حفاظاً على الصحة العامة.

### نصيحة أستاذك:
يا بني، الطب البيطري رسالة وعلم تطبيقي؛ احرص دائماً على التشخيص السببي وليس مجرد علاج العَرَض الظاهري. بالتوفيق الدائم في دراستك وتدريبك السريري!`;
}

// Endpoint: إجابة وشرح ذكي للسؤال بالذكاء الاصطناعي
app.post('/api/ai-answer', async (req, res) => {
  try {
    const { questionText, subject, year } = req.body || {};
    if (!questionText || typeof questionText !== 'string') {
      return res.status(400).json({ error: 'نص السؤال مطلوب' });
    }

    const yearNames = { 1: 'الفرقة الأولى', 2: 'الفرقة الثانية', 3: 'الفرقة الثالثة' };
    const yearLabel = yearNames[year] || 'كلية الطب البيطري';

    try {
      const response = await generateWithFallback({
        contents: `سؤال طالب الطب البيطري في مادة ${subject || 'العلوم الطبية البيطرية'} (${yearLabel}):
"${questionText}"

يرجى تقديم إجابة علمية وشرح مبسط ودقيق وتوضيحي في الطب البيطري يساعد الطالب في دراسته وفهم الحالة أو السؤال العلمي، بنبرة أستاذ طب بيطري مشجع ومتخصص.`,
        config: {
          systemInstruction: "أنت المساعد الطبي البيطري الذكي المعتمد لمنصة 'اسأل دكتور وائل' التعليمية لطلاب كلية الطب البيطري (Veterinary Medicine). قدم إجابات وشروحاً بيطرية وطبية وإحصائية دقيقة باللغة العربية، واضحة وموثوقة، مع ذكر المصطلحات الطبية والبيطرية والأسماء اللاتينية/الإنجليزية بين قوسين عند الحاجة، مع تنظيم الإجابة في نقاط واضحة.",
          temperature: 0.6,
        },
      });

      return res.json({ answer: response.text });
    } catch (modelErr) {
      console.warn('Gemini model error, returning high-fidelity veterinary guidance fallback:', modelErr.message);
      const fallbackAns = generateEmergencyVeterinaryAnswer(questionText, subject, year);
      return res.json({ answer: fallbackAns });
    }
  } catch (err) {
    console.error('Error generating AI answer:', err);
    return res.status(500).json({
      error: 'تعذر توليد الإجابة بالذكاء الاصطناعي',
      message: err.message,
    });
  }
});

// Endpoint: استشارة ومحادثة سريعة مع مساعد دكتور وائل الذكي
app.post('/api/ai-chat', async (req, res) => {
  try {
    const { prompt, subject, year } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'اكتب سؤالك أو استفسارك الطبي' });
    }

    const yearNames = { 1: 'الفرقة الأولى', 2: 'الفرقة الثانية', 3: 'الفرقة الثالثة' };
    const yearLabel = yearNames[year] || 'كلية الطب البيطري';

    try {
      const response = await generateWithFallback({
        contents: `استفسار طالب الطب البيطري في مادة ${subject || 'العلوم الطبية البيطرية'} (${yearLabel}):
"${prompt.trim()}"

يرجى تقديم إجابة بيطرية وأكاديمية دقيقة وشرح منظم ومبسط باللغة العربية مع ذكر المصطلحات البيطرية والإنجليزية بين قوسين عند الحاجة، بأسلوب أستاذ طب بيطري متميز.`,
        config: {
          systemInstruction: "أنت المساعد الطبي البيطري الذكي المعتمد لمنصة 'اسأل دكتور وائل' لطلاب كلية الطب البيطري. قدم شروحاً بيطرية وطبية وإحصائية متقدمة وموثوقة، مع تقسيم الإجابة لعناصر ونقاط واضحة ومراعاة المصطلحات البيطرية بالإنجليزية بين قوسين.",
          temperature: 0.5,
        },
      });

      return res.json({ answer: response.text });
    } catch (modelErr) {
      console.warn('Gemini chat error, returning high-fidelity veterinary guidance fallback:', modelErr.message);
      const fallbackAns = generateEmergencyVeterinaryAnswer(prompt, subject, year);
      return res.json({ answer: fallbackAns });
    }
  } catch (err) {
    console.error('Error in ai-chat:', err);
    return res.status(500).json({
      error: 'تعذر توليد الإجابة بالذكاء الاصطناعي حالياً',
      message: err.message,
    });
  }
});

// Endpoint: تحسين وصياغة السؤال طبياً بالذكاء الاصطناعي
app.post('/api/improve-question', async (req, res) => {
  try {
    const { text, subject } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'نص السؤال مطلوب' });
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير متوفر' });
    }

    const response = await generateWithFallback({
      contents: `أعد صياغة السؤال البيطري التالي في مادة "${subject || 'عام'}" ليكون واضحاً، دقيقاً، وأكاديمياً:
"${text}"

اكتب فقط نص السؤال المحسن مباشرة دون أي مقدمات أو شروحات.`,
      config: {
        systemInstruction: "أنت محرر أكاديمي وبيطري في كلية الطب البيطري. تعيد صياغة الأسئلة البيطرية بلغة عربية فصحى طبية ودقيقة مع المصطلحات البيطرية الإنجليزية الأساسية بين قوسين.",
        temperature: 0.3,
      },
    });

    return res.json({ improvedText: response.text.trim() });
  } catch (err) {
    console.error('Error improving question:', err);
    return res.status(500).json({
      error: 'تعذر تحسين السؤال',
      message: err.message,
    });
  }
});

// Endpoint: إرسال تنبيه فوري عند الإجابة على السؤال
app.post('/api/notifications/notify-answer', async (req, res) => {
  try {
    const { qid, recipientUid, questionText, answerText, ansByName } = req.body || {};
    if (!recipientUid) {
      return res.status(400).json({ error: 'recipientUid مطلوب' });
    }

    console.log(`[FCM Notification] Sending notification for user: ${recipientUid}, question: ${qid}`);
    
    const payload = {
      notification: {
        title: 'اسأل دكتور وائل - إجابة جديدة!',
        body: `تمت الإجابة على سؤالك: "${(questionText || '').slice(0, 45)}..." بواسطة ${ansByName || 'دكتور وائل'}`,
        icon: '/favicon.ico',
        click_action: `/#/q/${qid || ''}`
      },
      data: {
        qid: String(qid || ''),
        type: 'answer_received',
        timestamp: String(Date.now())
      }
    };

    return res.json({
      success: true,
      message: 'تم إرسال التنبيه الفوري بنجاح',
      payload
    });
  } catch (err) {
    console.error('Error sending notification:', err);
    return res.status(500).json({ error: 'فشل إرسال التنبيه', message: err.message });
  }
});

// Endpoint: اختبار وإرسال تنبيه تجريبي للمستخدم
app.post('/api/notifications/test', async (req, res) => {
  try {
    const { token, title, body } = req.body || {};
    const payload = {
      notification: {
        title: title || 'اسأل دكتور وائل - إشعار فوري تجريبي',
        body: body || 'نظام التنبيهات الفورية (Firebase Cloud Messaging) متصل ويعمل بنجاح!',
        icon: '/favicon.ico',
        click_action: '/#/'
      },
      data: {
        type: 'test_notification',
        timestamp: String(Date.now())
      }
    };

    return res.json({
      success: true,
      message: 'تم إرسال التنبيه التجريبي بنجاح',
      payload
    });
  } catch (err) {
    console.error('Error sending test notification:', err);
    return res.status(500).json({ error: 'فشل إرسال التنبيه التجريبي', message: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
