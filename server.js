import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fetch from 'node-fetch';
import morgan from 'morgan';

const app = express();
app.use(helmet());
app.use(morgan('tiny'));
app.use(express.json({ limit: '2mb' }));
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const corsOptions = FRONTEND_ORIGIN === '*'
	? { origin: '*', methods: ['POST','GET','OPTIONS'] }
	: { origin: FRONTEND_ORIGIN, methods: ['POST','GET','OPTIONS'] };
app.use(cors(corsOptions));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
	console.warn('Warning: OPENROUTER_API_KEY not set. /api/chat will return 500.');
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

app.post('/api/chat', async (req, res) => {
	if (!rateLimit(req.ip)) return res.status(429).json({ error: 'Too many requests' });
	if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server not configured' });
	try {
		const { messages = [], model = 'openrouter/auto', temperature = 0.4 } = req.body || {};
		const systemPrompt = 'You are an expert EV specialist assistant. Provide concise, technically accurate answers about electric vehicle range, charging, efficiency, comparison, battery chemistries, and ownership considerations. Be transparent about assumptions.';
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

app.get('/api/health', (req,res)=> res.json({ ok: true, time: Date.now() }));

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
