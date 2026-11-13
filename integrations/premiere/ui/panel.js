/* Strata panel for Premiere Pro (CEP).
 *
 * Post-production: Premiere's timeline is the reference. The panel is made
 * of the web app's own components (its stylesheet, <server>/premiere/app.css,
 * is linked before panel.css).
 *
 *  - Séquence (home): the Strata clips of the active sequence, in time
 *    order, as the Operator's rundown. The square moves Premiere's playhead
 *    to the clip and selects it; a click on the row opens it. An orange dot:
 *    the clip must be rendered again (trimmed in Premiere, or its template
 *    published since); TOUT METTRE À JOUR renders them again in place.
 *  - Modèles: the templates of a project of the server; + inserts one as it
 *    is at the playhead, a click opens a new clip.
 *  - Clip (selected in the sequence, or new): the animated preview, its
 *    length (Durée), its timeline (Déroulé: IN, the pauses, the actions the
 *    operator would do live, OUT at the end), its values. METTRE À JOUR
 *    renders it again in place; INSÉRER lays it on the first free track
 *    (at the playhead, or between the In and Out points); TOUTES LES LIGNES
 *    lays one clip per row of its data set on the sequence markers.
 *  - Réglages: server, API key, version.
 *
 * The server renders the clip at the sequence's size and frame rate
 * (QuickTime PNG + alpha, POST /api/render/jobs). Each clip keeps what made
 * it in <clip>.mov.pcg.json, next to it.
 *
 * Written for CEP 9+ (Chromium 61, Node 8): ES2015, no optional chaining, no `??`.
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
  var noop = function () {};

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

  /** Seconds on air of a template that holds until Take out. */
  var DEFAULT_HOLD = 5;
  /** Seconds on a pause that waits for Continue or a trigger. */
  var DEFAULT_PAUSE = 2;
  /** Longest clip the server renders. */
  var MAX_SECONDS = 300;
  /** The sequence is read this often (ms), the projects every SYNC_MS. */
  var POLL_MS = 1500;
  var SYNC_MS = 15000;

  var S = {
    server: '',
    key: '',
    folder: store.get('folder', ''),
    online: null,
    update: null,
    test: null,
    screen: 'seq',
    prev: 'seq',
    seq: null,
    clips: [],
    selKey: '',
    quietSel: '',
    full: {},
    sig: {},
    loading: {},
    projects: [],
    pid: store.get('project', ''),
    E: null,
    jobs: [],
    skew: 0,
    lastDefault: store.get('lastDefault', {}),
  };

  // ----------------------------------------------------------------- utils

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var enc = encodeURIComponent;
  var clamp = function (x, a, b) {
    return Math.max(a, Math.min(b, x));
  };
  var pad2 = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  /** "9,5" */
  var dec = function (x, digits) {
    return x.toFixed(digits).replace('.', ',');
  };
  /** "32 s", "9,5 s" */
  var secs = function (x) {
    return (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : dec(x, 1)) + ' s';
  };

  function hash(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + text.length;
  }
  var tplHashes = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** A template's fingerprint: it changes when the template is published again. */
  function tplHash(t) {
    var h = tplHashes && tplHashes.get(t);
    if (!h) {
      h = hash(JSON.stringify(t));
      if (tplHashes) tplHashes.set(t, h);
    }
    return h;
  }

  /** #rrggbb → rgba(), for the zone pills where color-mix() is missing. */
  function rgba(hex, a) {
    var m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
    if (!m) return '';
    var n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function plain(v) {
    return String(v == null ? '' : v)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var svg = function (name, size, body, fill) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + (fill || 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-' + name + '" aria-hidden="true">' + body + '</svg>';
  };
  var I = {
    plus: svg('plus', 15, '<path d="M5 12h14"></path><path d="M12 5v14"></path>'),
    plus13: svg('plus', 13, '<path d="M5 12h14"></path><path d="M12 5v14"></path>'),
    check: svg('check', 12, '<path d="M20 6 9 17l-5-5"></path>'),
    x: svg('x', 13, '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'),
    chevDown: svg('chevron-down', 12, '<path d="m6 9 6 6 6-6"></path>'),
    eye: svg('eye', 15, '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle>'),
    eyeOff: svg('eye-off', 15, '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"></path><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"></path><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"></path><path d="m2 2 20 20"></path>'),
    listPlus: svg('list-plus', 18, '<path d="M16 5H3"></path><path d="M11 12H3"></path><path d="M16 19H3"></path><path d="M18 9v6"></path><path d="M21 12h-6"></path>'),
    film: svg('film', 18, '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M7 3v18"></path><path d="M3 7.5h4"></path><path d="M3 12h18"></path><path d="M3 16.5h4"></path><path d="M17 3v18"></path><path d="M17 7.5h4"></path><path d="M17 16.5h4"></path>'),
    rows: svg('rows-3', 15, '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M21 9H3"></path><path d="M21 15H3"></path>'),
  };

  function toast(msg, err) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (err ? ' error' : '');
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, err ? 6000 : 2600);
  }

  function needNode() {
    if (node) return true;
    toast('Node.js est désactivé dans ce panneau', true);
    return false;
  }

  // ------------------------------------------------------------- timecodes

  function seqFps() {
    return S.seq ? S.seq.fps : 25;
  }

  /** HH:MM:SS:FF of a time of the sequence. */
  function tc(sec) {
    var fps = seqFps();
    var r = Math.round(fps);
    var f = Math.max(0, Math.round(((S.seq ? S.seq.zero : 0) + sec) * fps));
    var x = Math.floor(f / r);
    return pad2(Math.floor(x / 3600)) + ':' + pad2(Math.floor(x / 60) % 60) + ':' + pad2(x % 60) + ':' + pad2(f % r);
  }

  /** Frames as MM:SS:FF (the Designer's duration field). */
  function durTc(frames, r) {
    var x = Math.floor(frames / r);
    return pad2(Math.floor(x / 60)) + ':' + pad2(x % 60) + ':' + pad2(frames % r);
  }

  /** "5" or "5s" seconds, "2:10" seconds and frames, "1:02:10" minutes too → frames. */
  function parseDur(text, fps) {
    var r = Math.round(fps);
    var t = String(text).trim().replace(/s$/i, '');
    if (/^\d+([.,]\d+)?$/.test(t)) return Math.round(parseFloat(t.replace(',', '.')) * r);
    var parts = t.split(':').map(function (x) {
      return parseInt(x, 10);
    });
    if (parts.length < 2 || parts.length > 3) return null;
    if (
      parts.some(function (x) {
        return isNaN(x) || x < 0;
      })
    )
      return null;
    if (parts.length === 2) parts.unshift(0);
    return (parts[0] * 60 + parts[1]) * r + parts[2];
  }

  /** Seconds of a frame count of the sequence, and back. */
  var framesToSec = function (f) {
    return f / seqFps();
  };
  var secToFrames = function (s) {
    return Math.round(s * seqFps());
  };

  function fpsLabel(fps) {
    return Math.abs(fps - Math.round(fps)) < 0.001 ? String(Math.round(fps)) : String(+fps.toFixed(3)).replace('.', ',');
  }

  // ------------------------------------------------------------------ host

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) return reject(new Error('Hors de Premiere Pro'));
      window.__adobe_cep__.evalScript(script, function (res) {
        if (typeof res !== 'string' || res.indexOf('OK:') !== 0) reject(new Error(String(res).replace(/^ERR:/, '') || 'Erreur de script Premiere'));
        else resolve(res.slice(3));
      });
    });
  }
  var jsx = function (s) {
    return JSON.stringify(String(s));
  };

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

  /** The sequence line of pcg_state (premiere.jsx pcg_info). */
  function parseSeq(line) {
    var p = line.split('|');
    var fps = parseFloat(p[2]) || 25;
    var f = 1 / fps;
    var s = { width: +p[0], height: +p[1], fps: fps, rate: rateOf(fps), playhead: +p[3] || 0, name: p[4] || '', tracks: +p[5] || 0, end: +p[8] || 0, zero: +p[9] || 0, id: p[10] || p[4] || '' };
    var a = +p[6];
    var b = +p[7];
    // Unset, Premiere gives -1, or the whole sequence.
    s.range = a >= 0 && b > a + f && !(a < f && s.end > 0 && b >= s.end - f) ? { a: a, b: b } : null;
    return s;
  }

  function readState() {
    return evalScript('pcg_state()').then(function (r) {
      if (!r) return { seq: null, clips: [] };
      var lines = r.split('\n');
      return {
        seq: parseSeq(lines[0]),
        clips: lines
          .slice(1)
          .filter(Boolean)
          .map(function (l) {
            var p = l.split('\t');
            return { track: +p[0], start: +p[1], end: +p[2], selected: p[3] === '1', media: p[4], name: p[5] || '' };
          }),
      };
    });
  }

  function readMarkers() {
    return evalScript('pcg_markers()').then(function (r) {
      return r
        .split('\t')
        .filter(Boolean)
        .map(Number)
        .sort(function (a, b) {
          return a - b;
        });
    });
  }

  function freeTrack(start, len) {
    return evalScript('pcg_freeTrack(' + start + ', ' + (start + len) + ')').then(Number);
  }

  // ------------------------------------------------------------------- api

  function request(method, url, body) {
    return fetch(S.server + url, {
      method: method,
      cache: 'no-store',
      headers: Object.assign({ Authorization: 'Bearer ' + S.key }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(
      function (r) {
        if (r.status === 401 || r.status === 403) setOnline(false);
        if (!r.ok)
          return r.text().then(function (t) {
            var e = new Error(t || r.status + ' ' + r.statusText);
            e.status = r.status;
            throw e;
          });
        return r;
      },
      function (e) {
        setOnline(false);
        throw e;
      },
    );
  }
  function api(method, url, body) {
    return request(method, url, body).then(function (r) {
      return r.json();
    });
  }

  function setOnline(ok) {
    if (S.online === ok) return;
    S.online = ok;
    renderTop();
  }

  /** The server's clock (the clocks of a clip are frozen at its first render). */
  function serverNow() {
    return Date.now() + S.skew;
  }

  /** The values to freeze in a clip (defaults, connectors, data set rows) and its data sets. */
  function values(pid, tid, rows) {
    var t0 = Date.now();
    return api('POST', '/api/render/values', { projectId: pid, templateId: tid, rows: rows || undefined }).then(function (r) {
      if (typeof r.now === 'number') S.skew = r.now - (t0 + Date.now()) / 2;
      return { data: r.data || {}, datasets: r.datasets || [] };
    });
  }

  // -------------------------------------------------------------- projects

  function loadProject(id, force) {
    if (!id) return Promise.reject(new Error('Aucun projet'));
    if (S.full[id] && !force) return Promise.resolve(S.full[id]);
    if (S.loading[id]) return S.loading[id];
    var done = function () {
      delete S.loading[id];
    };
    S.loading[id] = request('GET', '/api/projects/' + enc(id))
      .then(function (r) {
        return r.text();
      })
      .then(function (text) {
        setOnline(true);
        var sig = hash(text);
        if (sig !== S.sig[id] || !S.full[id]) {
          var had = !!S.full[id];
          S.sig[id] = sig;
          S.full[id] = JSON.parse(text);
          if (had) projectChanged(id);
          else renderSeq();
        }
        done();
        return S.full[id];
      })
      .catch(function (e) {
        done();
        throw e;
      });
    return S.loading[id];
  }

  function loadProjects() {
    return api('GET', '/api/projects').then(function (list) {
      setOnline(true);
      S.projects = list;
      return list;
    });
  }

  /** The projects in use, read again: a template published since shows on its clips. */
  var syncing = false;
  function syncProjects() {
    if (syncing || !S.server || !S.key || document.hidden) return;
    var ids = [];
    var want = function (id) {
      if (id && ids.indexOf(id) < 0) ids.push(id);
    };
    S.clips.forEach(function (c) {
      want(c.side.projectId);
    });
    want(S.pid);
    if (S.E) want(S.E.p.id);
    syncing = true;
    ids
      .reduce(function (chain, id) {
        return chain.then(function () {
          return loadProject(id, true).catch(noop);
        });
      }, loadProjects().catch(noop))
      .then(function () {
        syncing = false;
      });
  }

  /** A project changed on the server. */
  function projectChanged(id) {
    var p = S.full[id];
    var E = S.E;
    if (E && E.p.id === id) {
      var t = tplOf(p, E.t.id);
      if (!t) {
        toast('Modèle supprimé : ' + E.t.name, true);
        S.E = null;
        if (S.screen === 'clip') show('seq');
      } else if (tplHash(t) !== tplHash(E.t)) {
        E.p = p;
        E.t = t;
        E.m = model(t, p);
        E.acts = actionsOf(t, p);
        E.timing = fitTiming(E.m, E.timing.duration, E.timing);
        E.events = fixEvents(E.events, E.acts, E.m, E.timing);
        t.fields.forEach(function (f) {
          if (!(f.key in E.data)) E.data[f.key] = f.default;
        });
        if (S.screen === 'clip') renderEditor();
      } else E.p = p;
    }
    renderSeq();
    if (S.screen === 'tpl') renderTpl();
  }

  function tplOf(p, id) {
    return p
      ? p.templates.filter(function (t) {
          return t.id === id;
        })[0] || null
      : null;
  }
  function zoneOf(p, id) {
    return (
      ((p && p.zones) || []).filter(function (z) {
        return z.id === id;
      })[0] || null
    );
  }
  function projFps(p) {
    var r = p && p.frameRate;
    return r && r.num && r.den ? r.num / r.den : 25;
  }

  // ------------------------------------------------------- template timing

  /**
   * The stops of a template, as the server counts them (render.rs `stops`):
   * its pauses and its on-air point, in frame order, one per frame. Each
   * with the seconds it holds as on air (a timed pause, a timed on-air).
   */
  function model(t, p) {
    var fps = projFps(p);
    var markers = t.markers || [];
    var out = markers.filter(function (m) {
      return m.kind === 'out';
    })[0];
    var hold = out ? Math.min(out.frame, t.duration) : t.duration;
    var after = function (m) {
      return m && m.resume && m.resume.type === 'after' ? Math.max(0, +m.resume.seconds || 0) : null;
    };
    var list = markers
      .filter(function (m) {
        return m.kind === 'pause';
      })
      .map(function (m) {
        return { frame: clamp(m.frame, 0, t.duration), onAir: false, name: m.name || 'Pause', hold: after(m) === null ? DEFAULT_PAUSE : after(m) };
      });
    list.push({ frame: hold, onAir: true, name: '', hold: after(out) === null ? DEFAULT_HOLD : after(out) });
    list.sort(function (a, b) {
      return a.frame - b.frame || (b.onAir ? 1 : 0) - (a.onAir ? 1 : 0);
    });
    var stops = [];
    list.forEach(function (s) {
      var prev = stops[stops.length - 1];
      if (prev && Math.abs(prev.frame - s.frame) < 1e-6) {
        if (s.onAir) stops[stops.length - 1] = s;
        return;
      }
      stops.push(s);
    });
    var onAir = 0;
    stops.forEach(function (s, i) {
      if (s.onAir) onAir = i;
    });
    return { fps: fps, duration: t.duration, stops: stops, onAir: onAir };
  }

  /** Seconds of the out animation, at its speed. */
  function outLen(m) {
    return Math.max(0, (m.duration - m.stops[m.onAir].frame) / m.fps);
  }

  /** The clip as the template plays on air: animations at their speed, its holds. */
  function naturalDuration(m) {
    var k = m.onAir;
    var h = 0;
    for (var i = 0; i < k; i++) h += m.stops[i].hold;
    return clamp(m.stops[k].frame / m.fps + h + m.stops[k].hold + outLen(m), 0.04, MAX_SECONDS);
  }

  /**
   * The clip's timing for `D` seconds: when it leaves each stop (render.rs
   * ClipTiming). The out animation always ends at the end of the clip; the
   * pauses stay where they were (`prev`), else as on air (fitted in).
   */
  function fitTiming(m, D, prev) {
    var k = m.onAir;
    var n = m.stops.length;
    var fps = m.fps;
    var st = [];
    var i;
    var leave = Math.max(0, D - outLen(m));
    st[k] = leave;
    for (i = k + 1; i < n; i++) st[i] = Math.min(D, st[i - 1] + (m.stops[i].frame - m.stops[i - 1].frame) / fps);
    if (prev && prev.stops && prev.stops.length === n) {
      for (i = 0; i < k; i++) st[i] = +prev.stops[i] || 0;
    } else {
      var need = m.stops[k].frame / fps;
      var H = 0;
      for (i = 0; i < k; i++) H += m.stops[i].hold;
      var room = leave - need;
      if (room >= 0) {
        var sc = H > 0 ? Math.min(1, room / H) : 0;
        var t = 0;
        var pf = 0;
        for (i = 0; i < k; i++) {
          t += (m.stops[i].frame - pf) / fps + m.stops[i].hold * sc;
          pf = m.stops[i].frame;
          st[i] = t;
        }
      } else {
        for (i = 0; i < k; i++) st[i] = m.stops[k].frame > 0 ? (leave * m.stops[i].frame) / m.stops[k].frame : 0;
      }
    }
    var lo = 0;
    for (i = 0; i < k; i++) {
      st[i] = clamp(st[i], lo, leave);
      lo = st[i];
    }
    return { stops: st, duration: D };
  }

  /** A clip made by an older panel: its seconds on air, with or without the out animation. */
  function timingFromHold(m, hold, withOut) {
    var t = 0;
    var prev = 0;
    var stops = m.stops.map(function (s, i) {
      t += (s.frame - prev) / m.fps + (i === m.onAir ? hold : 0);
      prev = s.frame;
      return t;
    });
    var duration = withOut === false ? stops[m.onAir] : t + (m.duration - prev) / m.fps;
    return { stops: stops, duration: clamp(duration, 0.04, MAX_SECONDS) };
  }

  /** The timing a sidecar recorded, when it still fits the template. */
  function sideTiming(m, side) {
    if (side.timing && side.timing.stops && side.timing.stops.length === m.stops.length) return { stops: side.timing.stops.slice(), duration: +side.timing.duration };
    if (typeof side.hold === 'number') return timingFromHold(m, side.hold, side.withOut);
    return null;
  }

  function renderedLen(side) {
    if (typeof side.rendered === 'number') return side.rendered;
    return side.timing && side.timing.duration ? +side.timing.duration : null;
  }

  /** The end of the IN (the graphic reaches its first stop) and the start of the OUT. */
  function zones(m, c) {
    return { inEnd: Math.max(0, Math.min(c.stops[0], m.stops[0].frame / m.fps)), outStart: c.stops[m.onAir] };
  }

  /** When the graphic is fully on air. */
  function onAirAt(m, c) {
    var k = m.onAir;
    var fromT = k > 0 ? c.stops[k - 1] : 0;
    var anim = (m.stops[k].frame - (k > 0 ? m.stops[k - 1].frame : 0)) / m.fps;
    return Math.min(c.stops[k], fromT + anim);
  }

  /**
   * The template frame shown `t` seconds into the clip, as the server
   * renders it (render.rs `ClipTiming::frame_at`). Null once it has gone out.
   */
  function clipFrame(m, c, t) {
    var fromF = 0;
    var fromT = 0;
    for (var k = 0; k <= m.stops.length; k++) {
      var last = k === m.stops.length;
      var toF = last ? m.duration : m.stops[k].frame;
      var toT = last ? c.duration : c.stops[k];
      if (last || t < toT) {
        var anim = (toF - fromF) / m.fps;
        var len = toT - fromT;
        var d = Math.max(0, t - fromT);
        var f = len >= anim ? fromF + Math.min(d, anim) * m.fps : len > 0 ? fromF + Math.min(d / len, 1) * (toF - fromF) : toF;
        return !last || f < m.duration - 1e-6 ? f : null;
      }
      fromF = toF;
      fromT = toT;
    }
    return null;
  }

  // --------------------------------------------------------------- actions

  /** An element generated inside a built widget (engine/built.ts insideWidget). */
  function insideWidget(byId, l) {
    for (var p = l.parent ? byId[l.parent] : null; p; p = p.parent ? byId[p.parent] : null) if (p.widget) return true;
    return false;
  }

  /** A built widget's definition: as placed (its snapshot, as on air), else the project's. */
  function widgetDef(l, p) {
    var s = l.widget.snap;
    if (s && s.controls) return s;
    return (
      ((p && p.widgets) || []).filter(function (d) {
        return d.id === l.widget.def;
      })[0] || null
    );
  }

  /**
   * What the operator does live that a clip places in time: the layers
   * waiting for Continue or a trigger (their start), and the buttons of the
   * built widgets (as the Operator lists them, widgets/built.tsx).
   */
  function actionsOf(t, p) {
    var layers = t.layers || [];
    var byId = {};
    layers.forEach(function (l) {
      byId[l.id] = l;
    });
    var starts = [];
    var controls = [];
    layers.forEach(function (l) {
      if (insideWidget(byId, l)) return;
      if (l.manualStart) starts.push({ id: l.id, name: l.name || l.id });
      if (!l.widget || l.visible === false) return;
      var def = widgetDef(l, p);
      if (!def) return;
      var sb = l.settingBindings || {};
      (def.controls || []).forEach(function (c) {
        if (c.kind === 'list' || c.kind === 'field') return;
        if (c.choose && !sb['widget.controls.' + c.id]) return;
        controls.push({ layer: l.id, op: c.id, label: (l.name || def.name || 'Widget') + ' · ' + (c.label || c.id) });
      });
    });
    return { starts: starts, controls: controls };
  }

  function eventLabel(ev, acts) {
    var c = ev.command || {};
    if (c.action === 'widget') {
      var s = acts.starts.filter(function (x) {
        return x.id === c.target;
      })[0];
      return 'Départ · ' + (s ? s.name : c.target);
    }
    if (c.action === 'act') {
      var k = acts.controls.filter(function (x) {
        return x.layer === c.target && x.op === c.op;
      })[0];
      return k ? k.label : c.op;
    }
    return String(c.action || '?');
  }

  var evSeq = 0;
  function sortEvents(list) {
    return list.sort(function (a, b) {
      return a.at - b.at || a.id - b.id;
    });
  }

  /** The actions of a clip for its template: those it no longer has dropped, a start for each layer that waits. */
  function fixEvents(events, acts, m, timing) {
    var out = (events || [])
      .filter(function (e) {
        var c = e && e.command;
        if (!c) return false;
        if (c.action === 'widget')
          return acts.starts.some(function (s) {
            return s.id === c.target;
          });
        if (c.action === 'act')
          return acts.controls.some(function (k) {
            return k.layer === c.target && k.op === c.op;
          });
        return true;
      })
      .map(function (e) {
        return { id: ++evSeq, at: clamp(+e.at || 0, 0, timing.duration), command: e.command };
      });
    acts.starts.forEach(function (s) {
      var has = out.some(function (e) {
        return e.command.action === 'widget' && e.command.target === s.id;
      });
      if (!has) out.push({ id: ++evSeq, at: onAirAt(m, timing), command: { action: 'widget', target: s.id, control: 'start' } });
    });
    return sortEvents(out);
  }

  // -------------------------------------------------------------- sidecars

  var sideCache = {};
  /** What made a clip (<clip>.mov.pcg.json); null for any other clip. */
  function sidecarOf(media) {
    if (!node || !media) return null;
    var p = media + '.pcg.json';
    var mt;
    try {
      mt = fs.statSync(p).mtime.getTime();
    } catch (e) {
      return null;
    }
    var c = sideCache[p];
    if (c && c.mt === mt) return c.side;
    var side = null;
    try {
      side = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {}
    if (side && (!side.projectId || !side.templateId)) side = null;
    sideCache[p] = { mt: mt, side: side };
    return side;
  }

  function clipKey(c) {
    return c.track + ':' + c.start.toFixed(3) + ':' + c.media;
  }

  function defaultsOf(t) {
    var d = {};
    (t.fields || []).forEach(function (f) {
      d[f.key] = f.default;
    });
    return d;
  }

  /** The clip's main text: its first text value. */
  function mainText(t, data) {
    var fields = (t && t.fields) || [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.kind !== 'text' && f.kind !== 'multiline') continue;
      var v = plain(data && data[f.key]);
      if (v) return v;
    }
    return t ? t.name : '';
  }

  // -------------------------------------------------------------- screens

  function show(scr) {
    if (S.screen !== scr) S.prev = S.screen;
    S.screen = scr;
    ['seq', 'tpl', 'clip', 'set'].forEach(function (k) {
      $('scr-' + k).classList.toggle('pp-off', k !== scr);
    });
    closeList();
    if (scr !== 'clip') setPlaying(false);
    renderTop();
    if (scr === 'seq') renderSeq();
    if (scr === 'tpl') renderTpl();
    if (scr === 'clip') renderEditor();
    if (scr === 'set') renderSettings(true);
  }

  function backTarget() {
    return S.screen === 'clip' && S.E && S.E.mode === 'new' ? 'tpl' : 'seq';
  }

  function renderTop() {
    var el = $('pill');
    var cls;
    var txt;
    if (!S.server || !S.key) {
      cls = 'wait';
      txt = 'Non connecté';
    } else if (S.online === false) {
      cls = 'lost';
      txt = 'Hors ligne';
    } else if (S.update === 'install' || S.update === 'reload') {
      cls = 'hot';
      txt = 'Mise à jour';
    } else if (S.online === true) {
      cls = 'ok';
      txt = 'Connecté';
    } else {
      cls = 'wait';
      txt = 'Connexion…';
    }
    el.className = 'ux1-pill ' + cls;
    $('pillTxt').textContent = txt;
    el.title = 'Réglages' + (S.server ? ' · ' + S.server.replace(/^https?:\/\//, '') : '');
    var back = $('back');
    back.classList.toggle('pp-off', S.screen === 'seq');
    back.title = backTarget() === 'tpl' ? 'Modèles' : 'Séquence';
  }

  // -------------------------------------------------------------- Séquence

  var lastRows = null;

  /** The rows of the Séquence screen: its Strata clips and the clips being made, in time order. */
  function rowsModel() {
    var out = [];
    S.clips.forEach(function (c) {
      var side = c.side;
      var p = S.full[side.projectId];
      var t = p ? tplOf(p, side.templateId) : null;
      var m = t ? model(t, p) : null;
      var timing = m ? sideTiming(m, side) : null;
      var z = m && timing ? zones(m, timing) : null;
      var needs = [];
      if (t) {
        var R = renderedLen(side);
        if (R !== null && Math.abs(c.len - R) > 0.5 / seqFps()) needs.push('Durée du clip changée : ' + dec(R, 1) + ' s → ' + dec(c.len, 1) + ' s');
        if (side.templateHash && side.templateHash !== tplHash(t)) needs.push('Modèle publié depuis ce rendu');
      }
      out.push({
        key: c.key,
        clip: c,
        track: c.track,
        start: c.start,
        main: t ? mainText(t, Object.assign(defaultsOf(t), side.data || {})) : plain(side.label) || c.name,
        tpl: t ? t.name : side.template || side.templateId,
        zone: t ? zoneOf(p, t.zone) : null,
        inPc: z ? (z.inEnd / timing.duration) * 100 : 0,
        outPc: z ? (z.outStart / timing.duration) * 100 : 100,
        needs: needs,
        on: c.selected,
      });
    });
    S.jobs.forEach(function (j) {
      if (j.kind !== 'insert') return;
      var r = j.row;
      out.push({ key: j.key, pending: true, track: r.track, start: r.start, main: r.main, tpl: r.t.name, zone: zoneOf(r.p, r.t.zone), inPc: r.inPc, outPc: r.outPc, needs: [], on: false });
    });
    out.sort(function (a, b) {
      return a.start - b.start || a.track - b.track;
    });
    return out;
  }

  function jobFor(key) {
    return (
      S.jobs.filter(function (j) {
        return j.key === key;
      })[0] || null
    );
  }

  function voidHtml(icon, text, add) {
    return '<div class="opx-void"><span class="opx-void-ic">' + icon + '</span><span class="opx-void-t">' + esc(text) + '</span>' + (add ? '<button class="opx-btn small" data-add-tpl="1">' + I.plus13 + ' Ajouter un graphique</button>' : '') + '</div>';
  }

  function renderSeq() {
    if (S.screen !== 'seq') return;
    var s = S.seq;
    $('seqTabs').classList.toggle('pp-off', !s);
    $('seqFmt').textContent = s ? s.width + '×' + s.height + ' · ' + fpsLabel(s.fps) + ' i/s' : '';
    $('seqAdd').disabled = !s;
    var rows = s ? rowsModel() : [];
    if (s) {
      $('seqName').textContent = s.name;
      $('seqN').textContent = String(S.clips.length);
      $('seqName').parentNode.title = S.clips.length + (S.clips.length > 1 ? ' graphiques' : ' graphique');
    }
    var html;
    if (!s) html = voidHtml(I.film, 'Ouvrez une séquence', false);
    else if (!rows.length) html = voidHtml(I.listPlus, 'Aucun graphique', true);
    else
      html = rows
        .map(function (r) {
          var job = jobFor(r.key);
          var zc = r.zone ? r.zone.color || '#8a90ad' : '';
          var state = job ? '<span class="pp-pct"></span>' : r.needs.length ? '<span class="tpl-draft" title="' + esc(r.needs.join('\n')) + '"></span>' : '';
          return (
            '<div class="opx-gr' + (r.on ? ' on' : '') + (job ? ' pp-busy' : '') + (r.pending ? ' pp-pending' : '') + '" data-row="' + esc(r.key) + '">' +
            '<button class="opx-sq big" ' + (r.pending ? 'disabled' : 'data-go="' + esc(r.key) + '"') + ' title="Aller au clip"><span class="pp-tc">' + (r.track == null ? '…' : 'V' + (r.track + 1)) + '</span></button>' +
            '<span class="opx-gr-main"><strong title="' + esc(r.main) + '">' + esc(r.main) + '</strong>' +
            '<span class="muted small opx-gr-line">' +
            (r.zone ? '<span class="opx-zpill" style="--zc: ' + esc(zc) + '; --zc-bg: ' + rgba(zc, 0.18) + '; --zc-bd: ' + rgba(zc, 0.38) + ';">' + esc(r.zone.name) + '</span>' : '') +
            '<span class="opx-gr-tpl">' + esc(r.tpl) + ' · ' + tc(r.start) + '</span></span>' +
            '<span class="opx-mtl" title="Entrée · à l’antenne · sortie"><span class="in" style="width: ' + r.inPc.toFixed(2) + '%;"></span><span class="out" style="left: ' + r.outPc.toFixed(2) + '%;"></span></span></span>' +
            '<span class="pp-state">' + state + '</span></div>'
          );
        })
        .join('');
    var box = $('rows');
    // Redrawn on every poll: only when it changed (a click must not lose its row).
    if (html !== lastRows) {
      box.innerHTML = lastRows = html;
      box.classList.toggle('pp-v', !s || !rows.length);
    }
    var n = rows.filter(function (r) {
      return r.needs.length && !jobFor(r.key);
    }).length;
    $('seqFoot').classList.toggle('pp-off', !n);
    $('updN').textContent = String(n);
    renderProgress();
  }

  /** The progress of the renders, in place (the rows are not drawn again). */
  function renderProgress() {
    if (S.screen === 'seq')
      [].forEach.call($('rows').querySelectorAll('.pp-busy'), function (el) {
        var j = jobFor(el.getAttribute('data-row'));
        var p = j ? Math.round(j.progress * 100) : 0;
        el.style.setProperty('--p', p + '%');
        var pct = el.querySelector('.pp-pct');
        if (pct) pct.textContent = j && j.started ? p + ' %' : '…';
      });
    renderFoot();
  }

  /** The playhead to the clip, and the clip selected in the sequence (it is not opened here). */
  function gotoClip(key) {
    var c = S.clips.filter(function (x) {
      return x.key === key;
    })[0];
    if (!c) return;
    S.quietSel = key;
    evalScript('pcg_goto(' + c.start + ', ' + c.track + ', ' + c.start + ')').catch(function (e) {
      toast(e.message, true);
    });
  }

  /** Every clip whose length or template changed, rendered again in place. */
  function updateAll() {
    if (!needNode()) return;
    rowsModel().forEach(function (r) {
      if (!r.clip || !r.needs.length || jobFor(r.key)) return;
      var c = r.clip;
      enqueue({
        kind: 'update',
        key: c.key,
        prepare: function () {
          return loadProject(c.side.projectId).then(function (p) {
            var t = tplOf(p, c.side.templateId);
            if (!t) throw new Error('Modèle introuvable : ' + (c.side.template || c.side.templateId));
            return specOfClip(c, p, t);
          });
        },
        place: function (file, spec) {
          return placeUpdate(c, file, spec.timing.duration);
        },
      });
    });
  }

  // ----------------------------------------------------------------- Modèles

  var lastTpl = '';

  function openTemplates() {
    if (!S.pid && S.E) S.pid = S.E.p.id;
    if (!S.pid && S.clips.length) S.pid = S.clips[0].side.projectId;
    show('tpl');
    var go = function () {
      if (!S.pid) return renderTpl();
      loadProject(S.pid).then(renderTpl, function (e) {
        toast(e.message, true);
        renderTpl();
      });
    };
    if (S.pid) go();
    loadProjects().then(function (list) {
      var known = list.some(function (p) {
        return p.id === S.pid;
      });
      if (!known && list.length) {
        S.pid = list[0].id;
        store.set('project', S.pid);
        go();
      } else renderTpl();
    }, noop);
  }

  function thumbUrl(p, t) {
    return S.server + '/api/projects/' + enc(p.id) + '/templates/' + enc(t.id) + '/thumbnail.png?w=480&key=' + enc(S.key) + '&v=' + enc(tplHash(t));
  }

  function renderTpl() {
    if (S.screen !== 'tpl') return;
    var p = S.full[S.pid];
    var summary = S.projects.filter(function (x) {
      return x.id === S.pid;
    })[0];
    $('pjNameTxt').textContent = p ? p.name : summary ? summary.name : S.pid ? '…' : 'Choisir un projet';
    var sel = S.E && S.E.p.id === S.pid ? S.E.t.id : '';
    var sig = S.pid + '|' + (S.sig[S.pid] || '') + '|' + sel + '|' + S.server;
    if (sig === lastTpl) return;
    lastTpl = sig;
    var list = p ? p.templates : [];
    $('tplList').innerHTML =
      '<header><span>Modèles</span></header>' +
      (p && !list.length ? voidHtml(I.listPlus, 'Aucun modèle', false) : '') +
      list
        .map(function (t) {
          var z = zoneOf(p, t.zone);
          return (
            '<div class="template-item' + (t.id === sel ? ' selected' : '') + '" draggable="true" data-tpl="' + esc(t.id) + '">' +
            '<img alt="" draggable="false" src="' + esc(thumbUrl(p, t)) + '">' +
            '<span class="tpl-text"><span class="tpl-name">' + esc(t.name) + '</span>' + (z ? '<em class="tpl-zone" style="--zc: ' + esc(z.color || '#8a90ad') + ';">' + esc(z.name) + '</em>' : '') + '</span>' +
            '<div class="item-actions"><button class="icon-btn ghost" data-add="' + esc(t.id) + '" title="Insérer à la tête de lecture">' + I.plus + '</button></div></div>'
          );
        })
        .join('');
  }

  function pickProject() {
    var go = function (list) {
      openList(
        $('pjName'),
        list.map(function (p) {
          return { value: p.id, label: p.name };
        }),
        S.pid,
        function (id) {
          S.pid = id;
          store.set('project', id);
          lastTpl = '';
          renderTpl();
          loadProject(id).then(renderTpl, function (e) {
            toast(e.message, true);
          });
        },
      );
    };
    if (S.projects.length) {
      go(S.projects);
      loadProjects().catch(noop);
    } else
      loadProjects().then(go, function (e) {
        toast(e.message, true);
      });
  }

  // -------------------------------------------------------------- the clip

  /** A Strata clip of the sequence, as it was made (what its sidecar keeps), for its template as it is now. */
  function specOfClip(c, p, t) {
    var side = c.side;
    var m = model(t, p);
    var acts = actionsOf(t, p);
    var timing = fitTiming(m, frameSnap(c.len), sideTiming(m, side));
    var data = Object.assign(defaultsOf(t), side.data || {});
    return {
      p: p,
      t: t,
      m: m,
      acts: acts,
      data: data,
      rows: Object.assign({}, side.rows || {}),
      events: fixEvents(side.events, acts, m, timing),
      clock: typeof side.clock === 'number' ? side.clock : null,
      timing: timing,
    };
  }

  /** Seconds on whole frames of the sequence. */
  function frameSnap(x) {
    return framesToSec(Math.max(1, secToFrames(x)));
  }

  function openClip(c) {
    loadProject(c.side.projectId).then(
      function (p) {
        var t = tplOf(p, c.side.templateId);
        if (!t) return toast('Modèle introuvable : ' + (c.side.template || c.side.templateId), true);
        var E = Object.assign(specOfClip(c, p, t), { mode: 'clip', clip: c, datasets: [], touched: {}, place: 'playhead', track: c.track });
        startEditor(E);
        if ((t.datasets || []).length)
          values(p.id, t.id, E.rows).then(function (r) {
            if (S.E !== E) return;
            E.datasets = r.datasets;
            renderVals();
          }, noop);
      },
      function (e) {
        toast(e.message, true);
      },
    );
  }

  function openNew(t) {
    var p = S.full[S.pid];
    if (!p) return;
    var m = model(t, p);
    var acts = actionsOf(t, p);
    var place = S.seq && S.seq.range ? 'range' : 'playhead';
    var D = place === 'range' ? frameSnap(S.seq.range.b - S.seq.range.a) : frameSnap(naturalDuration(m));
    var timing = fitTiming(m, D, null);
    var E = { mode: 'new', p: p, t: t, m: m, acts: acts, data: defaultsOf(t), rows: {}, datasets: [], touched: {}, clock: null, timing: timing, events: fixEvents([], acts, m, timing), place: place, track: null };
    startEditor(E);
    values(p.id, t.id, null).then(function (r) {
      if (S.E !== E) return;
      E.data = Object.assign(E.data, r.data);
      E.datasets = r.datasets;
      renderVals();
      renderFoot();
      sendPreview();
      $('monNameIn').value = monName(E);
    }, noop);
  }

  function startEditor(E) {
    S.E = E;
    pv.t = onAirAt(E.m, E.timing);
    show('clip');
    $('clipScroll').scrollTop = 0;
    setPlaying(pv.shown);
  }

  function monName(E) {
    return E.mode === 'clip' ? mainText(E.t, E.data) : E.t.name;
  }

  function renderEditor() {
    var E = S.E;
    if (!E) return show('seq');
    $('monNameIn').value = monName(E);
    var z = zoneOf(E.p, E.t.zone);
    $('monName').title = E.mode === 'clip' ? E.t.name + ' · V' + (E.clip.track + 1) + ' · ' + tc(E.clip.start) : E.t.name + (z ? ' · ' + z.name : '');
    renderEye();
    renderPlace();
    renderDur();
    renderVals();
    renderFoot();
    loadPreview();
    // Sizes need the screen laid out.
    sizePreview();
    renderRuler();
    renderActs();
    if (E.mode === 'new') computeTrack();
  }

  // Placement (a new clip): at the playhead, or between the sequence's In and Out points.

  function startOf(E) {
    return E.mode === 'clip' ? E.clip.start : E.place === 'range' && S.seq && S.seq.range ? S.seq.range.a : S.seq ? S.seq.playhead : 0;
  }

  function renderPlace() {
    var E = S.E;
    if (!E) return;
    var range = S.seq && S.seq.range;
    if (E.place === 'range' && !range) {
      E.place = 'playhead';
      if (E.mode === 'new') setDuration(frameSnap(naturalDuration(E.m)));
    }
    $('fPlace').classList.toggle('pp-off', E.mode !== 'new' || !range);
    $('fDur').classList.toggle('pp-off', E.mode === 'new' && E.place === 'range');
    [].forEach.call($('place').children, function (b) {
      b.classList.toggle('on', b.getAttribute('data-place') === E.place);
    });
    $('placeInfo').textContent = !range ? '' : E.place === 'range' ? tc(range.a) + ' → ' + tc(range.b) + ' · ' + secs(range.b - range.a) : tc(S.seq.playhead);
  }

  function setPlace(v) {
    var E = S.E;
    if (!E || E.place === v) return;
    E.place = v;
    var range = S.seq && S.seq.range;
    setDuration(v === 'range' && range ? frameSnap(range.b - range.a) : frameSnap(naturalDuration(E.m)));
    renderPlace();
  }

  /** The track a new clip goes to (the first free one above V1 at its place). */
  var trackTimer = 0;
  var trackAt = '';
  function computeTrack() {
    clearTimeout(trackTimer);
    trackTimer = setTimeout(function () {
      var E = S.E;
      if (!E || E.mode !== 'new' || !S.seq) return;
      var at = startOf(E);
      trackAt = at + '|' + E.timing.duration;
      freeTrack(at, E.timing.duration).then(function (t) {
        if (S.E !== E) return;
        E.track = t;
        renderFoot();
      }, noop);
    }, 120);
  }

  // Durée: the Designer's duration field, at the sequence's rate.

  function renderDur() {
    var E = S.E;
    if (!E) return;
    var r = Math.round(seqFps());
    var f = secToFrames(E.timing.duration);
    if (document.activeElement !== $('durTc')) $('durTc').value = durTc(f, r);
    [].forEach.call($('durPresets').children, function (b) {
      b.classList.toggle('on', f === +b.getAttribute('data-sec') * r);
    });
  }

  function setFrames(f) {
    setDuration(framesToSec(clamp(f, 1, Math.floor(MAX_SECONDS * seqFps()))));
  }

  function setDuration(D) {
    var E = S.E;
    if (!E) return;
    E.timing = fitTiming(E.m, D, E.timing);
    E.events.forEach(function (e) {
      e.at = Math.min(e.at, D);
    });
    pv.t = Math.min(pv.t, D);
    renderDur();
    renderRuler();
    renderActs();
    if (E.mode === 'new') computeTrack();
    sendPreview();
  }

  // Déroulé: the clip's timeline (the Designer's ruler).

  function renderRuler() {
    var E = S.E;
    if (!E || S.screen !== 'clip') return;
    var D = E.timing.duration;
    var W = $('ruler').clientWidth || 300;
    var pc = function (x) {
      return ((clamp(x, 0, D) / D) * 100).toFixed(3) + '%';
    };
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
    var step =
      steps.filter(function (s) {
        return (s / D) * W >= 56;
      })[0] || 120;
    var h = '';
    for (var i = 0; i * step < D - 1e-9; i++) {
      var x = i * step;
      if ((x / D) * W > W - 18) break;
      h += '<div class="tick" style="left: ' + pc(x) + ';"><span>' + String(+x.toFixed(1)).replace('.', ',') + '</span></div>';
    }
    $('rTime').innerHTML = h;
    var z = zones(E.m, E.timing);
    var px = function (x) {
      return (x / D) * W;
    };
    var mk = '<div class="tl-zone in" style="left: 0%; width: ' + pc(z.inEnd) + ';">' + (px(z.inEnd) >= 26 ? 'IN' : '') + '</div>';
    mk += '<div class="tl-zone out" style="left: ' + pc(z.outStart) + '; width: ' + pc(D - z.outStart) + ';">' + (px(D - z.outStart) >= 34 ? 'OUT' : '') + '</div>';
    E.m.stops.forEach(function (s, k) {
      if (s.onAir) return;
      var at = E.timing.stops[k];
      mk += '<div class="tl-marker pause" data-stop="' + k + '" title="' + esc(s.name + ' · ' + durTc(secToFrames(at), Math.round(seqFps()))) + '" style="left: ' + pc(at) + ';"><span>' + esc(s.name) + '</span></div>';
    });
    E.events.forEach(function (e, j) {
      var label = eventLabel(e, E.acts);
      mk += '<div class="tl-marker label" data-ev="' + j + '" title="' + esc(label + ' · ' + durTc(secToFrames(e.at), Math.round(seqFps()))) + '" style="left: ' + pc(e.at) + ';"><span>' + esc(label) + '</span></div>';
    });
    if (z.outStart < D - 1e-6) mk += '<div class="tl-marker onair" style="left: ' + pc(z.outStart) + ';"></div>';
    $('rMarks').innerHTML = mk;
    flipMarkers();
    renderHead();
  }

  /** A label that would leave the ruler on the right goes on the left of its marker. */
  function flipMarkers() {
    var W = $('ruler').clientWidth;
    [].forEach.call($('rMarks').querySelectorAll('.tl-marker.pause, .tl-marker.label'), function (el) {
      el.classList.remove('pp-flip');
      if (el.offsetLeft + el.offsetWidth > W - 2) el.classList.add('pp-flip');
    });
  }

  function renderHead() {
    var E = S.E;
    if (!E) return;
    $('rHead').style.left = ((clamp(pv.t, 0, E.timing.duration) / E.timing.duration) * 100).toFixed(3) + '%';
  }

  /**
   * A pause (`data-stop`) or an action (`data-ev`) dragged along the clip,
   * on whole frames. A pause stays between its neighbours.
   */
  function dragMarker(e, el) {
    var E = S.E;
    var rect = $('ruler').getBoundingClientRect();
    var D = E.timing.duration;
    var stop = el.hasAttribute('data-stop') ? +el.getAttribute('data-stop') : -1;
    var ev = stop < 0 ? E.events[+el.getAttribute('data-ev')] : null;
    var lo = 0;
    var hi = D;
    if (stop >= 0) {
      lo = stop > 0 ? E.timing.stops[stop - 1] : 0;
      hi = E.timing.stops[stop + 1] === undefined ? D : E.timing.stops[stop + 1];
    }
    var playing = pv.playing;
    setPlaying(false);
    el.classList.add('moving');
    trackPointer(
      e,
      function (m) {
        var t = (clamp(m.clientX - rect.left, 0, rect.width) / rect.width) * D;
        t = clamp(framesToSec(secToFrames(t)), lo, hi);
        if (stop >= 0) E.timing.stops[stop] = t;
        else ev.at = t;
        el.style.left = ((t / D) * 100).toFixed(3) + '%';
        pv.t = t;
        renderHead();
        sendPreview();
        renderActTimes();
      },
      function () {
        el.classList.remove('moving');
        sortEvents(E.events);
        renderRuler();
        renderActs();
        if (playing) setPlaying(true);
      },
    );
  }

  /** Clicks and drags on the ruler move the playhead of the preview. */
  function scrub(e) {
    var E = S.E;
    var rect = $('ruler').getBoundingClientRect();
    var at = function (m) {
      pv.t = (clamp(m.clientX - rect.left, 0, rect.width) / rect.width) * E.timing.duration;
      renderHead();
      sendPreview();
    };
    setPlaying(false);
    at(e);
    trackPointer(e, at, noop);
  }

  /** Follows the mouse until it is released (mouse events: every CEP Chromium sends them). */
  function trackPointer(e, move, up) {
    e.preventDefault();
    var onMove = function (ev) {
      ev.preventDefault();
      move(ev);
    };
    var onUp = function (ev) {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      up(ev);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  }

  // The actions placed on the clip, each with its time.

  function renderActs() {
    var E = S.E;
    if (!E) return;
    var r = Math.round(seqFps());
    $('addAct').classList.toggle('pp-off', !E.acts.controls.length);
    $('acts').classList.toggle('pp-off', !E.events.length);
    $('acts').innerHTML = E.events
      .map(function (e, j) {
        var label = eventLabel(e, E.acts);
        return (
          '<div class="opx-var pp-act"><i class="opx-var-dot"></i><span class="opx-var-name" title="' + esc(label) + '">' + esc(label) + '</span>' +
          '<div class="opx-var-val"><input class="pp-time" data-evt="' + j + '" value="' + durTc(secToFrames(e.at), r) + '" spellcheck="false" title="Minutes:secondes:images dans le clip"></div>' +
          (e.command.action === 'act' ? '<button class="icon-btn ghost" data-del="' + j + '" title="Retirer">' + I.x + '</button>' : '<span></span>') +
          '</div>'
        );
      })
      .join('');
  }

  function renderActTimes() {
    var E = S.E;
    var r = Math.round(seqFps());
    [].forEach.call($('acts').querySelectorAll('[data-evt]'), function (el) {
      var e = E.events[+el.getAttribute('data-evt')];
      if (e && document.activeElement !== el) el.value = durTc(secToFrames(e.at), r);
    });
  }

  function addAction() {
    var E = S.E;
    openList(
      $('addAct'),
      E.acts.controls.map(function (k, i) {
        return { value: String(i), label: k.label };
      }),
      '',
      function (v) {
        var k = E.acts.controls[+v];
        E.events.push({ id: ++evSeq, at: clamp(pv.t, 0, E.timing.duration), command: { action: 'act', target: k.layer, op: k.op } });
        sortEvents(E.events);
        renderRuler();
        renderActs();
      },
    );
  }

  // Valeurs: the template's values, the data sets' rows.

  function renderVals() {
    var E = S.E;
    if (!E) return;
    var box = $('vals');
    box.innerHTML = '';
    E.datasets.forEach(function (ds) {
      box.appendChild(varRow(ds.name || ds.key, rowPicker(ds)));
    });
    (E.t.fields || []).forEach(function (f) {
      box.appendChild(varRow(f.label || f.key, fieldInput(f)));
    });
    $('valsHead').classList.toggle('pp-off', !box.children.length);
    requestAnimationFrame(function () {
      [].forEach.call(box.querySelectorAll('textarea.tx-grow'), grow);
    });
  }

  function varRow(name, input) {
    var row = document.createElement('div');
    row.className = 'opx-var ';
    row.innerHTML = '<i class="opx-var-dot"></i><span class="opx-var-name" title="' + esc(name) + '">' + esc(name) + '</span><div class="opx-var-val"></div>';
    row.children[2].appendChild(input);
    return row;
  }

  function ddButton(label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dd-btn';
    b.innerHTML = '<span class="dd-label">' + esc(label) + '</span>' + I.chevDown;
    return b;
  }

  /** The row of a data set the clip shows: its values come from the server. */
  function rowPicker(ds) {
    var E = S.E;
    var cur = +E.rows[ds.key] || 1;
    var label = function (n) {
      var l = plain((ds.rows || [])[n - 1]);
      return n + (l ? ' · ' + l : '');
    };
    var b = ddButton(label(cur));
    b.onclick = function () {
      openList(
        b,
        (ds.rows || []).map(function (l, i) {
          return { value: String(i + 1), label: label(i + 1) };
        }),
        String(cur),
        function (v) {
          E.rows[ds.key] = +v;
          values(E.p.id, E.t.id, E.rows).then(function (r) {
            if (S.E !== E) return;
            var kept = {};
            Object.keys(E.touched).forEach(function (k) {
              kept[k] = E.data[k];
            });
            E.data = Object.assign(E.data, r.data, kept);
            E.datasets = r.datasets.length ? r.datasets : E.datasets;
            renderVals();
            sendPreview();
            $('monNameIn').value = monName(E);
          }, function (e) {
            toast(e.message, true);
          });
          b.querySelector('.dd-label').textContent = label(+v);
        },
      );
    };
    return b;
  }

  function segmented(choices, v, set) {
    var el = document.createElement('div');
    el.className = 'segmented';
    el.innerHTML = choices
      .map(function (c) {
        return '<button type="button" class="' + (c[0] === v ? 'on' : '') + '" data-v="' + esc(c[0]) + '">' + esc(c[1]) + '</button>';
      })
      .join('');
    el.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      [].forEach.call(el.children, function (x) {
        x.classList.toggle('on', x === b);
      });
      set(b.getAttribute('data-v'));
    };
    return el;
  }

  function grow(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(30, el.scrollHeight + 2) + 'px';
  }

  /** The control of a value, as the Operator's (text, choices, number, colour, on / off). */
  function fieldInput(f) {
    var E = S.E;
    var v = E.data[f.key] == null ? '' : String(E.data[f.key]);
    var set = function (x) {
      E.data[f.key] = x;
      E.touched[f.key] = true;
      sendPreview();
      if (E.mode === 'clip') $('monNameIn').value = monName(E);
    };
    var el;
    if (f.options && f.options.length) {
      var short =
        f.options.length <= 4 &&
        f.options.every(function (o) {
          return String(o[1]).length <= 12;
        });
      if (short) return segmented(f.options, v, set);
      var labelOf = function (x) {
        var o = f.options.filter(function (o2) {
          return o2[0] === x;
        })[0];
        return o ? o[1] : x;
      };
      el = ddButton(labelOf(v));
      el.onclick = function () {
        openList(
          el,
          f.options.map(function (o) {
            return { value: o[0], label: o[1] };
          }),
          String(E.data[f.key]),
          function (x) {
            set(x);
            el.querySelector('.dd-label').textContent = labelOf(x);
          },
        );
      };
      return el;
    }
    if (f.kind === 'boolean') {
      var num = v === '1' || v === '0';
      var on = v === 'true' || v === '1';
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'wk-tog' + (on ? ' on' : '');
      el.innerHTML = '<i></i>';
      el.onclick = function () {
        on = !on;
        el.classList.toggle('on', on);
        set(num ? (on ? '1' : '0') : on ? 'true' : 'false');
      };
      return el;
    }
    if (f.kind === 'color') {
      el = document.createElement('span');
      el.className = 'pp-color';
      el.innerHTML = '<input type="color"><input spellcheck="false">';
      var pick = el.children[0];
      var hex = el.children[1];
      pick.value = /^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7) : '#ffffff';
      hex.value = v;
      pick.oninput = function () {
        hex.value = pick.value + (hex.value.length === 9 ? hex.value.slice(7) : '');
        set(hex.value);
      };
      hex.oninput = function () {
        if (/^#[0-9a-f]{6}/i.test(hex.value)) pick.value = hex.value.slice(0, 7);
        set(hex.value);
      };
      return el;
    }
    if (f.kind === 'number') {
      el = document.createElement('input');
      el.spellcheck = false;
      el.value = v;
      el.oninput = function () {
        set(el.value);
      };
      return el;
    }
    // A text: on one line (Enter leaves it) or several (multiline, tables).
    var several = f.kind === 'multiline' || f.kind === 'table';
    el = document.createElement('textarea');
    el.rows = 1;
    el.className = 'tx-grow' + (several ? '' : ' line');
    el.spellcheck = false;
    el.value = v;
    el.oninput = function () {
      if (!several && /\n/.test(el.value)) el.value = el.value.replace(/\n/g, ' ');
      grow(el);
      set(el.value);
    };
    el.onkeydown = function (e) {
      if (!several && e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
    };
    return el;
  }

  // The buttons at the bottom.

  function renderFoot() {
    var E = S.E;
    if (!E || S.screen !== 'clip') return;
    var clip = E.mode === 'clip';
    $('updBox').classList.toggle('pp-off', !clip);
    $('ins').classList.toggle('pp-off', clip);
    var ds = E.datasets[0];
    var n = !clip && ds && ds.rows ? ds.rows.length : 0;
    $('insAll').classList.toggle('pp-off', n < 2);
    if (n >= 2) {
      $('insAll').innerHTML = I.rows + ' TOUTES LES LIGNES (' + n + ')';
      $('insAll').title = 'Une par marqueur de la séquence à partir de la tête de lecture';
    }
    if (clip) {
      var job = jobFor(E.clip.key);
      var p = job ? Math.round(job.progress * 100) : 0;
      $('upd').disabled = !!job;
      $('updBox').classList.toggle('pp-prog', !!job);
      $('updBox').style.setProperty('--p', p + '%');
      $('updTxt').textContent = job ? (job.started ? p + ' %' : '…') : 'METTRE À JOUR';
    } else {
      $('insTrack').textContent = E.track === null ? '' : 'V' + (E.track + 1);
      $('ins').disabled = !S.seq;
      $('insAll').disabled = !S.seq;
    }
  }

  // ---------------------------------------------------------------- preview

  var pv = { ready: false, page: '', loads: 0, playing: false, t: 0, last: 0, shown: store.get('preview', true) };

  function setPlaying(on) {
    on = !!on && pv.shown && S.screen === 'clip' && !!S.E;
    if (pv.playing === on) return;
    pv.playing = on;
    pv.last = 0;
    if (on) requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!pv.playing) return;
    var E = S.E;
    if (!E || S.screen !== 'clip') return setPlaying(false);
    if (pv.last) {
      pv.t += Math.min(0.25, (now - pv.last) / 1000);
      if (pv.t >= E.timing.duration) pv.t = pv.t % E.timing.duration;
      renderHead();
      sendPreview();
    }
    pv.last = now;
    requestAnimationFrame(tick);
  }

  /** The preview page of the server (the HTML5 renderer), loaded again for another project. */
  function loadPreview() {
    var E = S.E;
    var want = S.server + '|' + S.key + '|' + E.p.id;
    if (pv.page === want) return sendPreview();
    pv.page = want;
    pv.ready = false;
    // A new address each time: never a page kept from before (it would not say it is ready).
    $('pvFrame').src = S.server + '/embed/preview?key=' + enc(S.key) + '&project=' + enc(E.p.id) + '&n=' + ++pv.loads;
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== $('pvFrame').contentWindow) return;
    if (ev.data && ev.data.type === 'pcg-ready') {
      pv.ready = true;
      sendPreview();
    }
  });

  /** The picture at the sequence's shape, as large as the monitor allows. */
  function sizePreview() {
    var E = S.E;
    var box = $('screen');
    var W = box.clientWidth;
    var H = box.clientHeight;
    if (!W || !H) return;
    var w = (S.seq && S.seq.width) || E.p.width || 16;
    var h = (S.seq && S.seq.height) || E.p.height || 9;
    var k = Math.min(W / w, H / h);
    $('vp').style.width = Math.floor(w * k) + 'px';
    $('vp').style.height = Math.floor(h * k) + 'px';
  }

  function sendPreview() {
    var E = S.E;
    if (!E || S.screen !== 'clip') return;
    var f = clipFrame(E.m, E.timing, Math.min(pv.t, E.timing.duration));
    var frame = $('pvFrame');
    frame.style.visibility = f === null ? 'hidden' : '';
    if (!pv.ready || f === null || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      {
        type: 'pcg-preview',
        projectId: E.p.id,
        templateId: E.t.id,
        data: E.data,
        frame: f,
        width: S.seq ? S.seq.width : undefined,
        height: S.seq ? S.seq.height : undefined,
      },
      '*',
    );
  }

  function renderEye() {
    var b = $('eye');
    b.innerHTML = pv.shown ? I.eye : I.eyeOff;
    b.setAttribute('aria-pressed', pv.shown ? 'true' : 'false');
    b.title = pv.shown ? 'Masquer l’image' : 'Afficher l’image';
    $('mon').classList.toggle('pp-off', !pv.shown);
  }

  // ---------------------------------------------------------------- render

  function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    fs.mkdirSync(dir);
  }

  function outputFolder(project) {
    var base = S.folder ? S.folder : path.join(os.homedir(), 'Documents', 'Strata Renders');
    var dir = path.join(base, project.name.replace(/[\\/:*?"<>|]/g, '-'));
    mkdirs(dir);
    return dir;
  }

  /** What the server renders (POST /api/render/jobs). */
  function bodyOf(spec) {
    var s = S.seq;
    return {
      projectId: spec.p.id,
      templateId: spec.t.id,
      data: Object.assign({}, spec.data),
      width: s.width,
      height: s.height,
      frameRate: s.rate,
      timing: { stops: spec.timing.stops.slice(), duration: spec.timing.duration },
      events: spec.events.map(function (e) {
        return { at: Math.round(e.at * 1000) / 1000, command: e.command };
      }),
      clock: spec.clock,
      rows: Object.assign({}, spec.rows),
    };
  }

  function fileOf(spec, body) {
    var digest = crypto
      .createHash('md5')
      .update(JSON.stringify([body, tplHash(spec.t)]))
      .digest('hex')
      .slice(0, 10);
    var name = (spec.t.name + ' - ' + mainText(spec.t, spec.data)).replace(/[\\/:*?"<>|\n\r\t]/g, '-').slice(0, 70);
    return path.join(outputFolder(spec.p), name + ' ' + digest + '.mov');
  }

  function writeSidecar(file, spec, body) {
    var side = {
      projectId: body.projectId,
      templateId: body.templateId,
      templateHash: tplHash(spec.t),
      template: spec.t.name,
      label: mainText(spec.t, spec.data),
      data: body.data,
      rows: body.rows,
      events: body.events,
      clock: body.clock,
      timing: body.timing,
      rendered: body.timing.duration,
      width: body.width,
      height: body.height,
      frameRate: body.frameRate,
    };
    fs.writeFileSync(file + '.pcg.json', JSON.stringify(side, null, 2));
  }

  /** The server renders the clip; its progress shows where the clip is. */
  function renderOnServer(job, body) {
    return api('POST', '/api/render/jobs', body).then(function (r) {
      var id = r.id;
      return new Promise(function (resolve, reject) {
        var misses = 0;
        var poll = function () {
          api('GET', '/api/render/jobs/' + enc(id)).then(
            function (st) {
              misses = 0;
              if (st.error) return reject(new Error(st.error));
              job.progress = clamp(+st.progress || 0, 0, 1);
              renderProgress();
              if (!st.done) return setTimeout(poll, 400);
              request('GET', '/api/render/jobs/' + enc(id) + '/file')
                .then(function (res) {
                  return res.arrayBuffer();
                })
                .then(resolve, reject);
            },
            function (e) {
              if (++misses > 5 || e.status === 404) return reject(e);
              setTimeout(poll, 1000);
            },
          );
        };
        setTimeout(poll, 300);
      });
    });
  }

  /** Renders a job (a clip made before with the same values is reused), then lays it. */
  function run(job) {
    return Promise.resolve()
      .then(job.prepare)
      .then(function (spec) {
        if (!S.seq) throw new Error('Ouvrez une séquence');
        if (job.row)
          freeTrack(job.row.start, job.row.len).then(function (t) {
            job.row.track = t;
            renderSeq();
          }, noop);
        if (spec.clock === null || spec.clock === undefined) spec.clock = Math.round(serverNow());
        var body = bodyOf(spec);
        var file = fileOf(spec, body);
        var made = fs.existsSync(file)
          ? Promise.resolve()
          : renderOnServer(job, body).then(function (buf) {
              fs.writeFileSync(file, Buffer.from(buf));
            });
        return made.then(function () {
          writeSidecar(file, spec, body);
          job.progress = 1;
          renderProgress();
          return job.place(file, spec);
        });
      });
  }

  var jobSeq = 0;
  function enqueue(job) {
    job.id = ++jobSeq;
    if (!job.key) job.key = 'new:' + job.id;
    job.progress = 0;
    job.started = false;
    S.jobs.push(job);
    renderSeq();
    renderFoot();
    pump();
  }

  /** One render at a time. */
  function pump() {
    if (
      S.jobs.some(function (j) {
        return j.started;
      })
    )
      return;
    var j = S.jobs[0];
    if (!j) return;
    j.started = true;
    renderSeq();
    run(j)
      .then(
        function (msg) {
          toast('✓ ' + msg);
        },
        function (e) {
          toast(e.message || String(e), true);
        },
      )
      .then(function () {
        S.jobs.splice(S.jobs.indexOf(j), 1);
        renderSeq();
        renderFoot();
        poll();
        pump();
      });
  }

  /** A new clip laid on the first free track at `at`. */
  function placeNew(file, at, len) {
    return freeTrack(at, len).then(function (t) {
      return evalScript('pcg_import(' + jsx(file) + ', ' + t + ', ' + at + ')').then(function (r) {
        return 'Inséré sur ' + r;
      });
    });
  }

  /** A clip put in place of `c`: same track, same start. */
  function placeUpdate(c, file, len) {
    return evalScript('pcg_replaceClip(' + c.track + ', ' + c.start + ', ' + jsx(c.media) + ', ' + jsx(file) + ', ' + len + ')').then(
      function (r) {
        var E = S.E;
        var now = Object.assign({}, c, { media: file, end: c.start + len, len: len });
        now.key = clipKey(now);
        if (E && E.mode === 'clip' && E.clip.key === c.key) E.clip = now;
        // Still selected in the sequence: the same clip, not one to open.
        if (S.selKey === c.key) S.selKey = S.quietSel = now.key;
        return 'Mis à jour sur ' + r;
      },
      function (e) {
        if (/NOCLIP/.test(e.message)) throw new Error('Clip introuvable dans la séquence');
        if (/BUSY/.test(e.message)) throw new Error('Piste V' + (c.track + 1) + ' occupée après le clip');
        throw e;
      },
    );
  }

  /** What the editor holds, frozen for a render. */
  function snapshot(E) {
    return {
      p: E.p,
      t: E.t,
      m: E.m,
      acts: E.acts,
      data: Object.assign({}, E.data),
      rows: Object.assign({}, E.rows),
      events: E.events.map(function (e) {
        return { at: e.at, command: e.command };
      }),
      clock: E.clock,
      timing: { stops: E.timing.stops.slice(), duration: E.timing.duration },
    };
  }

  /** A clip being made, shown in the Séquence until it is laid. */
  function pendingRow(spec, at, len, track, main) {
    var z = zones(spec.m, spec.timing);
    return { p: spec.p, t: spec.t, start: at, len: len, track: track, main: main || mainText(spec.t, spec.data), inPc: (z.inEnd / len) * 100, outPc: (z.outStart / len) * 100 };
  }

  function insertJob(spec, at, main, after) {
    var len = spec.timing.duration;
    var job = {
      kind: 'insert',
      row: pendingRow(spec, at, len, null, main),
      prepare: function () {
        return spec.prepare ? spec.prepare() : spec;
      },
      place: function (file) {
        return placeNew(file, at, len).then(function (msg) {
          if (after) after(file);
          return msg;
        });
      },
    };
    freeTrack(at, len).then(function (t) {
      job.row.track = t;
      renderSeq();
    }, noop);
    enqueue(job);
  }

  function insertCurrent() {
    var E = S.E;
    if (!E || !S.seq || !needNode()) return;
    var spec = snapshot(E);
    insertJob(spec, startOf(E));
    show('seq');
  }

  function updateCurrent() {
    var E = S.E;
    if (!E || E.mode !== 'clip' || !needNode() || jobFor(E.clip.key)) return;
    var c = E.clip;
    var spec = snapshot(E);
    enqueue({
      kind: 'update',
      key: c.key,
      prepare: function () {
        return spec;
      },
      place: function (file) {
        return placeUpdate(c, file, spec.timing.duration).then(function (msg) {
          if (S.E === E) E.clock = spec.clock;
          return msg;
        });
      },
    });
  }

  /** One clip per row of the first data set, on the sequence markers from the playhead on. */
  function insertAllRows() {
    var E = S.E;
    var ds = E && E.datasets[0];
    if (!ds || !S.seq || !needNode()) return;
    var base = snapshot(E);
    var touched = Object.assign({}, E.touched);
    var len = base.timing.duration;
    var ph = S.seq.playhead;
    readMarkers()
      .catch(function () {
        return [];
      })
      .then(function (marks) {
        var mk = marks.filter(function (x) {
          return x >= ph - 1e-3;
        });
        var at = [];
        ds.rows.forEach(function (label, i) {
          at.push(i < mk.length ? mk[i] : i === 0 ? ph : at[i - 1] + len);
          var rows = Object.assign({}, base.rows);
          rows[ds.key] = i + 1;
          var spec = Object.assign({}, base, {
            rows: rows,
            clock: null,
            prepare: function () {
              return values(base.p.id, base.t.id, rows).then(function (r) {
                var kept = {};
                Object.keys(touched).forEach(function (k) {
                  kept[k] = base.data[k];
                });
                return Object.assign({}, base, { rows: rows, clock: null, data: Object.assign({}, base.data, r.data, kept) });
              });
            },
          });
          insertJob(spec, at[i], plain(label) || mainText(base.t, base.data));
        });
        show('seq');
      });
  }

  /** A template as it is (its values, its timing) at the playhead, from the list. */
  function quickInsert(t) {
    var p = S.full[S.pid];
    if (!p || !needNode()) return;
    if (!S.seq) return toast('Ouvrez une séquence', true);
    var m = model(t, p);
    var acts = actionsOf(t, p);
    var timing = fitTiming(m, frameSnap(naturalDuration(m)), null);
    var spec = {
      p: p,
      t: t,
      m: m,
      acts: acts,
      data: defaultsOf(t),
      rows: {},
      events: fixEvents([], acts, m, timing),
      clock: null,
      timing: timing,
    };
    spec.prepare = function () {
      return values(p.id, t.id, null).then(
        function (r) {
          return Object.assign({}, spec, { data: Object.assign(defaultsOf(t), r.data) });
        },
        function () {
          return spec;
        },
      );
    };
    insertJob(spec, S.seq.playhead, null, function (file) {
      S.lastDefault[p.id + '/' + t.id] = { file: file, sig: defaultSig(t) };
      store.set('lastDefault', S.lastDefault);
    });
    show('seq');
  }

  /** The last render of a template as it is, at this sequence's format (dragged to the sequence). */
  function defaultSig(t) {
    var s = S.seq;
    return tplHash(t) + '|' + (s ? s.width + 'x' + s.height + '@' + s.fps : '');
  }

  // ------------------------------------------------------------- selection

  /** The sequence and its Strata clips, read again; a clip selected in the sequence opens here. */
  var polling = false;
  function poll() {
    if (polling || !window.__adobe_cep__ || document.hidden) return;
    polling = true;
    readState().then(
      function (st) {
        polling = false;
        var before = S.seq;
        S.seq = st.seq;
        S.clips = st.clips
          .map(function (c) {
            c.len = c.end - c.start;
            c.key = clipKey(c);
            c.side = sidecarOf(c.media);
            return c;
          })
          .filter(function (c) {
            return !!c.side;
          });
        S.clips.forEach(function (c) {
          if (!S.full[c.side.projectId] && !S.loading[c.side.projectId]) loadProject(c.side.projectId).catch(noop);
        });
        watchSelection();
        renderSeq();
        var E = S.E;
        if (E && E.mode === 'new' && S.screen === 'clip') {
          renderPlace();
          var moved = !before || !S.seq || before.playhead !== S.seq.playhead || JSON.stringify(before.range) !== JSON.stringify(S.seq.range);
          if (moved || trackAt !== startOf(E) + '|' + E.timing.duration) computeTrack();
          renderFoot();
        }
      },
      function () {
        polling = false;
        S.seq = null;
        S.clips = [];
        renderSeq();
      },
    );
  }

  function watchSelection() {
    var sel = S.clips.filter(function (c) {
      return c.selected;
    })[0];
    var key = sel ? sel.key : '';
    if (!key) S.quietSel = '';
    if (key === S.selKey) return;
    S.selKey = key;
    if (!sel || key === S.quietSel || S.screen === 'set') return;
    if (S.E && S.E.mode === 'clip' && S.E.clip.key === key && S.screen === 'clip') return;
    openClip(sel);
  }

  // -------------------------------------------------------------- dropdown

  var dd = null;

  /** The app's drop-down list (.dd-list) under (or over) `anchor`. */
  function openList(anchor, options, value, pick) {
    closeList();
    var r = anchor.getBoundingClientRect();
    var el = document.createElement('div');
    var below = window.innerHeight - r.bottom;
    var up = below < 240 && r.top > below;
    el.className = 'dd-list' + (up ? ' up' : '');
    el.setAttribute('role', 'listbox');
    el.style.left = r.left + 'px';
    el.style.minWidth = Math.max(160, r.width) + 'px';
    if (up) el.style.bottom = window.innerHeight - r.top + 4 + 'px';
    else el.style.top = r.bottom + 4 + 'px';
    el.innerHTML = options.length
      ? options
          .map(function (o, i) {
            var on = o.value === value;
            return '<div role="option" class="dd-opt' + (on ? ' on' : '') + '" data-i="' + i + '"><span class="dd-check">' + (on ? I.check : '') + '</span><span class="dd-text">' + esc(o.label) + '</span>' + (o.note ? '<span class="dd-note">' + esc(o.note) + '</span>' : '') + '</div>';
          })
          .join('')
      : '<div class="dd-empty">Rien à choisir</div>';
    document.body.appendChild(el);
    var over = el.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) el.style.left = Math.max(8, r.left - over) + 'px';
    el.addEventListener('mousemove', function (e) {
      var o = e.target.closest('.dd-opt');
      [].forEach.call(el.children, function (x) {
        x.classList.toggle('hover', x === o);
      });
    });
    el.addEventListener('click', function (e) {
      var o = e.target.closest('.dd-opt');
      if (!o) return;
      var v = options[+o.getAttribute('data-i')];
      closeList();
      pick(v.value);
    });
    anchor.classList.add('open');
    dd = { el: el, anchor: anchor };
  }

  function closeList() {
    if (!dd) return;
    if (dd.el.parentNode) dd.el.parentNode.removeChild(dd.el);
    dd.anchor.classList.remove('open');
    dd = null;
  }

  document.addEventListener(
    'mousedown',
    function (e) {
      if (dd && !dd.el.contains(e.target) && !dd.anchor.contains(e.target)) closeList();
    },
    true,
  );
  window.addEventListener(
    'wheel',
    function (e) {
      if (dd && !dd.el.contains(e.target)) closeList();
    },
    { passive: true },
  );

  // -------------------------------------------------------------- settings

  function loadSettings() {
    S.server = (store.get('server', '') || '').replace(/\/+$/, '');
    S.key = store.get('key', '');
    $('server').value = S.server;
    $('key').value = S.key;
  }

  /** The web app's stylesheet, first in <head>; the last copy when the server cannot be reached. */
  function linkAppCss() {
    var body = document.body;
    var ready = function () {
      body.classList.remove('pp-wait');
      if (S.screen === 'clip') {
        sizePreview();
        renderRuler();
      }
    };
    var cached = function () {
      var c = store.get('appCss', null);
      if (c && c.text && !$('ppAppCss')) {
        var st = document.createElement('style');
        st.id = 'ppAppCss';
        st.textContent = c.text;
        document.head.insertBefore(st, document.head.firstChild);
      }
      ready();
    };
    if (!S.server) return cached();
    body.classList.add('pp-wait');
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = S.server + '/premiere/app.css';
    link.onload = function () {
      ready();
      // Kept for offline starts, once per version of the panel.
      var v = window.STRATA_LOADER ? window.STRATA_LOADER.ui : '';
      var c = store.get('appCss', null);
      if (c && c.v === v && c.server === S.server) return;
      fetch(link.href, { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.text() : null;
        })
        .then(function (text) {
          if (text) store.set('appCss', { v: v, server: S.server, text: text.replace(/url\(\s*(['"]?)\//g, 'url($1' + S.server + '/') });
        })
        .catch(noop);
    };
    link.onerror = cached;
    document.head.insertBefore(link, document.head.firstChild);
    setTimeout(ready, 5000);
  }

  /**
   * Keeps what was typed: true when it changed, null when the panel reloads
   * (a new server serves its own panel, through the loader).
   */
  function saveSettings() {
    var server = $('server').value.trim().replace(/\/+$/, '');
    if (server && !/^https?:\/\//.test(server)) server = 'http://' + server;
    var key = $('key').value.trim();
    var changed = server !== S.server || key !== S.key;
    var L = window.STRATA_LOADER;
    store.set('server', server);
    store.set('key', key);
    if (server && server !== S.server && (!L || server !== L.server)) {
      location.reload();
      return null;
    }
    S.server = server;
    S.key = key;
    if (changed) {
      S.full = {};
      S.sig = {};
      S.projects = [];
      S.online = null;
      lastTpl = '';
      pv.page = '';
    }
    return changed;
  }

  function testConnection() {
    if (saveSettings() === null) return;
    if (!S.server || !S.key) {
      S.test = { kind: 'err', text: 'Non configuré' };
      return renderSettings();
    }
    S.test = { kind: '', text: '…' };
    renderSettings();
    var t0 = Date.now();
    loadProjects().then(
      function () {
        S.test = { kind: 'ok', text: 'Connecté · ' + (Date.now() - t0) + ' ms' };
        renderSettings();
        syncProjects();
      },
      function (e) {
        var msg = String(e.message || '').trim();
        S.test = { kind: 'err', text: e.status === 401 || e.status === 403 ? 'Clé refusée' : msg.length > 40 || /fetch/i.test(msg) || !e.status ? 'Injoignable' : msg };
        if (e.status) setOnline(false);
        renderSettings();
      },
    );
  }

  function renderSettings(fresh) {
    if (S.screen !== 'set') return;
    if (fresh) {
      $('server').value = S.server;
      $('key').value = S.key;
    }
    var st = S.test;
    $('testState').className = 'muted small pp-ell' + (st && st.kind ? ' pp-' + st.kind : '');
    $('testState').textContent = st ? st.text : '';
    var L = window.STRATA_LOADER;
    $('ver').textContent = L ? L.ui : 'dev';
    var u = S.update;
    $('verState').className = 'muted small pp-ell' + (u === 'ok' ? ' pp-ok' : u === 'err' ? ' pp-err' : '');
    $('verState').textContent = u === 'ok' ? 'À jour' : u === 'install' || u === 'reload' ? 'Nouvelle version' : u === 'err' ? 'Injoignable' : u === 'checking' || u === 'installing' ? '…' : '';
    $('check').textContent = u === 'install' ? 'Mettre à jour' : u === 'reload' ? 'Recharger' : 'Vérifier';
    $('check').className = 'btn small' + (u === 'install' || u === 'reload' ? ' primary' : '');
    $('check').disabled = u === 'checking' || u === 'installing';
  }

  /** The server's panel against this one: a newer loader to install, or a newer panel to load. */
  function checkUpdate() {
    var L = window.STRATA_LOADER;
    if (!S.server) return;
    S.update = 'checking';
    renderSettings();
    fetch(S.server + '/premiere/manifest.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(
        function (m) {
          if (L && (m.loader || 0) > L.version) S.update = 'install';
          else if (L && m.version !== L.ui) S.update = 'reload';
          else S.update = 'ok';
          renderSettings();
          renderTop();
        },
        function () {
          S.update = 'err';
          renderSettings();
        },
      );
  }

  function updateNow() {
    var L = window.STRATA_LOADER;
    if (S.update === 'reload' || !L) return location.reload();
    S.update = 'installing';
    renderSettings();
    L.install().then(
      function (r) {
        if (r.restart) {
          S.update = 'ok';
          renderSettings();
          renderTop();
          toast('Redémarrez Premiere Pro');
        } else r.reload();
      },
      function (e) {
        S.update = 'err';
        renderSettings();
        toast(e.message, true);
      },
    );
  }

  // ------------------------------------------------------------------ wire

  document.addEventListener('click', function (e) {
    var el = e.target.closest('button, [data-tpl], [data-row]');
    if (!el || el.disabled) return;
    var d = el.dataset;
    if (d.go) return gotoClip(d.go);
    if (d.addTpl) return openTemplates();
    if (d.add) {
      var ta = tplOf(S.full[S.pid], d.add);
      if (ta) quickInsert(ta);
      return;
    }
    if (d.del !== undefined && S.E) {
      S.E.events.splice(+d.del, 1);
      renderRuler();
      renderActs();
      return;
    }
    if (d.place) return setPlace(d.place);
    if (d.sec) return setFrames(+d.sec * Math.round(seqFps()));
    if (d.tpl) {
      var t = tplOf(S.full[S.pid], d.tpl);
      if (t) openNew(t);
      return;
    }
    if (d.row) {
      var c = S.clips.filter(function (x) {
        return x.key === d.row;
      })[0];
      if (c) openClip(c);
    }
  });

  $('back').onclick = function () {
    show(backTarget());
  };
  $('brand').onclick = function () {
    show('seq');
  };
  $('pill').onclick = function () {
    show(S.screen === 'set' ? (S.prev === 'set' ? 'seq' : S.prev) : 'set');
  };
  $('seqAdd').onclick = openTemplates;
  $('updAll').onclick = updateAll;
  $('pjName').onclick = pickProject;
  $('upd').onclick = updateCurrent;
  $('ins').onclick = insertCurrent;
  $('insAll').onclick = insertAllRows;
  $('addAct').onclick = addAction;
  $('eye').onclick = function () {
    pv.shown = !pv.shown;
    store.set('preview', pv.shown);
    renderEye();
    setPlaying(pv.shown);
    if (pv.shown) sizePreview();
  };
  $('mon').onclick = function () {
    setPlaying(!pv.playing);
  };

  // The duration field.
  var durIn = $('durTc');
  durIn.onfocus = function () {
    durIn.select();
  };
  durIn.onblur = function () {
    var f = parseDur(durIn.value, seqFps());
    if (f !== null && S.E) setFrames(Math.max(1, f));
    renderDur();
  };
  durIn.onkeydown = function (e) {
    var r = Math.round(seqFps());
    if (e.key === 'Enter') durIn.blur();
    if (e.key === 'Escape') {
      durIn.value = '';
      renderDur();
      durIn.blur();
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && S.E) {
      e.preventDefault();
      setFrames(secToFrames(S.E.timing.duration) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : r));
      durIn.value = durTc(secToFrames(S.E.timing.duration), r);
    }
    e.stopPropagation();
  };
  $('durMinus').onclick = function (e) {
    if (S.E) setFrames(secToFrames(S.E.timing.duration) - (e.shiftKey ? 1 : Math.round(seqFps())));
  };
  $('durPlus').onclick = function (e) {
    if (S.E) setFrames(secToFrames(S.E.timing.duration) + (e.shiftKey ? 1 : Math.round(seqFps())));
  };

  // The ruler: markers dragged, the rest scrubs.
  $('ruler').addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !S.E) return;
    var mk = e.target.closest('[data-stop], [data-ev]');
    if (mk) dragMarker(e, mk);
    else scrub(e);
  });

  // The times of the actions.
  var acts = $('acts');
  acts.addEventListener('focusin', function (e) {
    if (e.target.matches('[data-evt]')) e.target.select();
  });
  acts.addEventListener('keydown', function (e) {
    if (!e.target.matches('[data-evt]')) return;
    if (e.key === 'Enter') e.target.blur();
    e.stopPropagation();
  });
  acts.addEventListener(
    'blur',
    function (e) {
      var E = S.E;
      if (!E || !e.target.matches('[data-evt]')) return;
      var ev = E.events[+e.target.getAttribute('data-evt')];
      var f = parseDur(e.target.value, seqFps());
      if (ev && f !== null) ev.at = clamp(framesToSec(f), 0, E.timing.duration);
      sortEvents(E.events);
      renderRuler();
      renderActs();
    },
    true,
  );

  // Settings.
  $('server').onchange = $('key').onchange = function () {
    if (saveSettings()) {
      renderTop();
      syncProjects();
    }
  };
  $('test').onclick = testConnection;
  $('paste').onclick = function () {
    var k = $('key');
    var done = function (text) {
      k.value = String(text || '').trim();
      if (saveSettings()) {
        renderTop();
        syncProjects();
      }
    };
    if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then(done, noop);
    else {
      k.focus();
      k.select();
      if (document.execCommand('paste')) done(k.value);
    }
  };
  $('check').onclick = function () {
    if (S.update === 'install' || S.update === 'reload') updateNow();
    else checkUpdate();
  };

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (dd) return closeList();
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return e.target.blur();
    if (S.screen !== 'seq') show(backTarget());
  });

  // A template dragged to the sequence: its last render as it is goes
  // there as a file; never rendered yet, it is inserted at the playhead.
  var dragged = null;
  document.addEventListener('dragstart', function (e) {
    var row = e.target.closest && e.target.closest('[data-tpl]');
    if (!row) return;
    var p = S.full[S.pid];
    var t = tplOf(p, row.getAttribute('data-tpl'));
    if (!t) return;
    dragged = { t: t, file: null, left: false, dropped: false };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', t.name);
    var last = S.lastDefault[p.id + '/' + t.id];
    if (node && last && last.sig === defaultSig(t) && fs.existsSync(last.file)) {
      dragged.file = last.file;
      e.dataTransfer.setData('com.adobe.cep.dnd.file.0', last.file);
    }
  });
  document.addEventListener('dragleave', function (e) {
    if (dragged) dragged.left = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
  });
  document.addEventListener('dragover', function () {
    if (dragged) dragged.left = false;
  });
  document.addEventListener('drop', function () {
    if (dragged) dragged.dropped = true;
  });
  document.addEventListener('dragend', function () {
    var d = dragged;
    dragged = null;
    if (d && !d.file && !d.dropped && d.left) quickInsert(d.t);
  });

  window.addEventListener('resize', function () {
    closeList();
    if (S.screen === 'clip') {
      sizePreview();
      renderRuler();
    }
  });
  // Back in the panel: the sequence and the projects may have changed.
  window.addEventListener('focus', function () {
    poll();
    syncProjects();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  setInterval(poll, POLL_MS);
  setInterval(syncProjects, SYNC_MS);

  // Settings of older panels (sync, loop).
  ['syncState', 'autoSync', 'syncEvery', 'loop'].forEach(function (k) {
    try {
      localStorage.removeItem('pcg.' + k);
    } catch (e) {}
  });
  loadSettings();
  linkAppCss();
  if (window.STRATA_LOADER && window.STRATA_LOADER.updateAvailable) S.update = 'install';
  if (!S.server || !S.key) show('set');
  else {
    show('seq');
    syncProjects();
  }
  poll();
})();
