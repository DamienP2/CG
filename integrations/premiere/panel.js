/* Pulse CG panel for Premiere Pro (CEP).
 *
 * Picks a template of a Pulse CG project, fills its fields, asks the server
 * to render it at the active sequence's size and frame rate (QuickTime,
 * PNG with alpha), saves the clip under Documents/Pulse CG Renders and lays
 * it on a video track at the playhead.
 */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };
  var node = typeof require === 'function';
  var fs = node ? require('fs') : null;
  var path = node ? require('path') : null;
  var os = node ? require('os') : null;

  var state = { server: '', key: '', projects: [], project: null, template: null, data: {}, sequence: null };

  // ------------------------------------------------------------------ host

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) return reject(new Error('Not running inside Premiere Pro'));
      window.__adobe_cep__.evalScript(script, function (res) {
        if (typeof res !== 'string' || res.indexOf('OK:') !== 0) reject(new Error(String(res).replace(/^ERR:/, '') || 'Premiere script error'));
        else resolve(res.slice(3));
      });
    });
  }

  var jsx = function (s) {
    return JSON.stringify(String(s));
  };

  /** Sequence size, frame rate (as num/den), playhead. */
  function readSequence() {
    return evalScript('pcg_sequenceInfo()').then(function (r) {
      var p = r.split('|');
      var fps = parseFloat(p[2]);
      return { width: +p[0], height: +p[1], fps: fps, rate: rateOf(fps), playhead: +p[3], name: p[4], tracks: +p[5] };
    });
  }

  function rateOf(fps) {
    var ntsc = [
      [24000, 1001],
      [30000, 1001],
      [60000, 1001],
    ];
    for (var i = 0; i < ntsc.length; i++) if (Math.abs(fps - ntsc[i][0] / ntsc[i][1]) < 0.01) return { num: ntsc[i][0], den: ntsc[i][1] };
    if (Math.abs(fps - Math.round(fps)) < 0.001) return { num: Math.round(fps), den: 1 };
    return { num: Math.round(fps * 1000), den: 1000 };
  }

  // ------------------------------------------------------------------- api

  function api(method, url, body, raw) {
    return fetch(state.server + url, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + state.key }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok)
        return r.text().then(function (t) {
          throw new Error(t || r.status + ' ' + r.statusText);
        });
      return raw ? r.arrayBuffer() : r.json();
    });
  }

  function status(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status ' + (kind || '');
  }

  function busy(on) {
    $('progress').classList.toggle('hidden', !on);
    $('insert').disabled = on;
    $('toBin').disabled = on;
  }

  // ------------------------------------------------------------- settings

  function loadSettings() {
    try {
      state.server = (localStorage.getItem('pcg.server') || '').replace(/\/+$/, '');
      state.key = localStorage.getItem('pcg.key') || '';
    } catch (e) {}
    $('server').value = state.server;
    $('key').value = state.key;
  }

  function connect() {
    if (!state.server || !state.key) {
      $('settings').classList.remove('hidden');
      $('main').classList.add('hidden');
      status('Enter the Pulse CG server and an API key.');
      return;
    }
    status('Connecting…');
    api('GET', '/api/projects')
      .then(function (list) {
        state.projects = list;
        var sel = $('project');
        sel.innerHTML = '';
        list.forEach(function (p) {
          var o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.name;
          sel.appendChild(o);
        });
        var last = localStorage.getItem('pcg.project');
        if (last && list.some((p) => p.id === last)) sel.value = last;
        $('settings').classList.add('hidden');
        $('main').classList.remove('hidden');
        status('Connected to ' + state.server, 'ok');
        return openProject(sel.value);
      })
      .catch(function (e) {
        $('settings').classList.remove('hidden');
        status('Cannot connect: ' + e.message, 'error');
      });
  }

  // --------------------------------------------------------------- project

  function thumb(t) {
    return state.server + '/api/projects/' + encodeURIComponent(state.project.id) + '/templates/' + encodeURIComponent(t.id) + '/thumbnail.png?key=' + encodeURIComponent(state.key) + '&v=' + JSON.stringify(t).length;
  }

  function openProject(id) {
    if (!id) return Promise.resolve();
    try {
      localStorage.setItem('pcg.project', id);
    } catch (e) {}
    return api('GET', '/api/projects/' + encodeURIComponent(id)).then(function (p) {
      state.project = p;
      var box = $('templates');
      box.innerHTML = '';
      p.templates.forEach(function (t) {
        var b = document.createElement('button');
        b.innerHTML = '<img loading="lazy"><span></span>';
        b.querySelector('img').src = thumb(t);
        b.querySelector('span').textContent = t.name;
        b.onclick = function () {
          selectTemplate(t, b);
        };
        box.appendChild(b);
      });
      $('editor').classList.add('hidden');
    });
  }

  function selectTemplate(t, button) {
    state.template = t;
    state.data = {};
    t.fields.forEach(function (f) {
      state.data[f.key] = f.default;
    });
    [].forEach.call($('templates').children, function (b) {
      b.classList.toggle('on', b === button);
    });
    $('preview').src = thumb(t);
    var box = $('fields');
    box.innerHTML = '';
    t.fields.forEach(function (f) {
      var label = document.createElement('label');
      label.textContent = f.label;
      var input;
      if (f.kind === 'multiline') input = document.createElement('textarea');
      else {
        input = document.createElement('input');
        input.type = f.kind === 'number' ? 'number' : f.kind === 'color' ? 'color' : 'text';
      }
      input.value = f.kind === 'color' ? String(f.default).slice(0, 7) : f.default;
      input.oninput = function () {
        state.data[f.key] = input.value;
        updatePreview();
      };
      label.appendChild(input);
      box.appendChild(label);
    });
    if (!t.fields.length) box.innerHTML = '<p class="hint">This template has no fields.</p>';
    $('editor').classList.remove('hidden');
    refreshSequence();
  }

  var previewTimer = 0;
  /** Server render of the template with the values typed so far. */
  function updatePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      $('preview').src = thumb(state.template) + '&data=' + encodeURIComponent(JSON.stringify(state.data));
    }, 350);
  }

  function refreshSequence() {
    return readSequence()
      .then(function (s) {
        state.sequence = s;
        $('sequence').textContent = 'Sequence “' + s.name + '”: ' + s.width + '×' + s.height + ' · ' + +s.fps.toFixed(3) + ' fps';
        var sel = $('track');
        var keep = sel.value || localStorage.getItem('pcg.track') || '1';
        sel.innerHTML = '';
        for (var i = 0; i < s.tracks; i++) {
          var o = document.createElement('option');
          o.value = String(i);
          o.textContent = 'V' + (i + 1);
          sel.appendChild(o);
        }
        sel.value = Math.min(+keep, s.tracks - 1);
        return s;
      })
      .catch(function (e) {
        state.sequence = null;
        $('sequence').textContent = e.message;
        throw e;
      });
  }

  // ---------------------------------------------------------------- render

  function outputFolder() {
    var base = path.join(os.homedir(), 'Documents', 'Pulse CG Renders', state.project.name.replace(/[\\/:*?"<>|]/g, '-'));
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  function fileName() {
    var first = state.template.fields.map((f) => state.data[f.key]).filter(Boolean)[0] || '';
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return (state.template.name + (first ? ' - ' + first : '')).replace(/[\\/:*?"<>|\n]/g, '-').slice(0, 80) + ' ' + stamp + '.mov';
  }

  function render(place) {
    if (!state.template) return;
    if (!node) return status('Node.js is disabled in this panel (see the README).', 'error');
    busy(true);
    status('Reading the sequence…');
    refreshSequence()
      .then(function (s) {
        status('Rendering ' + s.width + '×' + s.height + ' at ' + +s.fps.toFixed(3) + ' fps…');
        return api(
          'POST',
          '/api/render',
          {
            projectId: state.project.id,
            templateId: state.template.id,
            data: state.data,
            width: s.width,
            height: s.height,
            frameRate: s.rate,
            hold: parseFloat($('hold').value) || 0,
            includeOut: $('withOut').checked,
          },
          true,
        );
      })
      .then(function (buf) {
        var file = path.join(outputFolder(), fileName());
        fs.writeFileSync(file, Buffer.from(buf));
        status('Importing…');
        var track = place ? $('track').value : '-1';
        try {
          localStorage.setItem('pcg.track', $('track').value);
        } catch (e) {}
        return evalScript('pcg_import(' + jsx(file) + ', ' + Number(track) + ')');
      })
      .then(function (msg) {
        status(msg, 'ok');
      })
      .catch(function (e) {
        status(e.message, 'error');
      })
      .then(function () {
        busy(false);
      });
  }

  // ------------------------------------------------------------------ wire

  $('toggleSettings').onclick = function () {
    $('settings').classList.toggle('hidden');
  };
  $('saveSettings').onclick = function () {
    state.server = $('server').value.trim().replace(/\/+$/, '');
    if (state.server && !/^https?:\/\//.test(state.server)) state.server = 'http://' + state.server;
    state.key = $('key').value.trim();
    try {
      localStorage.setItem('pcg.server', state.server);
      localStorage.setItem('pcg.key', state.key);
    } catch (e) {}
    connect();
  };
  $('project').onchange = function () {
    openProject(this.value).catch(function (e) {
      status(e.message, 'error');
    });
  };
  $('refresh').onclick = connect;
  $('insert').onclick = function () {
    render(true);
  };
  $('toBin').onclick = function () {
    render(false);
  };

  loadSettings();
  connect();
})();
