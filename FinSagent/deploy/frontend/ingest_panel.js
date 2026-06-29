/**
 * 主页面右上角：文档入库浮层（新建上传在上；历史任务分页 + 触底加载；无额外 query）。
 */
(function () {
  var PAGE_SIZE = 10;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var wrap = document.getElementById('ingest-wrap');
    var trigger = document.getElementById('ingest-trigger');
    var sheet = document.getElementById('ingest-sheet');
    var pill = document.getElementById('ingest-status-pill');
    var fileInput = document.getElementById('ingest-file-input');
    var folderInput = document.getElementById('ingest-folder-input');
    var addFilesBtn = document.getElementById('ingest-add-files-btn');
    var addFolderBtn = document.getElementById('ingest-add-folder-btn');
    var listEl = document.getElementById('ingest-file-list');
    var taskHistoryEl = document.getElementById('ingest-task-history');
    var submitBtn = document.getElementById('ingest-submit-btn');
    var datasetSelect = document.getElementById('dataset-select');
    var datasetCreateToggle = document.getElementById('dataset-create-toggle');
    var datasetCreatePanel = document.getElementById('dataset-create-panel');
    var datasetNameInput = document.getElementById('dataset-name-input');
    var datasetIdInput = document.getElementById('dataset-id-input');
    var datasetCreateSubmit = document.getElementById('dataset-create-submit');
    var datasetCurrentNote = document.getElementById('dataset-current-note');

    if (!wrap || !trigger || !sheet) return;

    /** @type {File[]} */
    var pending = [];
    var pollTimer = null;
    var datasets = [];
    var activeDatasetId = null;
    var datasetsLoadingPromise = null;

    var historyNextPage = 1;
    var historyHasMore = true;
    var historyLoading = false;
    var historyScrollScheduled = false;

    function stopPoll() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function datasetStatusLabel(status) {
      if (status === 'indexed') return '已索引';
      if (status === 'indexing') return '索引中';
      if (status === 'empty') return '空';
      if (status === 'failed') return '失败';
      if (status === 'unavailable') return '不可用';
      return status || '未知';
    }

    function activeDataset() {
      return datasets.find(function (d) {
        return d.dataset_id === activeDatasetId;
      }) || null;
    }

    function renderDatasetControls() {
      if (!datasetSelect) return;
      datasetSelect.innerHTML = '';
      if (!datasets.length) {
        var emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '暂无资料库';
        datasetSelect.appendChild(emptyOpt);
        datasetSelect.disabled = true;
        if (datasetCurrentNote) datasetCurrentNote.textContent = '请先创建资料库后再上传文档。';
        renderList();
        return;
      }
      datasetSelect.disabled = false;
      datasets.forEach(function (d) {
        var opt = document.createElement('option');
        opt.value = d.dataset_id;
        opt.textContent = (d.name || d.dataset_id) + ' · ' + datasetStatusLabel(d.status);
        datasetSelect.appendChild(opt);
      });
      if (!activeDatasetId || !datasets.some(function (d) { return d.dataset_id === activeDatasetId; })) {
        activeDatasetId = datasets[0].dataset_id;
      }
      datasetSelect.value = activeDatasetId || '';
      var current = activeDataset();
      if (datasetCurrentNote) {
        datasetCurrentNote.textContent = current
          ? '当前资料库：' + (current.name || current.dataset_id) + ' / collection: ' + current.collection_name
          : '未选择资料库';
      }
      if (datasetCurrentNote && current) {
        datasetCurrentNote.textContent = '当前资料库：' + (current.name || current.dataset_id);
      }
      renderList();
    }

    async function loadDatasets() {
      try {
        var res = await fetch('/datasets');
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) throw new Error(data.detail || '加载资料库失败');
        datasets = Array.isArray(data.datasets) ? data.datasets : [];
        activeDatasetId = data.active_dataset_id || (datasets[0] && datasets[0].dataset_id) || null;
      } catch (err) {
        datasets = [];
        activeDatasetId = null;
        if (datasetCurrentNote) datasetCurrentNote.textContent = err.message || '加载资料库失败';
      } finally {
        renderDatasetControls();
      }
      return activeDatasetId;
    }

    function ensureDatasetsLoaded() {
      if (!datasetsLoadingPromise) {
        datasetsLoadingPromise = loadDatasets().finally(function () {
          datasetsLoadingPromise = null;
        });
      }
      return datasetsLoadingPromise;
    }

    async function activateDataset(nextId) {
      if (!nextId || nextId === activeDatasetId) return activeDatasetId;
      var res = await fetch('/datasets/' + encodeURIComponent(nextId) + '/activate', { method: 'POST' });
      var data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.detail || '切换资料库失败');
      activeDatasetId = nextId;
      await loadDatasets();
      resetHistoryAndLoadFirst();
      return activeDatasetId;
    }

    window.getActiveDatasetId = async function () {
      if (!activeDatasetId) await ensureDatasetsLoaded();
      return activeDatasetId || null;
    };

    function setPill(state, label) {
      pill.dataset.state = state;
      pill.textContent = label;
    }

    function statusLabel(s) {
      var x = (s || '').toLowerCase();
      if (x === 'queued') return '已排队';
      if (x === 'running') return '处理中';
      if (x === 'completed') return '已完成';
      if (x === 'failed') return '失败';
      if (x === 'uploaded') return '已上传';
      if (x === 'parsing') return '解析中';
      if (x === 'parsed') return '已解析';
      if (x === 'indexing') return '索引中';
      if (x === 'indexed') return '已索引';
      if (x === 'unsupported') return '待接入解析';
      return s || '—';
    }

    function formatTime(iso) {
      if (!iso) return '';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return iso;
      }
    }

    /**
     * @param {Record<string, unknown>} job
     * @returns {HTMLLIElement}
     */
    function renderTaskItem(job) {
      var jid = job.job_id || '';
      var li = document.createElement('li');
      li.className = 'ingest-task';
      li.dataset.expanded = 'false';
      li.title = jid ? '任务ID：' + jid : '';

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'ingest-task-head';
      head.setAttribute('aria-expanded', 'false');

      var chev = document.createElement('span');
      chev.className = 'ingest-task-chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

      var main = document.createElement('div');
      main.className = 'ingest-task-main';

      var title = document.createElement('div');
      title.className = 'ingest-task-title';
      title.textContent = jid ? '任务ID：' + jid : '任务ID：—';

      var sub = document.createElement('div');
      sub.className = 'ingest-task-sub';
      var n = job.file_count != null ? job.file_count : ((job.files && job.files.length) || 0);
      var parts = [];
      var t = formatTime(/** @type {string} */ (job.created_at));
      if (t) parts.push(t);
      parts.push(n + ' 个文件');
      sub.textContent = parts.join(' · ');

      var badge = document.createElement('span');
      badge.className = 'ingest-hist-badge';
      badge.dataset.st = (job.status || '').toLowerCase();
      badge.textContent = statusLabel(/** @type {string} */ (job.status));

      main.appendChild(title);
      main.appendChild(sub);
      head.appendChild(chev);
      head.appendChild(main);
      head.appendChild(badge);

      head.addEventListener('click', function () {
        var on = li.dataset.expanded === 'true';
        li.dataset.expanded = on ? 'false' : 'true';
        head.setAttribute('aria-expanded', on ? 'false' : 'true');
      });

      var filesWrap = document.createElement('div');
      filesWrap.className = 'ingest-task-files';
      var ul = document.createElement('ul');
      ul.className = 'ingest-task-file-list';

      var entries = job.files;
      if (!entries || !entries.length) {
        var paths = job.saved_paths || [];
        entries = paths.map(function (p) {
          return { original_filename: String(p).split(/[/\\]/).pop() || p, stored_path: p };
        });
      }

      entries.forEach(function (f) {
        var fli = document.createElement('li');
        fli.className = 'ingest-task-file';
        fli.textContent = f.original_filename || f.stored_basename || f.stored_path || '—';
        fli.title = f.stored_path || '';
        var st = f.status && f.status !== job.status ? ' [' + statusLabel(f.status) + ']' : '';
        if (st) fli.textContent += st;
        ul.appendChild(fli);
      });

      filesWrap.appendChild(ul);
      if (job.message && (job.status === 'failed' || job.status === 'completed')) {
        var msg = String(job.message);
        var note = document.createElement('div');
        note.className = 'ingest-task-sub';
        note.style.marginTop = '8px';
        note.style.whiteSpace = 'pre-wrap';
        note.style.wordBreak = 'break-word';
        note.textContent = msg.length > 400 ? msg.slice(0, 400) + '…' : msg;
        filesWrap.appendChild(note);
      }

      li.appendChild(head);
      li.appendChild(filesWrap);
      return li;
    }

    function resetHistoryPagination() {
      historyNextPage = 1;
      historyHasMore = true;
      historyLoading = false;
      if (taskHistoryEl) taskHistoryEl.innerHTML = '';
    }

    async function loadNextHistoryPage() {
      if (!taskHistoryEl || historyLoading || !historyHasMore) return;
      if (!activeDatasetId) {
        taskHistoryEl.innerHTML = '';
        var noDatasetLi = document.createElement('li');
        noDatasetLi.className = 'ingest-hist-empty';
        noDatasetLi.textContent = '请先创建或选择资料库';
        taskHistoryEl.appendChild(noDatasetLi);
        historyHasMore = false;
        return;
      }

      historyLoading = true;
      var page = historyNextPage;
      try {
        var res = await fetch(
          '/datasets/' + encodeURIComponent(activeDatasetId) + '/jobs?page=' +
            encodeURIComponent(String(page)) + '&page_size=' + encodeURIComponent(String(PAGE_SIZE))
        );
        var data = await res.json().catch(function () {
          return {};
        });
        var jobs = res.ok && Array.isArray(data.jobs) ? data.jobs : [];
        historyHasMore = !!data.has_more;

        if (page === 1 && jobs.length === 0) {
          var emptyLi = document.createElement('li');
          emptyLi.className = 'ingest-hist-empty';
          emptyLi.textContent = '暂无历史任务';
          taskHistoryEl.appendChild(emptyLi);
        } else {
          for (var i = 0; i < jobs.length; i++) {
            taskHistoryEl.appendChild(renderTaskItem(jobs[i]));
          }
        }
        historyNextPage = page + 1;
      } catch {
        if (page === 1 && taskHistoryEl.children.length === 0) {
          var errLi = document.createElement('li');
          errLi.className = 'ingest-hist-empty';
          errLi.textContent = '加载失败';
          taskHistoryEl.appendChild(errLi);
        }
        historyHasMore = false;
      } finally {
        historyLoading = false;
      }
    }

    async function resetHistoryAndLoadFirst() {
      resetHistoryPagination();
      await loadNextHistoryPage();
    }

    function openSheet() {
      sheet.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      ensureDatasetsLoaded().then(resetHistoryAndLoadFirst);
    }

    function closeSheet() {
      sheet.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    function toggleSheet() {
      if (sheet.hidden) openSheet();
      else closeSheet();
    }

    if (taskHistoryEl) {
      taskHistoryEl.addEventListener('scroll', function () {
        if (historyScrollScheduled) return;
        historyScrollScheduled = true;
        requestAnimationFrame(function () {
          historyScrollScheduled = false;
          var el = taskHistoryEl;
          if (historyLoading || !historyHasMore) return;
          if (el.scrollTop + el.clientHeight < el.scrollHeight - 48) return;
          loadNextHistoryPage();
        });
      });
    }

    function renderList() {
      listEl.innerHTML = '';
      if (pending.length === 0) {
        var li = document.createElement('li');
        li.className = 'ingest-row ingest-row--empty';
        li.textContent = '暂无待上传文件，请使用下方「选择文件」或「选择文件夹」添加资料文件';
        listEl.appendChild(li);
        submitBtn.disabled = true;
        return;
      }
      pending.forEach(function (file, idx) {
        var row = document.createElement('li');
        row.className = 'ingest-row';
        var icon = document.createElement('span');
        icon.className = 'ingest-row-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>';
        var name = document.createElement('span');
        name.className = 'ingest-row-name';
        var displayName = file.webkitRelativePath || file.name;
        name.textContent = displayName;
        name.title = displayName;
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ingest-row-remove';
        rm.setAttribute('aria-label', '移除');
        rm.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        rm.addEventListener('click', function () {
          pending.splice(idx, 1);
          renderList();
        });
        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(rm);
        listEl.appendChild(row);
      });
      submitBtn.disabled = !activeDatasetId;
    }

    function mapStatus(s) {
      var x = (s || '').toLowerCase();
      if (x === 'queued') return { pill: 'queued', text: '已排队' };
      if (x === 'running') return { pill: 'run', text: '处理中' };
      if (x === 'completed') return { pill: 'done', text: '已完成' };
      if (x === 'failed') return { pill: 'err', text: '失败' };
      return { pill: 'idle', text: '空闲' };
    }

    async function poll(jobId, datasetId) {
      stopPoll();
      var tick = async function () {
        try {
          var res = await fetch(
            '/datasets/' + encodeURIComponent(datasetId) + '/jobs/' + encodeURIComponent(jobId)
          );
          var data = await res.json().catch(function () {
            return {};
          });
          if (!res.ok) {
            setPill('err', '查询失败');
            stopPoll();
            trigger.disabled = false;
            return;
          }
          var m = mapStatus(data.status);
          setPill(m.pill, m.text);
          if (data.status === 'completed' || data.status === 'failed') {
            stopPoll();
            trigger.disabled = false;
            submitBtn.disabled = pending.length === 0 || !activeDatasetId;
            if (!sheet.hidden) resetHistoryAndLoadFirst();
          }
        } catch {
          setPill('err', '失败');
          stopPoll();
          trigger.disabled = false;
        }
      };
      await tick();
      pollTimer = setInterval(tick, 2000);
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleSheet();
    });

    function isSupportedFile(f) {
      var type = (f.type || '').toLowerCase();
      if (type === 'application/pdf') return true;
      var n = (f.name || '').toLowerCase();
      return /\.(pdf|doc|docx|odt|rtf|ppt|pptx|odp|xls|xlsx|csv|md|markdown)$/i.test(n);
    }

    function fileDedupeKey(f) {
      var rel = f.webkitRelativePath || '';
      return rel + '\0' + f.name + '\0' + f.size + '\0' + f.lastModified;
    }

    function mergeFilesIntoPending(fileList) {
      var add = Array.from(fileList || []).filter(isSupportedFile);
      for (var i = 0; i < add.length; i++) {
        var f = add[i];
        var key = fileDedupeKey(f);
        var dup = pending.some(function (x) {
          return fileDedupeKey(x) === key;
        });
        if (!dup) pending.push(f);
      }
      renderList();
    }

    if (addFilesBtn && fileInput) {
      addFilesBtn.addEventListener('click', function () {
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        mergeFilesIntoPending(fileInput.files);
        fileInput.value = '';
      });
    }

    if (addFolderBtn && folderInput) {
      addFolderBtn.addEventListener('click', function () {
        folderInput.click();
      });
      folderInput.addEventListener('change', function () {
        mergeFilesIntoPending(folderInput.files);
        folderInput.value = '';
      });
    }

    if (datasetSelect) {
      datasetSelect.addEventListener('change', function () {
        var nextId = datasetSelect.value;
        activateDataset(nextId).catch(function (err) {
          if (datasetCurrentNote) datasetCurrentNote.textContent = err.message || '切换资料库失败';
        });
      });
    }

    if (datasetCreateToggle && datasetCreatePanel) {
      datasetCreateToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        datasetCreatePanel.hidden = !datasetCreatePanel.hidden;
      });
    }

    if (datasetCreateSubmit) {
      datasetCreateSubmit.addEventListener('click', async function (e) {
        e.stopPropagation();
        var name = (datasetNameInput && datasetNameInput.value.trim()) || '';
        if (!name) {
          if (datasetCurrentNote) datasetCurrentNote.textContent = '请输入资料库名称';
          return;
        }
        datasetCreateSubmit.disabled = true;
        try {
          var res = await fetch('/datasets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
          });
          var data = await res.json().catch(function () {
            return {};
          });
          if (!res.ok) throw new Error(data.detail || '创建资料库失败');
          await activateDataset(data.dataset_id);
          if (datasetNameInput) datasetNameInput.value = '';
          if (datasetIdInput) datasetIdInput.value = '';
          if (datasetCreatePanel) datasetCreatePanel.hidden = true;
        } catch (err) {
          if (datasetCurrentNote) datasetCurrentNote.textContent = err.message || '创建资料库失败';
        } finally {
          datasetCreateSubmit.disabled = false;
        }
      });
    }

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closeSheet();
    });

    submitBtn.addEventListener('click', async function () {
      if (pending.length === 0) return;
      var datasetId = await window.getActiveDatasetId();
      if (!datasetId) {
        setPill('err', '无资料库');
        if (datasetCurrentNote) datasetCurrentNote.textContent = '请先创建或选择资料库';
        return;
      }
      stopPoll();
      var fd = new FormData();
      pending.forEach(function (f) {
        fd.append('files', f);
      });

      setPill('up', '上传中');
      trigger.disabled = true;
      submitBtn.disabled = true;
      closeSheet();

      try {
        var res = await fetch(
          '/datasets/' + encodeURIComponent(datasetId) + '/upload',
          { method: 'POST', body: fd }
        );
        var data = await res.json().catch(function () {
          return {};
        });
        if (!res.ok) {
          setPill('err', '失败');
          trigger.disabled = false;
          submitBtn.disabled = pending.length === 0 || !activeDatasetId;
          return;
        }
        var jobId = data.job_id;
        if (!jobId) {
          setPill('err', '失败');
          trigger.disabled = false;
          submitBtn.disabled = pending.length === 0 || !activeDatasetId;
          return;
        }
        var m = mapStatus(data.status || 'queued');
        setPill(m.pill, m.text);
        pending = [];
        renderList();
        await poll(jobId, datasetId);
      } catch (err) {
        setPill('err', '失败');
        trigger.disabled = false;
        submitBtn.disabled = pending.length === 0 || !activeDatasetId;
      }
    });

    renderList();
    setPill('idle', '空闲');
    ensureDatasetsLoaded();
  });
})();
