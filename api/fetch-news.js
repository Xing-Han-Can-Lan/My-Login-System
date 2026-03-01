import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  
  // 初始化 Gemini 客户端
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const isNonUS = /(.HK|SH.|SZ.|.SI)$/.test(STOCK_SYMBOL);

    let finalItems = [];

    // 配置 Gemini 模型参数
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      // 【关键修复 1】：放宽安全限制，防止新闻内容被误拦截
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
      generationConfig: { temperature: 0.2, topP: 0.8, topK: 40 }
    });

    if (isNonUS) {
      // 针对非美股：直接利用 Gemini 的训练数据或联网搜索意图
      const prompt = `你是金融专家。请查找并总结股票 "${STOCK_SYMBOL}" 在 ${dateStr} 左右的最新3条重要新闻。
      输出格式必须是严格的 JSON，格式如下：
      {"items": [{"text": "中文总结内容", "url": "来源链接"}]} 
      注意：只返回 JSON，不要解释。`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // 【关键修复 2】：更强力的 JSON 提取逻辑
      const jsonMatch = text.match(/\{[\s\S]*\}/); 
      if (jsonMatch) {
        finalItems = JSON.parse(jsonMatch[0]).items;
      }
    } else {
      // 美股：Finnhub 逻辑 (保持不变但增加容错)
      const newsRes = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${dateStr}&to=${dateStr}&token=${FINNHUB_KEY}`);
      const rawNews = await newsRes.json();

      if (rawNews && rawNews.length > 0) {
        const inputData = rawNews.slice(0, 5).map(n => ({ h: n.headline, u: n.url }));
        const prompt = `将以下新闻总结为3个中文要点，返回JSON: {"items":[{"text":"...","url":"..."}]} \n新闻内容: ${JSON.stringify(inputData)}`;
        const result = await model.generateContent(prompt);
        const text = (await result.response).text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) finalItems = JSON.parse(jsonMatch[0]).items;
      }
    }

    // 写入 Supabase
    await supabase.from('stock_news').upsert([
      {
        stock_symbol: STOCK_SYMBOL,
        content: JSON.stringify(finalItems),
        source_urls: finalItems.map(i => i.url),
        created_date: dateStr
      }
    ], { onConflict: 'stock_symbol,created_date' });

    return res.status(200).json({ success: true, data: finalItems });

  } catch (err) {
    // 【调试技巧】：在日志里打印完整的错误堆栈，方便在 Vercel Logs 查看
    console.error("Gemini API Error Stack:", err.stack);
    return res.status(500).json({ 
      success: false, 
      error: "接口配置异常: " + err.message 
    });
  }
}
