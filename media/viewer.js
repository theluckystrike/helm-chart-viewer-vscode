/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = {
    name: '',
    summary: null,
    pageSize: 100,
    page: 0,
    total: 0,
    rows: [],
    selected: null,
    tab: 'keys',
    req: 0,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function post(msg) {
    state.req += 1;
    vscode.postMessage({ ...msg, req: state.req });
  }

  function fmtSize(n) {
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  }

  function renderShell() {
    const s = state.summary;
    const errChip = s.errorCount > 0 ? `<span class="chip bad"><b>Errors:</b> ${s.errorCount}</span>` : '<span class="chip"><b>Checks:</b> OK</span>';
    const warnChip = s.warningCount > 0 ? `<span class="chip warn"><b>Warnings:</b> ${s.warningCount}</span>` : '';
    const secChip = s.secretCount > 0 ? `<span class="chip bad"><b>Secrets:</b> ${s.secretCount}</span>` : '';

    app.innerHTML = `
      <div class="top">
        <div class="title">
          <span class="name">${esc(state.name)}</span>
          <span class="kind">${esc(s.fileKind)} · ${fmtSize(s.fileSize)} · 100% offline</span>
        </div>
        <div class="summary">
          <span class="chip"><b>Keys:</b> ${s.keyCount}</span>
          <span class="chip"><b>Dependencies:</b> ${s.dependencyCount}</span>
          ${secChip}${errChip}${warnChip}
        </div>
        <div class="toolbar">
          <input id="q" type="search" placeholder="Filter keys by dot-path, value or type..." />
          <select id="statusFilter">
            <option value="">All statuses</option>
            <option value="error">Has errors / secrets</option>
            <option value="warning">Has warnings</option>
            <option value="secrets">Secrets only</option>
            <option value="ok">Clean</option>
          </select>
          <button id="filterBtn" type="button">Filter</button>
          <span class="sep"></span>
          <div id="protools"></div>
        </div>
        <div class="tabs">
          <button class="tab on" data-tab="keys" type="button">Values Explorer (${s.keyCount})</button>
          <button class="tab" data-tab="deps" type="button">Chart &amp; Dependencies (${s.dependencyCount})</button>
          <button class="tab" data-tab="findings" type="button">Static Checks (${s.errorCount + s.warningCount})</button>
        </div>
        <div id="hint" class="hint"></div>
      </div>
      <div class="main">
        <div id="leftPane" class="tablewrap"></div>
        <div id="detail" class="detail"><p class="muted">Select a value key to inspect its path, type, default value and security checks.</p></div>
      </div>
      <div class="pager">
        <button id="prev" type="button">Prev</button>
        <span id="pageInfo"></span>
        <button id="next" type="button">Next</button>
      </div>
    `;

    const q = document.getElementById('q');
    const stSel = document.getElementById('statusFilter');
    const runFilter = () => {
      state.page = 0;
      post({ type: 'filter', filter: { text: q.value, status: stSel.value } });
    };
    document.getElementById('filterBtn').addEventListener('click', runFilter);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runFilter(); });
    stSel.addEventListener('change', runFilter);

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        state.tab = btn.dataset.tab;
        renderPane();
      });
    });

    document.getElementById('prev').addEventListener('click', () => {
      if (state.page > 0) { state.page -= 1; loadPage(); }
    });
    document.getElementById('next').addEventListener('click', () => {
      if ((state.page + 1) * state.pageSize < state.total) { state.page += 1; loadPage(); }
    });
  }

  function loadPage() {
    post({ type: 'page', from: state.page * state.pageSize, n: state.pageSize });
  }

  function renderPane() {
    const left = document.getElementById('leftPane');
    const pager = document.querySelector('.pager');
    const s = state.summary;

    if (state.tab === 'deps') {
      pager.style.display = 'none';
      const meta = s.metadata;
      const metaRows = meta
        ? Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `<tr><td><strong>${esc(k)}</strong></td><td><code>${esc(v)}</code></td></tr>`).join('')
        : '';
      const depRows = (s.dependencies || []).map((d) => `<tr>
        <td><strong>${esc(d.name)}</strong></td>
        <td><code>${esc(d.version || '-')}</code></td>
        <td><code>${esc(d.repository || '-')}</code></td>
        <td>${esc(d.alias || '-')}</td>
        <td>${esc(d.condition || '-')}</td>
      </tr>`).join('');
      left.innerHTML = `
        ${metaRows ? `<div style="padding:8px 8px 4px;font-weight:600;">Chart Metadata</div><table id="grid"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${metaRows}</tbody></table>` : ''}
        <div style="padding:10px 8px 4px;font-weight:600;">Dependencies (${s.dependencyCount})</div>
        <table id="grid"><thead><tr><th>Name</th><th>Version</th><th>Repository</th><th>Alias</th><th>Condition</th></tr></thead>
        <tbody>${depRows || '<tr><td colspan="5" class="muted">No chart dependencies listed in this file.</td></tr>'}</tbody></table>
      `;
      return;
    }

    if (state.tab === 'findings') {
      pager.style.display = 'none';
      const fRows = (s.findings || []).map((f) => `<tr>
        <td class="${f.severity === 'error' ? 'bad' : ''}">${esc(f.severity.toUpperCase())}</td>
        <td>${esc(f.category)}</td>
        <td><code>${esc(f.keyPath)}</code></td>
        <td class="num">${f.line}</td>
        <td>${esc(f.finding)}</td>
      </tr>`).join('');
      left.innerHTML = fRows
        ? `<table id="grid"><thead><tr><th>Severity</th><th>Category</th><th>Key Path</th><th class="num">Line</th><th>Finding</th></tr></thead><tbody>${fRows}</tbody></table>`
        : '<p class="muted" style="padding:12px;">All Helm static security and configuration checks passed.</p>';
      return;
    }

    pager.style.display = 'flex';
    const body = state.rows.map((r) => {
      const sel = state.selected === r.index ? ' class="sel"' : '';
      const sBadge = r.isSecret ? '<span class="badge-mismatch">SECRET</span>' : '';
      const statusCls = r.status === 'error' ? 'bad' : (r.status === 'ok' ? 'ok' : '');
      return `<tr data-idx="${r.index}"${sel}>
        <td class="num">${r.line}</td>
        <td><code>${esc(r.path)}</code>${sBadge}</td>
        <td>${esc(r.type)}</td>
        <td><code>${esc(r.displayValue)}</code></td>
        <td class="${statusCls}">${esc(r.status.toUpperCase())}</td>
      </tr>`;
    }).join('');
    left.innerHTML = `<table id="grid">
      <thead><tr><th class="num">Line</th><th>Key Path</th><th>Type</th><th>Value</th><th>Status</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted">No matching value keys.</td></tr>'}</tbody>
    </table>`;

    left.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const idx = Number(tr.dataset.idx);
        state.selected = idx;
        left.querySelectorAll('tbody tr').forEach((row) => row.classList.toggle('sel', Number(row.dataset.idx) === idx));
        post({ type: 'detail', index: idx });
      });
    });

    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    document.getElementById('pageInfo').textContent = `Page ${state.page + 1} of ${pages} (${state.total} keys)`;
    document.getElementById('prev').disabled = state.page <= 0;
    document.getElementById('next').disabled = (state.page + 1) * state.pageSize >= state.total;
  }

  function renderDetail(d) {
    const el = document.getElementById('detail');
    if (!d) {
      el.innerHTML = '<p class="muted">No key selected.</p>';
      return;
    }
    const pairs = [
      ['Key Path', d.path],
      ['Type', d.type],
      ['Line', `L${d.line}`],
      ['Nesting Depth', String(d.depth)],
      ['Value', d.displayValue],
      ['Status', d.status.toUpperCase()],
    ];
    const rows = pairs.map(([k, v]) => `<tr><td><strong>${esc(k)}</strong></td><td><code>${esc(v)}</code></td></tr>`).join('');
    const fItems = (d.findings || []).map((f) => `<li class="${f.severity === 'error' ? 'bad' : ''}"><strong>[${esc(f.severity.toUpperCase())}] ${esc(f.category)}:</strong> ${esc(f.finding)}</li>`).join('');
    el.innerHTML = `
      <div class="dhead"><strong>${esc(d.path)}</strong><span class="muted">${esc(d.type)}</span></div>
      <table class="splits"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
      ${fItems ? `<div class="attr-head"><strong>Findings (${d.findings.length})</strong></div><ul class="findings-list">${fItems}</ul>` : ''}
    `;
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        if (m.error) {
          app.innerHTML = `<div class="error"><strong>Could not open ${esc(m.name)}</strong><p>${esc(m.error)}</p></div>`;
          return;
        }
        state.name = m.name;
        state.summary = m.summary;
        state.pageSize = m.pageSize || 100;
        state.page = 0;
        renderShell();
        loadPage();
        return;
      case 'pageResult':
        state.total = m.total;
        state.rows = m.rows || [];
        renderPane();
        if (state.rows.length && state.selected == null) {
          state.selected = state.rows[0].index;
          post({ type: 'detail', index: state.selected });
        }
        return;
      case 'filterResult':
        state.total = m.count;
        document.getElementById('hint').textContent = m.count < m.total ? `Showing ${m.count} of ${m.total} keys.` : '';
        loadPage();
        return;
      case 'detailResult':
        renderDetail(m.detail);
        return;
      case 'zovoAlso': {
        const anchor = m.anchor && document.getElementById(m.anchor);
        if (anchor && m.html) {
          const old = document.querySelector('.zovo-also');
          if (old) old.remove();
          anchor.insertAdjacentHTML('afterend', m.html);
        }
        return;
      }
      case 'hint':
        if (document.getElementById('hint')) document.getElementById('hint').textContent = m.text || '';
        return;
      default:
    }
  });

  post({ type: 'ready' });
})();
