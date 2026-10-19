//! QR code: settings, payload, geometry (crisp integer modules) and the
//! logo budget. The matrix itself comes from ONE encoder, the `qrcode` crate
//! (`cg-render/src/wid/qrcode.rs`, served to the web by `GET /api/qr`), so
//! both renderers draw the same code; this module only knows the structure
//! of a QR symbol (function patterns, codeword placement, RS blocks) to say
//! which codewords a centre logo hides.
//! Drawn by `cg-render/src/wid/qrcode.rs` and `web/src/widgets/qrcode.tsx` (keep in sync).

use serde::{Deserialize, Serialize};

use super::ActCtx;
use crate::anim::{interpolate_text, Data};
use crate::model::Layer;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// The layer's `data` as typed (old layers).
    #[default]
    Url,
    /// The layer's `data` too.
    Text,
    Vcard,
    Wifi,
    Email,
    Sms,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ecl {
    L,
    #[default]
    M,
    Q,
    H,
}

impl Ecl {
    pub fn ord(self) -> usize {
        match self {
            Ecl::L => 0,
            Ecl::M => 1,
            Ecl::Q => 2,
            Ecl::H => 3,
        }
    }
    /// Largest logo side, % of the code width.
    pub fn logo_max(self) -> u32 {
        [12, 18, 24, 30][self.ord()]
    }
    /// Format bits of the level.
    pub fn bits(self) -> u32 {
        [1, 0, 3, 2][self.ord()]
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModStyle {
    #[default]
    Square,
    Rounded,
    Dots,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FinderStyle {
    #[default]
    Square,
    Rounded,
    Circle,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Vcard {
    pub first: String,
    pub last: String,
    pub org: String,
    pub title: String,
    pub phone: String,
    pub email: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum WifiSec {
    #[default]
    WPA,
    WEP,
    #[serde(rename = "nopass")]
    Nopass,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Wifi {
    pub ssid: String,
    pub password: String,
    pub security: WifiSec,
    pub hidden: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Sms {
    pub number: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Logo {
    pub on: bool,
    /// Picture (asset path); empty = a play sign in `color`.
    pub src: String,
    /// Asked size, % of the code width (capped by the correction).
    pub size: u32,
    pub color: String,
}

impl Default for Logo {
    fn default() -> Self {
        Self {
            on: false,
            src: String::new(),
            size: 22,
            color: "#7c5cff".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Label {
    pub on: bool,
    pub text: String,
    pub size: f32,
    pub color: String,
    pub bg: String,
}

impl Default for Label {
    fn default() -> Self {
        Self {
            on: false,
            text: "Scan to vote".into(),
            size: 34.0,
            color: "#ffffff".into(),
            bg: "#7c5cff".into(),
        }
    }
}

/// Settings of the widget, flattened into the layer's JSON. The content of
/// URL / text is the layer's `data`, the modules use the `fill` colour and
/// the card the layer's `background`: an old layer (data + background +
/// fill) keeps its look.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub kind: Kind,
    pub vcard: Vcard,
    pub wifi: Wifi,
    pub email: Email,
    pub sms: Sms,
    pub ecl: Ecl,
    pub transparent: bool,
    /// Transparent background: the colour assumed behind (readability check).
    pub backdrop: String,
    /// Card corners, px.
    pub radius: f32,
    pub mod_style: ModStyle,
    pub finder_style: FinderStyle,
    pub finder_same: bool,
    pub finder_color: String,
    pub logo: Logo,
    /// Quiet zone, modules.
    pub quiet: u32,
    /// Smallest module on screen before the check fails, px.
    pub min_px: u32,
    pub label: Label,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            kind: Kind::Url,
            vcard: Vcard::default(),
            wifi: Wifi::default(),
            email: Email::default(),
            sms: Sms::default(),
            ecl: Ecl::M,
            transparent: false,
            backdrop: "#12151e".into(),
            radius: 0.0,
            mod_style: ModStyle::Square,
            finder_style: FinderStyle::Square,
            finder_same: true,
            finder_color: "#7c5cff".into(),
            logo: Logo::default(),
            quiet: 4,
            min_px: 6,
            label: Label::default(),
        }
    }
}

/// No operator state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {}

pub fn act(
    _layer: &Layer,
    _st: &mut State,
    op: &str,
    _args: &serde_json::Value,
    _ctx: &ActCtx,
) -> Result<(), String> {
    Err(format!("unknown action `{op}`"))
}

// ---------------------------------------------------------------- payload --

/// JavaScript's encodeURIComponent.
pub fn uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out += &format!("%{b:02X}");
        }
    }
    out
}

fn wifi_esc(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        if matches!(c, '\\' | ';' | ',' | ':' | '"') {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// The text encoded: `data` (URL / text) or built from the form.
pub fn payload(c: &Config, data_field: &str, data: &Data) -> String {
    let i = |s: &str| interpolate_text(s, data);
    match c.kind {
        Kind::Url | Kind::Text => i(data_field),
        Kind::Vcard => {
            let v = &c.vcard;
            let (first, last) = (i(&v.first), i(&v.last));
            let full: Vec<&str> = [first.as_str(), last.as_str()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect();
            let mut l = vec![
                "BEGIN:VCARD".to_string(),
                "VERSION:3.0".into(),
                format!("N:{last};{first}"),
                format!("FN:{}", full.join(" ")),
            ];
            for (k, val) in [
                ("ORG", &v.org),
                ("TITLE", &v.title),
                ("TEL;TYPE=CELL", &v.phone),
                ("EMAIL", &v.email),
                ("URL", &v.url),
            ] {
                let val = i(val);
                if !val.is_empty() {
                    l.push(format!("{k}:{val}"));
                }
            }
            l.push("END:VCARD".into());
            l.join("\n")
        }
        Kind::Wifi => {
            let w = &c.wifi;
            let sec = match w.security {
                WifiSec::WPA => "WPA",
                WifiSec::WEP => "WEP",
                WifiSec::Nopass => "nopass",
            };
            let pass = if w.security == WifiSec::Nopass {
                String::new()
            } else {
                format!("P:{};", wifi_esc(&i(&w.password)))
            };
            format!(
                "WIFI:T:{sec};S:{};{pass}{};",
                wifi_esc(&i(&w.ssid)),
                if w.hidden { "H:true;" } else { "" }
            )
        }
        Kind::Email => {
            let m = &c.email;
            let (sub, body) = (i(&m.subject), i(&m.body));
            let mut q = Vec::new();
            if !sub.is_empty() {
                q.push(format!("subject={}", uri_component(&sub)));
            }
            if !body.is_empty() {
                q.push(format!("body={}", uri_component(&body)));
            }
            format!(
                "mailto:{}{}",
                i(&m.to),
                if q.is_empty() {
                    String::new()
                } else {
                    format!("?{}", q.join("&"))
                }
            )
        }
        Kind::Sms => format!("SMSTO:{}:{}", i(&c.sms.number), i(&c.sms.message)),
    }
}

// ----------------------------------------------------------------- layout --

/// Geometry in the box: integer module size `m`, code `px` × `px` at (x0, y0).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geo {
    pub m: f32,
    pub px: f32,
    pub x0: f32,
    pub y0: f32,
    /// Label pill height (0 = none) and top.
    pub lab: f32,
    pub lab_y: f32,
}

pub fn round_js(v: f32) -> f32 {
    (v + 0.5).floor()
}

pub fn geo(c: &Config, label_text: &str, n: usize, w: f32, h: f32) -> Geo {
    let lab = if c.label.on && !label_text.is_empty() {
        round_js(c.label.size * 1.9)
    } else {
        0.0
    };
    let gap = if lab > 0.0 { 18.0 } else { 0.0 };
    let total = (n as u32 + 2 * c.quiet) as f32;
    let avail = w.min(h - lab - gap);
    let m = (avail / total).floor().max(1.0);
    let px = m * total;
    let x0 = round_js((w - px) / 2.0);
    let y0 = round_js((h - lab - gap - px) / 2.0).max(0.0);
    Geo {
        m,
        px,
        x0,
        y0,
        lab,
        lab_y: y0 + px + gap,
    }
}

// -------------------------------------------------- structure of a symbol --

const ECC_PER_BLOCK: [[i32; 41]; 4] = [
    [
        -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28,
        30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    [
        -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28,
        28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    ],
    [
        -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30,
        30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
    [
        -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24,
        30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
    ],
];
const NUM_BLOCKS: [[i32; 41]; 4] = [
    [
        -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12,
        13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
    ],
    [
        -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21,
        23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
    ],
    [
        -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27,
        29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
    ],
    [
        -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32,
        35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
    ],
];

pub fn raw_modules(v: usize) -> usize {
    let mut r = (16 * v + 128) * v + 64;
    if v >= 2 {
        let na = v / 7 + 2;
        r -= (25 * na - 10) * na - 55;
        if v >= 7 {
            r -= 36;
        }
    }
    r
}

pub fn align_pos(v: usize) -> Vec<usize> {
    if v == 1 {
        return Vec::new();
    }
    let n = v / 7 + 2;
    let step = if v == 32 {
        26
    } else {
        (v * 4 + 4).div_ceil(n * 2 - 2) * 2
    };
    let mut r = vec![6];
    let mut p = v * 4 + 17 - 7;
    while r.len() < n {
        r.insert(1, p);
        p -= step;
    }
    r
}

/// Function modules, codeword of each data module and RS blocks of a version.
#[derive(Debug, Clone)]
pub struct Structure {
    pub size: usize,
    pub version: usize,
    /// True = finder, timing, alignment, format or version module.
    pub func: Vec<bool>,
    /// Codeword (interleaved order) of each module, -1 = none.
    pub cw: Vec<i32>,
    /// Block of each interleaved codeword.
    pub block_of: Vec<usize>,
    pub blocks: usize,
    pub ecc_len: usize,
}

pub fn structure(size: usize, ecl: Ecl) -> Option<Structure> {
    if size < 21 || !(size - 17).is_multiple_of(4) {
        return None;
    }
    let v = (size - 17) / 4;
    if v > 40 {
        return None;
    }
    let e = ecl.ord();
    let mut func = vec![false; size * size];
    let mut set = |x: usize, y: usize| func[y * size + x] = true;
    for i in 0..size {
        set(6, i);
        set(i, 6);
    }
    for (cx, cy) in [(3i32, 3i32), (size as i32 - 4, 3), (3, size as i32 - 4)] {
        for dy in -4..=4 {
            for dx in -4..=4 {
                let (x, y) = (cx + dx, cy + dy);
                if x >= 0 && y >= 0 && (x as usize) < size && (y as usize) < size {
                    set(x as usize, y as usize);
                }
            }
        }
    }
    let al = align_pos(v);
    let k = al.len();
    for (i, &ay) in al.iter().enumerate() {
        for (j, &ax) in al.iter().enumerate() {
            if (i == 0 && j == 0) || (i == 0 && j == k - 1) || (i == k - 1 && j == 0) {
                continue;
            }
            for dy in 0..5 {
                for dx in 0..5 {
                    set(ax + dx - 2, ay + dy - 2);
                }
            }
        }
    }
    // Format areas.
    for i in 0..9 {
        set(8, i);
        set(i, 8);
    }
    for i in 0..8 {
        set(size - 1 - i, 8);
        set(8, size - 1 - i);
    }
    if v >= 7 {
        for i in 0..18 {
            let (a, b) = (size - 11 + i % 3, i / 3);
            set(a, b);
            set(b, a);
        }
    }
    let raw = raw_modules(v) / 8;
    let nb = NUM_BLOCKS[e][v] as usize;
    let ecc_len = ECC_PER_BLOCK[e][v] as usize;
    let n_short = nb - raw % nb;
    let short_len = raw / nb;
    // Interleaving: codeword k of the stream comes from block `block_of[k]`.
    let mut block_of = Vec::with_capacity(raw);
    for i in 0..=short_len {
        for j in 0..nb {
            // Short blocks have no codeword at index short_len - ecc_len.
            if i != short_len - ecc_len || j >= n_short {
                block_of.push(j);
            }
        }
    }
    let mut cw = vec![-1; size * size];
    let mut bit = 0usize;
    let mut right = size as i32 - 1;
    while right >= 1 {
        if right == 6 {
            right = 5;
        }
        for vert in 0..size {
            for j in 0..2 {
                let x = (right - j) as usize;
                let up = ((right + 1) & 2) == 0;
                let y = if up { size - 1 - vert } else { vert };
                if !func[y * size + x] && bit < raw * 8 {
                    cw[y * size + x] = (bit >> 3) as i32;
                    bit += 1;
                }
            }
        }
        right -= 2;
    }
    Some(Structure {
        size,
        version: v,
        func,
        cw,
        block_of,
        blocks: nb,
        ecc_len,
    })
}

/// Modules hidden by a centred logo of `pct` % (plus a one-module plate):
/// (x, y, n) in modules, and the logo side in modules.
pub fn logo_rect(size: usize, pct: u32) -> Option<(usize, usize, usize, usize)> {
    if pct == 0 {
        return None;
    }
    let side = (size as f32 * pct as f32 / 100.0).ceil() as usize;
    let plate = (side + 2).min(size);
    let a = (size - plate) / 2;
    Some((a, a, plate, side))
}

/// Damage of a logo: (a function module is hit, worst block, codewords a block repairs, modules, codewords).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Damage {
    pub fn_hit: bool,
    pub worst: usize,
    pub cap: usize,
    pub modules: usize,
    pub cws: usize,
}

pub fn damage(s: &Structure, pct: u32) -> Damage {
    let mut d = Damage {
        cap: s.ecc_len / 2,
        ..Default::default()
    };
    let Some((x0, y0, n, _)) = logo_rect(s.size, pct) else {
        return d;
    };
    let mut hit = std::collections::BTreeSet::new();
    for y in y0..(y0 + n).min(s.size) {
        for x in x0..(x0 + n).min(s.size) {
            d.modules += 1;
            let k = y * s.size + x;
            if s.func[k] {
                d.fn_hit = true;
            } else if s.cw[k] >= 0 {
                hit.insert(s.cw[k] as usize);
            }
        }
    }
    let mut per = vec![0usize; s.blocks];
    for &i in &hit {
        if let Some(b) = s.block_of.get(i) {
            per[*b] += 1;
        }
    }
    d.worst = per.into_iter().max().unwrap_or(0);
    d.cws = hit.len();
    d
}

/// The logo size drawn (%): asked, capped by the level and by what every
/// block can repair (85 % of it); and why it was capped ("level", "budget").
pub fn logo_size(c: &Config, s: Option<&Structure>) -> (u32, &'static str) {
    let Some(s) = s else {
        return (0, "");
    };
    if !c.logo.on {
        return (0, "");
    }
    let mut pct = c.logo.size.min(c.ecl.logo_max());
    let mut by = if c.logo.size > c.ecl.logo_max() {
        "level"
    } else {
        ""
    };
    while pct > 0 {
        let d = damage(s, pct);
        if !d.fn_hit && d.worst <= d.cap * 85 / 100 {
            break;
        }
        pct -= 1;
        by = "budget";
    }
    (pct, by)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_layers_load() {
        let l: Layer = serde_json::from_str(
            r##"{"id":"a","name":"QR","type":"qrCode","data":"https://x.y","background":"#ffffff","props":{}}"##,
        )
        .unwrap();
        let crate::LayerKind::QrCode { x, data, .. } = l.kind else {
            panic!()
        };
        assert_eq!(x, Config::default());
        assert_eq!(payload(&x, &data, &Data::new()), "https://x.y");
    }

    #[test]
    fn payloads() {
        let mut c = Config {
            kind: Kind::Wifi,
            ..Default::default()
        };
        c.wifi.ssid = "My;Net".into();
        c.wifi.password = "p:w".into();
        assert_eq!(
            payload(&c, "", &Data::new()),
            "WIFI:T:WPA;S:My\\;Net;P:p\\:w;;"
        );
        c.kind = Kind::Email;
        c.email.to = "a@b.c".into();
        c.email.subject = "Hi there".into();
        assert_eq!(
            payload(&c, "", &Data::new()),
            "mailto:a@b.c?subject=Hi%20there"
        );
        c.kind = Kind::Sms;
        c.sms.number = "+33".into();
        c.sms.message = "VOTE 7".into();
        assert_eq!(payload(&c, "", &Data::new()), "SMSTO:+33:VOTE 7");
    }

    #[test]
    fn crisp_geometry() {
        let c = Config {
            quiet: 4,
            ..Default::default()
        };
        let g = geo(&c, "", 25, 517.0, 633.0);
        assert_eq!(g.m, (517.0f32 / 33.0).floor());
        assert_eq!(g.x0.fract(), 0.0);
        assert_eq!(g.y0.fract(), 0.0);
    }

    #[test]
    fn structure_counts() {
        for v in [1usize, 2, 7, 10, 40] {
            for e in [Ecl::L, Ecl::M, Ecl::Q, Ecl::H] {
                let s = structure(17 + 4 * v, e).unwrap();
                let data_modules = s.func.iter().filter(|f| !**f).count();
                assert_eq!(data_modules, raw_modules(v), "v{v}");
                assert_eq!(s.block_of.len(), raw_modules(v) / 8);
            }
        }
    }

    #[test]
    fn logo_is_capped() {
        let s = structure(29, Ecl::M).unwrap();
        let c = Config {
            logo: Logo {
                on: true,
                size: 40,
                ..Default::default()
            },
            ..Default::default()
        };
        let (pct, by) = logo_size(&c, Some(&s));
        assert!(pct <= 18 && !by.is_empty());
        let s = structure(33, Ecl::H).unwrap();
        let c = Config {
            ecl: Ecl::H,
            logo: Logo {
                on: true,
                size: 22,
                ..Default::default()
            },
            ..Default::default()
        };
        let (pct, _) = logo_size(&c, Some(&s));
        assert!(pct > 10);
    }
}
