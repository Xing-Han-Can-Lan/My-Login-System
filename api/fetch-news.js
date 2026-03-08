import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

function getMarket(symbol) {
  if (symbol.endsWith('.HK')) return 'HK';
  if (symbol.endsWith('.SI')) return 'SG';
  if (symbol.startsWith('SH.') || symbol.startsWith('SZ.')) return 'CN';
  return 'US';
}

export default async function handler(req, res) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    GEMINI_KEY,
    FINNHUB_KEY,
    MARKETAUX_KEY
  } = process.env;

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);

  try {

    const STOCK_SYMBOL = (req.query.symbol || 'MSFT').toUpperCase();
    const market = getMarket(STOCK_SYMBOL);

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const fromDate = yesterday.toISOString().split('T')[0];
    const toDate = today.toISOString().split('T')[0];

    const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

    let rawNews = [];

    // ===============================
    // 1 获取新闻
    // ===============================

    if (market === 'US') {

      // Finnhub (原逻辑)
      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${STOCK_SYMBOL}&from=${fromDate}&to=${toDate}&token=${FINNHUB_KEY}`
      );

      rawNews = await newsRes.json();

      rawNews = rawNews.map(n => ({
        headline: n.headline,
        url: n.url
      }));

    } else {

      // Marketaux (新增)
      const newsRes = await fetch(
        `https://api.marketaux.com/v1/news/all?symbols=${STOCK_SYMBOL}&language=en&filter_entities=true&api_token=${MARKETAUX_KEY}`
      );

      const data = await newsRes.json();

      rawNews = (data.data || []).map(n => ({
        headline: n.title,
        url: n.url
      }));

    }

    let finalItems = [];

    if (!Array.isArray(rawNews) || rawNews.length === 0) {
      finalItems = [];
    } else {

      const newsInput = rawNews.slice(0, 8).map(n => ({
        h: n.headline,
        u: n.url
      }));

      // ===============================
      // 2 AI总结
      // ===============================

      try {

        const model = genAI.getGenerativeModel({
          model: "gemini-1.5-flash"
        });

        const prompt = `
Summarize these ${STOCK_SYMBOL} news into max 3 points.
Each point one Chinese sentence with its URL.

Return ONLY JSON:

{"items":[{"text":"","url":""}]}

News:
${JSON.stringify(newsInput)}
`;

        const result = await model.generateContent(prompt);

        const responseText = result.response.text();

        const jsonStr = responseText
          .replace(/```json|```/g, '')
          .trim();

        const parsed = JSON.parse(jsonStr);

        finalItems = parsed.items;

      } catch (aiErr) {

        console.error("AI 总结失败:", aiErr.message);

        finalItems = newsInput.slice(0, 3).map(n => ({
          text: n.h,
          url: n.u
        }));

      }
    }

    // ===============================
    // 3 写入数据库
    // ===============================

    const { error: dbError } = await supabase
      .from('stock_news')
      .upsert([
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
      market,
      date: dateStr,
      count: finalItems.length,
      data: finalItems
    });

  } catch (err) {

    console.error("API Error:", err);

    return res.status(500).json({
      error: err.message
    });

  }
}
