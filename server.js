const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ─── HEALTH CHECK ───
app.get('/', (req, res) => {
  res.json({ status: 'Yantra backend is running 🚀' });
});

// ─── SIGN UP ───
app.post('/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password required' });

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name }
  });

  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('users').insert({
    id: data.user.id,
    name,
    email,
    plan: 'starter',
    websites_built: 0,
    created_at: new Date().toISOString()
  });

  res.json({ success: true, user: { id: data.user.id, name, email } });
});

// ─── SIGN IN ───
app.post('/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return res.status(400).json({ error: error.message });

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', data.user.id)
    .single();

  res.json({
    success: true,
    token: data.session.access_token,
    user: {
      id: data.user.id,
      name: profile?.name || email.split('@')[0],
      email,
      plan: profile?.plan || 'starter',
      websites_built: profile?.websites_built || 0
    }
  });
});

// ─── GET USER PROFILE ───
app.get('/user/profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  res.json({ success: true, user: profile });
});

// ─── BUILD WEBSITE (calls Claude API securely) ───
app.post('/ai/build-website', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const { name, type, location, phone, description } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Business name and type required' });

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profile?.plan === 'starter' && (profile?.websites_built || 0) >= 3) {
    return res.status(403).json({ error: 'Free plan limit reached. Upgrade to Growth.' });
  }

  try {
    const prompt = `Create a complete, beautiful, professional single-page HTML website for this business:

Business Name: ${name}
Business Type: ${type}
Location: ${location || 'India'}
Phone: ${phone || 'Contact us'}
Description: ${description || `A premium ${type} business`}

Requirements:
- Complete standalone HTML file with all CSS and JS embedded
- Modern, clean, professional design matching the business type
- Sections: Hero with CTA, About, Services, Testimonials, Contact with phone and address, Footer
- Mobile responsive
- Smooth animations
- Google Fonts
- Professional color scheme fitting the business
- Return ONLY complete HTML code, no explanation, no markdown backticks`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API failed');
    }

    const data = await response.json();
    let html = data.content[0].text;
    html = html.replace(/^```html\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();

    await supabase.from('websites').insert({
      user_id: user.id,
      business_name: name,
      business_type: type,
      location: location || '',
      phone: phone || '',
      html_code: html,
      created_at: new Date().toISOString()
    });

    await supabase.from('users')
      .update({ websites_built: (profile?.websites_built || 0) + 1 })
      .eq('id', user.id);

    res.json({ success: true, html });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET USER'S WEBSITES ───
app.get('/user/websites', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: websites } = await supabase
    .from('websites')
    .select('id, business_name, business_type, location, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  res.json({ success: true, websites: websites || [] });
});

// ─── ADMIN MIDDLEWARE ───
const adminAuth = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (key !== 'YugaAdmin2025!') return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ─── ADMIN: GET ALL USERS ───
app.get('/admin/users', adminAuth, async (req, res) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, users: users || [] });
});

// ─── ADMIN: GET ALL WEBSITES ───
app.get('/admin/websites', adminAuth, async (req, res) => {
  const { data: websites, error } = await supabase
    .from('websites')
    .select('id, business_name, business_type, location, created_at, user_id')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Get user emails
  const withEmails = await Promise.all((websites || []).map(async (w) => {
    const { data: user } = await supabase.from('users').select('email, name').eq('id', w.user_id).single();
    return { ...w, user_email: user?.email || '', user_name: user?.name || '' };
  }));

  res.json({ success: true, websites: withEmails });
});

// ─── ADMIN: GET STATS ───
app.get('/admin/stats', adminAuth, async (req, res) => {
  const { count: userCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: websiteCount } = await supabase.from('websites').select('*', { count: 'exact', head: true });
  res.json({ success: true, users: userCount || 0, websites: websiteCount || 0 });
});

// ─── GET SINGLE WEBSITE ───
app.get('/user/websites/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: website } = await supabase
    .from('websites')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', user.id)
    .single();

  if (!website) return res.status(404).json({ error: 'Website not found' });

  res.json({ success: true, website });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Yantra backend running on port ${PORT} 🚀`));
