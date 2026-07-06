(function () {
  const state = {
    rootDir: '',
    activeDatasetId: null,
    selectedDatasetId: null,
    datasets: [],
    files: [],
    jobs: [],
    selectedFiles: [],
    search: '',
    statusFilter: 'all',
    pollTimer: null,
    currentArtifacts: null,
    pdfPreview: {
      doc: null,
      locations: [],
      currentIndex: 0,
      url: '',
      kind: '',
      item: null,
    },
  };

  const els = {
    datasetList: document.getElementById('kb-dataset-list'),
    content: document.getElementById('kb-content'),
    title: document.getElementById('kb-page-title'),
    subtitle: document.getElementById('kb-subtitle'),
    rootNote: document.getElementById('kb-root-note'),
    createOpenBtn: document.getElementById('kb-create-open-btn'),
    createForm: document.getElementById('kb-create-form'),
    createName: document.getElementById('kb-create-name'),
    refreshBtn: document.getElementById('kb-refresh-btn'),
    activateBtn: document.getElementById('kb-activate-btn'),
    uploadOpenBtn: document.getElementById('kb-upload-open-btn'),
    jobsOpenBtn: document.getElementById('kb-jobs-open-btn'),
    fileInput: document.getElementById('kb-file-input'),
    uploadZone: document.getElementById('kb-upload-zone'),
    pickFilesBtn: document.getElementById('kb-pick-files'),
    uploadSubmitBtn: document.getElementById('kb-upload-submit'),
    selectedFiles: document.getElementById('kb-selected-files'),
    jobsList: document.getElementById('kb-jobs-list'),
    previewTitle: document.getElementById('kb-preview-title'),
    previewBody: document.getElementById('kb-preview-body'),
    pdfModal: document.getElementById('kb-pdf-modal'),
    pdfTitle: document.getElementById('kb-pdf-title'),
    pdfBody: document.getElementById('kb-pdf-body'),
    toast: document.getElementById('kb-toast'),
    uploadModal: document.getElementById('kb-upload-modal'),
    createModal: document.getElementById('kb-create-modal'),
    jobsModal: document.getElementById('kb-jobs-modal'),
    previewModal: document.getElementById('kb-preview-modal'),
  };

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(function () {
      els.toast.classList.remove('show');
    }, 3600);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function statusLabel(status) {
    const map = {
      indexed: '已索引',
      indexing: '索引中',
      empty: '未入库',
      unavailable: '不可用',
      uploaded: '已上传',
      parsing: '解析中',
      parsed: '已解析',
      unsupported: '待接入解析',
      queued: '排队中',
      running: '处理中',
      completed: '已处理',
      failed: '失败',
      on_disk: '待入库',
    };
    return map[status] || status || '未知';
  }

  function statusText(status) {
    const cls = escapeHtml(String(status || '').toLowerCase());
    return '<span class="kb-status-text ' + cls + '"><span class="kb-status-dot"></span>' + escapeHtml(statusLabel(status)) + '</span>';
  }

  function formatBytes(value) {
    if (value == null || Number.isNaN(Number(value))) return '-';
    const n = Number(value);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  function formatTime(value) {
    if (!value) return '-';
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function basename(value) {
    const text = String(value || '');
    if (!text) return '';
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || text;
  }

  function fileDisplayName(file) {
    return file.original_filename || basename(file.stored_path) || '-';
  }

  function selectedDataset() {
    return state.datasets.find(function (item) {
      return item.dataset_id === state.selectedDatasetId;
    }) || null;
  }

  async function api(path, options) {
    const response = await fetch(path, options || {});
    const data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(data.detail || data.message || '请求失败');
    }
    return data;
  }

  async function loadDatasets() {
    const data = await api('/datasets');
    state.rootDir = data.root_dir || '';
    state.activeDatasetId = data.active_dataset_id || null;
    state.datasets = Array.isArray(data.datasets) ? data.datasets : [];
    els.rootNote.textContent = state.rootDir ? '资料库目录已配置' : '未配置资料库目录';

    if (!state.selectedDatasetId || !state.datasets.some(function (d) { return d.dataset_id === state.selectedDatasetId; })) {
      state.selectedDatasetId = state.activeDatasetId || (state.datasets[0] && state.datasets[0].dataset_id) || null;
    }

    renderDatasets();
    if (state.selectedDatasetId) {
      await loadSelectedDataset();
    } else {
      renderEmpty();
    }
  }

  async function loadSelectedDataset() {
    const dataset = selectedDataset();
    if (!dataset) {
      renderEmpty();
      return;
    }

    const datasetId = encodeURIComponent(dataset.dataset_id);
    const results = await Promise.all([
      api('/datasets/' + datasetId + '/files'),
      api('/datasets/' + datasetId + '/jobs?page=1&page_size=30'),
    ]);
    state.files = Array.isArray(results[0].files) ? results[0].files : [];
    state.jobs = Array.isArray(results[1].jobs) ? results[1].jobs : [];
    renderMain();
    renderJobsModal();
    updatePolling();
  }

  function renderDatasets() {
    els.datasetList.innerHTML = '';
    if (!state.datasets.length) {
      const empty = document.createElement('div');
      empty.className = 'kb-dataset-meta';
      empty.style.padding = '12px';
      empty.textContent = '暂无资料库';
      els.datasetList.appendChild(empty);
      return;
    }

    state.datasets.forEach(function (dataset) {
      const stats = dataset.stats || {};
      const active = dataset.dataset_id === state.activeDatasetId;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kb-dataset-item' + (dataset.dataset_id === state.selectedDatasetId ? ' active' : '');
      button.innerHTML =
        '<div class="kb-dataset-name">' +
          '<span>' + escapeHtml(dataset.name || dataset.dataset_id) + '</span>' +
          (active ? '<span class="kb-current-dot" title="当前使用中"></span>' : '') +
        '</div>' +
        '<div class="kb-dataset-count">' +
          escapeHtml(String(stats.file_count || 0)) + ' 个文件 · ' + escapeHtml(statusLabel(dataset.status)) +
        '</div>' +
        '<div class="kb-dataset-meta">' + escapeHtml(dataset.dataset_id) + '</div>';
      button.addEventListener('click', async function () {
        state.selectedDatasetId = dataset.dataset_id;
        renderDatasets();
        await loadSelectedDataset().catch(function (err) {
          showToast(err.message);
        });
      });
      els.datasetList.appendChild(button);
    });
  }

  function renderEmpty() {
    els.title.textContent = '机构资料库';
    els.subtitle.textContent = '选择资料库后查看文件';
    els.activateBtn.disabled = true;
    els.uploadOpenBtn.disabled = true;
    els.jobsOpenBtn.disabled = true;
    els.content.innerHTML =
      '<div class="kb-empty-state">' +
        '<div>' +
          '<h2>选择或新建资料库</h2>' +
          '<p>这里会展示当前资料库里的文件，上传与入库任务在右上角按钮中处理。</p>' +
        '</div>' +
      '</div>';
  }

  function filteredFiles() {
    const query = state.search.trim().toLowerCase();
    return state.files.filter(function (file) {
      const status = String(file.status || '');
      const haystack = [
        fileDisplayName(file),
        file.file_type,
        statusLabel(status),
      ].join(' ').toLowerCase();

      if (query && haystack.indexOf(query) === -1) return false;
      if (state.statusFilter === 'all') return true;
      if (state.statusFilter === 'active') return status === 'queued' || status === 'running' || status === 'parsing' || status === 'indexing';
      if (state.statusFilter === 'waiting') return status === 'on_disk' || status === 'uploaded' || status === 'unsupported';
      return status === state.statusFilter;
    });
  }

  function renderMain() {
    const dataset = selectedDataset();
    if (!dataset) return renderEmpty();

    const active = dataset.dataset_id === state.activeDatasetId;
    const completedCount = state.files.filter(function (file) {
      return file.status === 'indexed' || file.status === 'parsed' || file.status === 'completed';
    }).length;
    els.title.textContent = dataset.name || dataset.dataset_id;
    els.subtitle.textContent =
      ' · ' + state.files.length + ' 个文件 · ' +
      completedCount + ' 个已处理 · ' +
      (active ? '当前使用中' : '未设为当前');
    els.subtitle.textContent = els.subtitle.textContent.replace(/^ 路 /, '');
    els.activateBtn.disabled = active;
    els.activateBtn.textContent = active ? '当前资料库' : '设为当前';
    els.uploadOpenBtn.disabled = false;
    els.jobsOpenBtn.disabled = false;

    els.content.innerHTML =
      '<div class="kb-file-header">' +
        '<div class="kb-file-heading">' +
          '<h2>文件</h2>' +
          '<p>展示当前资料库中的上传文件和处理状态。点击产物可以查看 pipeline 生成的 chunks 与 PageIndex。</p>' +
        '</div>' +
        '<div class="kb-toolbar">' +
          '<input class="kb-input" id="kb-search-input" type="search" placeholder="搜索文件名或路径" value="' + escapeHtml(state.search) + '">' +
          '<select class="kb-select" id="kb-status-filter" aria-label="文件状态筛选">' +
            optionHtml('all', '全部文件') +
            optionHtml('indexed', '已索引') +
            optionHtml('active', '处理中') +
            optionHtml('waiting', '待入库') +
            optionHtml('uploaded', '已上传') +
            optionHtml('failed', '失败') +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="kb-file-surface">' +
        '<div class="kb-file-list" id="kb-file-list">' + fileListMarkup() + '</div>' +
      '</div>';

    const filter = document.getElementById('kb-status-filter');
    const search = document.getElementById('kb-search-input');
    if (filter) {
      filter.value = state.statusFilter;
      filter.addEventListener('change', function () {
        state.statusFilter = filter.value;
        renderVisibleFileRows();
      });
    }
    if (search) {
      search.addEventListener('input', function () {
        state.search = search.value;
        renderVisibleFileRows();
      });
    }
  }

  function fileListMarkup() {
    return (
      '<div class="kb-file-row head">' +
        '<div>文件</div><div>状态</div><div>类型/大小</div><div>时间</div><div style="text-align:right;">操作</div>' +
      '</div>' +
      renderFileRows(filteredFiles())
    );
  }

  function renderVisibleFileRows() {
    const list = document.getElementById('kb-file-list');
    if (list) list.innerHTML = fileListMarkup();
  }

  function optionHtml(value, label) {
    return '<option value="' + escapeHtml(value) + '"' + (state.statusFilter === value ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }

  function renderFileRows(files) {
    if (!files.length) {
      return (
        '<div class="kb-empty-state">' +
          '<div>' +
            '<h2>没有匹配文件</h2>' +
            '<p>可以调整筛选条件，或上传新的资料文件。</p>' +
          '</div>' +
        '</div>'
      );
    }

    return files.map(function (file) {
      const fileId = escapeHtml(file.file_id || '');
      const name = fileDisplayName(file);
      return (
        '<div class="kb-file-row" data-file-id="' + fileId + '">' +
          '<div style="min-width:0;">' +
            '<div class="kb-file-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</div>' +
          '</div>' +
          '<div>' + statusText(file.status) + '</div>' +
          '<div class="kb-muted">' + escapeHtml((file.file_type || 'pdf').toUpperCase()) + ' · ' + escapeHtml(formatBytes(file.size_bytes)) + '</div>' +
          '<div class="kb-muted">' + escapeHtml(formatTime(file.uploaded_at)) + '</div>' +
          '<div class="kb-row-actions">' +
            '<button class="kb-ghost" type="button" data-artifacts-file="' + fileId + '">产物</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderJobsModal() {
    if (!els.jobsList) return;
    if (!state.jobs.length) {
      els.jobsList.innerHTML = '<div class="kb-empty-state"><div><h2>暂无入库任务</h2><p>上传文件后会在这里显示处理记录。</p></div></div>';
      return;
    }

    els.jobsList.innerHTML = state.jobs.map(function (job) {
      const files = Array.isArray(job.files) && job.files.length
        ? job.files.map(fileDisplayName).join(', ')
        : '-';
      return (
        '<article class="kb-job-item">' +
          '<div class="kb-job-line">' +
            '<strong>' + escapeHtml(job.job_id || '-') + '</strong>' +
            statusText(job.status) +
          '</div>' +
          '<div class="kb-job-line">' +
            '<span>' + escapeHtml(formatTime(job.created_at)) + '</span>' +
            '<span>' + escapeHtml(String(job.file_count || 0)) + ' 个文件</span>' +
          '</div>' +
          '<div class="kb-muted">' + escapeHtml(files) + '</div>' +
          '<div class="kb-job-message">' + escapeHtml(job.message || '无消息') + '</div>' +
        '</article>'
      );
    }).join('');
  }

  function openModal(modal) {
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeModals() {
    closePdfPreview();
    [els.uploadModal, els.createModal, els.jobsModal, els.previewModal].forEach(function (modal) {
      if (!modal) return;
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
    });
    els.previewBody.innerHTML = '';
    state.currentArtifacts = null;
  }

  function closePdfPreview() {
    if (!els.pdfModal) return;
    els.pdfModal.classList.remove('show');
    els.pdfModal.setAttribute('aria-hidden', 'true');
    if (els.pdfBody) els.pdfBody.innerHTML = '';
    state.pdfPreview = {
      doc: null,
      locations: [],
      currentIndex: 0,
      url: '',
      kind: '',
      item: null,
    };
  }

  function setSelectedFiles(files) {
    const allowed = files.filter(function (file) {
      return /\.(pdf|doc|docx|odt|rtf|ppt|pptx|odp|xls|xlsx|csv|md|markdown)$/i.test(file.name || '');
    });
    if (files.length && allowed.length !== files.length) {
      showToast('已忽略暂不支持的文件格式。');
    }
    state.selectedFiles = allowed;
    renderSelectedFiles();
  }

  function renderSelectedFiles() {
    els.selectedFiles.innerHTML = '';
    els.uploadSubmitBtn.disabled = state.selectedFiles.length === 0;
    state.selectedFiles.forEach(function (file, index) {
      const row = document.createElement('div');
      row.className = 'kb-selected-file';
      row.innerHTML =
        '<span>' + escapeHtml(file.name) + '</span>' +
        '<span>' + escapeHtml(formatBytes(file.size)) + ' · <button class="kb-link-btn" type="button" data-remove-index="' + index + '">移除</button></span>';
      els.selectedFiles.appendChild(row);
    });
  }

  async function uploadSelectedFiles() {
    const dataset = selectedDataset();
    if (!dataset || !state.selectedFiles.length) return;

    els.uploadSubmitBtn.disabled = true;
    const formData = new FormData();
    state.selectedFiles.forEach(function (file) {
      formData.append('files', file);
    });

    try {
      const response = await fetch('/datasets/' + encodeURIComponent(dataset.dataset_id) + '/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json().catch(function () {
        return {};
      });
      if (!response.ok) throw new Error(data.detail || '上传失败');

      state.selectedFiles = [];
      renderSelectedFiles();
      closeModals();
      showToast('上传任务已创建。');
      await loadDatasets();
      openModal(els.jobsModal);
    } catch (err) {
      showToast(err.message || '上传失败');
      els.uploadSubmitBtn.disabled = state.selectedFiles.length === 0;
    }
  }

  function renderChunkItems(chunks) {
    if (!chunks || !chunks.available) {
      return '<div class="kb-empty-state"><div><h2>暂无 chunks</h2><p>该文件还没有生成最终切分结果。</p></div></div>';
    }
    if (!chunks.items || !chunks.items.length) {
      return '<div class="kb-empty-state"><div><h2>没有可展示的 chunk</h2><p>产物存在，但没有读到有效 content 字段。</p></div></div>';
    }
    return chunks.items.map(function (chunk, itemIndex) {
      const title = chunk.title || ('Chunk #' + chunk.index);
      const meta = [
        chunk.page_number != null ? ('page ' + chunk.page_number) : '',
        chunk.type || '',
        chunk.id != null ? ('id ' + chunk.id) : '',
      ].filter(Boolean).join(' · ');
      return (
        '<article class="kb-chunk-item kb-artifact-clickable" role="button" tabindex="0" data-artifact-kind="chunk" data-artifact-index="' + itemIndex + '">' +
          '<div class="kb-artifact-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
          '<div class="kb-muted">' + escapeHtml(meta || '-') + '</div>' +
          '<div class="kb-artifact-content">' + escapeHtml(chunk.content || '') + '</div>' +
        '</article>'
      );
    }).join('');
  }

  function renderPageIndexItems(pageindex) {
    if (!pageindex || !pageindex.available) {
      return '<div class="kb-empty-state"><div><h2>暂无 PageIndex</h2><p>该文件还没有生成 PageIndex structure。</p></div></div>';
    }
    if (!pageindex.structure || !pageindex.structure.length) {
      return '<div class="kb-empty-state"><div><h2>没有结构节点</h2><p>PageIndex 文件存在，但 structure 为空。</p></div></div>';
    }
    return pageindex.structure.map(function (node) {
      const title = node.title || ('Node ' + (node.node_id || node.index));
      const range = [
        node.node_id ? ('node ' + node.node_id) : '',
        node.start_index != null || node.end_index != null ? ('chunk ' + (node.start_index || '-') + '-' + (node.end_index || '-')) : '',
      ].filter(Boolean).join(' · ');
      return (
        '<article class="kb-node-item">' +
          '<div class="kb-artifact-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
          '<div class="kb-muted">' + escapeHtml(range || '-') + '</div>' +
          '<div class="kb-artifact-content">' + escapeHtml(node.summary || '') + '</div>' +
        '</article>'
      );
    }).join('');
  }

  function sanitizeTableHtml(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value || '');

    template.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(function (node) {
      node.remove();
    });

    const allowedTags = new Set([
      'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION',
      'COLGROUP', 'COL', 'BR', 'P', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'SUP', 'SUB',
    ]);
    const allowedAttrs = new Set(['colspan', 'rowspan']);

    template.content.querySelectorAll('*').forEach(function (node) {
      if (!allowedTags.has(node.tagName)) {
        node.replaceWith(document.createTextNode(node.textContent || ''));
        return;
      }
      Array.from(node.attributes).forEach(function (attr) {
        if (!allowedAttrs.has(attr.name.toLowerCase())) {
          node.removeAttribute(attr.name);
        }
      });
    });

    return template.innerHTML;
  }

  function renderTableItems(tables) {
    if (!tables || !tables.available) {
      return '<div class="kb-empty-state"><div><h2>暂无 Tables</h2><p>该文件还没有生成表格重构产物。</p></div></div>';
    }
    if (!tables.items || !tables.items.length) {
      return '<div class="kb-empty-state"><div><h2>没有可展示的 table</h2><p>表格产物存在，但没有读到有效 content 字段。</p></div></div>';
    }
    return tables.items.map(function (table, itemIndex) {
      const title = table.caption || ('Table #' + table.index);
      const meta = [
        table.page_number != null ? ('page ' + table.page_number) : '',
        table.original_index != null ? ('source ' + table.original_index) : '',
      ].filter(Boolean).join(' · ');
      return (
        '<article class="kb-table-item kb-artifact-clickable" role="button" tabindex="0" data-artifact-kind="table" data-artifact-index="' + itemIndex + '">' +
          '<div class="kb-artifact-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
          '<div class="kb-muted">' + escapeHtml(meta || '-') + '</div>' +
          (table.summary ? '<div class="kb-artifact-content">' + escapeHtml(table.summary) + '</div>' : '') +
          '<div class="kb-table-scroll">' + sanitizeTableHtml(table.content || '') + '</div>' +
          (table.footnote ? '<div class="kb-muted">' + escapeHtml(table.footnote) + '</div>' : '') +
        '</article>'
      );
    }).join('');
  }

  async function openArtifacts(fileId) {
    const dataset = selectedDataset();
    if (!dataset) return;
    const file = state.files.find(function (item) {
      return item.file_id === fileId;
    });
    if (!file) {
      showToast('未找到文件。');
      return;
    }

    const name = fileDisplayName(file) || '转化产物';
    els.previewTitle.innerHTML =
      '<span class="kb-modal-title-row">' +
        '<span class="kb-modal-title-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
        '<span class="kb-artifact-chip">' + statusLabel(file.status) + '</span>' +
        '<span class="kb-artifact-chip">' + escapeHtml(formatBytes(file.size_bytes)) + '</span>' +
      '</span>';
    els.previewBody.innerHTML =
      '<div class="kb-empty-state"><div><h2>正在读取产物</h2><p>正在加载 chunks 与 PageIndex。</p></div></div>';
    openModal(els.previewModal);

    try {
      const data = await api('/datasets/' + encodeURIComponent(dataset.dataset_id) + '/files/' + encodeURIComponent(file.file_id) + '/artifacts?max_chunks=120&max_tables=80');
      const chunks = data.chunks || {};
      const pageindex = data.pageindex || {};
      const tables = data.tables || {};
      state.currentArtifacts = {
        datasetId: dataset.dataset_id,
        fileId: file.file_id,
        fileName: name,
        fileType: (data.file && data.file.file_type) || file.file_type || '',
        chunks: Array.isArray(chunks.items) ? chunks.items : [],
        tables: Array.isArray(tables.items) ? tables.items : [],
      };
      els.previewBody.innerHTML =
        '<div class="kb-artifact-grid">' +
          '<section class="kb-artifact-section">' +
            '<div class="kb-artifact-section-head"><span>Chunks</span><span class="kb-muted">' + escapeHtml(String(chunks.total || 0)) + ' 条</span></div>' +
            '<div class="kb-artifact-list">' + renderChunkItems(chunks) + '</div>' +
          '</section>' +
          '<section class="kb-artifact-section">' +
            '<div class="kb-artifact-section-head"><span>PageIndex</span><span class="kb-muted">' + escapeHtml(String(pageindex.total_nodes || 0)) + ' 节点</span></div>' +
            '<div class="kb-artifact-list">' +
              (pageindex.doc_description ? '<article class="kb-node-item"><div class="kb-artifact-title">' + escapeHtml(pageindex.doc_name || 'Document') + '</div><div class="kb-artifact-content">' + escapeHtml(pageindex.doc_description) + '</div></article>' : '') +
              renderPageIndexItems(pageindex) +
            '</div>' +
          '</section>' +
          '<section class="kb-artifact-section kb-artifact-section-wide">' +
            '<div class="kb-artifact-section-head"><span>Tables</span><span class="kb-muted">' + escapeHtml(String(tables.total || 0)) + ' 张</span></div>' +
            '<div class="kb-artifact-list">' + renderTableItems(tables) + '</div>' +
          '</section>' +
        '</div>';
    } catch (err) {
      els.previewBody.innerHTML =
        '<div class="kb-empty-state"><div><h2>读取失败</h2><p>' + escapeHtml(err.message || '无法读取转化产物') + '</p></div></div>';
    }
  }

  function itemTitle(kind, item) {
    if (!item) return kind === 'table' ? 'Table' : 'Chunk';
    if (kind === 'table') return item.caption || ('Table #' + (item.index || '-'));
    return item.title || ('Chunk #' + (item.index || '-'));
  }

  function fallbackPageNumber(kind, item) {
    if (!item || item.page_number == null) return null;
    const n = Number(item.page_number);
    if (!Number.isFinite(n)) return null;
    return kind === 'chunk' ? n + 1 : n;
  }

  function normalizedPreviewLocations(kind, item) {
    const raw = Array.isArray(item && item.locations) ? item.locations : [];
    const locations = raw.map(function (loc) {
      const pageIdx = loc && loc.page_idx != null ? Number(loc.page_idx) : null;
      const pageNumber = loc && loc.page_number != null
        ? Number(loc.page_number)
        : (Number.isFinite(pageIdx) ? pageIdx + 1 : null);
      return {
        page_idx: Number.isFinite(pageIdx) ? pageIdx : (Number.isFinite(pageNumber) ? pageNumber - 1 : null),
        page_number: Number.isFinite(pageNumber) ? pageNumber : null,
        bbox: Array.isArray(loc && loc.bbox) ? loc.bbox : null,
        page_width: loc && loc.page_width != null ? Number(loc.page_width) : null,
        page_height: loc && loc.page_height != null ? Number(loc.page_height) : null,
        block_type: loc && loc.block_type,
        block_index: loc && loc.block_index,
        source_file: loc && loc.source_file,
      };
    }).filter(function (loc) {
      return loc.page_number != null || loc.bbox;
    });

    if (!locations.length) {
      const fallback = fallbackPageNumber(kind, item);
      if (fallback != null) {
        locations.push({ page_number: fallback, page_idx: fallback - 1, bbox: null });
      }
    }
    return locations;
  }

  function openArtifactPdfPreview(kind, index) {
    const ctx = state.currentArtifacts;
    if (!ctx) return;
    if (ctx.fileType && ctx.fileType !== 'pdf') {
      showToast('只有 PDF 文件支持原文预览。');
      return;
    }
    const list = kind === 'table' ? ctx.tables : ctx.chunks;
    const item = list[Number(index)];
    if (!item) {
      showToast('未找到该产物。');
      return;
    }
    const locations = normalizedPreviewLocations(kind, item);
    const pdfUrl = '/datasets/' + encodeURIComponent(ctx.datasetId) + '/files/' + encodeURIComponent(ctx.fileId) + '/pdf';
    state.pdfPreview = {
      doc: null,
      locations: locations,
      currentIndex: 0,
      url: pdfUrl,
      kind: kind,
      item: item,
    };
    els.pdfTitle.textContent = itemTitle(kind, item);
    els.pdfBody.innerHTML =
      '<div class="kb-pdf-layout">' +
        '<div class="kb-pdf-stage" id="kb-pdf-stage"></div>' +
        '<aside class="kb-pdf-rail" id="kb-pdf-rail" aria-label="定位页"></aside>' +
      '</div>';
    openModal(els.pdfModal);
    loadPdfDocument();
  }

  function sourceAnchor(value) {
    return 'kb-src-' + String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]+/g, '-');
  }

  function markdownTableToHtml(value) {
    const lines = String(value || '').split('\n').filter(function (line) {
      return line.trim().startsWith('|') && line.trim().endsWith('|');
    });
    if (lines.length < 2) return '<pre>' + escapeHtml(value || '') + '</pre>';
    const rows = lines.filter(function (line, index) {
      return index !== 1 || !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|$/.test(line.trim());
    }).map(function (line) {
      return line.trim().slice(1, -1).split('|').map(function (cell) {
        return cell.trim();
      });
    });
    return '<table><tbody>' + rows.map(function (row, rowIndex) {
      const tag = rowIndex === 0 ? 'th' : 'td';
      return '<tr>' + row.map(function (cell) {
        return '<' + tag + '>' + escapeHtml(cell) + '</' + tag + '>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
  }

  function tableRowsToMarkdown(rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    return rows.map(function (row) {
      return '| ' + (Array.isArray(row) ? row : []).map(function (cell) {
        return String(cell == null ? '' : cell).replace(/\|/g, '\\|');
      }).join(' | ') + ' |';
    }).join('\n');
  }

  function sourceLocationLabel(renderer, loc, index) {
    if (!loc) return '位置 ' + (index + 1);
    if (loc.display_text) return loc.display_text;
    if (renderer === 'ppt') return loc.slide_number ? ('slide ' + loc.slide_number) : ('位置 ' + (index + 1));
    if (renderer === 'excel') return [loc.sheet_name, loc.cell_range].filter(Boolean).join(' · ') || ('位置 ' + (index + 1));
    if (renderer === 'word') {
      if (loc.paragraph_index != null) return 'paragraph ' + loc.paragraph_index;
      if (loc.table_index != null) return 'table ' + loc.table_index;
      if (loc.image_index != null) return 'image ' + loc.image_index;
    }
    if (renderer === 'md' && loc.line_start != null) {
      return loc.line_end && loc.line_end !== loc.line_start ? ('lines ' + loc.line_start + '-' + loc.line_end) : ('line ' + loc.line_start);
    }
    return '位置 ' + (index + 1);
  }

  function sourceAnchorForLocation(renderer, loc, index) {
    if (renderer === 'ppt') return sourceAnchor('ppt-slide-' + (loc.slide_number || 1));
    if (renderer === 'excel') return sourceAnchor('excel-' + (loc.sheet_name || 'sheet'));
    if (renderer === 'md') return sourceAnchor('md-line-' + (loc.line_start || 1));
    if (renderer === 'word') {
      if (loc.block_id) return sourceAnchor('word-block-' + loc.block_id);
      if (loc.paragraph_index != null) return sourceAnchor('word-paragraph-' + loc.paragraph_index);
      if (loc.table_index != null) return sourceAnchor('word-table-' + loc.table_index);
      if (loc.image_index != null) return sourceAnchor('word-image-' + loc.image_index);
    }
    return sourceAnchor(renderer + '-' + index);
  }

  function renderSourceRail(data) {
    const renderer = data.renderer || 'source';
    const locations = Array.isArray(data.highlight_locations) ? data.highlight_locations : [];
    if (!locations.length) {
      return '<div class="kb-pdf-rail-title">定位位置</div><div class="kb-pdf-rail-empty">暂无精确来源位置</div>';
    }
    return '<div class="kb-pdf-rail-title">定位位置</div>' + locations.map(function (loc, index) {
      const anchor = sourceAnchorForLocation(renderer, loc, index);
      return '<button class="kb-pdf-rail-page' + (index === 0 ? ' active' : '') + '" type="button" data-source-anchor="' + escapeHtml(anchor) + '">' +
        '<strong>' + escapeHtml(sourceLocationLabel(renderer, loc, index)) + '</strong>' +
        '<small>' + escapeHtml(renderer) + '</small>' +
      '</button>';
    }).join('');
  }

  function renderPptSourceView(data) {
    const model = data.model || {};
    const highlights = Array.isArray(data.highlight_locations) ? data.highlight_locations : [];
    const slideWidth = Number(model.slide_width || 9144000);
    const slideHeight = Number(model.slide_height || 5143500);
    const html = (model.slides || []).map(function (slide) {
      const slideNumber = Number(slide.slide_number || 1);
      const slideAnchor = sourceAnchor('ppt-slide-' + slideNumber);
      const fullSlideHighlight = highlights.some(function (loc) {
        return Number(loc.slide_number || 1) === slideNumber && !loc.bbox;
      });
      const shapes = (slide.shapes || []).map(function (shape) {
        const box = shape.bbox || {};
        const x0 = Number(box.x0 || 0);
        const y0 = Number(box.y0 || 0);
        const x1 = Number(box.x1 || x0);
        const y1 = Number(box.y1 || y0);
        const highlighted = highlights.some(function (loc) {
          return Number(loc.slide_number || 1) === slideNumber && Number(loc.shape_index || -1) === Number(shape.shape_index || -2);
        });
        const style = 'left:' + (x0 / slideWidth * 100) + '%;top:' + (y0 / slideHeight * 100) + '%;width:' + ((x1 - x0) / slideWidth * 100) + '%;height:' + ((y1 - y0) / slideHeight * 100) + '%;';
        const content = shape.table && shape.table.length
          ? markdownTableToHtml(tableRowsToMarkdown(shape.table))
          : escapeHtml(shape.text || shape.name || '');
        return '<div class="kb-ppt-shape' + (highlighted ? ' highlight' : '') + '" style="' + style + '">' + content + '</div>';
      }).join('');
      return '<section class="kb-ppt-slide-wrap" id="' + escapeHtml(slideAnchor) + '">' +
        '<div class="kb-source-caption">Slide ' + slideNumber + '</div>' +
        '<div class="kb-ppt-slide' + (fullSlideHighlight ? ' highlight' : '') + '" style="aspect-ratio:' + slideWidth + '/' + slideHeight + '">' + shapes + '</div>' +
      '</section>';
    }).join('');
    return html || '<div class="kb-empty-state"><div><h2>暂无 PPT 视图</h2><p>' + escapeHtml(data.message || '没有可渲染的 slide。') + '</p></div></div>';
  }

  function renderExcelSourceView(data) {
    const sheets = (data.model && data.model.sheets) || [];
    return sheets.map(function (sheet) {
      const anchor = sourceAnchor('excel-' + sheet.sheet_name);
      const head = '<thead><tr><th></th>' + (sheet.columns || []).map(function (col) {
        return '<th>' + escapeHtml(col) + '</th>';
      }).join('') + '</tr></thead>';
      const body = '<tbody>' + (sheet.rows || []).map(function (row) {
        return '<tr><th>' + escapeHtml(row.row) + '</th>' + (row.cells || []).map(function (cell) {
          return '<td class="' + (cell.highlight ? 'highlight' : '') + '" title="' + escapeHtml(cell.address) + '">' + escapeHtml(cell.value) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<section class="kb-excel-sheet" id="' + escapeHtml(anchor) + '">' +
        '<div class="kb-source-caption">' + escapeHtml(sheet.sheet_name) + '</div>' +
        '<div class="kb-excel-grid"><table>' + head + body + '</table></div>' +
      '</section>';
    }).join('') || '<div class="kb-empty-state"><div><h2>暂无 Excel 视图</h2><p>' + escapeHtml(data.message || '没有可渲染的 sheet。') + '</p></div></div>';
  }

  function wordAnchorForBlock(block, index) {
    if (block.block_id) return sourceAnchor('word-block-' + block.block_id);
    if (block.paragraph_index != null) return sourceAnchor('word-paragraph-' + block.paragraph_index);
    if (block.table_index != null) return sourceAnchor('word-table-' + block.table_index);
    if (block.image_index != null) return sourceAnchor('word-image-' + block.image_index);
    return sourceAnchor('word-block-' + index);
  }

  function renderWordSourceView(data) {
    const blocks = (data.model && data.model.blocks) || [];
    return '<article class="kb-word-doc">' + blocks.map(function (block, index) {
      const type = String(block.block_type || '');
      const content = String(block.content || '');
      const heading = Array.isArray(block.heading_path) ? block.heading_path.join(' > ') : String(block.heading_path || '');
      const body = type.indexOf('table') >= 0 ? '<div class="kb-table-scroll">' + markdownTableToHtml(content) + '</div>' : '<div class="kb-word-text">' + escapeHtml(content) + '</div>';
      return '<section class="kb-word-block' + (block.highlight ? ' highlight' : '') + '" id="' + escapeHtml(wordAnchorForBlock(block, index)) + '">' +
        (heading ? '<div class="kb-source-caption">' + escapeHtml(heading) + '</div>' : '') +
        body +
      '</section>';
    }).join('') + '</article>';
  }

  function renderMdSourceView(data) {
    const lines = (data.model && data.model.lines) || [];
    return '<div class="kb-md-lines">' + lines.map(function (line) {
      const anchor = sourceAnchor('md-line-' + line.line);
      return '<div class="kb-md-line' + (line.highlight ? ' highlight' : '') + '" id="' + escapeHtml(anchor) + '">' +
        '<span>' + escapeHtml(line.line) + '</span><code>' + escapeHtml(line.text || '') + '</code>' +
      '</div>';
    }).join('') + '</div>';
  }

  function renderStructuredSourceView(data) {
    const renderer = data.renderer || 'source';
    let body = '';
    if (renderer === 'ppt') body = renderPptSourceView(data);
    else if (renderer === 'excel') body = renderExcelSourceView(data);
    else if (renderer === 'word') body = renderWordSourceView(data);
    else if (renderer === 'md') body = renderMdSourceView(data);
    else body = '<pre class="kb-source-pre">' + escapeHtml((data.model && data.model.content) || data.artifact && data.artifact.content || '') + '</pre>';
    els.pdfBody.innerHTML =
      '<div class="kb-pdf-layout kb-source-layout">' +
        '<div class="kb-source-stage" id="kb-source-stage">' +
          (data.message ? '<div class="kb-source-note">' + escapeHtml(data.message) + '</div>' : '') +
          body +
        '</div>' +
        '<aside class="kb-pdf-rail" id="kb-source-rail" aria-label="定位位置">' + renderSourceRail(data) + '</aside>' +
      '</div>';
    const first = (data.highlight_locations || [])[0];
    if (first) {
      window.setTimeout(function () {
        const target = document.getElementById(sourceAnchorForLocation(renderer, first, 0));
        if (target) target.scrollIntoView({ block: 'center', inline: 'center' });
      }, 0);
    }
  }

  async function openArtifactSourcePreview(kind, index) {
    const ctx = state.currentArtifacts;
    if (!ctx) return;
    const list = kind === 'table' ? ctx.tables : ctx.chunks;
    const item = list[Number(index)];
    if (!item) {
      showToast('未找到该产物。');
      return;
    }
    if (!item.id) {
      if (ctx.fileType === 'pdf') {
        openArtifactPdfPreview(kind, index);
      } else {
        showToast('该产物缺少 chunk_id，无法定位源文件。');
      }
      return;
    }
    els.pdfTitle.textContent = itemTitle(kind, item);
    els.pdfBody.innerHTML = '<div class="kb-empty-state"><div><h2>正在加载源文件视图</h2><p>' + escapeHtml(ctx.fileType || 'document') + '</p></div></div>';
    openModal(els.pdfModal);
    try {
      const data = await api('/datasets/' + encodeURIComponent(ctx.datasetId) + '/files/' + encodeURIComponent(ctx.fileId) + '/source-view?artifact_id=' + encodeURIComponent(item.id) + '&artifact_kind=' + encodeURIComponent(kind));
      if (data.renderer === 'pdf') {
        state.pdfPreview = {
          doc: null,
          locations: Array.isArray(data.highlight_locations) ? data.highlight_locations : normalizedPreviewLocations(kind, item),
          currentIndex: 0,
          url: data.model && data.model.pdf_url ? data.model.pdf_url : ('/datasets/' + encodeURIComponent(ctx.datasetId) + '/files/' + encodeURIComponent(ctx.fileId) + '/pdf'),
          kind: kind,
          item: item,
        };
        els.pdfBody.innerHTML =
          '<div class="kb-pdf-layout">' +
            '<div class="kb-pdf-stage" id="kb-pdf-stage"></div>' +
            '<aside class="kb-pdf-rail" id="kb-pdf-rail" aria-label="定位页"></aside>' +
          '</div>';
        await loadPdfDocument();
      } else {
        renderStructuredSourceView(data);
      }
    } catch (err) {
      setPdfError(err.message || '源文件视图加载失败。');
    }
  }

  async function loadPdfDocument() {
    const lib = window.pdfjsLib;
    if (!lib) {
      setPdfError('PDF.js 未加载，无法预览 PDF。');
      return;
    }
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
    try {
      const loadingTask = lib.getDocument({ url: state.pdfPreview.url });
      state.pdfPreview.doc = await loadingTask.promise;
      await renderCurrentPdfLocation();
    } catch (err) {
      setPdfError(err.message || 'PDF 加载失败。');
    }
  }

  function setPdfError(message) {
    if (els.pdfBody) {
      els.pdfBody.innerHTML = '<div class="kb-empty-state"><div><h2>无法预览 PDF</h2><p>' + escapeHtml(message) + '</p></div></div>';
    }
  }

  function currentPdfLocation() {
    const locations = state.pdfPreview.locations || [];
    return locations[state.pdfPreview.currentIndex] || locations[0] || {};
  }

  function samePdfPage(loc, pageNumber) {
    const n = loc.page_number != null ? Number(loc.page_number) : (loc.page_idx != null ? Number(loc.page_idx) + 1 : null);
    return Number.isFinite(n) && n === pageNumber;
  }

  function pdfLocationPage(loc) {
    const n = loc && loc.page_number != null ? Number(loc.page_number) : (loc && loc.page_idx != null ? Number(loc.page_idx) + 1 : null);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function hasDrawableBbox(loc) {
    return Boolean(
      loc &&
      Array.isArray(loc.bbox) &&
      loc.bbox.length >= 4 &&
      loc.page_width > 0 &&
      loc.page_height > 0
    );
  }

  function pdfPageEntries() {
    const map = new Map();
    (state.pdfPreview.locations || []).forEach(function (loc, index) {
      const page = pdfLocationPage(loc);
      if (!page) return;
      if (!map.has(page)) {
        map.set(page, { page: page, indexes: [], bboxCount: 0 });
      }
      const entry = map.get(page);
      entry.indexes.push(index);
      if (hasDrawableBbox(loc)) entry.bboxCount += 1;
    });
    return Array.from(map.values()).sort(function (a, b) {
      return a.page - b.page;
    });
  }

  function indexesForPdfPage(pageNumber) {
    const indexes = [];
    (state.pdfPreview.locations || []).forEach(function (loc, index) {
      if (samePdfPage(loc, pageNumber)) indexes.push(index);
    });
    return indexes;
  }

  function firstIndexForPdfPage(pageNumber) {
    const indexes = indexesForPdfPage(pageNumber);
    return indexes.length ? indexes[0] : 0;
  }

  function renderPdfRail(currentPage) {
    const rail = document.getElementById('kb-pdf-rail');
    if (!rail) return;
    const entries = pdfPageEntries();
    if (!entries.length) {
      rail.innerHTML = '<div class="kb-pdf-rail-title">定位页</div><div class="kb-pdf-rail-empty">暂无页码</div>';
      return;
    }
    rail.innerHTML =
      '<div class="kb-pdf-rail-title">定位页</div>' +
      entries.map(function (entry) {
        const active = entry.page === currentPage ? ' active' : '';
        const dots = Array.from({ length: Math.min(entry.bboxCount || entry.indexes.length, 6) }).map(function () {
          return '<span></span>';
        }).join('');
        const more = (entry.bboxCount || entry.indexes.length) > 6 ? '<em>+' + ((entry.bboxCount || entry.indexes.length) - 6) + '</em>' : '';
        return '<button class="kb-pdf-rail-page' + active + '" type="button" data-pdf-page-target="' + entry.page + '">' +
          '<strong>page ' + entry.page + '</strong>' +
          '<small>' + (entry.bboxCount || entry.indexes.length) + ' 处</small>' +
          '<i>' + dots + more + '</i>' +
        '</button>';
      }).join('');
  }

  function drawPdfHighlights(layer, locations, pageNumber, canvasWidth, canvasHeight) {
    let count = 0;
    locations.forEach(function (loc) {
      if (!samePdfPage(loc, pageNumber) || !hasDrawableBbox(loc)) return;
      const box = loc.bbox.map(Number);
      if (box.some(function (n) { return !Number.isFinite(n); })) return;
      const marker = document.createElement('div');
      marker.className = 'kb-pdf-highlight';
      marker.style.left = (box[0] / loc.page_width * canvasWidth) + 'px';
      marker.style.top = (box[1] / loc.page_height * canvasHeight) + 'px';
      marker.style.width = ((box[2] - box[0]) / loc.page_width * canvasWidth) + 'px';
      marker.style.height = ((box[3] - box[1]) / loc.page_height * canvasHeight) + 'px';
      layer.appendChild(marker);
      count += 1;
    });
    return count;
  }

  async function renderCurrentPdfLocation() {
    const pdf = state.pdfPreview.doc;
    if (!pdf) return;
    const loc = currentPdfLocation();
    const pageNumber = Math.min(Math.max(Number(loc.page_number || 1), 1), pdf.numPages);
    const stage = document.getElementById('kb-pdf-stage');
    if (!stage) return;
    stage.innerHTML = '<div class="kb-empty-state"><div><h2>正在渲染页面</h2><p>page ' + pageNumber + '</p></div></div>';

    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const maxWidth = Math.max(420, Math.min(980, stage.clientWidth || 900) - 24);
    const scale = Math.min(1.8, Math.max(0.45, maxWidth / baseViewport.width));
    const viewport = page.getViewport({ scale: scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';

    const pageWrap = document.createElement('div');
    pageWrap.className = 'kb-pdf-page-wrap';
    pageWrap.style.width = canvas.width + 'px';
    pageWrap.style.height = canvas.height + 'px';
    const layer = document.createElement('div');
    layer.className = 'kb-pdf-highlight-layer';
    layer.style.width = canvas.width + 'px';
    layer.style.height = canvas.height + 'px';
    pageWrap.appendChild(canvas);
    pageWrap.appendChild(layer);
    stage.innerHTML = '';
    stage.appendChild(pageWrap);

    await page.render({ canvasContext: context, viewport: viewport }).promise;
    const locations = state.pdfPreview.locations || [];
    drawPdfHighlights(layer, locations, pageNumber, canvas.width, canvas.height);
    renderPdfRail(pageNumber);
  }

  function updatePolling() {
    window.clearInterval(state.pollTimer);
    const hasRunning = state.jobs.some(function (job) {
      return job.status === 'queued' || job.status === 'running';
    });
    if (!hasRunning) return;
    state.pollTimer = window.setInterval(function () {
      loadDatasets().catch(function (err) {
        showToast(err.message);
      });
    }, 3000);
  }

  function bindEvents() {
    els.createOpenBtn.addEventListener('click', function () {
      openModal(els.createModal);
      window.setTimeout(function () { els.createName.focus(); }, 0);
    });

    els.uploadOpenBtn.addEventListener('click', function () {
      openModal(els.uploadModal);
    });

    els.jobsOpenBtn.addEventListener('click', function () {
      renderJobsModal();
      openModal(els.jobsModal);
    });

    els.refreshBtn.addEventListener('click', function () {
      loadDatasets().catch(function (err) {
        showToast(err.message);
      });
    });

    els.activateBtn.addEventListener('click', async function () {
      const dataset = selectedDataset();
      if (!dataset) return;
      try {
        await api('/datasets/' + encodeURIComponent(dataset.dataset_id) + '/activate', { method: 'POST' });
        showToast('已设为当前资料库。');
        await loadDatasets();
      } catch (err) {
        showToast(err.message);
      }
    });

    els.createForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      const name = els.createName.value.trim();
      if (!name) {
        showToast('请输入资料库名称。');
        return;
      }
      try {
        const dataset = await api('/datasets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name }),
        });
        els.createName.value = '';
        state.selectedDatasetId = dataset.dataset_id;
        closeModals();
        showToast('资料库已创建。');
        await loadDatasets();
      } catch (err) {
        showToast(err.message);
      }
    });

    els.pickFilesBtn.addEventListener('click', function () {
      els.fileInput.click();
    });

    els.fileInput.addEventListener('change', function () {
      setSelectedFiles(Array.from(els.fileInput.files || []));
      els.fileInput.value = '';
    });

    els.uploadSubmitBtn.addEventListener('click', uploadSelectedFiles);

    ['dragenter', 'dragover'].forEach(function (eventName) {
      els.uploadZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        els.uploadZone.classList.add('dragging');
      });
    });

    ['dragleave', 'drop'].forEach(function (eventName) {
      els.uploadZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        els.uploadZone.classList.remove('dragging');
      });
    });

    els.uploadZone.addEventListener('drop', function (event) {
      setSelectedFiles(Array.from(event.dataTransfer.files || []));
    });

    document.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.matches('[data-close-modal]')) {
        closeModals();
        return;
      }
      if (target.matches('[data-close-pdf-preview]')) {
        closePdfPreview();
        return;
      }
      const pdfPageTarget = target.closest('[data-pdf-page-target]');
      if (pdfPageTarget) {
        const page = Number(pdfPageTarget.getAttribute('data-pdf-page-target'));
        if (Number.isFinite(page)) {
          state.pdfPreview.currentIndex = firstIndexForPdfPage(page);
          renderCurrentPdfLocation();
        }
        return;
      }
      const sourceAnchorTarget = target.closest('[data-source-anchor]');
      if (sourceAnchorTarget) {
        const anchor = sourceAnchorTarget.getAttribute('data-source-anchor');
        const node = anchor ? document.getElementById(anchor) : null;
        if (node) {
          document.querySelectorAll('[data-source-anchor]').forEach(function (button) {
            button.classList.remove('active');
          });
          sourceAnchorTarget.classList.add('active');
          node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        }
        return;
      }
      const artifactItem = target.closest('[data-artifact-kind]');
      if (artifactItem) {
        openArtifactSourcePreview(
          artifactItem.getAttribute('data-artifact-kind'),
          artifactItem.getAttribute('data-artifact-index')
        );
        return;
      }
      const removeBtn = target.closest('[data-remove-index]');
      if (removeBtn) {
        state.selectedFiles.splice(Number(removeBtn.getAttribute('data-remove-index')), 1);
        renderSelectedFiles();
        return;
      }
      const artifactsBtn = target.closest('[data-artifacts-file]');
      if (artifactsBtn) {
        openArtifacts(artifactsBtn.getAttribute('data-artifacts-file'));
      }
    });

    [els.uploadModal, els.createModal, els.jobsModal, els.previewModal].forEach(function (modal) {
      modal.addEventListener('click', function (event) {
        if (event.target === modal) closeModals();
      });
    });
    if (els.pdfModal) {
      els.pdfModal.addEventListener('click', function (event) {
        if (event.target === els.pdfModal) closePdfPreview();
      });
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (els.pdfModal && els.pdfModal.classList.contains('show')) closePdfPreview();
        else closeModals();
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element) {
        const artifactItem = event.target.closest('[data-artifact-kind]');
        if (artifactItem) {
          event.preventDefault();
          openArtifactSourcePreview(
            artifactItem.getAttribute('data-artifact-kind'),
            artifactItem.getAttribute('data-artifact-index')
          );
        }
      }
    });
  }

  bindEvents();
  loadDatasets().catch(function (err) {
    showToast(err.message);
    renderEmpty();
  });
})();
