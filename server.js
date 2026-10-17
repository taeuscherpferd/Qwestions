const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin-key.txt');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 1024 * 1024;

function id() {
  return crypto.randomBytes(5).toString('hex');
}

function newSession(name) {
  return {
    id: id(),
    name: name || 'New class',
    createdAt: new Date().toISOString(),
    questions: [],
    responses: []
  };
}

function loadStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (saved && Array.isArray(saved.sessions)) return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read saved data at ' + STORE_FILE + ': ' + error.message);
  }
  const session = newSession('New class');
  return { currentSessionId: session.id, sessions: [session] };
}

let store = loadStore();

function loadAdminToken() {
  if (process.env.QWESTIONS_ADMIN_KEY) return process.env.QWESTIONS_ADMIN_KEY;
  try {
    const saved = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = crypto.randomBytes(18).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

const adminToken = loadAdminToken();

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = STORE_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
  fs.renameSync(temporary, STORE_FILE);
}

if (!store.sessions.length) {
  const session = newSession('New class');
  store.sessions.push(session);
  store.currentSessionId = session.id;
}
if (!store.sessions.some((session) => session.id === store.currentSessionId)) {
  store.currentSessionId = store.sessions[0].id;
}
saveStore();

function currentSession() {
  return store.sessions.find((session) => session.id === store.currentSessionId);
}

function lanAddresses() {
  const result = [];
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch (error) {
    // Some environments, including iSH, cannot enumerate network interfaces.
    // Address discovery is optional; the teacher can enter the Wi-Fi address.
    return result;
  }
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((address) => {
      const family = address.family;
      if ((family === 'IPv4' || family === 4) && !address.internal && !address.address.startsWith('169.254.')) {
        result.push({ name, address: address.address });
      }
    });
  });
  return result;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (part) => {
      body += part;
      if (body.length > MAX_BODY) {
        reject(Object.assign(new Error('Request is too large.'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(Object.assign(new Error('Please send valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function findSession(sessionId) {
  return store.sessions.find((session) => session.id === sessionId);
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function sendFile(response, filename) {
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
  };
  fs.readFile(filename, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(content);
  });
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const adminRoute = (request.method === 'GET' && (pathname === '/api/admin' || /^\/api\/export\/[a-f0-9]+\.csv$/.test(pathname))) ||
    (request.method === 'POST' && (pathname === '/api/sessions' || pathname === '/api/questions' || /^\/api\/questions\/[a-f0-9]+\/(open|close)$/.test(pathname))) ||
    (request.method === 'DELETE' && /^\/api\/questions\/[a-f0-9]+$/.test(pathname));
  if (adminRoute) {
    const provided = Buffer.from(request.headers['x-admin-key'] || '');
    const expected = Buffer.from(adminToken);
    const allowed = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!allowed) {
      sendJson(response, 401, { error: 'Host key required.' });
      return;
    }
  }

  if (request.method === 'GET' && pathname === '/api/admin') {
    const session = findSession(url.searchParams.get('sessionId')) || currentSession();
    sendJson(response, 200, {
      currentSessionId: store.currentSessionId,
      selectedSession: session,
      sessions: store.sessions.map(({ id: sessionId, name, createdAt }) => ({
        id: sessionId,
        name,
        createdAt,
        isCurrent: sessionId === store.currentSessionId
      })),
      lanAddresses: lanAddresses(),
      port: PORT
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJson(request);
    const name = safeText(body.name, 80) || 'New class';
    const previous = currentSession();
    if (previous) {
      previous.questions.forEach((question) => {
        if (question.status === 'open') {
          question.status = 'closed';
          question.closedAt = new Date().toISOString();
        }
      });
    }
    const session = newSession(name);
    store.sessions.unshift(session);
    store.currentSessionId = session.id;
    saveStore();
    sendJson(response, 201, { session });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/questions') {
    const body = await readJson(request);
    const session = findSession(body.sessionId);
    if (!session || session.id !== store.currentSessionId) {
      sendJson(response, 404, { error: 'Start a new class before adding questions.' });
      return;
    }
    const prompt = safeText(body.prompt, 500);
    const type = body.type === 'text' ? 'text' : 'choice';
    const choices = type === 'choice' && Array.isArray(body.choices)
      ? body.choices.map((choice) => safeText(choice, 160)).filter(Boolean).slice(0, 12)
      : [];
    if (!prompt) {
      sendJson(response, 400, { error: 'Write a question first.' });
      return;
    }
    if (type === 'choice' && choices.length < 2) {
      sendJson(response, 400, { error: 'Add at least two answer choices.' });
      return;
    }
    const question = {
      id: id(),
      prompt,
      type,
      choices,
      status: 'draft',
      createdAt: new Date().toISOString()
    };
    session.questions.push(question);
    saveStore();
    sendJson(response, 201, { question });
    return;
  }

  const questionAction = pathname.match(/^\/api\/questions\/([a-f0-9]+)\/(open|close)$/);
  if (request.method === 'POST' && questionAction) {
    const session = currentSession();
    const question = session.questions.find((item) => item.id === questionAction[1]);
    if (!question) {
      sendJson(response, 404, { error: 'Question not found in the current class.' });
      return;
    }
    const now = new Date().toISOString();
    if (questionAction[2] === 'open') {
      question.status = 'open';
      question.openedAt = now;
      delete question.closedAt;
    } else {
      question.status = 'closed';
      question.closedAt = now;
    }
    saveStore();
    sendJson(response, 200, { question });
    return;
  }

  const deleteQuestion = pathname.match(/^\/api\/questions\/([a-f0-9]+)$/);
  if (request.method === 'DELETE' && deleteQuestion) {
    const questionId = deleteQuestion[1];
    const session = store.sessions.find((item) => item.questions.some((question) => question.id === questionId));
    if (!session) {
      sendJson(response, 404, { error: 'Question not found.' });
      return;
    }
    session.questions = session.questions.filter((question) => question.id !== questionId);
    session.responses = session.responses.filter((answer) => answer.questionId !== questionId);
    saveStore();
    sendJson(response, 200, { deletedQuestionId: questionId });
    return;
  }

  const studentRoute = pathname.match(/^\/api\/student\/([a-f0-9]+)$/);
  if (request.method === 'GET' && studentRoute) {
    const session = findSession(studentRoute[1]);
    if (!session) {
      sendJson(response, 404, { error: 'This class link has expired.' });
      return;
    }
    const questions = session.questions.filter((item) => item.status === 'open');
    const participantId = safeText(url.searchParams.get('participantId'), 100);
    const responses = participantId
      ? session.responses.filter((item) => item.participantId === participantId && questions.some((question) => question.id === item.questionId))
      : [];
    sendJson(response, 200, {
      session: { id: session.id, name: session.name, isCurrent: session.id === store.currentSessionId },
      questions,
      responses
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/answers') {
    const body = await readJson(request);
    const session = findSession(body.sessionId);
    if (!session || session.id !== store.currentSessionId) {
      sendJson(response, 409, { error: 'This class has ended. Ask the teacher for the new link.' });
      return;
    }
    const question = session.questions.find((item) => item.id === body.questionId && item.status === 'open');
    if (!question) {
      sendJson(response, 409, { error: 'This question is closed.' });
      return;
    }
    const participantId = safeText(body.participantId, 100);
    const name = safeText(body.name, 80);
    if (!participantId || !name) {
      sendJson(response, 400, { error: 'Enter your name before answering.' });
      return;
    }
    let answer = '';
    if (question.type === 'choice') {
      answer = safeText(body.answer, 160);
      if (!question.choices.includes(answer)) {
        sendJson(response, 400, { error: 'Choose one of the listed answers.' });
        return;
      }
    } else {
      answer = safeText(body.answer, 4000);
      if (!answer) {
        sendJson(response, 400, { error: 'Write a short answer first.' });
        return;
      }
    }
    const now = new Date().toISOString();
    let saved = session.responses.find((item) => item.questionId === question.id && item.participantId === participantId);
    if (saved) {
      saved.name = name;
      saved.answer = answer;
      saved.updatedAt = now;
    } else {
      saved = {
        questionId: question.id,
        participantId,
        name,
        answer,
        submittedAt: now,
        updatedAt: now
      };
      session.responses.push(saved);
    }
    saveStore();
    sendJson(response, 200, { response: saved });
    return;
  }

  const exportRoute = pathname.match(/^\/api\/export\/([a-f0-9]+)\.csv$/);
  if (request.method === 'GET' && exportRoute) {
    const session = findSession(exportRoute[1]);
    if (!session) {
      sendJson(response, 404, { error: 'Class not found.' });
      return;
    }
    const rows = [['Class', 'Question', 'Type', 'Participant', 'Answer', 'Submitted', 'Last updated']];
    session.questions.forEach((question) => {
      session.responses.filter((item) => item.questionId === question.id).forEach((item) => {
        rows.push([
          session.name,
          question.prompt,
          question.type === 'text' ? 'Written' : 'Multiple choice',
          item.name,
          item.answer,
          item.submittedAt,
          item.updatedAt
        ]);
      });
    });
    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="qwestions-' + session.id + '.csv"',
      'Cache-Control': 'no-store'
    });
    response.end(csv);
    return;
  }

  const qrRoute = pathname === '/api/qr';
  if (request.method === 'GET' && qrRoute) {
    const text = safeText(url.searchParams.get('text'), 2000);
    if (!text) {
      sendJson(response, 400, { error: 'Missing QR link.' });
      return;
    }
    try {
      const svg = await QRCode.toString(text, {
        type: 'svg',
        width: 280,
        margin: 4,
        errorCorrectionLevel: 'M'
      });
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(svg);
    } catch (error) {
      sendJson(response, 400, { error: 'Could not create the QR code.' });
    }
    return;
  }

  sendJson(response, 404, { error: 'API route not found.' });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }
    if (url.pathname === '/') {
      sendFile(response, path.join(PUBLIC, 'index.html'));
      return;
    }
    if (/^\/join\/[a-f0-9]+\/?$/.test(url.pathname)) {
      sendFile(response, path.join(PUBLIC, 'join.html'));
      return;
    }
    if (url.pathname === '/styles.css' || url.pathname === '/admin.js' || url.pathname === '/student.js') {
      sendFile(response, path.join(PUBLIC, path.basename(url.pathname)));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Something went wrong. Please try again.' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('Qwestions is running on port ' + PORT + '.');
  console.log('Host key: ' + adminToken);
  console.log('On this device: http://localhost:' + PORT);
  const addresses = lanAddresses();
  addresses.forEach((item) => console.log('On this network: http://' + item.address + ':' + PORT));
  if (!addresses.length) {
    console.log('Automatic Wi-Fi address detection is unavailable. The server is still running.');
    console.log('Find the iPad IP address in Settings > Wi-Fi > (i), then enter http://<IP-address>:' + PORT + ' in the teacher page.');
  }
  console.log('Keep this terminal open while the class is using the app.');
});
