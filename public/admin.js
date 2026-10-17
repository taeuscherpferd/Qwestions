(() => {
  const $ = (selector) => document.querySelector(selector);
  const state = { sessionId: null, currentSessionId: null, selectedSession: null, lanAddresses: [], port: 3000, toastTimer: null, ready: false };
  const picker = $('#session-picker');
  const keyStorageName = 'qwestions:host-key';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400);
  }

  async function authorizedFetch(url, options) {
    const settings = options || {};
    const headers = Object.assign({}, settings.headers || {});
    const savedKey = localStorage.getItem(keyStorageName) || '';
    if (savedKey) headers['X-Admin-Key'] = savedKey;
    let response = await fetch(url, Object.assign({}, settings, { headers }));
    if (response.status === 401) {
      const entered = window.prompt('Enter the host key shown in the iSH terminal:');
      if (!entered) throw new Error('Host key is required to manage this class.');
      localStorage.setItem(keyStorageName, entered.trim());
      headers['X-Admin-Key'] = entered.trim();
      response = await fetch(url, Object.assign({}, settings, { headers }));
    }
    return response;
  }

  async function api(url, options) {
    const response = await authorizedFetch(url, options);
    const data = response.headers.get('content-type') && response.headers.get('content-type').includes('application/json')
      ? await response.json()
      : {};
    if (!response.ok) throw new Error(response.status === 401 ? 'That host key did not match. Reload and try again.' : data.error || 'Something went wrong.');
    return data;
  }

  function setHostDefault() {
    const input = $('#host-address');
    input.placeholder = 'http://192.168.1.23:' + state.port;
    if (input.value.trim()) {
      updateJoinLink();
      return;
    }
    const here = new URL(window.location.href);
    const isLocal = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(here.hostname);
    if (isLocal) {
      input.value = state.lanAddresses.length
        ? here.protocol + '//' + state.lanAddresses[0].address + ':' + state.port
        : '';
    } else {
      input.value = here.origin;
    }
    updateJoinLink();
  }

  function updateJoinLink() {
    const session = state.selectedSession;
    const base = $('#host-address').value.trim().replace(/\/+$/, '');
    const link = $('#participant-link');
    const image = $('#qr-image');
    const isSavedClass = session && session.id !== state.currentSessionId;
    if (!session || !base || isSavedClass) {
      link.textContent = isSavedClass ? 'Saved class · QR unavailable' : session ? 'Enter the iPad’s Wi-Fi address above to create a QR code.' : '';
      link.removeAttribute('href');
      image.removeAttribute('src');
      image.alt = isSavedClass ? 'QR code unavailable for a saved class' : 'Enter the iPad’s Wi-Fi address to create a QR code';
      return;
    }
    let joinUrl;
    try {
      joinUrl = new URL(base);
      if (joinUrl.protocol !== 'http:' && joinUrl.protocol !== 'https:') throw new Error('Use an http or https address.');
      joinUrl.pathname = '/join/' + session.id;
      joinUrl.search = '';
      joinUrl.hash = '';
    } catch (error) {
      link.textContent = 'Enter a valid address, including http://';
      link.removeAttribute('href');
      image.removeAttribute('src');
      return;
    }
    link.href = joinUrl.toString();
    link.textContent = joinUrl.toString();
    image.src = '/api/qr?text=' + encodeURIComponent(joinUrl.toString());
    image.alt = 'QR code to join ' + session.name;
  }

  function renderChoiceResults(question, answers) {
    const total = answers.length;
    if (!total) return '<p class="hint">No responses yet.</p>';
    return '<div class="answer-results">' + question.choices.map((choice) => {
      const count = answers.filter((answer) => answer.answer === choice).length;
      const percent = total ? Math.round(count / total * 100) : 0;
      return '<div class="choice-result"><span class="choice-name" title="' + escapeHtml(choice) + '">' + escapeHtml(choice) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + percent + '%"></div></div><span class="choice-total">' + count + '</span></div>';
    }).join('') + '</div>';
  }

  function renderQuestion(question, session) {
    const answers = session.responses.filter((answer) => answer.questionId === question.id);
    const isOpen = question.status === 'open';
    const resultMarkup = question.type === 'choice'
      ? renderChoiceResults(question, answers)
      : (answers.length ? '<div class="answer-results">' + answers.slice().reverse().map((answer) => '<div class="written-answer"><p>' + escapeHtml(answer.answer) + '</p><span>' + escapeHtml(answer.name) + (answer.updatedAt ? ' · ' + new Date(answer.updatedAt).toLocaleString() : '') + '</span></div>').join('') + '</div>' : '<p class="hint">No responses yet.</p>');
    return '<article class="question-card ' + (isOpen ? 'is-open' : '') + '" data-question-id="' + question.id + '">' +
      '<div class="question-top"><div class="question-copy"><div class="question-meta"><span class="type-tag">' + (question.type === 'text' ? 'Written answer' : 'Multiple choice') + '</span><span aria-hidden="true">·</span><span class="status-tag ' + (isOpen ? 'open' : '') + '">' + (isOpen ? 'Open' : question.status === 'closed' ? 'Closed' : 'Draft') + '</span></div><p class="question-prompt">' + escapeHtml(question.prompt) + '</p></div>' +
      (session.id === state.currentSessionId ? '<div class="question-actions">' + (isOpen
        ? '<button class="small-button" data-action="close" data-id="' + question.id + '">Close</button>'
        : '<button class="small-button open-action" data-action="open" data-id="' + question.id + '">Open</button>') + '</div>' : '') + '</div>' +
      '<p class="response-count">' + answers.length + ' ' + (answers.length === 1 ? 'response' : 'responses') + (isOpen ? ' · accepting answers' : '') + '</p>' +
      '<details class="response-details"><summary>View responses</summary>' + resultMarkup + '</details></article>';
  }

  function render(data) {
    const expandedQuestions = new Set(Array.from($('#question-list').querySelectorAll('.question-card')).filter((card) => card.querySelector('details').open).map((card) => card.dataset.questionId));
    state.currentSessionId = data.currentSessionId;
    state.selectedSession = data.selectedSession;
    state.ready = true;
    state.lanAddresses = data.lanAddresses || [];
    state.port = data.port || 3000;

    const oldValue = picker.value;
    picker.replaceChildren();
    data.sessions.forEach((session) => {
      const option = document.createElement('option');
      option.value = session.id;
      option.textContent = session.name + (session.isCurrent ? ' · Current' : ' · Saved');
      picker.appendChild(option);
    });
    const selected = data.selectedSession.id;
    picker.value = data.sessions.some((session) => session.id === oldValue) && oldValue === selected ? oldValue : selected;

    $('#session-title').textContent = data.selectedSession.name;
    const isCurrent = data.selectedSession.id === data.currentSessionId;
    $('#archive-note').classList.toggle('hidden', isCurrent);
    $('#question-form').classList.toggle('hidden', !isCurrent);
    $('#export-link').href = '/api/export/' + data.selectedSession.id + '.csv';
    $('#question-count').textContent = data.selectedSession.questions.length + (data.selectedSession.questions.length === 1 ? ' question' : ' questions');
    const openQuestion = data.selectedSession.questions.find((question) => question.status === 'open');
    $('#room-status').textContent = !isCurrent ? 'Saved class' : openQuestion ? 'Question is open' : 'Ready when you are';
    $('#open-count').textContent = openQuestion ? '1' : '0';
    $('#response-count').textContent = data.selectedSession.responses.length;
    $('#question-list').innerHTML = data.selectedSession.questions.length
      ? data.selectedSession.questions.map((question) => renderQuestion(question, data.selectedSession)).join('')
      : '<div class="empty-state">Your question list is empty. Add a question above, then open it for the room.</div>';
    expandedQuestions.forEach((questionId) => {
      const card = $('#question-list [data-question-id="' + questionId + '"]');
      if (card) card.querySelector('details').open = true;
    });
    $('#choices-field').classList.toggle('hidden', $('#question-type').value !== 'choice');

    if (!state.hostInitialized) {
      setHostDefault();
      state.hostInitialized = true;
    } else {
      updateJoinLink();
    }
  }

  async function refresh(sessionId) {
    const suffix = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '';
    const data = await api('/api/admin' + suffix);
    render(data);
  }

  $('#question-type').addEventListener('change', () => {
    $('#choices-field').classList.toggle('hidden', $('#question-type').value !== 'choice');
  });
  $('#host-address').addEventListener('input', updateJoinLink);
  $('#session-picker').addEventListener('change', () => refresh(picker.value).catch((error) => showToast(error.message)));
  $('#new-session').addEventListener('click', async () => {
    const name = window.prompt('Name this class', 'New class');
    if (name === null) return;
    try {
      const data = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      state.hostInitialized = false;
      await refresh(data.session.id);
      showToast('New class is ready.');
    } catch (error) {
      showToast(error.message);
    }
  });

  $('#question-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('#form-message');
    message.textContent = '';
    const body = {
      sessionId: state.selectedSession.id,
      prompt: $('#prompt').value,
      type: $('#question-type').value,
      choices: $('#choices').value.split('\n').map((choice) => choice.trim()).filter(Boolean)
    };
    try {
      await api('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('#prompt').value = '';
      if (body.type === 'choice') $('#choices').value = '';
      await refresh(state.selectedSession.id);
      showToast('Question added.');
    } catch (error) {
      message.textContent = error.message;
    }
  });

  $('#question-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    button.disabled = true;
    try {
      await api('/api/questions/' + button.dataset.id + '/' + button.dataset.action, { method: 'POST' });
      await refresh(state.selectedSession.id);
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });

  $('#copy-link').addEventListener('click', async () => {
    const link = $('#participant-link').href;
    if (!link || link === window.location.href || !link.startsWith('http')) return showToast('Set the iPad address first.');
    try {
      await navigator.clipboard.writeText(link);
      showToast('Participant link copied.');
    } catch (error) {
      showToast('Copy is unavailable here. Use the QR code.');
    }
  });

  $('#export-link').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!state.selectedSession) return;
    try {
      const response = await authorizedFetch('/api/export/' + state.selectedSession.id + '.csv');
      if (!response.ok) {
        let message = 'Could not download responses.';
        try { message = (await response.json()).error || message; } catch (error) {}
        throw new Error(message);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = 'qwestions-' + state.selectedSession.id + '.csv';
      document.body.appendChild(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      showToast(error.message);
    }
  });

  refresh().catch((error) => {
    $('#session-title').textContent = 'Could not connect';
    showToast(error.message);
  });

  window.setInterval(() => {
    const activeElement = document.activeElement;
    if (document.hidden || !state.ready || !state.selectedSession || ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName)) return;
    refresh(state.selectedSession.id).catch(() => {});
  }, 3500);
})();
