import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const STOCK_SYMBOL = 'MSFT';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    
    const fromDate = yesterday.toISOString().split('T')[0];
    const toDate = today.toISOString().split('T')[0];

    // 1. 获取 Finnhub 原始新闻
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
    );
    const rawNews = await newsRes.json();

    if (!Array.isArray(rawNews) || rawNews.length === 0) {
      return res.status(200).json({ success: true, message: "今日无重要新闻" });
    }

    // 只取前 8 条，避免超出 LLM token 限制
    const newsInput = rawNews.slice(0, 8).map(n => ({ 
      h: n.headline, 
      u: n.url 
    }));

    let finalItems = [];

    // 2. 尝试调用 AI 进行总结
    try {
      // 默认尝试使用 flash 1.5
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Summarize these MSFT news into max 3 points. Each point one Chinese sentence with its URL. Return ONLY JSON: {"items": [{"text": "...", "url": "..."}]} News: ${JSON.stringify(newsInput)}`;
      
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const jsonStr = responseText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      finalItems = parsed.items;
    } catch (aiErr) {
      console.error("AI 总结失败，启用兜底方案:", aiErr.message);
      // 兜底方案：直接把前 3 条新闻标题拿出来，不经过 AI
      finalItems = newsInput.slice(0, 3).map(n => ({
        text: n.h,
        url: n.u
      }));
    }

    // 3. 写入 Supabase (使用 upsert 避免重复)
    const { error: dbError } = await supabase.from('stock_news').insert([{
      stock_symbol: STOCK_SYMBOL,
      content: JSON.stringify(finalItems),
      source_urls: finalItems.map(i => i.url)
    }]);

    if (dbError) throw dbError;

    return res.status(200).json({ 
      success: true, 
      count: finalItems.length,
      data: finalItems 
    });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
