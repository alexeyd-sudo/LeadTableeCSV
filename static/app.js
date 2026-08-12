(function () {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const dzFilename = document.getElementById('dz-filename');
  const uploadForm = document.getElementById('upload-form');
  const uploadBtn = document.getElementById('upload-btn');
  const uploadError = document.getElementById('upload-error');

  const panels = {
    upload: document.getElementById('step-upload'),
    scan: document.getElementById('step-scan'),
    map: document.getElementById('step-map'),
    result: document.getElementById('step-result'),
  };
  const dots = Array.from(document.querySelectorAll('.step-dot'));

  let state = {
    sessionId: null,
    sourceColumns: [],
    targetFields: [],
  };

  function showPanel(name, stepNum) {
    Object.values(panels).forEach(p => p.classList.remove('active'));
    panels[name].classList.add('active');
    dots.forEach(d => {
      const n = Number(d.dataset.step);
      d.classList.toggle('active', n === stepNum);
      d.classList.toggle('done', n < stepNum);
    });
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      onFileChosen();
    }
  });
  fileInput.addEventListener('change', onFileChosen);

  function onFileChosen() {
    const f = fileInput.files[0];
    dzFilename.textContent = f ? f.name : '';
    uploadBtn.disabled = !f;
  }

  uploadForm.addEventListener('submit', async e => {
    e.preventDefault();
    const f = fileInput.files[0];
    if (!f) return;
    uploadError.textContent = '';
    uploadBtn.disabled = true;

    showPanel('scan', 2);

    const fd = new FormData();
    fd.append('file', f);

    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Ошибка загрузки');

      state.sessionId = data.session_id;
      state.sourceColumns = data.source_columns;
      state.targetFields = data.target_fields;

      renderPhoneSummary(data.phone_summary, data.row_count);
      renderMappingTable(data.source_columns, data.target_fields);
      showPanel('map', 3);
    } catch (err) {
      showPanel('upload', 1);
      uploadError.textContent = err.message;
      uploadBtn.disabled = false;
    }
  });

  function renderPhoneSummary(summary, rowCount) {
    const el = document.getElementById('phone-summary');
    el.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'hint';
    info.style.marginBottom = '10px';
    info.textContent = `Строк в файле: ${rowCount}.` + (summary.length
      ? ` Найдены колонки с телефонами (${summary.length}):`
      : ' Колонок с телефонами не обнаружено.');
    el.appendChild(info);

    summary.forEach(s => {
      const chip = document.createElement('span');
      chip.className = 'phone-chip';
      const st = s.stats;
      chip.innerHTML = `<span>${escapeHtml(s.header)}</span>` +
        (s.max_count > 1 ? `<span class="badge">до ${s.max_count} номеров/ячейка</span>` : '') +
        `<span class="badge ok">✓${st.ok}</span>` +
        (st.fixed ? `<span class="badge fixed">+добавлен ${st.fixed}</span>` : '') +
        (st.invalid ? `<span class="badge invalid">⚠ ${st.invalid}</span>` : '');
      el.appendChild(chip);
    });
  }

  function renderMappingTable(columns, targets) {
    const el = document.getElementById('mapping-table');
    el.innerHTML = '';

    columns.forEach(col => {
      const row = document.createElement('div');
      row.className = 'mapping-row';

      const left = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'col-label';
      label.textContent = col.label;
      left.appendChild(label);
      if (col.samples && col.samples.length) {
        const samples = document.createElement('div');
        samples.className = 'col-samples';
        samples.innerHTML = col.samples.map(s => `<span>${escapeHtml(s)}</span>`).join('');
        left.appendChild(samples);
      }
      row.appendChild(left);

      const select = document.createElement('select');
      select.dataset.key = col.key;
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '— не использовать —';
      select.appendChild(noneOpt);
      targets.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        select.appendChild(opt);
      });
      row.appendChild(select);

      el.appendChild(row);
    });
  }

  document.getElementById('convert-btn').addEventListener('click', async () => {
    const convertError = document.getElementById('convert-error');
    convertError.textContent = '';

    const mapping = {};
    document.querySelectorAll('#mapping-table select').forEach(sel => {
      if (sel.value) mapping[sel.dataset.key] = sel.value;
    });

    if (!Object.keys(mapping).length) {
      convertError.textContent = 'Сопоставьте хотя бы одну колонку с полем CRM.';
      return;
    }

    try {
      const resp = await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, mapping }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Ошибка формирования файла');

      renderResult(data);
      showPanel('result', 4);
    } catch (err) {
      convertError.textContent = err.message;
    }
  });

  function renderResult(data) {
    const summary = document.getElementById('result-summary');
    const nonEmptyCols = Object.entries(data.filled).filter(([h]) => h !== 'Source');
    summary.innerHTML = `<p>Готово. Строк: <b>${data.row_count}</b>.</p>` +
      `<div class="fill-grid">` +
      nonEmptyCols.map(([h, n]) => `<div class="fill-cell"><b>${n}</b>${escapeHtml(h)}</div>`).join('') +
      `</div>`;

    document.getElementById('download-link').href = data.download_url;

    const previewEl = document.getElementById('result-preview');
    if (data.preview.length) {
      let html = '<table class="preview"><thead><tr>' +
        data.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>';
      data.preview.forEach(r => {
        html += '<tr>' + r.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>';
      });
      html += '</tbody></table>';
      previewEl.innerHTML = '<p class="hint">Превью первых строк:</p>' + html;
    } else {
      previewEl.innerHTML = '';
    }
  }

  document.getElementById('restart-btn').addEventListener('click', () => {
    state = { sessionId: null, sourceColumns: [], targetFields: [] };
    fileInput.value = '';
    dzFilename.textContent = '';
    uploadBtn.disabled = true;
    uploadError.textContent = '';
    showPanel('upload', 1);
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
