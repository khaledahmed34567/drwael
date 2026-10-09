import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    return process.env.GEMINI_API_KEY;
  }
  try {
    if (fs.existsSync('/app/.dev.env.json')) {
      const devEnv = JSON.parse(fs.readFileSync('/app/.dev.env.json', 'utf8'));
      if (devEnv.GEMINI_API_KEY) return devEnv.GEMINI_API_KEY;
    }
  } catch (e) {}
  try {
    if (fs.existsSync(path.join(__dirname, '.env'))) {
      const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
      for (const line of lines) {
        if (line.startsWith('GEMINI_API_KEY=')) {
          return line.slice('GEMINI_API_KEY='.length).trim();
        }
      }
    }
  } catch (e) {}
  return process.env.GEMINI_API_KEY;
}

function getAiClient() {
  const key = getGeminiApiKey();
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateWithFallback(options) {
  const ai = getAiClient();
  try {
    return await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      ...options,
    });
  } catch (err) {
    if (err.status === 503 || err.status === 429 || (err.message && (err.message.includes('503') || err.message.includes('UNAVAILABLE')))) {
      console.warn('503 on gemini-3.8-flash, using gemini-3.1-flash-lite fallback...');
      return await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        ...options,
      });
    }
    throw err;
  }
}

const fallbackProfanities = [
  /حمار/i, /كلب/i, /غبي/i, /متخلف/i, /قذر/i, /وسخ/i, /شتم/i, /سب/i, /لعن/i,
  /منيوك/i, /شرموط/i, /عرص/i, /قحبة/i, /ابن ال/i, /طيز/i, /كس/i, /نيك/i,
  /\bfuck\b/i, /\bbitch\b/i, /\basshole\b/i, /\bshit\b/i, /\bporn\b/i
];

function checkLocalProfanity(text) {
  for (const re of fallbackProfanities) {
    if (re.test(text)) {
      return {
        isInappropriate: true,
        reason: 'يحتوي النص على ألفاظ غير لائقة ومسيئة للآداب العامة والبيئة التعليمية.',
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
        contents: `قم بمراجعة السؤال أو المنشور التالي لطلاب الطب في منصة 'اسأل دكتور وائل':
السؤال: "${text}"
المادة: "${subject || 'عام'}"
اسم المستخدم: "${name || 'طالب'}"

المعايير الصارمة:
1. يصنف السؤال كغير لائق (isInappropriate: true) إذا احتوى على:
   - ألفاظ بذيئة، شتائم، قذف، إيحاءات خارجة غير علمية، أو تحرش.
   - منشورات مزعجة (Spam)، نصوص عشوائية لا معنى لها، أو محتوى ترويجي ودعائي.
   - تنمر أو إساءة شخصية موجهة لأي طالب أو دكتور.
   - معلومات طبية تحرض على الانتحار أو إيذاء النفس أو تعاطي المخدرات.
2. لا يصنف السؤال كغير لائق (isInappropriate: false) إذا كان سؤالاً طبياً، تشريحياً، فسيولوجياً، إحصائياً، أو استفساراً منهجياً عن أمراض أو أجهزة حساسة في سياق التعليم الطبي البحت.`,
        config: {
          systemInstruction: "أنت نظام رقابة أمان ومحتوى ذكي لمنصة تعليمية طبية جامعية. وظيفتك اكتشاف وحجب الأسئلة غير اللائقة والمسيئة والبذيئة، مع التمييز بين الأسئلة العلمية الطبية وبين الإساءة والشتائم.",
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isInappropriate: {
                type: Type.BOOLEAN,
                description: 'صحيح إذا كان السؤال غير لائق أو يحتوي شتائم أو إساءة أو سبام ويجب حذفه',
              },
              reason: {
                type: Type.STRING,
                description: 'شرح موجز وواضح باللغة العربية لسبب عدم الملاءمة ليظهر للمستخدم',
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

// Endpoint: إجابة وشرح ذكي للسؤال بالذكاء الاصطناعي
app.post('/api/ai-answer', async (req, res) => {
  try {
    const { questionText, subject, year } = req.body || {};
    if (!questionText || typeof questionText !== 'string') {
      return res.status(400).json({ error: 'نص السؤال مطلوب' });
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير متوفر' });
    }

    const yearNames = { 1: 'الفرقة الأولى', 2: 'الفرقة الثانية', 3: 'الفرقة الثالثة' };
    const yearLabel = yearNames[year] || 'كلية الطب';

    const response = await generateWithFallback({
      contents: `سؤال الطالب في مادة ${subject || 'العلوم الطبية'} (${yearLabel}):
"${questionText}"

يرجى تقديم إجابة علمية وشرح مبسط ودقيق وتوضيحي يساعد الطالب في دراسته وفهم السؤال، بنبرة أستاذ طبي مشجع ومتخصص.`,
      config: {
        systemInstruction: "أنت المساعد الذكي المعتمد لمنصة 'اسأل دكتور وائل' التعليمية الطبية. قدم إجابات وشروحاً طبية وإحصائية دقيقة باللغة العربية، واضحة وموثوقة، مع تقسيم الإجابة لنقاط منظمة ومراعاة المصطلحات الطبية بالإنجليزية بين قوسين عند الحاجة.",
        temperature: 0.6,
      },
    });

    return res.json({ answer: response.text });
  } catch (err) {
    console.error('Error generating AI answer:', err);
    return res.status(500).json({
      error: 'تعذر توليد الإجابة بالذكاء الاصطناعي',
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
      contents: `أعد صياغة السؤال الطبي التالي في مادة "${subject || 'عام'}" ليكون واضحاً، دقيقاً، وأكاديمياً:
"${text}"

اكتب فقط نص السؤال المحسن مباشرة دون أي مقدمات أو شروحات.`,
      config: {
        systemInstruction: "أنت محرر أكاديمي وطبي في كلية الطب. تعيد صياغة الأسئلة الطبية بلغة عربية فصحى طبية ودقيقة مع المصطلحات الإنجليزية الأساسية بين قوسين.",
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
