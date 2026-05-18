const express = require('express');
const cors    = require('cors');

const app    = express();
const API_KEY = process.env.API_KEY || 'changeme';

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── In-memory store (survives until server restarts) ────────────────────────
// Each item: { id, type, amount, currency, account, category, title, description, date }
const pending = [];
let idCounter = 1;
const genId = () => String(idCounter++);

// ─── Message parser ───────────────────────────────────────────────────────────
const CATEGORY_MAP = [
  [/(food|eat|lunch|dinner|breakfast|restaurant|snack|coffee|cafe|pizza|burger|shawarma|saj|falafel|manakish)/i, 'Food & Dining'],
  [/(uber|taxi|car|gas|fuel|parking|transport|bus|metro|lyft|bolt)/i,                                            'Transportation'],
  [/(shop|clothes|shirt|shoes|jacket|mall|store|zara|h&m|buying)/i,                                              'Shopping'],
  [/(bill|electric|water|internet|phone|subscri|netflix|spotify)/i,                                              'Bills & Utilities'],
  [/(doctor|pharmacy|medicine|hospital|clinic|health)/i,                                                         'Healthcare'],
  [/(cinema|movie|game|concert|entertainment|fun|night out)/i,                                                   'Entertainment'],
  [/(school|tuition|course|book|education|university)/i,                                                         'Education'],
  [/(rent|housing|landlord|apartment)/i,                                                                         'Housing'],
  [/(salon|barber|haircut|gym|personal)/i,                                                                       'Personal Care'],
  [/(travel|hotel|flight|trip|vacation)/i,                                                                       'Travel'],
  [/(salary|راتب)/i,                                                                                              'Salary'],
  [/(freelance|project|client)/i,                                                                                 'Freelance'],
  [/(gift|هدية)/i,                                                                                                'Gift'],
];

function guessCategory(text, type) {
  for (const [regex, category] of CATEGORY_MAP) {
    if (regex.test(text)) return category;
  }
  return type === 'income' ? 'Other' : 'Other';
}

function parseMessage(raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();

  // ── Determine transaction type ──
  const isExpense = /^(paid|spent|bought|exp|expense|-|صرفت|دفعت|اشتريت)/i.test(text);
  const isIncome  = /^(received|got|income|salary|earned|deposited|\+|استلمت|وصلني)/i.test(text);
  if (!isExpense && !isIncome) return null;
  const type = isIncome ? 'income' : 'expense';

  // ── Extract amount (first number found) ──
  const amtMatch = text.match(/[\d,]+(?:\.\d+)?/);
  if (!amtMatch) return null;
  const amount = parseFloat(amtMatch[0].replace(/,/g, ''));
  if (!amount || isNaN(amount)) return null;

  // ── Currency ──
  const isLBP    = /\b(lbp|ll|lira|ل\.?ل|ليرة)\b/i.test(text);
  const currency = isLBP ? 'LBP' : 'USD';

  // ── Account ──
  let account = 'wallet';
  if (/\bsavings\b/i.test(text))             account = 'savings';
  else if (/\b(bank|card|byblos|blom|audi|bankmed)\b/i.test(text)) account = 'bank';

  // ── Title = everything after the amount & keywords ──
  const title = text
    .replace(/^(paid|spent|bought|exp|expense|received|got|income|salary|earned|deposited|-|\+|صرفت|دفعت|اشتريت|استلمت|وصلني)\s*/i, '')
    .replace(/[\d,]+(?:\.\d+)?/, '')
    .replace(/\b(lbp|ll|lira|usd|\$|dollars?|savings|bank|card|wallet)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || (type === 'income' ? 'Income' : 'Expense');

  return {
    id:          genId(),
    type,
    amount,
    currency,
    account,
    category:    guessCategory(text, type),
    title:       title.charAt(0).toUpperCase() + title.slice(1),
    description: `via WhatsApp: "${raw}"`,
    date:        new Date().toISOString(),
  };
}

function confirmMessage(tx) {
  const sign   = tx.type === 'income' ? '+' : '-';
  const amt    = tx.currency === 'LBP'
    ? `${tx.amount.toLocaleString()} LL`
    : `$${tx.amount.toFixed(2)}`;
  const acct   = tx.account === 'wallet' ? 'Wallet' : tx.account === 'savings' ? 'Savings' : 'Bank';
  return `✅ Logged!\n${sign}${amt} · ${tx.title}\n📂 ${tx.category} · 💼 ${acct}\n\nIt will sync to your app shortly.`;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', pending: pending.length }));

// Twilio WhatsApp webhook — NO auth (Twilio calls this)
app.post('/webhook/whatsapp', (req, res) => {
  const body = (req.body.Body || '').trim();
  const tx   = parseMessage(body);

  let reply;
  if (tx) {
    pending.push(tx);
    reply = confirmMessage(tx);
  } else {
    reply = [
      '❓ Could not understand that.',
      '',
      'Try:',
      '  paid 50 coffee',
      '  paid 100000 lbp uber',
      '  paid 30 bank lunch',
      '  received 1500 salary',
      '  spent 200 savings shopping',
    ].join('\n');
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${reply}</Message></Response>`);
});

// ── API endpoints (called by the React app) ───────────────────────────────────

function checkKey(req, res) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

// Get all pending transactions
app.get('/api/pending', (req, res) => {
  if (!checkKey(req, res)) return;
  res.json(pending);
});

// Mark one or more as processed (removes them)
app.post('/api/processed', (req, res) => {
  if (!checkKey(req, res)) return;
  const ids = req.body.ids || [];
  ids.forEach((id) => {
    const idx = pending.findIndex((t) => t.id === id);
    if (idx !== -1) pending.splice(idx, 1);
  });
  res.json({ ok: true, remaining: pending.length });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ WhatsApp bridge running on port ${PORT}`));
