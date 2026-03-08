import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    // 【优点保留 & 增强】：从查询参数获取股票代码，默认为 MSFT
    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    
    const fromDate = yesterday.toISOString().split('T')[0];
    const toDate = today.toISOString().split('T')[0];
    
    // 【核心改动】：生成东八区日期字符串 YYYY-MM-DD
    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); 

    // 1. 获取 Finnhub 原始新闻
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
    );
    const rawNews = await newsRes.json();

    let finalItems = [];

    // 如果没新闻，记录空内容，保留日期记录（满足你的新要求）
    if (!Array.isArray(rawNews) || rawNews.length === 0) {
      finalItems = []; 
    } else {
      // 只取前 8 条，避免超出 LLM token 限制
      const newsInput = rawNews.slice(0, 8).map(n => ({ 
        h: n.headline, 
        u: n.url 
      }));

      // 2. 尝试调用 AI 进行总结（保留你原有的优秀 AI 逻辑）
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        // 动态注入 STOCK_SYMBOL，确保总结准确
        const prompt = `Summarize these ${STOCK_SYMBOL} news into max 3 points. Each point one Chinese sentence with its URL. Return ONLY JSON: {"items": [{"text": "...", "url": "..."}]} News: ${JSON.stringify(newsInput)}`;
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        finalItems = parsed.items;
      } catch (aiErr) {
        console.error("AI 总结失败，启用兜底方案:", aiErr.message);
        finalItems = newsInput.slice(0, 3).map(n => ({
          text: n.h,
          url: n.u
        }));
      }
    }

    // 3. 【核心改动】：写入 Supabase (使用 upsert 实现按日期覆盖)
    const { error: dbError } = await supabase.from('stock_news').upsert([
      {
        stock_symbol: STOCK_SYMBOL,
        content: JSON.stringify(finalItems),
        source_urls: finalItems.map(i => i.url),
        created_date: dateStr // 显式存入东八区日期
      }
    ], { 
      onConflict: 'stock_symbol,created_date' // 冲突时（同股同日）自动执行更新
    });

    if (dbError) throw dbError;

    return res.status(200).json({ 
      success: true, 
      symbol: STOCK_SYMBOL,
      date: dateStr,
      count: finalItems.length,
      data: finalItems 
    });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
