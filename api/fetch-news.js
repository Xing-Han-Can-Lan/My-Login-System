import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  
  // 1. 初始化 Gemini (只定义一次)
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash" 
  }, { apiVersion: 'v1' });

  try {
    const STOCK_SYMBOL = 'MSFT';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    
    const fromDate = yesterday.toISOString().split('T')[0];
    const toDate = today.toISOString().split('T')[0];

    // 2. 获取 Finnhub 新闻
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
    );
    const rawNews = await newsRes.json();

    if (!Array.isArray(rawNews) || rawNews.length === 0) {
      return res.status(200).json({ message: "今日无重要新闻" });
    }

    // 3. AI 总结逻辑
    const newsInput = rawNews.slice(0, 10).map(n => ({ h: n.headline, s: n.summary, u: n.url }));
    const prompt = `Summarize these MSFT news into max 3 points. Each point one Chinese sentence with its URL. Return ONLY JSON: {"items": [{"text": "...", "url": "..."}]} News: ${JSON.stringify(newsInput)}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    // 清理并解析 JSON
    const jsonStr = responseText.replace(/```json|```/g, '').trim();
    const finalData = JSON.parse(jsonStr);

    // 4. 写入 Supabase
    const { error: dbError } = await supabase.from('stock_news').insert([{
      stock_symbol: STOCK_SYMBOL,
      content: JSON.stringify(finalData.items),
      source_urls: finalData.items.map(i => i.url)
    }]);

    if (dbError) throw dbError;

    return res.status(200).json({ success: true, data: finalData.items });

  } catch (err) {
    console.error("Error Detail:", err);
    return res.status(500).json({ error: err.message });
  }
}
