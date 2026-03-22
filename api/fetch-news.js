import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import yahooFinance from 'yahoo-finance2'; // [新增]

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY, MARKETAUX_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    
    // 1. 缓存检查逻辑 (保持不变)
    const { data: cachedData } = await supabase
      .from('stock_news')
      .select('content')
      .eq('stock_symbol', STOCK_SYMBOL)
      .eq('created_date', dateStr)
      .maybeSingle();

    if (cachedData?.content) {
      return res.status(200).json({ 
        success: true, 
        symbol: STOCK_SYMBOL,
        data: JSON.parse(cachedData.content),
        from_cache: true 
      });
    }

    // 2. 逻辑判断：准备原始 API 请求
    let rawNews = [];
    let marketauxSymbol = STOCK_SYMBOL;
    if (STOCK_SYMBOL.startsWith('SH.')) marketauxSymbol = STOCK_SYMBOL.replace('SH.', '') + '.SS';
    else if (STOCK_SYMBOL.startsWith('SZ.')) marketauxSymbol = STOCK_SYMBOL.replace('SZ.', '') + '.SZ';

    const isNonUS = /(.HK|.SS|.SZ|.SI)$/.test(marketauxSymbol);

    // 3. 执行主 API 请求
    if (isNonUS) {
      const url = `https://api.marketaux.com/v1/news/all?symbols=${marketauxSymbol}&filter_entities=true&language=en,zh&api_token=${MARKETAUX_KEY}`;
      const marketauxRes = await fetch(url);
      const result = await marketauxRes.json();
      rawNews = result.data || [];
    } else {
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const fromDate = yesterday.toISOString().split('T')[0];
      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
      );
      rawNews = await newsRes.json();
    }

    // --- 【手术刀新增：Yahoo Finance 兜底逻辑】 ---
    if (!Array.isArray(rawNews) || rawNews.length === 0) {
      console.log(`[补救] 主 API 无结果，尝试 Yahoo Finance: ${marketauxSymbol}`);
      try {
        // search 接口通常能返回最新的相关新闻，即使是新加坡股市
        const searchResult = await yahooFinance.search(marketauxSymbol, { newsCount: 5 });
        if (searchResult.news && searchResult.news.length > 0) {
          rawNews = searchResult.news.map(n => ({
            headline: n.title,
            url: n.link,
            source: 'Yahoo'
          }));
        }
      } catch (yErr) {
        console.error("Yahoo Finance 补救失败:", yErr.message);
      }
    }
    // --------------------------------------------

    // 4. 数据标准化与 AI 总结 (逻辑保持不变)
    let finalItems = [];
    if (rawNews.length > 0) {
      const newsInput = rawNews.slice(0, 8).map(n => ({
        h: n.headline || n.title,
        u: n.url
      }));

      try {
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        const prompt = `Summarize these ${STOCK_SYMBOL} news into max 3 points... (省略重复 Prompt)`;
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        finalItems = JSON.parse(jsonStr).items;
      } catch (aiErr) {
        finalItems = newsInput.slice(0, 3).map(n => ({ text: n.h, url: n.u }));
      }
    }

    // 5. 写入 Supabase (保持不变)
    await supabase.from('stock_news').upsert([{
        stock_symbol: STOCK_SYMBOL,
        content: JSON.stringify(finalItems),
        source_urls: finalItems.map(i => i.url),
        created_date: dateStr
    }], { onConflict: 'stock_symbol,created_date' });

    return res.status(200).json({ success: true, symbol: STOCK_SYMBOL, data: finalItems });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
