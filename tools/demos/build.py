#!/usr/bin/env python3
"""Builds the demo projects bank (crates/cg-server/demos/*.json).

Ten projects, from a single lower third to a multi-format live show, that
together use every feature of Pulse CG: zones and their areas, playlists,
markers (on air, pauses resumed by the operator, a delay or a trigger),
widgets, variables of every kind, data filters and operations (logic),
formats, guides, safe areas and areas to keep clear.

Run: python3 tools/demos/build.py   (the server embeds the JSON files)
"""
import json
import os

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'crates', 'cg-server', 'demos')
FPS = 50

# ---------------------------------------------------------------- helpers --


def hexc(h, a=1.0):
    h = h.lstrip('#')
    return [round(int(h[i:i + 2], 16) / 255, 4) for i in (0, 2, 4)] + [a]


WHITE = hexc('ffffff')
INK = hexc('0b0d17', 0.92)


def ease(t='easeOut'):
    return {'type': t}


def keys(*pts):
    """keys((frame, value, easing?), ...)"""
    out = []
    for p in pts:
        f, v = p[0], p[1]
        out.append({'frame': float(f), 'value': v, 'easing': ease(p[2] if len(p) > 2 else 'easeOut')})
    return out


def fade(on_air, length=12):
    """Opacity in at the start, out from the on-air point."""
    return {'opacity': keys((0, 0), (length, 1, 'linear'), (on_air, 1, 'easeIn'), (on_air + length, 0, 'linear'))}


def wipe(on_air, length=18, prop='cropRight'):
    return {prop: keys((0, 1), (length, 0, 'linear'), (on_air, 0, 'easeIn'), (on_air + length, 1, 'linear'))}


def slide(prop, start, end, on_air, length=18, delay=0):
    return {prop: keys((delay, start), (delay + length, end, 'linear'), (on_air, end, 'easeIn'), (on_air + length, start, 'linear'))}


class T:
    """A template being built."""

    def __init__(self, tid, name, zone, duration=80, on_air=45):
        self.t = {
            'id': tid,
            'name': name,
            'duration': float(duration),
            'markers': [{'id': f'{tid}-out', 'frame': float(on_air), 'name': 'On air', 'kind': 'out'}],
            'fields': [],
            'layers': [],
            'zone': zone,
            'revision': 1,
            'markerModel': 2,
        }
        self.on_air = on_air
        self.n = 0

    def field(self, key, label, default='', kind='text', **extra):
        self.t['fields'].append({'key': key, 'label': label, 'kind': kind, 'default': str(default), **extra})
        return key

    def pause(self, frame, name='Pause', resume=None):
        m = {'id': f"{self.t['id']}-p{len(self.t['markers'])}", 'frame': float(frame), 'name': name, 'kind': 'pause'}
        if resume:
            m['resume'] = resume
        self.t['markers'].append(m)

    def layer(self, kind, name, parent=None, props=None, tracks=None, bindings=None, **attrs):
        self.n += 1
        lid = f"{self.t['id']}-{self.n}"
        layer = {
            'id': lid,
            'name': name,
            'parent': parent,
            'type': kind,
            'visible': True,
            'locked': False,
            'props': {k: (float(v) if isinstance(v, (int, float)) else v) for k, v in (props or {}).items()},
            'tracks': tracks or {},
            'bindings': bindings or {},
            **attrs,
        }
        self.t['layers'].append(layer)
        return lid

    def group(self, name, x, y, w, h, parent=None, clip=False, tracks=None, bindings=None, **props):
        return self.layer('group', name, parent, {'x': x, 'y': y, 'width': w, 'height': h, **props}, tracks, bindings, clip=clip)

    def rect(self, name, x, y, w, h, fill, parent=None, tracks=None, radius=0, bindings=None, **props):
        p = {'x': x, 'y': y, 'width': w, 'height': h, 'fill': fill, **props}
        if radius:
            p['cornerRadius'] = radius
        return self.layer('rect', name, parent, p, tracks, bindings)

    def ellipse(self, name, x, y, w, h, fill, parent=None, tracks=None, **props):
        return self.layer('ellipse', name, parent, {'x': x, 'y': y, 'width': w, 'height': h, 'fill': fill, **props}, tracks)

    def text(self, name, text, x, y, w, h, size, parent=None, color=WHITE, weight=700, family='Inter', align='left', valign='middle', tracks=None, bindings=None, **style):
        return self.layer(
            'text', name, parent, {'x': x, 'y': y, 'width': w, 'height': h, 'fill': color, 'fontSize': size}, tracks, bindings,
            text=text, fontFamily=family, fontWeight=weight, align=align, verticalAlign=valign, uppercase=False, **style,
        )

    def widget(self, kind, name, x, y, w, h, parent=None, props=None, tracks=None, **attrs):
        return self.layer(kind, name, parent, {'x': x, 'y': y, 'width': w, 'height': h, **(props or {})}, tracks, **attrs)

    def font(self, size, align='left', weight=700, color=WHITE):
        return {'fontFamily': 'Inter', 'fontWeight': weight, 'align': align, 'verticalAlign': 'middle', 'uppercase': False}, {'fontSize': float(size), 'fill': color}

    def logic(self, nodes, edges):
        self.t['logic'] = {'nodes': nodes, 'edges': edges}

    def done(self):
        return self.t


def zone(zid, name, layer, color, area=(0, 0, 1, 1), transition='sequential', vertical=None):
    """A zone; graphics are cut to its area (fractions of the picture)."""
    box = lambda a: dict(zip(('x', 'y', 'width', 'height'), a))
    z = {'id': zid, 'name': name, 'layer': layer, 'color': color, 'transition': transition, 'areas': {'main': box(area)}}
    if vertical:
        z['areas']['vertical'] = box(vertical)
    return z


def item(name, tid, zone_id, playlist, data, layer, read=None):
    slug = ''.join(c if c.isalnum() else '-' for c in name.lower()).strip('-')
    it = {'id': f'{playlist}-{slug}', 'name': name, 'templateId': tid, 'zone': zone_id, 'playlist': playlist, 'layer': layer, 'data': data}
    if read:
        it['read'] = read
    return it


def project(pid, name, description, level, tags, templates, zones, playlists, rundown, formats=None, guides=None):
    zl = {z['id']: z['layer'] for z in zones}
    for r in rundown:
        r['layer'] = zl[r['zone']]
    p = {
        'id': pid,
        'name': name,
        'description': description,
        'width': 1920,
        'height': 1080,
        'frameRate': {'num': FPS, 'den': 1},
        'templates': templates,
        'rundown': rundown,
        'zones': zones,
        'playlists': [{'id': i, 'name': n} for i, n in playlists],
        'formats': formats or [],
    }
    if guides:
        p['guides'] = guides
    return {'demo': {'id': pid, 'name': name, 'level': level, 'tags': tags, 'description': description}, 'project': p}


ACCENT = hexc('ff3b5c')
VIOLET = hexc('7c5cff')
BLUE = hexc('2563eb')
GREEN = hexc('22c55e')
AMBER = hexc('f5a524')
SLATE = hexc('1e2233', 0.94)

FULL = zone('full', 'Full screen', 50, '#38bdf8')
LOWER = zone('lower', 'Lower third', 10, '#7c5cff', (0.04, 0.68, 0.66, 0.28))

demos = []

# ------------------------------------------------- 1. Lower third basics --
t = T('lt', 'Lower third', 'lower', duration=70, on_air=40)
t.field('name', 'Name', 'Marie Curie')
t.field('title', 'Title', 'Physicist & chemist')
g = t.group('Lower third', 120, 820, 1000, 150, clip=True, tracks=wipe(40))
t.rect('Accent', 0, 0, 12, 150, ACCENT, g)
t.rect('Plate', 12, 0, 988, 92, INK, g)
t.rect('Title plate', 12, 92, 620, 58, ACCENT, g, tracks={'width': keys((6, 0), (24, 620, 'linear'))})
t.text('Name', '{{name}}', 44, 0, 940, 92, 54, g, bindings={})
t.text('Title', '{{title}}', 44, 92, 580, 58, 28, g, weight=600, transform='upper')
demos.append(project(
    'demo-01-lower-third', '01 · Lower third', 'One lower third: a name and a title that wipe in and out. The place to start: fill the two fields in the Operator and take it.',
    1, ['Lower third', 'Animation', 'Variables'], [t.done()], [LOWER], [('show', 'Show')],
    [item('Marie Curie', 'lt', 'lower', 'show', {'name': 'Marie Curie', 'title': 'Physicist & chemist'}, 0),
     item('Albert Einstein', 'lt', 'lower', 'show', {'name': 'Albert Einstein', 'title': 'Theoretical physicist'}, 0)],
))

# ------------------------------------------------- 2. Channel bug & clock --
bug = T('bug', 'Channel bug', 'bug', duration=60, on_air=30)
bug.field('channel', 'Channel', 'PULSE 24')
g = bug.group('Bug', 1640, 54, 230, 70, tracks=fade(30))
bug.rect('Plate', 0, 0, 230, 70, VIOLET, g, radius=10)
bug.text('Channel', '{{channel}}', 0, 0, 230, 70, 30, g, align='center', weight=800)
clk = T('clock', 'Clock', 'clock', duration=60, on_air=30)
g = clk.group('Clock', 1640, 132, 230, 54, tracks=fade(30))
clk.rect('Plate', 0, 0, 230, 54, INK, g, radius=8)
f, p = clk.font(30, 'center', 600)
clk.widget('clock', 'Time', 0, 0, 230, 54, g, p, mode='time', format='HH:mm:ss', timezone='', target='', **f)
live = T('live', 'LIVE tag', 'live', duration=80, on_air=50)
live.field('label', 'Label', 'LIVE')
live.field('place', 'Place', 'PARIS')
g = live.group('Live', 60, 54, 420, 60, clip=True, tracks=wipe(50, 14))
live.rect('Red', 0, 0, 120, 60, ACCENT, g)
live.text('Live', '{{label}}', 0, 0, 120, 60, 30, g, align='center', weight=800)
live.rect('Place plate', 120, 0, 300, 60, INK, g)
live.text('Place', '{{place}}', 140, 0, 270, 60, 28, g, weight=600)
live.pause(20, 'Hold', {'type': 'manual'})
demos.append(project(
    'demo-02-bug-clock', '02 · Channel bug and clock', 'Three graphics on air together in their own zones: a channel bug, a clock widget and a LIVE tag that holds on a pause until you press Continue. The bug area is kept clear in the guides.',
    1, ['Zones', 'Clock widget', 'Pause', 'Guides'],
    [bug.done(), clk.done(), live.done()],
    [zone('live', 'Top left', 20, '#ff3b5c', (0.02, 0.03, 0.26, 0.09)), zone('bug', 'Bug', 60, '#7c5cff', (0.84, 0.04, 0.14, 0.08)), zone('clock', 'Clock', 61, '#22c55e', (0.84, 0.12, 0.14, 0.06))],
    [('show', 'Show')],
    [item('Bug', 'bug', 'bug', 'show', {'channel': 'PULSE 24'}, 0), item('Clock', 'clock', 'clock', 'show', {}, 0), item('Live Paris', 'live', 'live', 'show', {'label': 'LIVE', 'place': 'PARIS'}, 0)],
    guides={'vertical': [0.0625, 0.9375], 'horizontal': [0.9], 'actionSafe': 0.035, 'titleSafe': 0.05, 'exclusions': [{'id': 'bug', 'name': 'Channel bug', 'x': 0.84, 'y': 0.04, 'width': 0.13, 'height': 0.18}]},
))

# ------------------------------------------------------ 3. Breaking news --
br = T('breaking', 'Breaking news', 'banner', duration=90, on_air=60)
br.field('headline', 'Headline', 'Storm warning for the whole west coast')
br.field('label', 'Label', 'BREAKING NEWS')
g = br.group('Breaking', 0, 790, 1920, 170, clip=True, tracks=wipe(60, 16))
br.rect('Red band', 0, 0, 1920, 64, ACCENT, g)
br.widget('typewriter', 'Label', 60, 0, 900, 64, g, {'fontSize': 34.0, 'fill': WHITE}, text='{{label}}', speed=22.0, cursor=True, fontFamily='Inter', fontWeight=800, align='left', verticalAlign='middle', uppercase=False)
br.rect('Headline plate', 0, 64, 1920, 106, INK, g)
br.text('Headline', '{{headline}}', 60, 64, 1800, 106, 48, g)
br.pause(30, 'Read the headline', {'type': 'after', 'seconds': 8})
tk = T('ticker', 'News ticker', 'ticker', duration=60, on_air=30)
tk.field('items', 'Headlines', 'Markets open higher\nElection debate tonight at 9 pm\nTraffic: A6 closed near Lyon', kind='multiline')
g = tk.group('Ticker', 0, 990, 1920, 60, tracks=slide('y', 1080, 990, 30, 14))
tk.rect('Plate', 0, 0, 1920, 60, SLATE, g)
tk.rect('Label', 0, 0, 180, 60, BLUE, g)
tk.text('Label text', 'NEWS', 0, 0, 180, 60, 28, g, align='center', weight=800)
f, p = tk.font(30, weight=600)
tk.layer('text', 'Crawl', g, {'x': 200, 'y': 0, 'width': 1720, 'height': 60, **p}, text='{{items}}', scroll='horizontal', separator='   •   ', speed=160.0, **f)
demos.append(project(
    'demo-03-breaking-news', '03 · Breaking news', 'A breaking news banner whose label types itself in, holds 8 seconds on its headline then plays on by itself, and a news ticker crawling at the bottom.',
    2, ['Breaking news', 'Ticker', 'Typewriter', 'Auto pause'],
    [br.done(), tk.done()], [zone('banner', 'Banner', 15, '#ff3b5c', (0, 0.72, 1, 0.18)), zone('ticker', 'Ticker', 40, '#f5a524', (0, 0.9, 1, 0.08))], [('show', 'Show')],
    [item('Storm warning', 'breaking', 'banner', 'show', {'headline': 'Storm warning for the whole west coast', 'label': 'BREAKING NEWS'}, 0),
     item('Ticker', 'ticker', 'ticker', 'show', {'items': 'Markets open higher\nElection debate tonight at 9 pm\nTraffic: A6 closed near Lyon'}, 0)],
))

# ---------------------------------------------------------- 4. Weather --
w = T('weather', 'Weather board', 'full', duration=100, on_air=70)
cities = [('paris', 'Paris', '18'), ('lyon', 'Lyon', '21'), ('marseille', 'Marseille', '25'), ('lille', 'Lille', '14')]
w.field('title', 'Title', 'Weather · Tomorrow')
for key, name, temp in cities:
    w.field(f'{key}', f'{name} °C', temp, kind='number', min=-20, max=45)
g = w.group('Board', 360, 160, 1200, 760, tracks=fade(70, 15))
w.rect('Panel', 0, 0, 1200, 760, hexc('0e2a4a', 0.92), g, radius=24)
w.text('Title', '{{title}}', 60, 30, 1080, 100, 56, g, weight=800)
for i, (key, name, temp) in enumerate(cities):
    y = 170 + i * 140
    row = w.group(name, 60, y, 1080, 120, g, tracks=slide('x', 1300, 60, 70, 16 + i * 3))
    w.rect('Row', 0, 0, 1080, 120, hexc('ffffff', 0.06), row, radius=14)
    w.ellipse('Sun', 30, 25, 70, 70, AMBER, row)
    w.text('City', name, 130, 0, 600, 120, 44, row, weight=600)
    f, p = w.font(56, 'right', 800)
    w.widget('counter', 'Temperature', 700, 0, 340, 120, row, p, **{'from': '0', 'to': '{{' + key + '}}', 'duration': 1.2, 'decimals': 0, 'prefix': '', 'suffix': '°', 'grouping': False}, **f)
rot = T('weather-strip', 'Forecast strip', 'lower', duration=60, on_air=30)
rot.field('lines', 'Forecasts', 'Paris  18°  sunny\nLyon  21°  clouds\nMarseille  25°  sunny\nLille  14°  rain', kind='multiline')
g = rot.group('Strip', 120, 880, 900, 90, tracks=wipe(30))
rot.rect('Plate', 0, 0, 900, 90, hexc('0e2a4a', 0.95), g, radius=12)
f, p = rot.font(40, weight=600)
rot.widget('rotator', 'Forecasts', 40, 0, 840, 90, g, p, text='{{lines}}', interval=3.0, fade=0.5, **f)
demos.append(project(
    'demo-04-weather', '04 · Weather', 'A full-screen weather board whose temperatures count up (number variables with a range, set with sliders), and a strip that rotates through the forecasts.',
    2, ['Weather', 'Counter', 'Rotator', 'Number range'],
    [w.done(), rot.done()], [LOWER, FULL], [('weather', 'Weather')],
    [item('Tomorrow', 'weather', 'full', 'weather', {'title': 'Weather · Tomorrow', 'paris': '18', 'lyon': '21', 'marseille': '25', 'lille': '14'}, 0),
     item('Forecast strip', 'weather-strip', 'lower', 'weather', {}, 0)],
))

# ------------------------------------------------------ 5. Election night --
el = T('results', 'Results', 'full', duration=110, on_air=80)
el.field('title', 'Title', 'Presidential election · Second round')
el.field('results', 'Results (name: %)', 'Candidate A: 52.4\nCandidate B: 47.6', kind='multiline')
el.field('turnout', 'Turnout %', '71.3', kind='number', min=0, max=100)
el.field('winner', 'Projected winner shown', 'true', kind='boolean')
el.field('votes', 'Votes counted', '31254870', kind='number')
g = el.group('Results', 300, 140, 1320, 800, tracks=fade(80))
el.rect('Panel', 0, 0, 1320, 800, SLATE, g, radius=20)
el.text('Title', '{{title}}', 60, 30, 1200, 90, 48, g, weight=800)
f, p = el.font(34, weight=600)
el.widget('barChart', 'Bars', 60, 150, 1200, 330, g, dict(p, fill=BLUE), text='{{results}}', percent=True, duration=1.6, track='#ffffff1f', textColor='#ffffff', **f)
el.text('Turnout label', 'Turnout', 60, 520, 300, 60, 30, g, weight=600)
el.widget('progress', 'Turnout', 360, 535, 840, 30, g, {'fill': GREEN, 'cornerRadius': 15.0}, value='{{turnout}}', max='100', duration=1.5, track='#ffffff22')
f, p = el.font(30, 'right', 500, hexc('a3a8bf'))
el.widget('counter', 'Votes', 60, 610, 1140, 60, g, p, **{'from': '0', 'to': '{{votes}}', 'duration': 2.0, 'decimals': 0, 'prefix': '', 'suffix': ' votes counted', 'grouping': True}, **f)
badge = el.group('Projected winner', 60, 690, 520, 80, g, bindings={'opacity': 'winner'})
el.rect('Badge', 0, 0, 520, 80, ACCENT, badge, radius=12)
el.text('Badge text', 'PROJECTED WINNER: A', 0, 0, 520, 80, 30, badge, align='center', weight=800)
el.pause(40, 'Results in', {'type': 'trigger', 'name': 'reveal'})
demos.append(project(
    'demo-05-election', '05 · Election night', 'Results with animated bars, a turnout bar, a vote counter, and a "projected winner" badge switched by a boolean variable. The board waits on the trigger "reveal" before the results animate.',
    3, ['Elections', 'Bar chart', 'Progress', 'Boolean', 'Trigger'],
    [el.done()], [FULL], [('night', 'Election night')],
    [item('Second round', 'results', 'full', 'night', {}, 0)],
))

# ------------------------------------------------------- 6. Football --
sb = T('scorebug', 'Score bug', 'score', duration=60, on_air=30)
sb.field('home', 'Home', 'PSG')
sb.field('away', 'Away', 'OM')
sb.field('homeScore', 'Home score', '0', kind='number', min=0, max=20)
sb.field('awayScore', 'Away score', '0', kind='number', min=0, max=20)
sb.field('homeColor', 'Home colour', '#1d4ed8', kind='color')
sb.field('awayColor', 'Away colour', '#38bdf8', kind='color')
g = sb.group('Score bug', 60, 50, 560, 64, clip=True, tracks=wipe(30, 14))
sb.rect('Plate', 0, 0, 560, 64, INK, g)
sb.rect('Home colour', 0, 0, 10, 64, BLUE, g, bindings={'fill': 'homeColor'})
sb.text('Home', '{{home}}', 20, 0, 120, 64, 30, g, transform='upper')
sb.rect('Score plate', 140, 0, 140, 64, WHITE, g)
sb.text('Score', '{{homeScore}} - {{awayScore}}', 140, 0, 140, 64, 34, g, color=hexc('0b0d17'), align='center', weight=800)
sb.text('Away', '{{away}}', 290, 0, 120, 64, 30, g, transform='upper')
sb.rect('Away colour', 410, 0, 10, 64, BLUE, g, bindings={'fill': 'awayColor'})
f, p = sb.font(30, 'center', 600)
sb.widget('clock', 'Match clock', 420, 0, 140, 64, g, p, mode='elapsed', format='mm:ss', timezone='', target='', manualStart=True, **f)
goal = T('goal', 'Goal', 'full', duration=90, on_air=60)
goal.field('team', 'Team', 'PSG')
goal.field('scorer', 'Scorer', 'Mbappé 23\'')
g = goal.group('Goal', 0, 380, 1920, 320, clip=True, tracks=wipe(60, 12, 'cropBottom'))
goal.rect('Band', 0, 0, 1920, 320, ACCENT, g)
goal.text('GOAL', 'GOAL!', 0, 20, 1920, 200, 160, g, align='center', weight=900, tracks={'scaleX': keys((0, 0.6, 'back'), (18, 1, 'linear')), 'scaleY': keys((0, 0.6, 'back'), (18, 1, 'linear'))}, transform='upper')
goal.text('Scorer', '{{team}} · {{scorer}}', 0, 220, 1920, 80, 44, g, align='center', weight=600)
lu = T('lineup', 'Line-up', 'full', duration=90, on_air=60)
lu.field('team', 'Team', 'Paris Saint-Germain')
lu.field('players', 'Players', 'Donnarumma\nHakimi\nMarquinhos\nPacho\nMendes\nVitinha\nNeves\nZaïre-Emery\nDembélé\nBarcola\nKvaratskhelia', kind='multiline')
g = lu.group('Line-up', 560, 90, 800, 900, tracks=fade(60))
lu.rect('Panel', 0, 0, 800, 900, SLATE, g, radius=20)
lu.text('Team', '{{team}}', 50, 30, 700, 80, 44, g, weight=800)
lu.text('Players', '{{players}}', 50, 130, 700, 740, 40, g, weight=500, valign='top', lineHeight=1.6)
demos.append(project(
    'demo-06-football', '06 · Football match', 'A score bug with team colours (colour variables) and a match clock the operator starts and pauses from the controls on air, a GOAL! full screen and the line-ups.',
    3, ['Sport', 'Score', 'Colours', 'Widget controls', 'Line height'],
    [sb.done(), goal.done(), lu.done()],
    [zone('score', 'Score bug', 20, '#ff3b5c', (0.03, 0.04, 0.3, 0.07)), FULL],
    [('pre', 'Before the match'), ('live', 'Match')],
    [item('Line-up PSG', 'lineup', 'full', 'pre', {}, 0), item('PSG - OM', 'scorebug', 'score', 'live', {}, 0), item('Goal PSG', 'goal', 'full', 'live', {}, 0)],
))

# --------------------------------------------------------- 7. Markets --
mk = T('markets', 'Markets', 'lower', duration=70, on_air=40)
mk.field('index', 'Index', 'CAC 40')
mk.field('value', 'Value', '7 512.30')
mk.field('change', 'Change %', '1.24', kind='number', min=-10, max=10)
g = mk.group('Index', 120, 840, 700, 120, clip=True, tracks=wipe(40))
mk.rect('Plate', 0, 0, 700, 120, INK, g, radius=10)
idx = mk.text('Index', '{{index}}', 30, 0, 300, 120, 44, g, weight=800)
mk.text('Value', '{{value}}', 300, 0, 260, 120, 40, g, weight=600, align='right')
up = mk.text('Up', '▲ {{change}} %', 560, 0, 140, 60, 26, g, color=GREEN, weight=700)
down = mk.text('Down', '▼ {{change}} %', 560, 60, 140, 60, 26, g, color=ACCENT, weight=700)
# Logic: show ▲ when the change is ≥ 0, ▼ otherwise.
mk.logic(
    [
        {'id': 'f', 'type': 'field', 'key': 'change', 'x': 60, 'y': 80},
        {'id': 'zero', 'type': 'constant', 'value': 0, 'x': 60, 'y': 200},
        {'id': 'one', 'type': 'constant', 'value': 1, 'x': 60, 'y': 320},
        {'id': 'none', 'type': 'constant', 'value': 0, 'x': 60, 'y': 440},
        {'id': 'isUp', 'type': 'condition', 'cmp': 'ge', 'x': 340, 'y': 100},
        {'id': 'isDown', 'type': 'condition', 'cmp': 'lt', 'x': 340, 'y': 320},
        {'id': 'tUp', 'type': 'target', 'layer': up, 'prop': 'opacity', 'mode': 'set', 'x': 640, 'y': 100},
        {'id': 'tDown', 'type': 'target', 'layer': down, 'prop': 'opacity', 'mode': 'set', 'x': 640, 'y': 320},
    ],
    [
        {'from': 'f', 'to': 'isUp', 'port': 'a'}, {'from': 'zero', 'to': 'isUp', 'port': 'b'}, {'from': 'one', 'to': 'isUp', 'port': 'then'}, {'from': 'none', 'to': 'isUp', 'port': 'else'},
        {'from': 'f', 'to': 'isDown', 'port': 'a'}, {'from': 'zero', 'to': 'isDown', 'port': 'b'}, {'from': 'one', 'to': 'isDown', 'port': 'then'}, {'from': 'none', 'to': 'isDown', 'port': 'else'},
        {'from': 'isUp', 'to': 'tUp', 'port': 'in'}, {'from': 'isDown', 'to': 'tDown', 'port': 'in'},
    ],
)
mt = T('market-ticker', 'Market ticker', 'ticker', duration=60, on_air=30)
mt.field('quotes', 'Quotes', 'AIR  142.10  ▲ 0.8 %\nLVMH  712.40  ▼ 1.2 %\nTOTAL  58.32  ▲ 0.3 %\nSANOFI  91.05  ▲ 1.9 %', kind='multiline')
g = mt.group('Ticker', 0, 1000, 1920, 56, tracks=slide('y', 1080, 1000, 30, 12))
mt.rect('Plate', 0, 0, 1920, 56, hexc('0a1a12', 0.95), g)
f, p = mt.font(28, weight=600, color=hexc('d1fae5'))
mt.layer('text', 'Quotes', g, {'x': 0, 'y': 0, 'width': 1920, 'height': 56, **p}, text='{{quotes}}', scroll='horizontal', separator='     ', speed=140.0, **f)
demos.append(project(
    'demo-07-markets', '07 · Markets', 'A stock index whose ▲ / ▼ follows the sign of the change (a condition in the logic), and a ticker of quotes. Open the Data canvas to see the operations wired to the arrows.',
    3, ['Finance', 'Logic', 'Condition', 'Ticker'],
    [mk.done(), mt.done()], [LOWER, zone('ticker', 'Ticker', 40, '#f5a524', (0, 0.92, 1, 0.06))], [('markets', 'Markets')],
    [item('CAC 40 up', 'markets', 'lower', 'markets', {'index': 'CAC 40', 'value': '7 512.30', 'change': '1.24'}, 0),
     item('DAX down', 'markets', 'lower', 'markets', {'index': 'DAX', 'value': '18 120.55', 'change': '-0.62'}, 0),
     item('Quotes', 'market-ticker', 'ticker', 'markets', {}, 0)],
))

# ------------------------------------------------------- 8. Talk show --
gs = T('guest', 'Guest', 'lower', duration=80, on_air=50)
gs.field('name', 'Name', 'Ada Lovelace')
gs.field('role', 'Role', 'Mathematician')
gs.field('handle', 'Social', '@ada')
g = gs.group('Guest', 120, 800, 1100, 170, clip=True, tracks=wipe(50))
gs.rect('Plate', 0, 0, 1100, 110, hexc('1b1036', 0.94), g)
gs.rect('Accent', 0, 110, 1100, 6, VIOLET, g)
# The plate follows the name: text width + 120, at least 600 (logic).
plate = gs.t['layers'][1]['id']
nm = gs.text('Name', '{{name}}', 40, 0, 1000, 110, 56, g, family='DejaVu Serif', transform='capitalize')
gs.text('Role', '{{role}}  ·  {{handle}}', 40, 116, 1000, 54, 28, g, weight=500, decoration='underline')
gs.logic(
    [
        {'id': 'tw', 'type': 'textSize', 'layer': nm, 'metric': 'width', 'x': 60, 'y': 80},
        {'id': 'pad', 'type': 'constant', 'value': 120, 'x': 60, 'y': 220},
        {'id': 'sum', 'type': 'math', 'op': 'add', 'x': 340, 'y': 120},
        {'id': 'min', 'type': 'constant', 'value': 600, 'x': 340, 'y': 280},
        {'id': 'max', 'type': 'math', 'op': 'max', 'x': 620, 'y': 160},
        {'id': 'set', 'type': 'target', 'layer': plate, 'prop': 'width', 'mode': 'set', 'x': 900, 'y': 160},
    ],
    [{'from': 'tw', 'to': 'sum', 'port': 'a'}, {'from': 'pad', 'to': 'sum', 'port': 'b'}, {'from': 'sum', 'to': 'max', 'port': 'a'}, {'from': 'min', 'to': 'max', 'port': 'b'}, {'from': 'max', 'to': 'set', 'port': 'in'}],
)
qt = T('quote', 'Quote', 'full', duration=100, on_air=70)
qt.field('quote', 'Quote', 'The Analytical Engine weaves algebraic patterns just as the Jacquard loom weaves flowers and leaves.', kind='multiline')
qt.field('author', 'Author', 'Ada Lovelace')
g = qt.group('Quote', 260, 260, 1400, 560, tracks=fade(70, 16))
qt.rect('Panel', 0, 0, 1400, 560, hexc('1b1036', 0.92), g, radius=28)
qt.text('Mark', '“', 50, 10, 200, 200, 220, g, color=VIOLET, family='DejaVu Serif')
qt.text('Quote', '{{quote}}', 120, 90, 1180, 330, 52, g, weight=500, family='DejaVu Serif', valign='top', wrap=True, lineHeight=1.35)
qt.text('Author', '— {{author}}', 120, 450, 1180, 70, 34, g, weight=600, color=hexc('c4b5fd'))
vote = T('vote', 'Vote by QR code', 'corner', duration=70, on_air=40)
vote.field('url', 'Link', 'https://example.com/vote')
vote.field('question', 'Question', 'Who wins tonight?')
g = vote.group('Vote', 1440, 560, 420, 460, tracks=fade(40))
vote.rect('Card', 0, 0, 420, 460, WHITE, g, radius=24)
vote.widget('qrCode', 'QR', 60, 40, 300, 300, g, {'fill': hexc('0b0d17')}, data='{{url}}', background='#ffffff')
vote.text('Question', '{{question}}', 30, 350, 360, 90, 30, g, color=hexc('0b0d17'), align='center', wrap=True)
nx = T('next', 'Next segment countdown', 'corner', duration=70, on_air=40)
nx.field('label', 'Next', 'Music live in')
nx.field('target', 'Target time', '21:30')
g = nx.group('Next', 1440, 900, 420, 120, tracks=fade(40))
nx.rect('Card', 0, 0, 420, 120, VIOLET, g, radius=18)
nx.text('Label', '{{label}}', 0, 8, 420, 50, 26, g, align='center', weight=600)
f, p = nx.font(46, 'center', 800)
nx.widget('clock', 'Countdown', 0, 54, 420, 60, g, p, mode='countdown', format='mm:ss', timezone='', target='{{target}}', **f)
demos.append(project(
    'demo-08-talk-show', '08 · Talk show', 'Guest lower thirds whose plate follows the name (logic: text width + padding), a quote in a wrapping paragraph, a vote QR code and a countdown to the next segment. Text with case and underline.',
    4, ['Talk show', 'Logic', 'Paragraph', 'QR code', 'Countdown', 'Typography'],
    [gs.done(), qt.done(), vote.done(), nx.done()],
    [LOWER, FULL, zone('corner', 'Corner', 30, '#e879f9', (0.74, 0.5, 0.24, 0.46))],
    [('show', 'Show')],
    [item('Ada Lovelace', 'guest', 'lower', 'show', {}, 0), item('Grace Hopper', 'guest', 'lower', 'show', {'name': 'grace hopper', 'role': 'Computer scientist', 'handle': '@grace'}, 0),
     item('Quote Ada', 'quote', 'full', 'show', {}, 0), item('Vote', 'vote', 'corner', 'show', {}, 0), item('Next: music', 'next', 'corner', 'show', {}, 0)],
))

# --------------------------------------------------------- 9. Esports --
mh = T('match', 'Match header', 'top', duration=70, on_air=40)
for k, v in (('teamA', 'Nova'), ('teamB', 'Vortex'), ('mapsA', '1'), ('mapsB', '0'), ('map', 'Map 2 · Inferno')):
    mh.field(k, k[0].upper() + k[1:], v, kind='number' if k.startswith('maps') else 'text', **({'min': 0, 'max': 3} if k.startswith('maps') else {}))
g = mh.group('Header', 560, 30, 800, 110, tracks=slide('y', -120, 30, 40, 14))
mh.rect('Plate', 0, 0, 800, 80, INK, g, radius=10)
mh.rect('A', 0, 0, 300, 80, hexc('7c3aed'), g, radius=10)
mh.rect('B', 500, 0, 300, 80, hexc('0891b2'), g, radius=10)
mh.text('Team A', '{{teamA}}', 20, 0, 270, 80, 38, g, weight=800, transform='upper')
mh.text('Score', '{{mapsA}}  :  {{mapsB}}', 300, 0, 200, 80, 40, g, align='center', weight=800)
mh.text('Team B', '{{teamB}}', 510, 0, 270, 80, 38, g, weight=800, align='right', transform='upper')
mh.text('Map', '{{map}}', 0, 80, 800, 30, 22, g, align='center', weight=600, color=hexc('c7d2fe'))
pc = T('player', 'Player card', 'lower', duration=80, on_air=50)
pc.field('player', 'Player', 'ZyWoo')
pc.field('kills', 'Kills', '24', kind='number', min=0, max=60)
pc.field('adr', 'ADR', '96.4', kind='number', min=0, max=200)
pc.field('mvp', 'MVP', 'true', kind='boolean')
g = pc.group('Card', 120, 760, 760, 220, clip=True, tracks=wipe(50))
pc.rect('Plate', 0, 0, 760, 220, hexc('140c2e', 0.95), g, radius=16)
pc.text('Player', '{{player}}', 40, 20, 500, 80, 54, g, weight=900)
f, p = pc.font(40, weight=800, color=hexc('c4b5fd'))
pc.widget('counter', 'Kills', 40, 110, 300, 80, g, p, **{'from': '0', 'to': '{{kills}}', 'duration': 1.0, 'decimals': 0, 'prefix': '', 'suffix': ' kills', 'grouping': False}, **f)
pc.widget('counter', 'ADR', 360, 110, 300, 80, g, p, **{'from': '0', 'to': '{{adr}}', 'duration': 1.0, 'decimals': 1, 'prefix': 'ADR ', 'suffix': '', 'grouping': False}, **f)
mvp = pc.group('MVP', 560, 24, 170, 60, g, bindings={'opacity': 'mvp'})
pc.rect('MVP plate', 0, 0, 170, 60, AMBER, mvp, radius=30)
pc.text('MVP text', 'MVP', 0, 0, 170, 60, 30, mvp, align='center', color=hexc('241500'), weight=900)
pl = T('poll', 'Viewer poll', 'full', duration=90, on_air=60)
pl.field('question', 'Question', 'Who takes map 3?')
pl.field('answers', 'Answers', 'Nova: 61\nVortex: 39', kind='multiline')
g = pl.group('Poll', 460, 260, 1000, 540, tracks=fade(60))
pl.rect('Panel', 0, 0, 1000, 540, hexc('140c2e', 0.94), g, radius=22)
pl.text('Question', '{{question}}', 50, 30, 900, 90, 48, g, weight=800)
f, p = pl.font(34, weight=700)
pl.widget('barChart', 'Answers', 50, 150, 900, 330, g, dict(p, fill=hexc('8b5cf6')), text='{{answers}}', percent=True, duration=1.4, track='#ffffff1a', textColor='#ffffff', **f)
br2 = T('break', 'Break countdown', 'full', duration=80, on_air=50)
br2.field('label', 'Label', 'Back in')
br2.field('minutes', 'Minutes', '5:00')
g = br2.group('Break', 0, 0, 1920, 1080, tracks=fade(50))
br2.rect('Background', 0, 0, 1920, 1080, hexc('0c0718'), g)
br2.text('Label', '{{label}}', 0, 380, 1920, 100, 60, g, align='center', weight=700, transform='upper')
f, p = br2.font(180, 'center', 900)
br2.widget('clock', 'Timer', 0, 480, 1920, 220, g, p, mode='timer', format='m:ss', timezone='', target='{{minutes}}', **f)
cr = T('credits', 'Credits', 'full', duration=60, on_air=30)
cr.field('credits', 'Credits', 'PULSE CUP 2026\n\nCasters\nAnna · Ben\n\nObservers\nChloe · Dan\n\nThanks for watching', kind='multiline')
f, p = cr.font(44, 'center', 600)
cr.rect('Background', 0, 0, 1920, 1080, hexc('0c0718', 0.9), tracks=fade(30))
cr.layer('text', 'Roll', None, {'x': 460, 'y': 0, 'width': 1000, 'height': 1080, **p}, text='{{credits}}', scroll='vertical', speed=80.0, **dict(f, verticalAlign='top'))
demos.append(project(
    'demo-09-esports', '09 · Esports tournament', 'Match header, player cards with counters and an MVP badge (boolean), a viewer poll, a break timer and the end credits roll. Several playlists for the phases of the show.',
    4, ['Esports', 'Counters', 'Boolean', 'Poll', 'Timer', 'Credits'],
    [mh.done(), pc.done(), pl.done(), br2.done(), cr.done()],
    [zone('top', 'Top', 30, '#22c55e', (0.29, 0.02, 0.42, 0.11)), LOWER, FULL],
    [('pre', 'Pre-show'), ('live', 'Live'), ('post', 'Post-show')],
    [item('Break 5 min', 'break', 'full', 'pre', {}, 0), item('Nova vs Vortex', 'match', 'top', 'live', {}, 0), item('ZyWoo', 'player', 'lower', 'live', {}, 0),
     item('Poll map 3', 'poll', 'full', 'live', {}, 0), item('Credits', 'credits', 'full', 'post', {}, 0)],
))

# ---------------------------------------- 10. Multi-format social live --
VERT = {'id': 'vertical', 'name': '9:16', 'width': 1080, 'height': 1920}
lt = T('social-lt', 'Speaker', 'lower', duration=80, on_air=50)
lt.field('name', 'Name', 'Alex Martin')
lt.field('topic', 'Topic', 'Live from the Pulse summit')
lt.field('accent', 'Accent', '#ff3b5c', kind='color')
g = lt.group('Speaker', 120, 800, 1100, 170, clip=True, tracks=wipe(50))
lt.t['layers'][-1]['overrides'] = {'vertical': {'props': {'x': 60.0, 'y': 1420.0, 'width': 960.0, 'height': 220.0}}}
lt.rect('Accent', 0, 0, 14, 170, ACCENT, g, bindings={'fill': 'accent'})
lt.rect('Plate', 14, 0, 1086, 170, INK, g)
lt.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 946.0, 'height': 220.0}}}
lt.text('Name', '{{name}}', 50, 10, 1030, 90, 58, g)
lt.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 880.0, 'fontSize': 64.0}}}
lt.text('Topic', '{{topic}}', 50, 100, 1030, 60, 30, g, weight=500, wrap=True)
lt.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 880.0, 'height': 110.0, 'fontSize': 38.0}}}
cap = T('caption', 'Caption', 'caption', duration=60, on_air=30)
cap.field('text', 'Caption', 'Tap the link in bio to join the live Q&A', kind='multiline')
g = cap.group('Caption', 360, 60, 1200, 120, tracks=fade(30))
cap.t['layers'][-1]['overrides'] = {'vertical': {'props': {'x': 60.0, 'y': 220.0, 'width': 960.0, 'height': 220.0}}}
cap.rect('Plate', 0, 0, 1200, 120, hexc('ffffff', 0.94), g, radius=20)
cap.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 960.0, 'height': 220.0}}}
cap.text('Text', '{{text}}', 30, 0, 1140, 120, 36, g, color=hexc('0b0d17'), align='center', wrap=True)
cap.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 900.0, 'height': 220.0, 'fontSize': 46.0}}}
ac = T('social-clock', 'Studio clock', 'clockz', duration=60, on_air=30)
ac.widget('analogClock', 'Clock', 1700, 60, 160, 160, None, {'fill': INK, 'stroke': WHITE}, tracks=fade(30), timezone='', seconds=True, accent='#ff3b5c')
ac.t['layers'][-1]['overrides'] = {'vertical': {'props': {'x': 880.0, 'y': 40.0, 'width': 160.0, 'height': 160.0}}}
sl = T('sponsors', 'Sponsors', 'sponsors', duration=60, on_air=30)
sl.field('sponsors', 'Sponsors', 'Pulse CG\nYour brand here\nThanks to our partners', kind='multiline')
g = sl.group('Sponsors', 1260, 900, 600, 100, tracks=fade(30))
sl.t['layers'][-1]['overrides'] = {'vertical': {'props': {'x': 140.0, 'y': 1700.0, 'width': 800.0, 'height': 110.0}}}
sl.rect('Plate', 0, 0, 600, 100, VIOLET, g, radius=50)
sl.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 800.0, 'height': 110.0}}}
f, p = sl.font(34, 'center', 700)
sl.widget('rotator', 'Names', 0, 0, 600, 100, g, p, text='{{sponsors}}', interval=2.5, fade=0.4, **f)
sl.t['layers'][-1]['overrides'] = {'vertical': {'props': {'width': 800.0, 'height': 110.0}}}
demos.append(project(
    'demo-10-social-live', '10 · Multi-format social live', 'One take drives the TV picture (16:9) and a vertical one (9:16) for social networks: every template has its own layout in each format. Accent colour variable, wrapping text, studio clock, rotating sponsors, guides and an area kept clear for the platform\'s buttons.',
    5, ['Multi-format', '9:16', 'Social', 'Overrides', 'Analog clock', 'Guides'],
    [lt.done(), cap.done(), ac.done(), sl.done()],
    [
        zone('lower', 'Lower third', 10, '#7c5cff', (0.04, 0.68, 0.66, 0.28), vertical=(0.04, 0.72, 0.92, 0.15)),
        zone('caption', 'Caption', 20, '#38bdf8', (0.18, 0.05, 0.64, 0.12), vertical=(0.04, 0.1, 0.92, 0.13)),
        zone('clockz', 'Clock', 60, '#22c55e', (0.88, 0.05, 0.09, 0.16), vertical=(0.8, 0.015, 0.18, 0.1)),
        zone('sponsors', 'Sponsors', 25, '#f5a524', (0.65, 0.82, 0.32, 0.11), vertical=(0.1, 0.87, 0.8, 0.08)),
    ],
    [('live', 'Live')],
    [item('Alex Martin', 'social-lt', 'lower', 'live', {}, 0), item('Q&A caption', 'caption', 'caption', 'live', {}, 0), item('Clock', 'social-clock', 'clockz', 'live', {}, 0), item('Sponsors', 'sponsors', 'sponsors', 'live', {}, 0)],
    formats=[VERT],
    guides={'vertical': [0.5], 'horizontal': [0.5], 'actionSafe': 0.05, 'titleSafe': 0.1, 'exclusions': [{'id': 'ui', 'name': 'Platform buttons (9:16)', 'x': 0.86, 'y': 0.55, 'width': 0.12, 'height': 0.35}]},
))


# ------------------------------------------------ design: staggered motion --


def stagger(prop, rest, start, delay, on_air, length=16, out_delay=0, ein='back', eout='easeIn'):
    """`prop` from `start` to `rest` at `delay`, back to `start` after the on-air point."""
    return {prop: keys((0, start, 'hold'), (delay, start, ein), (delay + length, rest, 'linear'), (on_air + out_delay, rest, eout), (on_air + out_delay + length * 0.7, start, 'linear'))}


def merge(*tracks):
    out = {}
    for t in tracks:
        out.update(t)
    return out


# ---------------------------------------------- 11. League standings --
TEAMS = [
    ('PSG', '#1d4ed8', 31, 74, 'WWDWW'), ('Monaco', '#dc2626', 31, 64, 'WLWWD'), ('Marseille', '#38bdf8', 31, 61, 'WWLWW'),
    ('Lille', '#b91c1c', 31, 56, 'DWWLW'), ('Nice', '#111827', 31, 53, 'LWDWW'), ('Lyon', '#2563eb', 31, 52, 'WDLWL'),
    ('Lens', '#facc15', 31, 49, 'DDWLW'), ('Rennes', '#ef4444', 31, 45, 'LWLDW'), ('Brest', '#e11d48', 31, 43, 'WLLDD'),
    ('Nantes', '#eab308', 31, 38, 'LDLWL'),
]
st = T('standings', 'League standings', 'full', duration=150, on_air=110)
st.field('title', 'Title', 'Ligue 1 · Matchday 31')
st.field('highlight', 'Highlighted position', '3', kind='number', min=1, max=10)
for i, (name, col, played, pts, form) in enumerate(TEAMS, 1):
    st.field(f't{i}', f'#{i} team', name)
    st.field(f'p{i}', f'#{i} points', str(pts), kind='number', min=0, max=114)
board = st.group('Standings', 360, 90, 1200, 900, clip=True, tracks=stagger('opacity', 1, 0, 0, 110, 10, 20, 'easeOut'))
st.rect('Panel', 0, 0, 1200, 900, hexc('0a0f24', 0.94), board, radius=22, tracks=merge(stagger('scaleY', 1, 0.2, 0, 110, 14, 20, 'easeOut')))
head = st.group('Header', 0, 0, 1200, 120, board, clip=True)
st.rect('Header band', 0, 0, 1200, 120, hexc('1d4ed8'), head, radius=22, tracks=stagger('cropRight', 0, 1, 4, 110, 18, 18, 'easeOut'))
st.text('Title', '{{title}}', 50, 0, 900, 120, 48, head, weight=800, tracks=stagger('x', 50, -700, 10, 110, 18, 16), transform='upper')
for x, label in ((870, 'PL'), (990, 'PTS'), (1090, 'FORM')):
    st.text(label, label, x - 20, 0, 140, 120, 22, head, weight=700, align='center', color=hexc('bfdbfe'), tracks=stagger('opacity', 1, 0, 22, 110, 10, 10, 'easeOut'))
ROW, TOP = 74, 130
# Highlight bar (logic: its y follows the highlighted position).
hl = st.rect('Highlight', 20, TOP, 1160, ROW - 6, hexc('facc15', 0.22), board, radius=12, tracks=stagger('opacity', 1, 0, 60, 110, 12, 4, 'easeOut'))
for i, (name, col, played, pts, form) in enumerate(TEAMS, 1):
    d = 14 + i * 4
    row = st.group(f'Row {i}', 20, TOP + (i - 1) * ROW, 1160, ROW - 6, board, clip=True, tracks=merge(stagger('x', 20, 1260, d, 110, 18, (10 - i) * 1.5)))
    st.rect('Row plate', 0, 0, 1160, ROW - 6, hexc('ffffff', 0.05 if i % 2 else 0.09), row, radius=12)
    st.rect('Rank', 0, 0, 70, ROW - 6, hexc('1d4ed8') if i <= 3 else hexc('334155'), row, radius=12)
    st.text('Rank n', str(i), 0, 0, 70, ROW - 6, 32, row, align='center', weight=900)
    st.rect('Colour', 84, 14, 8, ROW - 34, hexc(col.lstrip('#')), row, radius=4, tracks=stagger('scaleY', 1, 0, d + 10, 110, 10))
    st.text('Team', '{{t%d}}' % i, 110, 0, 600, ROW - 6, 34, row, weight=700)
    st.text('Played', str(played), 850, 0, 100, ROW - 6, 30, row, align='center', weight=500, color=hexc('cbd5e1'))
    f, p = st.font(34, 'center', 900)
    st.widget('counter', 'Points', 920, 0, 140, ROW - 6, row, p, **{'from': '0', 'to': '{{p%d}}' % i, 'duration': 1.4, 'decimals': 0, 'prefix': '', 'suffix': '', 'grouping': False}, **f)
    for k, r in enumerate(form):
        c = {'W': GREEN, 'D': hexc('94a3b8'), 'L': ACCENT}[r]
        st.ellipse(f'Form {k + 1}', 1075 + k * 16, (ROW - 6) / 2 - 6, 12, 12, c, row, tracks=stagger('opacity', 1, 0, d + 18 + k * 2, 110, 6))
st.logic(
    [
        {'id': 'pos', 'type': 'field', 'key': 'highlight', 'x': 60, 'y': 80},
        {'id': 'one', 'type': 'constant', 'value': 1, 'x': 60, 'y': 200},
        {'id': 'idx', 'type': 'math', 'op': 'sub', 'x': 320, 'y': 100},
        {'id': 'row', 'type': 'constant', 'value': ROW, 'x': 320, 'y': 240},
        {'id': 'off', 'type': 'math', 'op': 'mul', 'x': 580, 'y': 120},
        {'id': 'top', 'type': 'constant', 'value': TOP, 'x': 580, 'y': 260},
        {'id': 'y', 'type': 'math', 'op': 'add', 'x': 840, 'y': 140},
        {'id': 'set', 'type': 'target', 'layer': hl, 'prop': 'y', 'mode': 'set', 'x': 1100, 'y': 140},
    ],
    [{'from': 'pos', 'to': 'idx', 'port': 'a'}, {'from': 'one', 'to': 'idx', 'port': 'b'}, {'from': 'idx', 'to': 'off', 'port': 'a'}, {'from': 'row', 'to': 'off', 'port': 'b'},
     {'from': 'off', 'to': 'y', 'port': 'a'}, {'from': 'top', 'to': 'y', 'port': 'b'}, {'from': 'y', 'to': 'set', 'port': 'in'}],
)
demos.append(project(
    'demo-11-standings', '11 · League standings', 'A designed league table: the panel unfolds, the header wipes in, the ten rows fly in one after the other, the points count up and the form dots pop in; the rows leave in reverse order. A highlight bar moves to the position you choose (logic: (position − 1) × row height + top).',
    4, ['Sport', 'Table', 'Stagger', 'Counters', 'Logic'],
    [st.done()], [FULL], [('show', 'Show')],
    [item('Standings matchday 31', 'standings', 'full', 'show', {}, 0), item('Standings · Marseille', 'standings', 'full', 'show', {'highlight': '3'}, 0), item('Standings · Lyon', 'standings', 'full', 'show', {'highlight': '6'}, 0)],
))

# ----------------------------------------------------- 12. Live poll --
pq = T('poll', 'Live poll', 'full', duration=170, on_air=130)
pq.field('question', 'Question', 'Who will win the final?')
pq.field('total', 'Total votes', '48213', kind='number')
ANS = [('A', 'Team Nova', '46', '#8b5cf6'), ('B', 'Team Vortex', '31', '#06b6d4'), ('C', 'Draw', '15', '#f59e0b'), ('D', 'No idea', '8', '#64748b')]
for k, label, pc, col in ANS:
    pq.field(f'a{k}', f'Answer {k}', label)
    pq.field(f'v{k}', f'Answer {k} %', pc, kind='number', min=0, max=100)
pq.pause(70, 'Votes open', {'type': 'trigger', 'name': 'results'})
bg = pq.group('Background', 0, 0, 1920, 1080, tracks=stagger('opacity', 1, 0, 0, 130, 14, 26, 'easeOut'))
pq.rect('Dim', 0, 0, 1920, 1080, hexc('05040f', 0.7), bg)
pq.ellipse('Glow 1', 1180, -220, 900, 900, hexc('7c3aed', 0.35), bg, tracks={'rotation': keys((0, 0, 'linear'), (170, 40, 'linear')), 'scaleX': keys((0, 0.6, 'easeOut'), (40, 1, 'linear')), 'scaleY': keys((0, 0.6, 'easeOut'), (40, 1, 'linear'))})
pq.ellipse('Glow 2', -260, 520, 800, 800, hexc('06b6d4', 0.25), bg, tracks={'scaleX': keys((0, 0.5, 'easeOut'), (50, 1, 'linear')), 'scaleY': keys((0, 0.5, 'easeOut'), (50, 1, 'linear'))})
card = pq.group('Card', 360, 140, 1200, 800, clip=True, tracks=merge(stagger('y', 140, 1100, 6, 130, 22, 10), stagger('rotation', 0, 6, 6, 130, 22, 10)))
pq.rect('Card plate', 0, 0, 1200, 800, hexc('0f0b24', 0.96), card, radius=32)
pq.rect('Top line', 0, 0, 1200, 10, hexc('8b5cf6'), card, radius=5, tracks=stagger('cropRight', 0, 1, 20, 130, 20))
pq.widget('typewriter', 'Question', 70, 40, 1060, 120, card, {'fontSize': 56.0, 'fill': WHITE}, text='{{question}}', speed=28.0, cursor=False, fontFamily='Inter', fontWeight=800, align='left', verticalAlign='middle', uppercase=False)
LIVE_Y = 170
pq.rect('Live dot', 70, LIVE_Y + 10, 16, 16, ACCENT, card, radius=8, tracks={'opacity': keys((0, 0, 'hold'), (40, 1, 'linear'), (55, 0.2, 'linear'), (70, 1, 'linear'), (85, 0.2, 'linear'), (100, 1, 'linear'))})
f, p = pq.font(26, 'left', 600, hexc('c4b5fd'))
pq.widget('counter', 'Votes', 100, LIVE_Y, 600, 36, card, p, **{'from': '0', 'to': '{{total}}', 'duration': 3.0, 'decimals': 0, 'prefix': 'LIVE · ', 'suffix': ' votes', 'grouping': True}, **f)
for i, (k, label, pc, col) in enumerate(ANS):
    y = 240 + i * 130
    d = 40 + i * 6
    ans = pq.group(f'Answer {k}', 70, y, 1060, 110, card, tracks=stagger('x', 70, -1200, d, 130, 18, (3 - i) * 3))
    pq.rect('Track', 0, 0, 1060, 110, hexc('ffffff', 0.06), ans, radius=20)
    # The bar fills to its share once the results are revealed (after the "results" trigger).
    pq.widget('progress', 'Bar', 0, 0, 1060, 110, ans, {'fill': hexc(col.lstrip('#'), 0.85), 'cornerRadius': 20.0}, value='{{v%s}}' % k, max='100', duration=1.6, track='#00000000',
              tracks={'opacity': keys((0, 0, 'hold'), (72, 0, 'linear'), (78, 1, 'linear'))})
    pq.rect('Letter', 16, 16, 78, 78, hexc(col.lstrip('#')), ans, radius=18, tracks=stagger('scaleX', 1, 0, d + 10, 130, 12))
    pq.text('Letter text', k, 16, 16, 78, 78, 40, ans, align='center', weight=900)
    pq.text('Label', '{{a%s}}' % k, 120, 0, 700, 110, 40, ans, weight=700)
    f, p = pq.font(48, 'right', 900)
    pq.widget('counter', 'Percent', 760, 0, 270, 110, ans, dict(p, opacity=0.0), **{'from': '0', 'to': '{{v%s}}' % k, 'duration': 1.6, 'decimals': 0, 'prefix': '', 'suffix': ' %', 'grouping': False}, **f)
    pq.t['layers'][-1]['tracks'] = {'opacity': keys((0, 0, 'hold'), (72, 0, 'linear'), (80, 1, 'linear'))}
demos.append(project(
    'demo-12-live-poll', '12 · Live poll', 'A designed poll: glowing background, the card swings in, the question types itself, the answers slide in one by one while a live vote counter runs. On the trigger "results" the bars fill to their share and the percentages count up.',
    5, ['Poll', 'Stagger', 'Trigger', 'Typewriter', 'Progress', 'Counters'],
    [pq.done()], [FULL], [('show', 'Show')],
    [item('Final poll', 'poll', 'full', 'show', {}, 0)],
))

# ------------------------------------------- 13. Election hemicycle --
import math
PARTIES = [('Left', '#e11d48', 162), ('Greens', '#16a34a', 48), ('Centre', '#f59e0b', 171), ('Right', '#2563eb', 62), ('Far right', '#1e3a8a', 134)]
TOTAL = sum(n for _, _, n in PARTIES)
hc = T('hemicycle', 'Seats', 'full', duration=180, on_air=140)
hc.field('title', 'Title', 'National Assembly · Projection')
for i, (name, col, n) in enumerate(PARTIES):
    hc.field(f'n{i}', name, name)
    hc.field(f's{i}', f'{name} seats', str(n), kind='number', min=0, max=TOTAL)
panel = hc.group('Results', 160, 80, 1600, 920, clip=True, tracks=stagger('opacity', 1, 0, 0, 140, 12, 30, 'easeOut'))
hc.rect('Panel', 0, 0, 1600, 920, hexc('0b1020', 0.95), panel, radius=26)
hc.text('Title', '{{title}}', 60, 20, 1480, 100, 50, panel, weight=800, tracks=stagger('opacity', 1, 0, 6, 140, 14))
hc.text('Majority', f'Majority: {TOTAL // 2 + 1} seats', 60, 100, 1480, 50, 26, panel, weight=600, color=hexc('94a3b8'), tracks=stagger('opacity', 1, 0, 14, 140, 14))
# Seats in rows of a half circle; each seat pops in, left to right.
cx, cy = 800, 700
rows = [(260 + r * 34, 0) for r in range(9)]
counts = []
remaining = 120  # dots drawn (one per ~5 seats)
radii = [260 + r * 34 for r in range(9)]
total_len = sum(radii)
per_row = [round(120 * r / total_len) for r in radii]
dots = []
for r, n in zip(radii, per_row):
    for j in range(n):
        a = math.pi * (1 - j / max(1, n - 1))
        dots.append((a, cx + r * math.cos(a), cy - r * math.sin(a)))
dots.sort(key=lambda d: -d[0])  # left to right
bounds, acc = [], 0
for _, col, n in PARTIES:
    acc += n
    bounds.append((acc / TOTAL * len(dots), col))
for i, (a, x, y) in enumerate(dots):
    col = next(c for b, c in bounds if i < b)
    hc.ellipse(f'Seat {i + 1}', x - 12, y - 12, 24, 24, hexc(col.lstrip('#')), panel,
               tracks=merge(stagger('scaleX', 1, 0, 20 + i * 0.5, 140, 8, i * 0.15), stagger('scaleY', 1, 0, 20 + i * 0.5, 140, 8, i * 0.15)))
hc.rect('Majority line', cx - 2, cy - 600, 4, 600, hexc('ffffff', 0.5), panel, tracks=stagger('scaleY', 1, 0, 90, 140, 16))
# Party legend with counters.
for i, (name, col, n) in enumerate(PARTIES):
    x = 60 + i * 300
    lg = hc.group(f'Legend {name}', x, 760, 280, 130, panel, tracks=stagger('y', 760, 960, 80 + i * 5, 140, 16, (4 - i) * 2))
    hc.rect('Swatch', 0, 0, 280, 8, hexc(col.lstrip('#')), lg, radius=4)
    hc.text('Party', '{{n%d}}' % i, 0, 14, 280, 44, 28, lg, weight=700)
    f, p = hc.font(52, 'left', 900, hexc(col.lstrip('#')) if col not in ('#1e3a8a',) else hexc('93c5fd'))
    hc.widget('counter', 'Seats', 0, 56, 280, 70, lg, p, **{'from': '0', 'to': '{{s%d}}' % i, 'duration': 1.8, 'decimals': 0, 'prefix': '', 'suffix': '', 'grouping': False}, **f)
hc.pause(110, 'Projection shown', {'type': 'manual'})
demos.append(project(
    'demo-13-election-seats', '13 · Election: seats', 'A designed seat projection: ' + str(len(dots)) + ' seats of a half circle pop in one after the other in the colours of the parties, the majority line rises, and the legend slides up with the seat counters. Holds until Continue, then the seats leave in a wave.',
    5, ['Elections', 'Hemicycle', 'Stagger', 'Counters', 'Pause'],
    [hc.done()], [FULL], [('night', 'Election night')],
    [item('Seats projection', 'hemicycle', 'full', 'night', {}, 0)],
))

os.makedirs(OUT, exist_ok=True)
for old in os.listdir(OUT):
    if old.endswith('.json') or old == 'index.rs':
        os.remove(os.path.join(OUT, old))
for d in demos:
    with open(os.path.join(OUT, d['demo']['id'] + '.json'), 'w') as fh:
        json.dump(d, fh, ensure_ascii=False, indent=1)
# The list the server embeds (crates/cg-server/src/demos.rs includes it).
with open(os.path.join(OUT, 'index.rs'), 'w') as fh:
    fh.write('// Generated by tools/demos/build.py.\n&[\n')
    for d in demos:
        fh.write(f'    include_str!("{d["demo"]["id"]}.json"),\n')
    fh.write(']\n')
print(f'{len(demos)} demo projects written to {os.path.normpath(OUT)}')
