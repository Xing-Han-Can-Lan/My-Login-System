import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

    // --- 新增：判断市场类型 ---
    const isNonUS = /(.HK|SH.|SZ.|.SI)$/.test(STOCK_SYMBOL);
    let finalItems = [];

    if (isNonUS) {
      // --- 方案 A: 针对非美股，直接调用 Gemini 联网搜索 ---
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        // 强制开启搜索工具（如果你的 SDK 支持）或在提示词中明确要求获取今日新闻
      });

      const prompt = `你是一个金融分析师。请搜索并查找股票代码为 "${STOCK_SYMBOL}" 的今日（${dateStr}）最新重要新闻。
      请总结出最多3个要点，每个要点包含一条中文总结和来源URL。
      必须仅返回 JSON 格式: {"items": [{"text": "...", "url": "..."}]}`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const jsonStr = responseText.replace(/```json|```/g, '').trim();
      finalItems = JSON.parse(jsonStr).items;

    } else {
      // --- 方案 B: 美股保留原有的 Finnhub 逻辑 ---
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const fromDate = yesterday.toISOString().split('T')[0];
      const toDate = today.toISOString().split('T')[0];

      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
      );
      const rawNews = await newsRes.json();

      if (Array.isArray(rawNews) && rawNews.length > 0) {
        const newsInput = rawNews.slice(0, 8).map(n => ({ h: n.headline, u: n.url }));
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Summarize these ${STOCK_SYMBOL} news into max 3 points. Each point one Chinese sentence with its URL. Return ONLY JSON: {"items": [{"text": "...", "url": "..."}]} News: ${JSON.stringify(newsInput)}`;
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        finalItems = JSON.parse(jsonStr).items;
      }
    }

    // 3. 写入 Supabase (保持原逻辑不变)
    const { error: dbError } = await supabase.from('stock_news').upsert([
      {
        stock_symbol: STOCK_SYMBOL,
        content: JSON.stringify(finalItems),
        source_urls: finalItems.map(i => i.url),
        created_date: dateStr
      }
    ], { onConflict: 'stock_symbol,created_date' });

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
    // 增加一个更友好的错误返回，避免 10s 超时导致的 504 错误
    return res.status(200).json({ success: false, error: "获取超时或AI响应异常，请重试" });
  }
}
