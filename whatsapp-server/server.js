const express = require('express');
const cors    = require('cors');

const app     = express();
const API_KEY = process.env.API_KEY || 'changeme';

// Your Green API credentials (set as environment variables in Railway)
const GA_INSTANCE = process.env.GREEN_API_INSTANCE || '';
const GA_TOKEN    = process.env.GREEN_API_TOKEN    || '';

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── In-memory pending transactions ──────────────────────────────────────────
const pending = [];
let idCounter = 1;
const genId   = () => String(idCounter++);

// ─── Message parser ───────────────────────────────────────────────────────────
const CATEGORY_MAP = [
  [/(food|eat|lunch|dinner|breakfast|restaurant|snack|coffee|cafe|pizza|burger|shawarma|saj|falafel|manakish|sushi)/i, 'Food & Dining'],
  [/(uber|taxi|car|gas|fuel|parking|transport|bus|metro|bolt)/i,                                                       'Transportation'],
  [/(shop|clothes|shirt|shoes|jacket|mall|store|zara|h&m)/i,                                                           'Shopping'],
  [/(bill|electric|water|internet|phone|subscri|netflix|spotify)/i,                                                    'Bills & Utilities'],
  [/(doctor|pharmacy|medicine|hospital|clinic|health)/i,                                                               'Healthcare'],
  [/(cinema|movie|game|concert|entertainment|night out)/i,                                                             'Entertainment'],
  [/(school|tuition|course|book|education|university)/i,                                                               'Education'],
  [/(rent|housing|landlord|apartment)/i,                                                                               'Housing'],
  [/(salon|barber|haircut|gym|personal care)/i,                                                                        'Personal Care'],
  [/(travel|hotel|flight|trip|vacation)/i,                                                                             'Travel'],
  [/(salary|راتب)/i,                                                                                                    'Salary'],
  [/(freelance|project|client)/i,                                                                                      'Freelance'],
  [/(gift|هدية)/i,                                                                                                      'Gift'],
];

function guessCategory(text, type) {
  for (const [regex, cat] of CATEGORY_MAP) {
    if (regex.test(text)) return cat;
  }
  return 'Other';
}

function parseMessage(raw) {
  const text  = raw.trim();
  const lower = text.toLowerCase();

  const isExpense = /^(paid|spent|bought|exp|expense|-|صرفت|دفعت|اشتريت)/i.test(text);
  const isIncome  = /^(received|got|income|salary|earned|deposited|\+|استلمت|وصلني)/i.test(text);
  if (!isExpense && !isIncome) return null;
  const type = isIncome ? 'income' : 'expense';

  const amtMatch = text.match(/[\d,]+(?:\.\d+)?/);
  if (!amtMatch) return null;
  const amount = parseFloat(amtMatch[0].replace(/,/g, ''));
  if (!amount || isNaN(amount)) return null;

  const isLBP    = /\b(lbp|ll|lira|ل\.?ل|ليرة)\b/i.test(text);
  const currency = isLBP ? 'LBP' : 'USD';

  let account = 'wallet';
  if (/\bsavings\b/i.test(text)) account = 'savings';
  else if (/\b(bank|card|byblos|blom|audi|bankmed)\b/i.test(text)) account = 'bank';

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
  const sign = tx.type === 'income' ? '+' : '-';
  const amt  = tx.currency === 'LBP'
    ? `${tx.amount.toLocaleString()} LL`
    : `$${tx.amount.toFixed(2)}`;
  const acct = tx.account === 'wallet' ? 'Wallet' : tx.account === 'savings' ? 'Savings' : 'Bank';
  return `✅ Logged!\n${sign}${amt} · ${tx.title}\n📂 ${tx.category} · 💼 ${acct}\n\nSyncs to your app within 30 seconds.`;
}

async function sendReply(chatId, message) {
  if (!GA_INSTANCE || !GA_TOKEN) return;
  try {
    await fetch(
      `https://api.green-api.com/waInstance${GA_INSTANCE}/sendMessage/${GA_TOKEN}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chatId, message }),
      }
    );
  } catch (e) {
    console.error('Failed to send reply:', e.message);
  }
}

// ─── Store last 10 raw webhooks for debugging ─────────────────────────────────
const debugLog = [];

// ─── Green API webhook ────────────────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  // Log everything for debugging
  debugLog.unshift({ time: new Date().toISOString(), body });
  if (debugLog.length > 10) debugLog.pop();
  console.log('WEBHOOK RECEIVED:', JSON.stringify(body, null, 2));

  const type    = body?.typeWebhook;
  const msgType = body?.messageData?.typeMessage;

  // Accept incoming + outgoing messages
  const allowedWebhooks = ['incomingMessageReceived', 'outgoingMessageReceived'];
  if (!allowedWebhooks.includes(type)) return;

  // Extract text — handles both textMessage and extendedTextMessage
  let text = '';
  if (msgType === 'textMessage') {
    text = body?.messageData?.textMessageData?.textMessage || '';
  } else if (msgType === 'extendedTextMessage') {
    text = body?.messageData?.extendedTextMessageData?.text || '';
  }

  const chatId = body?.senderData?.chatId || '';
  if (!text || !chatId) return;

  const tx = parseMessage(text);
  if (tx) {
    pending.push(tx);
    await sendReply(chatId, confirmMessage(tx));
  } else {
    await sendReply(chatId, [
      '❓ Could not understand that.',
      '',
      'Try:',
      '  paid 50 coffee',
      '  paid 100000 lbp uber',
      '  paid 30 bank lunch',
      '  received 1500 salary',
      '  spent 200 savings shopping',
    ].join('\n'));
  }
});

// ─── React app polling endpoints ──────────────────────────────────────────────
function checkKey(req, res) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.get('/',              (req, res) => res.json({ status: 'ok', pending: pending.length }));
app.get('/debug',         (req, res) => { if (!checkKey(req, res)) return; res.json({ pending, debugLog }); });
app.get('/api/pending',   (req, res) => { if (!checkKey(req, res)) return; res.json(pending); });
app.post('/api/processed',(req, res) => {
  if (!checkKey(req, res)) return;
  (req.body.ids || []).forEach((id) => {
    const i = pending.findIndex((t) => t.id === id);
    if (i !== -1) pending.splice(i, 1);
  });
  res.json({ ok: true, remaining: pending.length });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ WhatsApp bridge running on port ${PORT}`));
