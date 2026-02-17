import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  // 1. 初始化配置（从 Vercel 环境变量读取）
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
// 确保模型名称没有拼写错误，或者尝试使用不带版本号的简洁名 
  const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
  });

  try {
    const STOCK_SYMBOL = 'MSFT';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    
    const fromDate = yesterday.toISOString().split('T')[0];
    const toDate = today.toISOString().split('T')[0];

    // 2. 获取新闻
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${process.env.FINNHUB_KEY}`
    );
    const rawNews = await newsRes.json();

    if (!rawNews || rawNews.length === 0) {
      return res.status(200).json({ message: "今日无新闻" });
    }

    // 3. AI 总结
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const newsInput = rawNews.slice(0, 10).map(n => ({ h: n.headline, s: n.summary, u: n.url }));
    
    const prompt = `你是财经助手。总结以下微软新闻为最多3点，每点一句话(中英双语)，附带链接。以JSON返回: {"items": [{"text": "...", "url": "..."}]}. 新闻: ${JSON.stringify(newsInput)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const jsonStr = response.text().replace(/```json|```/g, '').trim();
    const finalData = JSON.parse(jsonStr);

    // 4. 存入 Supabase
    await supabase.from('stock_news').insert([{
      stock_symbol: STOCK_SYMBOL,
      content: JSON.stringify(finalData.items),
      source_urls: finalData.items.map(i => i.url)
    }]);

    return res.status(200).json({ success: true, data: finalData.items });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
