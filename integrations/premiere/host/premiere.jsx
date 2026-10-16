/* Pulse CG panel — Premiere Pro side (ExtendScript).
   Returns plain "OK:…" / "ERR:…" strings: old ExtendScript has no JSON. */

/** "width|height|fps|playheadSeconds|sequenceName" of the active sequence. */
function pcg_sequenceInfo() {
  var s = app.project.activeSequence;
  if (!s) return "ERR:Open a sequence first.";
  var ticksPerFrame = Number(s.timebase);
  var fps = ticksPerFrame > 0 ? 254016000000 / ticksPerFrame : 25;
  var pos = s.getPlayerPosition();
  return "OK:" + s.frameSizeHorizontal + "|" + s.frameSizeVertical + "|" + fps + "|" + pos.seconds + "|" + s.name + "|" + s.videoTracks.numTracks;
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

/** Imports `path` into the "Pulse CG" bin; with a track index, also lays it
    on that video track at the playhead (overwrite). */
function pcg_import(path, trackIndex) {
  var s = app.project.activeSequence;
  var bin = pcg_bin("Pulse CG");
  if (!app.project.importFiles([path], true, bin, false)) return "ERR:Premiere could not import " + path;
  var item = null;
  for (var i = bin.children.numItems - 1; i >= 0; i--) {
    var c = bin.children[i];
    if (c.getMediaPath && pcg_norm(c.getMediaPath()) === pcg_norm(path)) {
      item = c;
      break;
    }
  }
  if (!item) return "ERR:Imported, but not found in the bin.";
  if (trackIndex === "" || trackIndex === null || trackIndex < 0) return "OK:" + item.name + " imported";
  if (!s) return "ERR:Open a sequence to place the clip.";
  var t = Math.min(Number(trackIndex), s.videoTracks.numTracks - 1);
  var track = s.videoTracks[t];
  track.overwriteClip(item, s.getPlayerPosition().seconds);
  return "OK:" + item.name + " placed on V" + (t + 1);
}
