(() => {
  const $ = (selector) => document.querySelector(selector);
  const sessionId = window.location.pathname.split('/')[2];
  const storageKey = 'qwestions:participant:' + sessionId;
  let identity = null;
  let currentQuestionId = null;
  let polling = false;

  function makeId() {
    if (window.crypto && window.crypto.getRandomValues) {
      const values = new Uint8Array(16);
      window.crypto.getRandomValues(values);
      return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function readIdentity() {
    try { identity = JSON.parse(localStorage.getItem(storageKey)); } catch (error) { identity = null; }
    if (!identity || !identity.id || !identity.name) identity = null;
  }

  function saveIdentity() {
    localStorage.setItem(storageKey, JSON.stringify(identity));
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function showIdentity() {
    $('#identity-panel').classList.remove('hidden');
    $('#waiting-panel').classList.add('hidden');
    $('#question-panel').classList.add('hidden');
    $('#student-name').value = identity ? identity.name : $('#student-name').value;
    $('#student-name').focus();
  }

  function join() {
    const name = $('#student-name').value.trim();
    if (!name) {
      $('#join-error').textContent = 'Enter your name to join.';
      return;
    }
    identity = identity || { id: makeId() };
    identity.name = name.slice(0, 80);
    saveIdentity();
    $('#join-error').textContent = '';
    $('#identity-panel').classList.add('hidden');
    currentQuestionId = null;
    poll();
  }

  function renderWaiting(ended) {
    currentQuestionId = null;
    $('#identity-panel').classList.add('hidden');
    $('#question-panel').classList.add('hidden');
    $('#waiting-panel').classList.remove('hidden');
    $('#signed-in-name').textContent = identity.name;
    $('#waiting-panel h2').textContent = ended ? 'This class has ended.' : "You're in.";
    $('#waiting-panel > p').textContent = ended
      ? 'Ask your teacher for the new class QR code to join the next class.'
      : 'There isn’t a question open right now. This page will update when your teacher opens one.';
  }

  function renderQuestion(question, savedResponse) {
    if (currentQuestionId === question.id) return;
    currentQuestionId = question.id;
    $('#waiting-panel').classList.add('hidden');
    $('#identity-panel').classList.add('hidden');
    const panel = $('#question-panel');
    panel.classList.remove('hidden');
    const content = document.createElement('div');
    content.innerHTML = '<p class="eyebrow">YOUR TURN</p><h2></h2><form id="answer-form"></form><p class="answer-status" role="status"></p>';
    content.querySelector('h2').textContent = question.prompt;
    const form = content.querySelector('form');
    if (question.type === 'choice') {
      const options = document.createElement('div');
      options.className = 'student-options';
      question.choices.forEach((choice) => {
        const label = document.createElement('label');
        label.className = 'student-option';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'answer';
        input.value = choice;
        input.required = true;
        input.checked = savedResponse && savedResponse.answer === choice;
        const text = document.createElement('span');
        text.textContent = choice;
        label.append(input, text);
        options.appendChild(label);
      });
      form.appendChild(options);
    } else {
      const textarea = document.createElement('textarea');
      textarea.name = 'answer';
      textarea.maxLength = 4000;
      textarea.required = true;
      textarea.placeholder = 'Write your answer here…';
      textarea.value = savedResponse ? savedResponse.answer : '';
      form.appendChild(textarea);
    }
    const submitRow = document.createElement('div');
    submitRow.className = 'student-submit';
    submitRow.innerHTML = '<span class="hint">You can change your answer while the question is open.</span><button class="button button-accent" type="submit">Send answer ↗</button>';
    form.appendChild(submitRow);
    content.querySelector('.answer-status').textContent = savedResponse ? 'Your answer is saved. You can update it while this question stays open.' : '';
    panel.replaceChildren(content);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const answer = question.type === 'choice'
        ? (new FormData(form).get('answer') || '')
        : form.elements.answer.value.trim();
      const status = panel.querySelector('.answer-status');
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status.textContent = 'Sending…';
      try {
        await api('/api/answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, questionId: question.id, participantId: identity.id, name: identity.name, answer })
        });
        status.textContent = 'Answer saved. You can change it while this question stays open.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  async function poll() {
    if (!identity || polling) return;
    polling = true;
    try {
      const data = await api('/api/student/' + encodeURIComponent(sessionId) + '?participantId=' + encodeURIComponent(identity.id));
      $('#student-session').textContent = data.session.name;
      $('#student-error').classList.add('hidden');
      if (!data.session.isCurrent) renderWaiting(true);
      else if (data.question) renderQuestion(data.question, data.response);
      else renderWaiting(false);
    } catch (error) {
      $('#student-error').textContent = error.message;
      $('#student-error').classList.remove('hidden');
    } finally {
      polling = false;
    }
  }

  $('#join-button').addEventListener('click', join);
  $('#student-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') join(); });
  $('#change-name').addEventListener('click', showIdentity);
  readIdentity();
  if (identity) {
    $('#student-session').textContent = 'Connecting…';
    poll();
  } else {
    $('#student-session').textContent = 'Add your name to join.';
    showIdentity();
  }
  window.setInterval(poll, 2200);
})();
