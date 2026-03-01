import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const isNonUS = /(.HK|SH.|SZ.|.SI)$/.test(STOCK_SYMBOL);

    // 【关键修复点】：使用 gemini-2.0-flash 代替 1.5
    // 如果 2.0 依然报错，请尝试使用 "gemini-1.5-flash-002"
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash", 
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ]
    });

    let finalItems = [];

    if (isNonUS) {
      // 港股/A股：利用 2.0 强大的推理能力直接获取
      const prompt = `Search and summarize the top 3 news for stock ${STOCK_SYMBOL} on date ${dateStr}. 
      Return strictly as JSON: {"items":[{"text":"Chinese summary","url":"..."}]}`;
      
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) finalItems = JSON.parse(jsonMatch[0]).items;
    } else {
      // 美股：Finnhub 逻辑 (保持不变)
      // ... 之前的 Finnhub 逻辑 ...
    }

    // 写入数据库
    if (finalItems.length > 0) {
      await supabase.from('stock_news').upsert([{
        stock_symbol: STOCK_SYMBOL,
        content: JSON.stringify(finalItems),
        source_urls: finalItems.map(i => i.url),
        created_date: dateStr
      }], { onConflict: 'stock_symbol,created_date' });
    }

    return res.status(200).json({ success: true, data: finalItems });

  } catch (err) {
    console.error("DEBUG INFO:", err.message);
    // 如果依然 404，返回更具体的建议
    if (err.message.includes('404')) {
      return res.status(200).json({ 
        success: false, 
        error: "模型未找到，请检查您的 API Key 是否支持 Gemini 2.0 或联系管理员切换模型 ID" 
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}
