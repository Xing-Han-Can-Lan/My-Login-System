import { createClient } from '@supabase/supabase-js'

// 初始化 Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: '仅支持 POST 请求' });
  }

  const { user, pass } = req.body;

    // 在这里加一行，方便在 Vercel Logs 里看到输入
  console.log("收到登录请求:", user, "密码长度:", pass.length);

  // 1. 查找用户是否存在
  const { data: userData, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', user)
    .single();

  if (!userData) {
    return res.status(200).json({ success: false, message: '用户名错误' });
  }

  // 2. 检查是否已被锁定
  if (userData.is_locked) {
    return res.status(200).json({ success: false, message: '密码错误超8次，账号已锁定！请联系管理员！' });
  }

  // 3. 验证密码
  if (userData.password === pass) {
    // 登录成功：重置错误次数
    await supabase
      .from('users')
      .update({ failed_attempts: 0 })
      .eq('username', user);
    
    return res.status(200).json({ success: true });
  } else {
    // 密码错误：增加计数
    const newAttempts = (userData.failed_attempts || 0) + 1;
    let message = '密码错误';
    
    if (newAttempts >= 8) {
      // 达到8次，锁定账号
      await supabase
        .from('users')
        .update({ failed_attempts: newAttempts, is_locked: true })
        .eq('username', user);
      message = '密码错误超8次，账号已锁定！请联系管理员！';
    } else {
      await supabase
        .from('users')
        .update({ failed_attempts: newAttempts })
        .eq('username', user);
      message = `密码错误！您还有 ${8 - newAttempts} 次机会。`;
    }

    return res.status(200).json({ success: false, message });
  }
}
