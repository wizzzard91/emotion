// Enhancements for the disk page. Without this script everything works through plain forms.
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  // Delete confirmation.
  document.addEventListener('submit', function (event) {
    var text = event.target.getAttribute('data-confirm');
    if (text && !window.confirm(text)) event.preventDefault();
  });

  // Only one menu stays open; a click outside or Escape closes it.
  function closeMenus(except) {
    document.querySelectorAll('details.row-menu[open], details.tool[open]').forEach(function (d) {
      if (d !== except) d.open = false;
    });
  }
  document.addEventListener('click', function (event) {
    closeMenus(event.target.closest ? event.target.closest('details.row-menu, details.tool') : null);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeMenus(null);
  });

  // Dates in the user's time zone rather than the server's.
  document.querySelectorAll('time[datetime]').forEach(function (el) {
    var date = new Date(el.getAttribute('datetime'));
    if (isNaN(date)) return;
    el.textContent = date
      .toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      .replace(',', '');
  });

  // Upload through XMLHttpRequest: progress bar and drag-and-drop.
  var form = document.querySelector('[data-upload-form]');
  if (!form) return;
  var input = form.querySelector('input[type="file"]');
  var tool = document.querySelector('[data-upload-tool]');
  var status = document.querySelector('[data-upload-status]');
  var statusText = document.querySelector('[data-upload-text]');
  var progress = document.querySelector('[data-upload-progress]');
  var busy = false;

  function send(files) {
    if (busy || !files || !files.length) return;
    busy = true;
    var data = new FormData();
    for (var i = 0; i < files.length; i++) data.append('files', files[i], files[i].name);

    var label = files.length === 1 ? files[0].name : 'Файлов: ' + files.length;
    status.hidden = false;
    progress.removeAttribute('value');
    statusText.textContent = 'Загрузка: ' + label;

    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', function (event) {
      if (!event.lengthComputable) return;
      var percent = Math.round((event.loaded / event.total) * 100);
      progress.value = percent;
      statusText.textContent = (percent < 100 ? 'Загрузка: ' : 'Сохранение: ') + label + ' — ' + percent + '%';
    });
    xhr.addEventListener('load', function () {
      var reply = null;
      try {
        reply = JSON.parse(xhr.responseText);
      } catch (e) {}
      if (reply && typeof reply.redirect === 'string') {
        window.location.assign(reply.redirect);
        return;
      }
      fail(reply && reply.errors && reply.errors[0]);
    });
    xhr.addEventListener('error', function () {
      fail();
    });
    xhr.send(data);
  }

  function fail(text) {
    busy = false;
    progress.value = 0;
    statusText.textContent = text || 'Не удалось загрузить: проверьте соединение и попробуйте ещё раз';
    input.value = '';
  }

  // The upload button opens the file picker right away; choosing files submits.
  tool.querySelector('summary').addEventListener('click', function (event) {
    event.preventDefault();
    input.click();
  });
  input.addEventListener('change', function () {
    send(input.files);
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    send(input.files);
  });

  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }
  var depth = 0;
  function setDragging(on) {
    document.body.classList.toggle('dragging', on);
  }
  window.addEventListener('dragenter', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    setDragging(true);
  });
  window.addEventListener('dragover', function (event) {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('dragleave', function (event) {
    if (!hasFiles(event)) return;
    depth = Math.max(depth - 1, 0);
    if (depth === 0) setDragging(false);
  });
  window.addEventListener('drop', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setDragging(false);
    send(event.dataTransfer.files);
  });
})();
