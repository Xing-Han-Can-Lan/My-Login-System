import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import yahooFinanceModule from 'yahoo-finance2';

const yahooFinance = yahooFinanceModule.default || yahooFinanceModule;

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_KEY, FINNHUB_KEY, MARKETAUX_KEY } = process.env;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {
    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    
// --- 【新增：缓存检查逻辑】 ---
    console.log(`[检查缓存] 股票: ${STOCK_SYMBOL}, 日期: ${dateStr}`);
    const { data: cachedData, error: fetchError } = await supabase
      .from('stock_news')
      .select('content')
      .eq('stock_symbol', STOCK_SYMBOL)
      .eq('created_date', dateStr)
      .maybeSingle(); // 获取单条记录，如果没有也不报错

    if (cachedData && cachedData.content) {
      console.log(`[缓存命中] 直接从 Supabase 返回数据`);
      return res.status(200).json({ 
        success: true, 
        symbol: STOCK_SYMBOL,
        date: dateStr,
        from_cache: true, // 标记数据来自缓存
        data: JSON.parse(cachedData.content) 
      });
    }
    // ----------------------------

    // --- 逻辑判断：选择数据源 (仅在缓存未命中时执行) ---
    let rawNews = [];
    
    // 1. 自动转换 A 股格式 (将 SH.601398 转换为 601398.SS)
    let marketauxSymbol = STOCK_SYMBOL;
    if (STOCK_SYMBOL.startsWith('SH.')) {
        marketauxSymbol = STOCK_SYMBOL.replace('SH.', '') + '.SS';
    } else if (STOCK_SYMBOL.startsWith('SZ.')) {
        marketauxSymbol = STOCK_SYMBOL.replace('SZ.', '') + '.SZ';
    }

    const isNonUS = marketauxSymbol.includes('.HK') || 
                    marketauxSymbol.includes('.SS') || 
                    marketauxSymbol.includes('.SZ') || 
                    marketauxSymbol.includes('.SI');

    console.log(`[调试] 原始输入: ${STOCK_SYMBOL}, 转换后: ${marketauxSymbol}, 是否非美股: ${isNonUS}`);

    if (isNonUS) {
      const url = `https://api.marketaux.com/v1/news/all?symbols=${marketauxSymbol}&filter_entities=true&language=en,zh&api_token=${MARKETAUX_KEY}`;
      console.log(`[调试] 正在请求 Marketaux URL: ${url}`);

      const marketauxRes = await fetch(url);
      const result = await marketauxRes.json();
      
      // 关键：在日志中打印 API 返回的状态
      if (result.error) {
          console.error(`[错误] Marketaux API 报错:`, result.error);
      }
      console.log(`[调试] Marketaux 返回新闻条数: ${result.data ? result.data.length : 0}`);
      
      rawNews = result.data || [];
    } else {
      // ... 原有 Finnhub 逻辑 ...
      console.log(`[调试] 正在请求 Finnhub, 代码: ${STOCK_SYMBOL}`);
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const fromDate = yesterday.toISOString().split('T')[0];
      const toDate = today.toISOString().split('T')[0];

      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
      );
      rawNews = await newsRes.json();
      // ... 
    }

    // --- Yahoo Finance 补救逻辑 ---
    if (!Array.isArray(rawNews) || rawNews.length === 0) {
      console.log(`[补救] 主 API 无结果，尝试 Yahoo Finance: ${marketauxSymbol}`);
      try {
        // 确保使用转换后的符号，如 D05.SI
        const searchResult = await yahooFinance.search(marketauxSymbol, { 
          newsCount: 5,
          quotesCount: 1 // 也可以顺便带出报价信息
        });
        
        if (searchResult && searchResult.news && searchResult.news.length > 0) {
          rawNews = searchResult.news.map(n => ({
            title: n.title,
            url: n.link
          }));
        }
      } catch (yErr) {
        console.error("Yahoo Finance 补救执行失败:", yErr.message);
      }
    }

   
    // --- 数据标准化处理 ---
    // 因为两个 API 返回字段名不同，这里统一格式为 { h: headline, u: url }
    let newsInput = [];
    if (Array.isArray(rawNews) && rawNews.length > 0) {
      newsInput = rawNews.slice(0, 8).map(n => ({
        h: n.headline || n.title, // Finnhub 用 headline, Marketaux 用 title
        u: n.url
      }));
    }

    let finalItems = [];
    if (newsInput.length > 0) {
      // --- 调用 AI 进行总结 (保留原有优点) ---
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        const prompt = `Summarize these ${STOCK_SYMBOL} news into max 3 points. Each point one Chinese sentence with its URL. Return ONLY JSON: {"items": [{"text": "...", "url": "..."}]} News: ${JSON.stringify(newsInput)}`;
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonStr = responseText.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        finalItems = parsed.items;
      } catch (aiErr) {
        console.error("AI 总结失败:", aiErr.message);
        finalItems = newsInput.slice(0, 3).map(n => ({ text: n.h, url: n.u }));
      }
    }

    // --- 写入 Supabase (保留 Upsert 逻辑) ---
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
      count: finalItems.length,
      data: finalItems 
    });

  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
