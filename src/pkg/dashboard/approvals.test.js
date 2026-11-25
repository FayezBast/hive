const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'static-src', 'js', 'approvals.js'), 'utf8')
  .split('function v4RefreshPanels()')[0];

function setup(post, pending, fetchPending = dto => ({ ok: true, json: async () => dto(pending) })) {
  const list = { innerHTML: '' };
  const count = { textContent: '' };
  const elements = {
    'approvals-section': { style: {} },
    'approvals-actions': { style: {} },
    'approvals-list': list,
    'approvals-selected-count': count,
  };
  const dto = rows => ({ enabled: true, items: rows.map(row => typeof row === 'string' ? { id: row } : row) });
  const toasts = [];
  const requests = [];
  const fetch = async (url, opts) => {
    requests.push(url);
    if (url === '/api/approvals/bulk') return post(JSON.parse(opts.body));
    return fetchPending(dto);
  };
  const desk = new Function('document', 'fetch', 'showToast', 'escapeHtml', 'refreshSectionCardShell',
    source + '\nreturn { approvalsResolveSelected, approvalsSetFilter, approvalsToggle, fetchApprovals, renderApprovals };')(
    { getElementById: id => elements[id] }, fetch, (message, type) => toasts.push({ message, type }),
    String, () => {});
  return { ...desk, dto, list, count, toasts, requests, actions: elements['approvals-actions'] };
}

test('bulk approval reports partial failures and keeps pending failures selected for retry', async () => {
  let complete;
  const desk = setup(body => {
    assert.deepEqual(body, { ids: ['resolved', 'failed', 'gone', 'missing'], approved: true });
    return new Promise(resolve => { complete = resolve; });
  }, ['failed', 'missing', 'later']);
  desk.renderApprovals(desk.dto(['resolved', 'failed', 'gone', 'missing', 'later']));
  desk.approvalsToggle('resolved');
  desk.approvalsToggle('failed');
  desk.approvalsToggle('gone');
  desk.approvalsToggle('missing');

  const request = desk.approvalsResolveSelected(true);
  desk.approvalsToggle('later');
  complete({ ok: true, json: async () => ({ results: [
    { id: 'resolved', ok: true },
    { id: 'failed', ok: false, error: 'could not write approval journal' },
    { id: 'gone', ok: false, error: 'already resolved' },
  ] }) });
  await request;

  assert.deepEqual(desk.requests, ['/api/approvals/bulk', '/api/approvals']);
  assert.equal(desk.count.textContent, '3 selected');
  assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="failed"/);
  assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="missing"/);
  assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="later"/);
  assert.doesNotMatch(desk.list.innerHTML, /data-arg0="(?:resolved|gone)"/);
  assert.deepEqual(desk.toasts, [{
    type: 'error',
    message: 'Bulk approve failed for 2 of 4 approvals. failed: could not write approval journal; gone: already resolved ' +
      'Could not confirm bulk approve for 1 of 4 approvals.',
  }]);
});

for (const { name, post, message } of [
  {
    name: 'HTTP rejection',
    post: () => ({ ok: false, status: 403, json: async () => ({ error: 'owner access required' }) }),
    message: 'Bulk reject failed for 1 of 1 approvals. owner access required',
  },
  {
    name: 'an expired session',
    post: () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'session_expired', detail: 'Sign in again and retry.' }),
    }),
    message: 'Bulk reject failed for 1 of 1 approvals. Sign in again and retry.',
  },
  {
    name: 'non-JSON gateway failure',
    post: () => ({ ok: false, status: 502, json: async () => { throw new Error(); } }),
    message: 'Could not confirm bulk reject for 1 of 1 approvals. HTTP 502',
  },
  {
    name: 'unreadable successful HTTP response',
    post: () => ({ ok: true, json: async () => { throw new Error(); } }),
    message: 'Could not confirm bulk reject for 1 of 1 approvals. Invalid bulk approval response',
  },
]) {
  test('bulk rejection reports ' + name + ' and preserves pending selections', async () => {
    const desk = setup(post, ['pending']);
    desk.renderApprovals(desk.dto(['pending']));
    desk.approvalsToggle('pending');
    await desk.approvalsResolveSelected(false);

    assert.deepEqual(desk.requests, ['/api/approvals/bulk', '/api/approvals']);
    assert.equal(desk.count.textContent, '1 selected');
    assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="pending"/);
    assert.deepEqual(desk.toasts, [{ type: 'error', message }]);
  });
}

test('a lost bulk response leaves the outcome unconfirmed and the pending item selected', async () => {
  const pending = ['applied', 'pending'];
  const desk = setup(() => {
    pending.shift();
    throw new Error('connection closed');
  }, pending);
  desk.renderApprovals(desk.dto(pending));
  desk.approvalsToggle('applied');
  desk.approvalsToggle('pending');

  await desk.approvalsResolveSelected(true);

  assert.equal(desk.count.textContent, '1 selected');
  assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="pending"/);
  assert.doesNotMatch(desk.list.innerHTML, /data-arg0="applied"/);
  assert.deepEqual(desk.toasts, [{
    type: 'error', message: 'Could not confirm bulk approve for 2 of 2 approvals. connection closed',
  }]);
});

test('an older poll cannot undo a confirmed result when its refresh fails', async () => {
  let finishPoll;
  const desk = setup(() => ({ ok: true, json: async () => ({ results: [
    { id: 'resolved', ok: true },
    { id: 'pending', ok: false, error: 'could not write approval journal' },
  ] }) }), [], dto => {
    if (finishPoll) return { ok: false, status: 503 };
    return new Promise(resolve => {
      finishPoll = () => resolve({ ok: true, json: async () => dto(['resolved', 'pending']) });
    });
  });
  desk.renderApprovals(desk.dto(['resolved', 'pending']));
  const poll = desk.fetchApprovals();
  desk.approvalsToggle('resolved');
  desk.approvalsToggle('pending');

  await desk.approvalsResolveSelected(true);
  finishPoll();
  await poll;

  assert.equal(desk.count.textContent, '1 selected');
  assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="pending"/);
  assert.doesNotMatch(desk.list.innerHTML, /data-arg0="resolved"/);
});

test('switching rule filters after a failed bulk action keeps retries scoped to visible rows', async () => {
  const pending = [
    { id: 'alpha', rule: 'rule A' },
    { id: 'beta', rule: 'rule B' },
  ];
  const submitted = [];
  const desk = setup(body => {
    submitted.push(body);
    if (submitted.length === 1) {
      return { ok: false, status: 502, json: async () => ({ error: 'try again' }) };
    }
    pending.pop();
    return { ok: true, json: async () => ({ results: [{ id: 'beta', ok: true }] }) };
  }, pending);

  desk.renderApprovals(desk.dto(pending));
  desk.approvalsSetFilter('rule A');
  desk.approvalsToggle('alpha');
  await desk.approvalsResolveSelected(true);
  assert.equal(desk.count.textContent, '1 selected');

  desk.approvalsSetFilter('rule B');
  assert.equal(desk.actions.style.display, 'none');
  await desk.approvalsResolveSelected(false);
  assert.equal(submitted.length, 1);
  desk.approvalsToggle('beta');
  assert.equal(desk.count.textContent, '1 selected');
  await desk.approvalsResolveSelected(false);

  assert.deepEqual(submitted, [{ ids: ['alpha'], approved: true }, { ids: ['beta'], approved: false }]);
  desk.approvalsSetFilter('rule A');
  assert.equal(desk.count.textContent, '1 selected');
  assert.match(desk.list.innerHTML, /checked data-change-action="approvalsToggle" data-arg0="alpha"/);
});
