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

    // 判断是否为非美股
    const isNonUS = /(.HK|SH.|SZ.|.SI)$/.test(STOCK_SYMBOL);
    let finalItems = [];

    if (isNonUS) {
      // --- 针对港股、A股、新股的新逻辑 ---
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        // 直接让 AI 依靠其联网/知识库总结最新动态（不依赖 Finnhub）
        const prompt = `你是一个专业的金融分析师。请搜索并列举股票代码 "${STOCK_SYMBOL}" 在 ${dateStr} 当天或最近的3条重要新闻或公告。
        请用中文总结，并必须返回严格的 JSON 格式：{"items": [{"text": "总结内容", "url": "来源链接"}]}`;
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        finalItems = parsed.items;
      } catch (aiErr) {
        console.error("非美股获取失败:", aiErr.message);
        finalItems = []; // 失败则返回空，至少保证记录了日期
      }

    } else {
      // --- 原有的美股逻辑（完全保留，不做变动） ---
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
        try {
          const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
          const prompt = `Summarize these ${STOCK_SYMBOL} news into max 3 points. Each point one Chinese sentence with its URL. Return ONLY JSON: {"items": [{"text": "...", "url": "..."}]} News: ${JSON.stringify(newsInput)}`;
          
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          const jsonStr = responseText.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(jsonStr);
          finalItems = parsed.items;
        } catch (aiErr) {
          finalItems = newsInput.slice(0, 3).map(n => ({ text: n.h, url: n.u }));
        }
      }
    }

    // 写入 Supabase (复用你原有的成功写入逻辑)
    const { error: dbError } = await supabase.from('stock_news').upsert([
      {
        stock_symbol: STOCK_SYMBOL,
        content: JSON.stringify(finalItems),
        source_urls: finalItems.map(i => i.url),
        created_date: dateStr
      }
    ], { 
      onConflict: 'stock_symbol,created_date'
    });

    if (dbError) throw dbError;

    return res.status(200).json({ 
      success: true, 
      symbol: STOCK_SYMBOL,
      date: dateStr,
      data: finalItems 
    });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(200).json({ success: false, error: err.message });
  }
}
