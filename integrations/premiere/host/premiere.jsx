/* Strata panel — Premiere Pro side (ExtendScript).
   Returns plain "OK:…" / "ERR:…" strings: old ExtendScript has no JSON.
   Lists come back one item per line, fields separated by tabs. Times are
   in seconds of the sequence. */

var PCG_TICKS = 254016000000;

function pcg_clean(s) {
  return String(s == null ? "" : s).replace(/[\t\r\n]+/g, " ");
}

function pcg_secs(ticks) {
  var n = Number(ticks);
  return isNaN(n) ? 0 : n / PCG_TICKS;
}

/** "width|height|fps|playhead|name|videoTracks|in|out|end|zero|id" of the active sequence (seconds; in/out -1 when not set). */
function pcg_info(s) {
  var ticksPerFrame = Number(s.timebase);
  var fps = ticksPerFrame > 0 ? PCG_TICKS / ticksPerFrame : 25;
  var pos = s.getPlayerPosition();
  var inPt = -1;
  var outPt = -1;
  try {
    inPt = s.getInPointAsTime().seconds;
    outPt = s.getOutPointAsTime().seconds;
  } catch (e) {}
  var end = 0;
  var zero = 0;
  var id = "";
  try {
    end = pcg_secs(s.end);
    zero = pcg_secs(s.zeroPoint);
    id = s.sequenceID;
  } catch (e2) {}
  return s.frameSizeHorizontal + "|" + s.frameSizeVertical + "|" + fps + "|" + pos.seconds + "|" + pcg_clean(s.name).replace(/\|/g, "/") + "|" + s.videoTracks.numTracks + "|" + inPt + "|" + outPt + "|" + end + "|" + zero + "|" + pcg_clean(id).replace(/\|/g, "/");
}

function pcg_sequenceInfo() {
  var s = app.project.activeSequence;
  if (!s) return "ERR:Open a sequence first.";
  return "OK:" + pcg_info(s);
}

function pcg_mediaOf(c) {
  try {
    return c.projectItem ? String(c.projectItem.getMediaPath()) : "";
  } catch (e) {
    return "";
  }
}

/**
 * The active sequence and its clips in one call: the sequence line
 * (pcg_sequenceInfo), then one line per QuickTime clip of the video tracks:
 * "track\tstart\tend\tselected\tmediaPath\tname". "OK:" alone: no sequence.
 */
function pcg_state() {
  var s = app.project.activeSequence;
  if (!s) return "OK:";
  var out = [pcg_info(s)];
  for (var t = 0; t < s.videoTracks.numTracks; t++) {
    var tr = s.videoTracks[t];
    for (var i = 0; i < tr.clips.numItems; i++) {
      var c = tr.clips[i];
      var media = pcg_mediaOf(c);
      if (!/\.mov$/i.test(media)) continue;
      out.push(t + "\t" + c.start.seconds + "\t" + c.end.seconds + "\t" + (c.isSelected() ? 1 : 0) + "\t" + pcg_clean(media) + "\t" + pcg_clean(c.name));
    }
  }
  return "OK:" + out.join("\n");
}

/** The sequence markers' times, tab separated. */
function pcg_markers() {
  var s = app.project.activeSequence;
  if (!s) return "ERR:Open a sequence first.";
  var out = [];
  try {
    var m = s.markers.getFirstMarker();
    var n = 0;
    while (m && n < 2000) {
      out.push(m.start.seconds);
      m = s.markers.getNextMarker(m);
      n++;
    }
  } catch (e) {}
  return "OK:" + out.join("\t");
}

function pcg_bin(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var c = root.children[i];
    if (c.type === ProjectItemType.BIN && c.name === name) return c;
  }
  return root.createBin(name);
}

function pcg_norm(p) {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

/** The clip of video track `t` starting at `start` (seconds), with that media when given. */
function pcg_clipAt(s, t, start, media) {
  if (!s || t < 0 || t >= s.videoTracks.numTracks) return null;
  var tr = s.videoTracks[t];
  for (var i = 0; i < tr.clips.numItems; i++) {
    var c = tr.clips[i];
    if (Math.abs(c.start.seconds - start) > 0.002) continue;
    if (media && pcg_norm(pcg_mediaOf(c)) !== pcg_norm(media)) continue;
    return c;
  }
  return null;
}

/** Moves the playhead to `at` seconds and selects the clip of track `t` at `start` (alone). */
function pcg_goto(at, t, start) {
  var s = app.project.activeSequence;
  if (!s) return "ERR:Open a sequence first.";
  s.setPlayerPosition(String(Math.round(Number(at) * PCG_TICKS)));
  var c = pcg_clipAt(s, Number(t), Number(start), "");
  if (!c) return "OK:";
  var lists = [s.videoTracks, s.audioTracks];
  for (var l = 0; l < lists.length; l++) {
    for (var k = 0; k < lists[l].numTracks; k++) {
      var tr = lists[l][k];
      for (var i = 0; i < tr.clips.numItems; i++) {
        if (tr.clips[i].isSelected()) tr.clips[i].setSelected(false, false);
      }
    }
  }
  c.setSelected(true, true);
  return "OK:";
}

/** "mediaPath\tstart\tend\ttrack" of the selected clip, or "OK:" when nothing is selected. */
function pcg_selected() {
  var s = app.project.activeSequence;
  if (!s) return "OK:";
  for (var t = 0; t < s.videoTracks.numTracks; t++) {
    var tr = s.videoTracks[t];
    for (var i = 0; i < tr.clips.numItems; i++) {
      var c = tr.clips[i];
      if (c.isSelected()) return "OK:" + pcg_clean(pcg_mediaOf(c)) + "\t" + c.start.seconds + "\t" + c.end.seconds + "\t" + t;
    }
  }
  return "OK:";
}

/** Nothing on track `t` between start and end (seconds), but the clip `except`. */
function pcg_free(tr, start, end, except) {
  for (var i = 0; i < tr.clips.numItems; i++) {
    var c = tr.clips[i];
    if (except && c.start.seconds === except.start.seconds && c.end.seconds === except.end.seconds) continue;
    if (c.start.seconds < end - 0.001 && c.end.seconds > start + 0.001) return false;
  }
  return true;
}

/** The first video track above V1 with nothing between start and end (seconds); the top one when none is free. */
function pcg_freeTrack(start, end) {
  var s = app.project.activeSequence;
  if (!s) return "ERR:Open a sequence first.";
  var n = s.videoTracks.numTracks;
  for (var t = 1; t < n; t++) {
    if (pcg_free(s.videoTracks[t], Number(start), Number(end), null)) return "OK:" + t;
  }
  return "OK:" + (n - 1);
}

function pcg_importItem(path) {
  var bin = pcg_bin("Strata");
  if (!app.project.importFiles([path], true, bin, false)) return null;
  for (var i = bin.children.numItems - 1; i >= 0; i--) {
    var c = bin.children[i];
    if (c.getMediaPath && pcg_norm(c.getMediaPath()) === pcg_norm(path)) return c;
  }
  return null;
}

/** Imports `path` into the "Strata" bin; with a track index, also lays it
    on that video track at `at` seconds (the playhead when negative). */
function pcg_import(path, trackIndex, at) {
  var s = app.project.activeSequence;
  var item = pcg_importItem(path);
  if (!item) return "ERR:Premiere could not import " + path;
  if (trackIndex === "" || trackIndex === null || trackIndex < 0) return "OK:" + item.name + " imported";
  if (!s) return "ERR:Open a sequence to place the clip.";
  var t = Math.min(Number(trackIndex), s.videoTracks.numTracks - 1);
  var when = at === undefined || at < 0 ? s.getPlayerPosition().seconds : Number(at);
  s.videoTracks[t].overwriteClip(item, when);
  return "OK:V" + (t + 1);
}

/**
 * Puts `path` in place of the clip of track `t` at `start` showing `oldPath`:
 * same track, same start. Refused when the new length (`len` seconds) would
 * cover another clip of the track.
 */
function pcg_replaceClip(t, start, oldPath, path, len) {
  var s = app.project.activeSequence;
  if (!s) return "ERR:Open a sequence first.";
  t = Number(t);
  start = Number(start);
  var old = pcg_clipAt(s, t, start, oldPath);
  if (!old) return "ERR:NOCLIP";
  if (!pcg_free(s.videoTracks[t], start, start + Number(len), old)) return "ERR:BUSY";
  var item = pcg_importItem(path);
  if (!item) return "ERR:Premiere could not import " + path;
  try {
    old.remove(false, false);
  } catch (e) {}
  s.videoTracks[t].overwriteClip(item, start);
  return "OK:V" + (t + 1);
}

/** Replaces the selected clip by `path`, at the same place and track (older panels). */
function pcg_replaceSelected(path) {
  var r = pcg_selected();
  if (r === "OK:") return "ERR:Select the Strata clip to update in the timeline.";
  var p = r.slice(3).split("\t");
  return pcg_replaceClip(Number(p[3]), Number(p[1]), p[0], path, 0);
}
