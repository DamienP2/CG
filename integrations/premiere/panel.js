/* Pulse CG panel for Premiere Pro (CEP).
 *
 * Picks a template of a Pulse CG project, fills its values with a live
 * preview (the server's HTML5 renderer in an iframe), asks the server to
 * render it at the active sequence's size and frame rate (QuickTime, PNG
 * with alpha) and lays the clip on a free video track. A clip placed by the
 * panel keeps its values in a sidecar file (<clip>.pcg.json): selecting it in
 * the timeline loads it back, and Update replaces it in place. Graphics can
 * also be made from the sequence markers, all at once.
 *
 * Written for CEP 9+ (Chromium 61): no optional chaining, no `??`.
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
  var crypto = node ? require('crypto') : null;

  var store = {
    get: function (k, d) {
      try {
        var v = localStorage.getItem('pcg.' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set: function (k, v) {
      try {
        localStorage.setItem('pcg.' + k, JSON.stringify(v));
      } catch (e) {}
    },
  };

  var S = {
    server: '',
    key: '',
    folder: '',
    projects: [],
    project: null,
    template: null,
    data: {},
    seq: null,
    tab: 'graphics',
    filter: 'all',
    q: '',
    favs: store.get('favs', {}),
    recent: store.get('recent', {}),
    bg: 'alpha',
    t: 0,
    playing: false,
    durMode: 'value',
    hold: store.get('hold', 5),
    withOut: true,
    track: 'auto',
    queue: [],
    editing: null,
    selectedPath: '',
    markers: [],
    use: [],
    map: {},
    warnings: [],
  };

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

  /** Size, frame rate, playhead, In / Out of the active sequence (seconds). */
  function readSequence() {
    return evalScript('pcg_sequenceInfo()').then(function (r) {
      var p = r.split('|');
      var fps = parseFloat(p[2]);
      return { width: +p[0], height: +p[1], fps: fps, rate: rateOf(fps), playhead: +p[3], name: p[4], tracks: +p[5], inPt: +p[6], outPt: +p[7] };
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
    return fetch(S.server + url, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + S.key }, body ? { 'Content-Type': 'application/json' } : {}),
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

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  // ------------------------------------------------------------- template timing

  function fpsOf() {
    var r = S.project && S.project.frameRate;
    return r ? r.num / r.den || 25 : 25;
  }
  /** The on-air point (out marker), else the end. */
  function holdFrame(t) {
    var m = (t.markers || []).filter(function (x) {
      return x.kind === 'out';
    })[0];
    return m ? m.frame : t.duration;
  }
  function inSecs() {
    return S.template ? holdFrame(S.template) / fpsOf() : 0;
  }
  function outSecs() {
    return S.template ? (S.template.duration - holdFrame(S.template)) / fpsOf() : 0;
  }
  /** Seconds on air, from the timing choice. */
  function holdSecs() {
    var around = inSecs() + (S.withOut ? outSecs() : 0);
    if (S.durMode === 'inout' && S.seq && S.seq.outPt > S.seq.inPt) return Math.max(0, S.seq.outPt - S.seq.inPt - around);
    if (S.durMode === 'clip' && S.selection) return Math.max(0, S.selection.end - S.selection.start - around);
    return Math.max(0, S.hold);
  }
  function total() {
    return inSecs() + holdSecs() + (S.withOut ? outSecs() : 0);
  }
  /** Where the clip goes: the In point, the selected clip, or the playhead. */
  function placeAt() {
    if (S.durMode === 'inout' && S.seq && S.seq.outPt > S.seq.inPt) return S.seq.inPt;
    if (S.durMode === 'clip' && S.selection) return S.selection.start;
    return S.seq ? S.seq.playhead : -1;
  }
  /** Template frame shown at `t` seconds of the clip. */
  function frameAt(t) {
    var fps = fpsOf();
    var h = holdFrame(S.template);
    if (t < inSecs()) return t * fps;
    if (t < inSecs() + holdSecs() || !S.withOut) return h;
    return Math.min(S.template.duration, h + (t - inSecs() - holdSecs()) * fps);
  }

  // ------------------------------------------------------------- settings

  function loadSettings() {
    S.server = (store.get('server', '') || '').replace(/\/+$/, '');
    S.key = store.get('key', '');
    S.folder = store.get('folder', '');
    $('server').value = S.server;
    $('key').value = S.key;
    $('folder').value = S.folder;
  }

  function show(connected) {
    ['tabs', 'body', 'foot'].forEach(function (id) {
      $(id).classList.toggle('hidden', !connected);
    });
    $('dot').className = 'dot ' + (connected ? 'ok' : S.server ? 'err' : '');
    $('dot').title = connected ? 'Connected to ' + S.server : 'Not connected';
  }

  function connect() {
    if (!S.server || !S.key) {
      $('settings').classList.remove('hidden');
      show(false);
      status('Enter the Pulse CG server and an API key.');
      return;
    }
    status('Connecting…');
    api('GET', '/api/projects')
      .then(function (list) {
        S.projects = list;
        var sel = $('project');
        sel.innerHTML = list
          .map(function (p) {
            return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
          })
          .join('');
        var last = store.get('project', '');
        if (
          last &&
          list.some(function (p) {
            return p.id === last;
          })
        )
          sel.value = last;
        $('settings').classList.add('hidden');
        show(true);
        status('');
        $('pvFrame').src = S.server + '/embed/preview?key=' + encodeURIComponent(S.key);
        return openProject(sel.value);
      })
      .catch(function (e) {
        $('settings').classList.remove('hidden');
        show(false);
        status('Cannot connect: ' + e.message, 'error');
      });
  }

  // --------------------------------------------------------------- project

  function thumb(t) {
    return S.server + '/api/projects/' + encodeURIComponent(S.project.id) + '/templates/' + encodeURIComponent(t.id) + '/thumbnail.png?key=' + encodeURIComponent(S.key) + '&v=' + JSON.stringify(t).length;
  }

  function zoneName(id) {
    var z = (S.project.zones || []).filter(function (x) {
      return x.id === id;
    })[0];
    return z ? z.name : '';
  }

  function openProject(id) {
    if (!id) return Promise.resolve();
    store.set('project', id);
    return api('GET', '/api/projects/' + encodeURIComponent(id)).then(function (p) {
      S.project = p;
      S.filter = 'all';
      var keep = S.template && p.templates.filter((t) => t.id === S.template.id)[0];
      if (keep) S.template = keep;
      else S.template = null;
      renderTemplates();
      renderEditor();
      refreshSequence();
    });
  }

  function renderTemplates() {
    if (!S.project) return;
    var zones = [];
    S.project.templates.forEach(function (t) {
      if (t.zone && zones.indexOf(t.zone) < 0) zones.push(t.zone);
    });
    var chips = [['all', 'All'], ['fav', 'Favourites']].concat(
      zones.map(function (z) {
        return [z, zoneName(z) || z];
      }),
    );
    $('filters').innerHTML = chips
      .map(function (c) {
        return '<button class="chip ' + (S.filter === c[0] ? 'on' : '') + '" data-filter="' + esc(c[0]) + '">' + esc(c[1]) + '</button>';
      })
      .join('');
    var favs = S.favs[S.project.id] || {};
    var q = S.q.trim().toLowerCase();
    var list = S.project.templates.filter(function (t) {
      if (S.filter === 'fav' && !favs[t.id]) return false;
      if (S.filter !== 'all' && S.filter !== 'fav' && t.zone !== S.filter) return false;
      return !q || t.name.toLowerCase().indexOf(q) >= 0;
    });
    $('templates').innerHTML = list.length
      ? list
          .map(function (t) {
            return (
              '<button class="tpl ' +
              (S.template && S.template.id === t.id ? 'on' : '') +
              '" data-tpl="' +
              esc(t.id) +
              '"><img loading="lazy" src="' +
              esc(thumb(t)) +
              '"><span class="z">' +
              esc(zoneName(t.zone)) +
              '</span><span class="star ' +
              (favs[t.id] ? 'on' : '') +
              '" data-fav="' +
              esc(t.id) +
              '" title="Favourite">★</span><span class="nm">' +
              esc(t.name) +
              '</span></button>'
            );
          })
          .join('')
      : '<div class="empty">No template.</div>';
  }

  function selectTemplate(t, data) {
    S.template = t;
    S.data = {};
    t.fields.forEach(function (f) {
      S.data[f.key] = f.default;
    });
    if (data) Object.assign(S.data, data);
    S.t = inSecs() + 0.5;
    S.map = {};
    renderTemplates();
    renderEditor();
  }

  // ---------------------------------------------------------------- editor

  function renderEditor() {
    var t = S.template;
    $('editor').classList.toggle('hidden', !t);
    $('insert').disabled = !t;
    $('toBin').disabled = !t;
    if (!t) return;
    var box = $('fields');
    box.innerHTML = t.fields.length ? '' : '<div class="empty">No values to set.</div>';
    t.fields.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'f';
      row.innerHTML = '<span>' + esc(f.label) + '</span>';
      row.appendChild(fieldInput(f));
      box.appendChild(row);
      var rec = (S.recent[f.key] || []).filter(function (v) {
        return v !== S.data[f.key];
      });
      if ((f.kind === 'text' || f.kind === 'multiline') && rec.length) {
        var r = document.createElement('div');
        r.className = 'recent';
        r.innerHTML = rec
          .slice(0, 4)
          .map(function (v) {
            return '<button data-recent="' + esc(f.key) + '" data-v="' + esc(v) + '" title="' + esc(v) + '">' + esc(v) + '</button>';
          })
          .join('');
        box.appendChild(r);
      }
    });
    renderTiming();
    renderEditing();
    sendPreview();
  }

  function fieldInput(f) {
    var v = S.data[f.key] == null ? '' : String(S.data[f.key]);
    var set = function (x) {
      S.data[f.key] = x;
      sendPreview();
    };
    var el;
    if (f.options && f.options.length) {
      el = document.createElement('select');
      el.innerHTML = f.options
        .map(function (o) {
          return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>';
        })
        .join('');
      el.value = v;
      el.onchange = function () {
        set(el.value);
      };
      return el;
    }
    if (f.kind === 'boolean') {
      el = document.createElement('button');
      el.className = 'tog ' + (v === 'true' ? 'on' : '');
      el.innerHTML = '<i></i>';
      el.onclick = function () {
        var on = !el.classList.contains('on');
        el.classList.toggle('on', on);
        set(on ? 'true' : 'false');
      };
      return el;
    }
    if (f.kind === 'color') {
      el = document.createElement('div');
      el.className = 'color';
      el.innerHTML = '<input type="color"><input>';
      var pick = el.children[0];
      var hex = el.children[1];
      pick.value = v.slice(0, 7) || '#ffffff';
      hex.value = v;
      pick.oninput = function () {
        hex.value = pick.value + (v.length === 9 ? v.slice(7) : '');
        set(hex.value);
      };
      hex.oninput = function () {
        if (/^#[0-9a-f]{6}/i.test(hex.value)) pick.value = hex.value.slice(0, 7);
        set(hex.value);
      };
      return el;
    }
    el = document.createElement(f.kind === 'multiline' ? 'textarea' : 'input');
    if (f.kind === 'multiline') el.rows = 2;
    if (f.kind === 'number') el.type = 'number';
    el.value = v;
    el.oninput = function () {
      set(el.value);
    };
    return el;
  }

  function renderTiming() {
    [].forEach.call($('durModes').children, function (b) {
      b.classList.toggle('on', b.dataset.dur === S.durMode);
    });
    $('holdRow').classList.toggle('hidden', S.durMode !== 'value');
    $('hold').value = S.hold;
    $('withOut').classList.toggle('on', S.withOut);
    $('sum').innerHTML = 'IN <b>' + inSecs().toFixed(1) + '</b> + ON AIR <b>' + holdSecs().toFixed(1) + '</b>' + (S.withOut ? ' + OUT <b>' + outSecs().toFixed(1) + '</b>' : '') + ' = <b>' + total().toFixed(1) + ' s</b>';
    renderScrub();
    renderMeta();
  }

  function renderMeta() {
    var s = S.seq;
    var where = S.track === 'auto' ? 'first free track' : 'V' + (+S.track + 1);
    $('meta').textContent = S.template ? S.template.name + ' · ' + total().toFixed(1) + ' s' + (s ? ' · ' + s.width + '×' + s.height + ' ' + +s.fps.toFixed(3) + ' fps' : '') + ' → ' + where : '';
    $('insert').innerHTML = S.editing ? '↻ Update clip' : S.durMode === 'inout' ? '↓ Insert at In' : S.durMode === 'clip' ? '↓ Insert over the clip' : '↓ Insert at playhead';
  }

  function renderScrub() {
    if (!S.template) return;
    var a = inSecs();
    var h = holdSecs();
    var o = S.withOut ? outSecs() : 0;
    $('scrub').innerHTML = '<div class="a" style="flex:' + Math.max(a, 0.01) + '">IN</div><div class="h" style="flex:' + Math.max(h, 0.01) + '">' + h.toFixed(1) + ' s</div>' + (o ? '<div class="o" style="flex:' + o + '">OUT</div>' : '') + '<span class="cur" id="cur"></span>';
    moveCursor();
  }

  function moveCursor() {
    var c = $('cur');
    var tot = total() || 1;
    var t = Math.min(S.t, tot);
    if (c) c.style.left = (t / tot) * 100 + '%';
    $('pvTc').textContent = t.toFixed(1) + ' / ' + tot.toFixed(1) + ' s';
  }

  function renderEditing() {
    var e = S.editing;
    $('editing').classList.toggle('hidden', !e);
    if (e) $('editing').innerHTML = '✎ Editing <b>' + esc(e.label) + '</b><span class="sp"></span><button class="ib" id="stopEdit" title="Stop editing">✕</button>';
    renderMeta();
  }

  // --------------------------------------------------------------- preview

  var frameReady = false;
  function sendPreview() {
    var w = $('pvFrame').contentWindow;
    if (!w || !frameReady || !S.template) return;
    w.postMessage({ type: 'pcg-preview', projectId: S.project.id, templateId: S.template.id, data: S.data, frame: frameAt(Math.min(S.t, total())), width: S.seq ? S.seq.width : undefined, height: S.seq ? S.seq.height : undefined }, '*');
    moveCursor();
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data || {};
    if (m.type === 'pcg-ready') {
      frameReady = true;
      sendPreview();
    } else if (m.type === 'pcg-warnings') {
      S.warnings = m.list || [];
      var w = $('warn');
      w.classList.toggle('hidden', !S.warnings.length);
      w.innerHTML = S.warnings
        .map(function (x) {
          return '⚠ ' + esc(x.layer) + (x.overflows ? ': too long for its box, not all shown.' : ': too long, reduced to ' + Math.round(x.ratio * 100) + ' %.');
        })
        .join('<br>');
    }
  });

  var last = 0;
  function loop(now) {
    if (S.playing) {
      S.t += (now - (last || now)) / 1000;
      if (S.t > total() + 0.5) S.t = 0;
      sendPreview();
    }
    last = now;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function setBackground(bg) {
    S.bg = bg;
    [].forEach.call($('bgs').children, function (b) {
      b.classList.toggle('on', b.dataset.bg === bg);
    });
    var el = $('pvBg');
    el.className = 'pv-bg ' + (bg === 'frame' ? '' : bg);
    el.style.backgroundImage = '';
    if (bg !== 'frame') return;
    if (!node) return status('Node.js is disabled in this panel (see the README).', 'error');
    var file = path.join(os.tmpdir(), 'pcg-frame-' + Date.now() + '.png');
    evalScript('pcg_exportFrame(' + jsx(file) + ')')
      .then(function () {
        // Premiere writes the file a moment later.
        var tries = 0;
        var h = setInterval(function () {
          tries++;
          if (fs.existsSync(file) && fs.statSync(file).size > 0) {
            clearInterval(h);
            var data = fs.readFileSync(file).toString('base64');
            el.style.backgroundImage = 'url(data:image/png;base64,' + data + ')';
            fs.unlink(file, function () {});
          } else if (tries > 30) {
            clearInterval(h);
            status('The frame could not be read.', 'error');
          }
        }, 100);
      })
      .catch(function (e) {
        status(e.message, 'error');
        setBackground('alpha');
      });
  }

  // ------------------------------------------------------------- sequence

  function refreshSequence() {
    return readSequence()
      .then(function (s) {
        S.seq = s;
        var sel = $('track');
        var keep = S.track;
        var opts = '<option value="auto">Auto · first free</option>';
        for (var i = 1; i < s.tracks; i++) opts += '<option value="' + i + '">V' + (i + 1) + '</option>';
        sel.innerHTML = opts;
        sel.value = keep === 'auto' || +keep < s.tracks ? keep : 'auto';
        renderTiming();
        return s;
      })
      .catch(function (e) {
        S.seq = null;
        renderMeta();
        throw e;
      });
  }

  /** The selected clip; a clip made by the panel loads its values back. */
  function watchSelection() {
    if (!window.__adobe_cep__) return;
    evalScript('pcg_selected()')
      .then(function (r) {
        if (!r) {
          S.selection = null;
          if (S.selectedPath) {
            S.selectedPath = '';
            S.editing = null;
            renderEditing();
          }
          return;
        }
        var p = r.split('\t');
        S.selection = { media: p[0], start: +p[1], end: +p[2], track: +p[3] };
        if (p[0] === S.selectedPath) return;
        S.selectedPath = p[0];
        var side = node && p[0] && fs.existsSync(p[0] + '.pcg.json') ? JSON.parse(fs.readFileSync(p[0] + '.pcg.json', 'utf8')) : null;
        if (!side || !S.project || side.projectId !== S.project.id) {
          S.editing = null;
          renderEditing();
          if (S.durMode === 'clip') renderTiming();
          return;
        }
        var t = S.project.templates.filter(function (x) {
          return x.id === side.templateId;
        })[0];
        if (!t) return;
        S.editing = { media: p[0], label: side.label || t.name };
        S.withOut = side.withOut !== false;
        S.durMode = 'value';
        S.hold = side.hold;
        S.tab = 'graphics';
        showTab();
        selectTemplate(t, side.data);
      })
      .catch(function () {});
  }
  setInterval(watchSelection, 1000);

  // ---------------------------------------------------------------- render

  function outputFolder() {
    var base = S.folder ? S.folder : path.join(os.homedir(), 'Documents', 'Pulse CG Renders');
    var dir = path.join(base, S.project.name.replace(/[\\/:*?"<>|]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function labelOf(t, data) {
    var first = t.fields
      .map(function (f) {
        return data[f.key];
      })
      .filter(Boolean)[0];
    return String(first || t.name).replace(/\n/g, ' ');
  }

  function remember(data) {
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (!v || typeof v !== 'string' || v.length > 120) return;
      var l = (S.recent[k] || []).filter(function (x) {
        return x !== v;
      });
      l.unshift(v);
      S.recent[k] = l.slice(0, 6);
    });
    store.set('recent', S.recent);
  }

  var chain = Promise.resolve();
  /**
   * Renders the current template with `data` (one render at a time) and
   * hands the file to `place`. The same graphic rendered before is reused.
   */
  function enqueue(data, place, where) {
    if (!node) return status('Node.js is disabled in this panel (see the README).', 'error');
    var t = S.template;
    var s = S.seq;
    var body = { projectId: S.project.id, templateId: t.id, data: Object.assign({}, data), width: s.width, height: s.height, frameRate: s.rate, hold: holdSecs(), includeOut: S.withOut };
    var hash = crypto
      .createHash('md5')
      .update(JSON.stringify([body, t.revision || 0, JSON.stringify(t).length]))
      .digest('hex')
      .slice(0, 10);
    var label = labelOf(t, data);
    var file = path.join(outputFolder(), (t.name + ' - ' + label).replace(/[\\/:*?"<>|\n]/g, '-').slice(0, 70) + ' ' + hash + '.mov');
    var job = { label: label, template: t.name, secs: total(), where: where, state: 'waiting', started: 0 };
    S.queue.unshift(job);
    remember(data);
    renderQueue();
    chain = chain.then(function () {
      var cached = fs.existsSync(file);
      job.state = cached ? 'cached' : 'rendering';
      job.started = Date.now();
      renderQueue();
      var made = cached
        ? Promise.resolve()
        : api('POST', '/api/render', body, true).then(function (buf) {
            fs.writeFileSync(file, Buffer.from(buf));
          });
      return made
        .then(function () {
          fs.writeFileSync(file + '.pcg.json', JSON.stringify({ projectId: body.projectId, templateId: t.id, data: body.data, hold: body.hold, withOut: body.includeOut, label: label }, null, 2));
          return place(file);
        })
        .then(function (msg) {
          if (job.state !== 'cached') job.state = 'done';
          status(msg, 'ok');
        })
        .catch(function (e) {
          job.state = 'error';
          job.error = e.message;
          status(e.message, 'error');
        })
        .then(renderQueue);
    });
  }

  function trackFor(start, secs) {
    if (S.track !== 'auto') return Promise.resolve(+S.track);
    return evalScript('pcg_freeTrack(' + start + ', ' + (start + secs) + ')').then(Number);
  }

  function insert() {
    if (!S.template) return;
    refreshSequence()
      .then(function () {
        if (S.editing)
          return enqueue(S.data, function (file) {
            return evalScript('pcg_replaceSelected(' + jsx(file) + ')');
          }, 'update');
        var at = placeAt();
        var secs = total();
        return trackFor(at, secs).then(function (track) {
          enqueue(S.data, function (file) {
            return evalScript('pcg_import(' + jsx(file) + ', ' + track + ', ' + at + ')');
          }, 'V' + (track + 1));
        });
      })
      .catch(function (e) {
        status(e.message, 'error');
      });
  }

  function toBin() {
    refreshSequence()
      .then(function () {
        enqueue(S.data, function (file) {
          return evalScript('pcg_import(' + jsx(file) + ', -1, -1)');
        }, 'bin');
      })
      .catch(function (e) {
        status(e.message, 'error');
      });
  }

  function renderQueue() {
    var running = S.queue.filter(function (j) {
      return j.state === 'waiting' || j.state === 'rendering';
    }).length;
    $('running').textContent = running;
    $('running').classList.toggle('hidden', !running);
    $('queue').innerHTML = S.queue.length
      ? S.queue
          .map(function (j) {
            var badge = { waiting: '<span class="badge">waiting</span>', rendering: '<span class="badge">rendering</span>', done: '<span class="badge ok">done</span>', cached: '<span class="badge cache">cached</span>', error: '<span class="badge err">failed</span>' }[j.state];
            return '<div class="q"><div><b>' + esc(j.label) + '</b><span class="meta">' + esc(j.template) + ' · ' + j.secs.toFixed(1) + ' s · ' + esc(j.where) + (j.error ? ' · ' + esc(j.error) : '') + '</span>' + (j.state === 'rendering' ? '<div class="bar"><i></i></div>' : '') + '</div>' + badge + '</div>';
          })
          .join('')
      : '<div class="sec empty">No render yet.</div>';
  }

  // --------------------------------------------------------------- markers

  function loadMarkers() {
    return evalScript('pcg_markers()')
      .then(function (r) {
        S.markers = r
          ? r.split('\n').map(function (l) {
              var p = l.split('\t');
              return { start: +p[0], name: p[1] || '', comment: p[2] || '' };
            })
          : [];
        S.use = S.markers.map(function () {
          return true;
        });
        renderMarkers();
      })
      .catch(function (e) {
        status(e.message, 'error');
      });
  }

  function tcOf(s) {
    var m = Math.floor(s / 60);
    var x = Math.floor(s % 60);
    return (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }

  function renderMarkers() {
    $('markers').innerHTML = S.markers.length
      ? S.markers
          .map(function (m, i) {
            return '<label class="mrow"><input type="checkbox" data-use="' + i + '" ' + (S.use[i] ? 'checked' : '') + '><span class="tc">' + tcOf(m.start) + '</span><div><b>' + esc(m.name || '—') + '</b><span>' + esc(m.comment) + '</span></div></label>';
          })
          .join('')
      : '<div class="empty">No marker in the sequence.</div>';
    var t = S.template;
    $('mapTitle').textContent = t ? 'Fill ' + t.name + ' with' : 'Choose a template in Graphics';
    var texts = t
      ? t.fields.filter(function (f) {
          return f.kind === 'text' || f.kind === 'multiline';
        })
      : [];
    $('map').innerHTML = t
      ? t.fields
          .map(function (f) {
            var d = S.map[f.key] || (texts[0] === f ? 'name' : texts[1] === f ? 'comment' : 'value');
            S.map[f.key] = d;
            return '<span>' + esc(f.label) + '</span><select data-map="' + esc(f.key) + '"><option value="name" ' + (d === 'name' ? 'selected' : '') + '>Marker name</option><option value="comment" ' + (d === 'comment' ? 'selected' : '') + '>Marker comment</option><option value="value" ' + (d === 'value' ? 'selected' : '') + '>Its value</option></select>';
          })
          .join('')
      : '';
    var n = S.use.filter(Boolean).length;
    $('batch').disabled = !t || !n;
    $('batch').textContent = '↓ Create ' + n + ' graphic' + (n > 1 ? 's' : '') + ' at the markers';
    $('batchMeta').textContent = t ? 'Each one ' + holdSecs().toFixed(1) + ' s on air (Timing), on ' + (S.track === 'auto' ? 'the first free track' : 'V' + (+S.track + 1)) + '.' : '';
  }

  function batch() {
    refreshSequence()
      .then(function () {
        var secs = total();
        return S.markers.reduce(function (p, m, i) {
          if (!S.use[i]) return p;
          return p.then(function () {
            var data = Object.assign({}, S.data);
            Object.keys(S.map).forEach(function (k) {
              if (S.map[k] === 'name') data[k] = m.name;
              else if (S.map[k] === 'comment') data[k] = m.comment;
            });
            return trackFor(m.start, secs).then(function (track) {
              enqueue(data, function (file) {
                return evalScript('pcg_import(' + jsx(file) + ', ' + track + ', ' + m.start + ')');
              }, 'V' + (track + 1) + ' · ' + tcOf(m.start));
            });
          });
        }, Promise.resolve());
      })
      .then(function () {
        S.tab = 'renders';
        showTab();
      })
      .catch(function (e) {
        status(e.message, 'error');
      });
  }

  // ------------------------------------------------------------------ tabs

  function showTab() {
    [].forEach.call($('tabs').children, function (b) {
      b.classList.toggle('on', b.dataset.tab === S.tab);
    });
    ['graphics', 'markers', 'renders'].forEach(function (k) {
      $('tab-' + k).classList.toggle('hidden', S.tab !== k);
    });
    $('foot').classList.toggle('hidden', S.tab !== 'graphics');
    if (S.tab === 'markers') loadMarkers();
    if (S.tab === 'renders') renderQueue();
  }

  // ------------------------------------------------------------------ wire

  document.addEventListener('click', function (e) {
    var el = e.target.closest('button, [data-tpl]');
    if (!el) return;
    var d = el.dataset;
    if (d.fav) {
      e.stopPropagation();
      var f = (S.favs[S.project.id] = S.favs[S.project.id] || {});
      if (f[d.fav]) delete f[d.fav];
      else f[d.fav] = 1;
      store.set('favs', S.favs);
      return renderTemplates();
    }
    if (d.tpl) {
      S.editing = null;
      return selectTemplate(
        S.project.templates.filter(function (t) {
          return t.id === d.tpl;
        })[0],
      );
    }
    if (d.filter) {
      S.filter = d.filter;
      return renderTemplates();
    }
    if (d.tab) {
      S.tab = d.tab;
      return showTab();
    }
    if (d.bg) return setBackground(d.bg);
    if (d.dur) {
      S.durMode = d.dur;
      if (d.dur === 'clip' && !S.selection) status('Select a clip in the timeline: the graphic takes its length.');
      return refreshSequence().catch(function () {
        renderTiming();
      });
    }
    if (d.recent) {
      S.data[d.recent] = d.v;
      return renderEditor();
    }
    if (el.id === 'stopEdit') {
      S.editing = null;
      return renderEditing();
    }
  });

  $('search').oninput = function () {
    S.q = this.value;
    renderTemplates();
  };
  $('safe').onclick = function () {
    $('safe').classList.toggle('on');
    $('pvSafe').classList.toggle('hidden');
  };
  $('play').onclick = function () {
    S.playing = !S.playing;
    if (S.playing && S.t >= total()) S.t = 0;
    $('play').textContent = S.playing ? '❚❚' : '▶';
  };
  $('scrub').onclick = function (e) {
    var r = this.getBoundingClientRect();
    S.t = ((e.clientX - r.left) / r.width) * total();
    S.playing = false;
    $('play').textContent = '▶';
    sendPreview();
  };
  $('reset').onclick = function () {
    if (S.template) selectTemplate(S.template);
  };
  $('hold').oninput = function () {
    S.hold = Math.max(0, parseFloat(this.value) || 0);
    store.set('hold', S.hold);
    renderTiming();
    sendPreview();
  };
  $('withOut').onclick = function () {
    S.withOut = !S.withOut;
    renderTiming();
    sendPreview();
  };
  $('track').onchange = function () {
    S.track = this.value;
    renderMeta();
  };
  $('toggleSettings').onclick = function () {
    $('settings').classList.toggle('hidden');
  };
  $('saveSettings').onclick = function () {
    S.server = $('server').value.trim().replace(/\/+$/, '');
    if (S.server && !/^https?:\/\//.test(S.server)) S.server = 'http://' + S.server;
    S.key = $('key').value.trim();
    S.folder = $('folder').value.trim();
    store.set('server', S.server);
    store.set('key', S.key);
    store.set('folder', S.folder);
    connect();
  };
  $('project').onchange = function () {
    openProject(this.value).catch(function (e) {
      status(e.message, 'error');
    });
  };
  $('insert').onclick = insert;
  $('toBin').onclick = toBin;
  $('reloadMarkers').onclick = loadMarkers;
  $('batch').onclick = batch;
  $('markers').onchange = function (e) {
    if (e.target.dataset.use !== undefined) {
      S.use[+e.target.dataset.use] = e.target.checked;
      renderMarkers();
    }
  };
  $('map').onchange = function (e) {
    if (e.target.dataset.map) S.map[e.target.dataset.map] = e.target.value;
  };
  // Back in the panel: the sequence may have changed.
  window.addEventListener('focus', function () {
    refreshSequence().catch(function () {});
  });

  loadSettings();
  connect();
})();
