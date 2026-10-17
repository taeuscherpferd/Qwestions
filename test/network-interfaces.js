const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const adminKey = 'network-regression-test';

// Run the actual server with isolated saved data and a simulated OS interface API.
const launcher = `
  const os = require('os');
  os.networkInterfaces = () => {
    if (process.env.QWESTIONS_TEST_NETWORK === 'unavailable') {
      const error = new Error('uv_interface_addresses returned Unknown system error 22');
      error.code = 'ERR_SYSTEM_ERROR';
      throw error;
    }
    if (process.env.QWESTIONS_TEST_NETWORK === 'empty') return {};
    return {
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      wifi: [
        { family: 'IPv4', address: '192.168.1.23', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '169.254.1.2', internal: false }
      ],
      ethernet: [{ family: 4, address: '10.0.0.23', internal: false }]
    };
  };
  const http = require('http');
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (port, host, callback) {
    this.once('listening', () => process.send({ port: this.address().port }));
    return listen.call(this, 0, host, callback);
  };
  require('./server.js');
`;

function request(port, route, body, method, key = adminKey) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route,
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: (res.headers['content-type'] || '').includes('application/json')
              ? JSON.parse(buffer.toString()) : buffer
          });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Server request timed out.')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function checkServer(mode, expectedAddresses) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwestions-network-'));
  fs.copyFileSync(path.join(root, 'server.js'), path.join(directory, 'server.js'));
  const child = spawn(process.execPath, ['-e', launcher], {
    cwd: directory,
    env: Object.assign({}, process.env, {
      NODE_PATH: path.join(root, 'node_modules'), HOST: '127.0.0.1', PORT: '3000',
      QWESTIONS_ADMIN_KEY: adminKey, QWESTIONS_TEST_NETWORK: mode
    }),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timed out.')), 10000);
      child.once('message', (message) => { clearTimeout(timeout); resolve(message.port); });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error('Server exited during startup (' + code + '): ' + errors));
      });
    });
    // Repeated teacher refreshes must work as well as startup.
    for (let refresh = 0; refresh < 2; refresh++) {
      const admin = await request(port, '/api/admin');
      assert.strictEqual(admin.status, 200, mode + ': teacher page must remain usable');
      assert.deepStrictEqual(admin.body.lanAddresses, expectedAddresses);
    }

    if (mode === 'unavailable') {
      const admin = await request(port, '/api/admin');
      const sessionId = admin.body.currentSessionId;
      const created = await request(port, '/api/questions', {
        sessionId, prompt: 'What did you learn?', type: 'text'
      });
      assert.strictEqual(created.status, 201);
      const questionId = created.body.question.id;
      assert.strictEqual((await request(port, '/api/questions/' + questionId + '/open', {})).status, 200);
      assert.strictEqual((await request(port, '/api/student/' + sessionId)).body.questions[0].id, questionId);
      const answer = 'Manual Wi-Fi addresses work.';
      assert.strictEqual((await request(port, '/api/answers', {
        sessionId, questionId, participantId: 'student-1', name: 'Student', answer
      })).status, 200);
      const saved = JSON.parse(fs.readFileSync(path.join(directory, 'data', 'store.json'), 'utf8'));
      assert.strictEqual(saved.sessions[0].responses[0].answer, answer);
      const csv = await request(port, '/api/export/' + sessionId + '.csv');
      assert.strictEqual(csv.status, 200);
      assert(csv.body.toString().includes(answer));
      const qr = await request(port, '/api/qr?text=' + encodeURIComponent('http://192.168.1.23:3000/join/' + sessionId));
      assert.strictEqual(qr.status, 200);
      assert(qr.headers['content-type'].startsWith('image/svg+xml'));
      assert(qr.body.toString().includes('<svg xmlns="http://www.w3.org/2000/svg"'));
      assert.strictEqual((await request(port, '/api/qr')).status, 400);

      const second = await request(port, '/api/questions', {
        sessionId, prompt: 'Choose a color.', type: 'choice', choices: ['Green', 'Blue']
      });
      assert.strictEqual(second.status, 201);
      const secondId = second.body.question.id;
      assert.strictEqual((await request(port, '/api/student/' + sessionId)).body.questions.length, 1, 'Drafts stay hidden');
      await request(port, '/api/questions/' + secondId + '/open', {});
      const studentRoute = '/api/student/' + sessionId + '?participantId=student-1';
      let student = await request(port, studentRoute);
      assert.deepStrictEqual(student.body.questions.map((question) => question.id), [questionId, secondId]);
      assert.strictEqual(student.body.responses[0].answer, answer);
      assert.strictEqual((await request(port, '/api/answers', {
        sessionId, questionId: secondId, participantId: 'student-1', name: 'Student', answer: 'Green'
      })).status, 200);
      student = await request(port, studentRoute);
      assert.strictEqual(student.body.responses.length, 2, 'Both questions accept independent answers');
      assert.deepStrictEqual((await request(port, '/api/student/' + sessionId + '?participantId=someone-else')).body.responses, []);

      await request(port, '/api/questions/' + questionId + '/close', {});
      assert.deepStrictEqual((await request(port, studentRoute)).body.questions.map((question) => question.id), [secondId]);
      assert.strictEqual((await request(port, '/api/questions/' + questionId, undefined, 'DELETE', '')).status, 401);
      assert.strictEqual((await request(port, '/api/questions/' + questionId, undefined, 'DELETE')).status, 200);
      let teacher = (await request(port, '/api/admin')).body.selectedSession;
      assert.deepStrictEqual(teacher.questions.map((question) => question.id), [secondId]);
      assert.strictEqual(teacher.responses.length, 1, 'Deleting a question removes only its own responses');
      assert.strictEqual(teacher.responses[0].questionId, secondId);
      const afterDeletion = JSON.parse(fs.readFileSync(path.join(directory, 'data', 'store.json'), 'utf8')).sessions[0];
      assert.strictEqual(afterDeletion.questions.length, 1);
      assert.strictEqual(afterDeletion.responses.length, 1);
      assert.strictEqual((await request(port, '/api/questions/' + questionId, undefined, 'DELETE')).status, 404);
      assert.strictEqual((await request(port, '/api/questions/' + questionId + '/open', {})).status, 404);
      assert.strictEqual((await request(port, '/api/answers', {
        sessionId, questionId, participantId: 'student-1', name: 'Student', answer
      })).status, 409);
      const remainingCsv = (await request(port, '/api/export/' + sessionId + '.csv')).body.toString();
      assert(!remainingCsv.includes(answer));
      assert(remainingCsv.includes('Green'));

      await request(port, '/api/sessions', { name: 'Next class' });
      const ended = (await request(port, studentRoute)).body;
      assert.strictEqual(ended.session.isCurrent, false);
      assert.deepStrictEqual(ended.questions, [], 'A new class closes all questions in the previous class');
      assert.strictEqual((await request(port, '/api/questions/' + secondId, undefined, 'DELETE')).status, 200, 'Saved classes also allow deletion');
      teacher = (await request(port, '/api/admin?sessionId=' + sessionId)).body.selectedSession;
      assert.strictEqual(teacher.questions.length, 0);
      assert.strictEqual(teacher.responses.length, 0);
      console.log('Passed: SVG QR, multiple questions, independent answers, protected deletion, and saved classes');
    }
    console.log('Passed: ' + mode + ' network interfaces');
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

(async () => {
  await checkServer('unavailable', []);
  await checkServer('empty', []);
  await checkServer('available', [
    { name: 'wifi', address: '192.168.1.23' },
    { name: 'ethernet', address: '10.0.0.23' }
  ]);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
