import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fetch from 'node-fetch';
import morgan from 'morgan';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));
let EV_DATA = [];
try {
	const data = readFileSync(join(__dirname, 'evs.json'), 'utf8');
	EV_DATA = JSON.parse(data);
} catch (e) {
	console.warn('Warning: Could not load evs.json', e.message);
}
app.use(helmet());
app.use(morgan('tiny'));
app.use(express.json({ limit: '2mb' }));
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
const corsOptions = FRONTEND_ORIGIN
	? { origin: [FRONTEND_ORIGIN, 'null'], methods: ['POST','GET','OPTIONS'], credentials: false }
	: { origin: true, methods: ['POST','GET','OPTIONS'] };
app.use(cors(corsOptions));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD;
if (!OPENROUTER_API_KEY) {
	console.warn('Warning: OPENROUTER_API_KEY not set. /api/chat will return 500.');
}
if (!CHAT_PASSWORD) {
	console.warn('Warning: CHAT_PASSWORD not set in .env. Chat endpoint will return 401.');
}

// Simple in-memory rate limiter: 60 requests per minute per IP
const recent = [];
function rateLimit(ip) {
	const now = Date.now();
	for (let i = recent.length - 1; i >= 0; i--) {
		if (now - recent[i].t > 60000) recent.splice(i,1);
	}
	const count = recent.filter(r => r.ip === ip).length;
	if (count >= 60) return false;
	recent.push({ ip, t: now });
	return true;
}

// Session-based authentication for chat: store authenticated IPs
const authenticatedSessions = new Map();
function isSessionAuth(ip) {
	if (!authenticatedSessions.has(ip)) return false;
	const { expiry } = authenticatedSessions.get(ip);
	if (Date.now() > expiry) {
		authenticatedSessions.delete(ip);
		return false;
	}
	return true;
}
function markSessionAuth(ip) {
	authenticatedSessions.set(ip, { expiry: Date.now() + 3600000 }); // 1 hour session
}

app.post('/api/chat', async (req, res) => {
	if (!rateLimit(req.ip)) return res.status(429).json({ error: 'Too many requests' });
	if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });
	
	// Check if password provided OR session already authenticated
	const { password } = req.body || {};
	const isAuth = isSessionAuth(req.ip);
	
	if (password && password === CHAT_PASSWORD) {
		// Password correct - mark session as authenticated
		markSessionAuth(req.ip);
	} else if (!isAuth) {
		// No valid password and no existing session
		return res.status(401).json({ error: 'Unauthorized: Invalid or missing password' });
	}
	
	try {
		const { messages = [], model = 'openrouter/auto', temperature = 0.4 } = req.body || {};
		const systemPrompt = 'You are a brief EV specialist assistant. Answer in 1-2 sentences maximum. Only provide more detail if the user explicitly asks for it. Focus on range, charging, efficiency, battery chemistry, and comparisons. Be direct and concise.';
		const payload = {
			model,
			messages: [
				{ role: 'system', content: systemPrompt },
				...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content||'') }))
			],
			temperature,
			max_tokens: 600,
		};
		const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
				'HTTP-Referer': process.env.OPENROUTER_SITE || 'https://example.com',
				'X-Title': process.env.OPENROUTER_TITLE || 'EV Range Lab',
			},
			body: JSON.stringify(payload)
		});
		if (!resp.ok) {
			const text = await resp.text();
			return res.status(resp.status).json({ error: 'OpenRouter error', detail: text });
		}
		const data = await resp.json();
		const reply = data.choices?.[0]?.message?.content || 'No response';
		res.json({ reply, model: data.model || model });
	} catch (e) {
		console.error(e);
		res.status(500).json({ error: 'Server error' });
	}
});

// Root route for health check
app.get('/', (req, res) => res.json({ ok: true, service: 'EV Backend', time: Date.now() }));

app.get('/api/health', (req,res)=> res.json({ ok: true, time: Date.now() }));

// EV data endpoint (fallback for frontend if frontend fetch fails)
app.get('/api/evs', (req, res) => {
	if (!EV_DATA || EV_DATA.length === 0) {
		return res.status(503).json({ error: 'EV data not available' });
	}
	res.json(EV_DATA);
});

// 404 for any other routes
app.use((req, res) => {
	res.status(404).json({ error: 'Not found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	console.error('Unhandled error:', err);
	res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Backend listening on port', PORT));
