//! The expressions of the Logic canvas: a Calculation (`a + b`,
//! `format(a, 1) & " %"`), the conditions of an If (`a > b et c = "OUI"`)
//! and its values. Same syntax and results in the web renderer
//! (`web/src/engine/expr.ts`).
//!
//! Numbers (`12.5`), texts (`"…"`, `'…'`, `«…»`), `vrai` / `faux`, the
//! node's inputs by name, `+ - * / % ^`, `&` (joins texts), comparisons
//! (`= != < <= > >=`, also `== <> ≠ ≤ ≥`), `et` / `ou` / `non` (also
//! `and or not && || !`), brackets and functions (French or English
//! names, see [`call`]).

use super::LVal;

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Text(String),
    Name(String),
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Bin(Op, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
    Join,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Text(String),
    Name(String),
    Op(&'static str),
    Open,
    Close,
    Comma,
}

fn lex(s: &str) -> Result<Vec<Tok>, String> {
    let c: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && c.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            while i < c.len() && (c[i].is_ascii_digit() || c[i] == '.') {
                i += 1;
            }
            let t: String = c[start..i].iter().collect();
            out.push(Tok::Num(t.parse().map_err(|_| format!("nombre « {t} »"))?));
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '«' || ch == '“' {
            let end = match ch {
                '«' => '»',
                '“' => '”',
                q => q,
            };
            let start = i + 1;
            i += 1;
            while i < c.len() && c[i] != end {
                i += 1;
            }
            if i >= c.len() {
                return Err("texte non fermé".into());
            }
            let t: String = c[start..i].iter().collect();
            // « OUI » : the spaces inside French quotes are not part of the text.
            out.push(Tok::Text(if ch == '«' { t.trim().to_string() } else { t }));
            i += 1;
            continue;
        }
        if ch.is_alphabetic() || ch == '_' {
            let start = i;
            while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_') {
                i += 1;
            }
            let w: String = c[start..i].iter().collect();
            match fold(&w).as_str() {
                "et" | "and" => out.push(Tok::Op("et")),
                "ou" | "or" => out.push(Tok::Op("ou")),
                "non" | "not" => out.push(Tok::Op("non")),
                _ => out.push(Tok::Name(w)),
            }
            continue;
        }
        let two: String = c[i..(i + 2).min(c.len())].iter().collect();
        let op2 = match two.as_str() {
            "==" => Some("="),
            "!=" | "<>" => Some("!="),
            "<=" => Some("<="),
            ">=" => Some(">="),
            "&&" => Some("et"),
            "||" => Some("ou"),
            _ => None,
        };
        if let Some(o) = op2 {
            out.push(Tok::Op(o));
            i += 2;
            continue;
        }
        let op1 = match ch {
            '+' => "+",
            '-' | '−' => "-",
            '*' | '×' => "*",
            '/' | '÷' => "/",
            '%' => "%",
            '^' => "^",
            '&' => "&",
            '=' => "=",
            '≠' => "!=",
            '<' => "<",
            '>' => ">",
            '≤' => "<=",
            '≥' => ">=",
            '!' => "non",
            '(' => {
                out.push(Tok::Open);
                i += 1;
                continue;
            }
            ')' => {
                out.push(Tok::Close);
                i += 1;
                continue;
            }
            ',' | ';' => {
                out.push(Tok::Comma);
                i += 1;
                continue;
            }
            other => return Err(format!("caractère « {other} »")),
        };
        out.push(Tok::Op(op1));
        i += 1;
    }
    Ok(out)
}

/// A name in lower case without accents (« Arrondi » = « arrondi »).
pub fn fold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' | 'À' | 'Â' | 'Ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'î' | 'ï' | 'Î' | 'Ï' => 'i',
            'ô' | 'ö' | 'Ô' | 'Ö' => 'o',
            'ù' | 'û' | 'ü' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

struct P {
    t: Vec<Tok>,
    i: usize,
}

impl P {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }
    fn op(&mut self, ops: &[&str]) -> Option<&'static str> {
        match self.peek() {
            Some(Tok::Op(o)) if ops.contains(o) => {
                let o = *o;
                self.i += 1;
                Some(o)
            }
            _ => None,
        }
    }
    fn or(&mut self) -> Result<Expr, String> {
        let mut a = self.and()?;
        while self.op(&["ou"]).is_some() {
            a = Expr::Bin(Op::Or, Box::new(a), Box::new(self.and()?));
        }
        Ok(a)
    }
    fn and(&mut self) -> Result<Expr, String> {
        let mut a = self.not()?;
        while self.op(&["et"]).is_some() {
            a = Expr::Bin(Op::And, Box::new(a), Box::new(self.not()?));
        }
        Ok(a)
    }
    fn not(&mut self) -> Result<Expr, String> {
        if self.op(&["non"]).is_some() {
            return Ok(Expr::Not(Box::new(self.not()?)));
        }
        self.cmp()
    }
    fn cmp(&mut self) -> Result<Expr, String> {
        let a = self.join()?;
        let op = match self.op(&["=", "!=", "<", "<=", ">", ">="]) {
            Some("=") => Op::Eq,
            Some("!=") => Op::Ne,
            Some("<") => Op::Lt,
            Some("<=") => Op::Le,
            Some(">") => Op::Gt,
            Some(">=") => Op::Ge,
            _ => return Ok(a),
        };
        Ok(Expr::Bin(op, Box::new(a), Box::new(self.join()?)))
    }
    fn join(&mut self) -> Result<Expr, String> {
        let mut a = self.add()?;
        while self.op(&["&"]).is_some() {
            a = Expr::Bin(Op::Join, Box::new(a), Box::new(self.add()?));
        }
        Ok(a)
    }
    fn add(&mut self) -> Result<Expr, String> {
        let mut a = self.mul()?;
        while let Some(o) = self.op(&["+", "-"]) {
            let op = if o == "+" { Op::Add } else { Op::Sub };
            a = Expr::Bin(op, Box::new(a), Box::new(self.mul()?));
        }
        Ok(a)
    }
    fn mul(&mut self) -> Result<Expr, String> {
        let mut a = self.unary()?;
        while let Some(o) = self.op(&["*", "/", "%"]) {
            let op = match o {
                "*" => Op::Mul,
                "/" => Op::Div,
                _ => Op::Rem,
            };
            a = Expr::Bin(op, Box::new(a), Box::new(self.unary()?));
        }
        Ok(a)
    }
    fn unary(&mut self) -> Result<Expr, String> {
        if self.op(&["-"]).is_some() {
            return Ok(Expr::Neg(Box::new(self.unary()?)));
        }
        if self.op(&["+"]).is_some() {
            return self.unary();
        }
        let a = self.primary()?;
        if self.op(&["^"]).is_some() {
            return Ok(Expr::Bin(Op::Pow, Box::new(a), Box::new(self.unary()?)));
        }
        Ok(a)
    }
    fn primary(&mut self) -> Result<Expr, String> {
        let Some(t) = self.t.get(self.i).cloned() else {
            return Err("expression incomplète".into());
        };
        self.i += 1;
        match t {
            Tok::Num(n) => Ok(Expr::Num(n)),
            Tok::Text(s) => Ok(Expr::Text(s)),
            Tok::Open => {
                let e = self.or()?;
                match self.peek() {
                    Some(Tok::Close) => {
                        self.i += 1;
                        Ok(e)
                    }
                    _ => Err("parenthèse non fermée".into()),
                }
            }
            Tok::Name(n) => {
                if self.peek() == Some(&Tok::Open) {
                    self.i += 1;
                    let mut args = Vec::new();
                    if self.peek() == Some(&Tok::Close) {
                        self.i += 1;
                        return Ok(Expr::Call(fold(&n), args));
                    }
                    loop {
                        args.push(self.or()?);
                        match self.peek() {
                            Some(Tok::Comma) => self.i += 1,
                            Some(Tok::Close) => {
                                self.i += 1;
                                break;
                            }
                            _ => return Err("parenthèse non fermée".into()),
                        }
                    }
                    let f = fold(&n);
                    if !FUNCTIONS.iter().any(|(a, b)| *a == f || *b == f) {
                        return Err(format!("fonction inconnue « {n} »"));
                    }
                    return Ok(Expr::Call(f, args));
                }
                match fold(&n).as_str() {
                    "vrai" | "true" => Ok(Expr::Num(1.0)),
                    "faux" | "false" => Ok(Expr::Num(0.0)),
                    _ => Ok(Expr::Name(n)),
                }
            }
            Tok::Op(o) => Err(format!("« {o} » inattendu")),
            Tok::Close => Err("« ) » inattendu".into()),
            Tok::Comma => Err("« , » inattendue".into()),
        }
    }
}

/// The functions, by French and English name.
pub const FUNCTIONS: &[(&str, &str)] = &[
    ("min", "min"),
    ("max", "max"),
    ("abs", "abs"),
    ("arrondi", "round"),
    ("plancher", "floor"),
    ("plafond", "ceil"),
    ("limiter", "clamp"),
    ("remapper", "remap"),
    ("racine", "sqrt"),
    ("puissance", "pow"),
    ("si", "if"),
    ("vide", "empty"),
    ("longueur", "len"),
    ("majuscules", "upper"),
    ("minuscules", "lower"),
    ("capitaliser", "capitalize"),
    ("nettoyer", "trim"),
    ("contient", "contains"),
    ("commence", "startswith"),
    ("finit", "endswith"),
    ("remplacer", "replace"),
    ("ligne", "line"),
    ("gauche", "left"),
    ("droite", "right"),
    ("format", "fmt"),
    ("compact", "short"),
    ("pluriel", "plural"),
    ("nombre", "num"),
    ("texte", "text"),
    ("entre", "between"),
    ("temps", "time"),
    ("heure", "hour"),
    ("minute", "minutes"),
    ("seconde", "seconds"),
    ("osciller", "osc"),
    ("clignoter", "blink"),
    ("melanger", "mix"),
];

/// Parses an expression (an error says what is wrong, in French).
pub fn parse(s: &str) -> Result<Expr, String> {
    let t = lex(s)?;
    if t.is_empty() {
        return Ok(Expr::Text(String::new()));
    }
    let mut p = P { t, i: 0 };
    let e = p.or()?;
    if p.i < p.t.len() {
        return Err("expression en trop".into());
    }
    Ok(e)
}

/// The inputs an expression reads (its names), in order.
pub fn names(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Name(n) => {
            if !out.contains(n) {
                out.push(n.clone())
            }
        }
        Expr::Neg(a) | Expr::Not(a) => names(a, out),
        Expr::Bin(_, a, b) => {
            names(a, out);
            names(b, out);
        }
        Expr::Call(_, args) => args.iter().for_each(|a| names(a, out)),
        Expr::Num(_) | Expr::Text(_) => {}
    }
}

/// Time for the time functions: seconds since the graphic came in, and the
/// clock (ms since 1970).
#[derive(Debug, Clone, Copy, Default)]
pub struct Clock {
    pub secs: f64,
    pub now_ms: i64,
}

pub fn num(v: &LVal) -> f64 {
    v.num()
}

/// A text read as a number, when it is one (`12`, `-3,5`, ` 4.0 `).
pub fn as_number(v: &LVal) -> Option<f64> {
    match v {
        LVal::Num(n) => Some(*n),
        LVal::Text(t) => {
            let t = t.trim();
            if t.is_empty() {
                return None;
            }
            t.replace(',', ".")
                .parse::<f64>()
                .ok()
                .filter(|x| x.is_finite())
        }
    }
}

pub fn text(v: &LVal) -> String {
    match v {
        LVal::Num(n) => super::format_number(*n),
        LVal::Text(t) => t.clone(),
    }
}

pub fn truthy(v: &LVal) -> bool {
    match v {
        LVal::Num(n) => *n != 0.0,
        LVal::Text(t) => {
            let t = fold(t.trim());
            !t.is_empty() && t != "0" && t != "false" && t != "faux" && t != "non"
        }
    }
}

fn b(x: bool) -> LVal {
    LVal::Num(if x { 1.0 } else { 0.0 })
}

/// Compares numbers as numbers, texts as texts (trimmed, any case).
fn compare(a: &LVal, b: &LVal) -> std::cmp::Ordering {
    match (as_number(a), as_number(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        _ => text(a)
            .trim()
            .to_lowercase()
            .cmp(&text(b).trim().to_lowercase()),
    }
}

/// `x` the French way: `decimals` after a comma, thin spaces between thousands.
pub fn format_fr(x: f64, decimals: usize, grouping: bool) -> String {
    if !x.is_finite() {
        return String::new();
    }
    let s = format!("{:.*}", decimals, x.abs());
    let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
    let mut g = String::new();
    for (i, c) in int.chars().enumerate() {
        if grouping && i > 0 && (int.len() - i) % 3 == 0 {
            g.push('\u{202f}');
        }
        g.push(c);
    }
    let neg = x < 0.0 && s.chars().any(|c| c.is_ascii_digit() && c != '0');
    format!(
        "{}{}{}",
        if neg { "-" } else { "" },
        g,
        if frac.is_empty() {
            String::new()
        } else {
            format!(",{frac}")
        }
    )
}

/// 1 234 → « 1,2 k », 3 400 000 → « 3,4 M ».
pub fn short(x: f64) -> String {
    let a = x.abs();
    let (v, unit) = if a >= 1e9 {
        (x / 1e9, " Md")
    } else if a >= 1e6 {
        (x / 1e6, " M")
    } else if a >= 1e3 {
        (x / 1e3, " k")
    } else {
        (x, "")
    };
    let r = (v * 10.0).round() / 10.0;
    let s = if r.fract() == 0.0 {
        format_fr(r, 0, false)
    } else {
        format_fr(r, 1, false)
    };
    format!("{s}{unit}")
}

fn hex(c: &str) -> Option<[f64; 4]> {
    let h = c.trim().trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok().map(f64::from);
    match h.len() {
        6 => Some([p(0)?, p(2)?, p(4)?, 255.0]),
        8 => Some([p(0)?, p(2)?, p(4)?, p(6)?]),
        3 => {
            let q = |i: usize| {
                u8::from_str_radix(&h[i..i + 1].repeat(2), 16)
                    .ok()
                    .map(f64::from)
            };
            Some([q(0)?, q(1)?, q(2)?, 255.0])
        }
        _ => None,
    }
}

fn hour_parts(now_ms: i64) -> (f64, f64, f64) {
    let Ok(ts) = jiff::Timestamp::from_millisecond(now_ms) else {
        return (0.0, 0.0, 0.0);
    };
    let z = ts.to_zoned(jiff::tz::TimeZone::system());
    (z.hour() as f64, z.minute() as f64, z.second() as f64)
}

fn call(f: &str, args: &[Expr], get: &mut dyn FnMut(&str) -> LVal, clock: &Clock) -> LVal {
    let mut v: Vec<LVal> = Vec::with_capacity(args.len());
    // « si » only evaluates the branch it takes.
    if f == "si" || f == "if" {
        let c = args
            .first()
            .map(|a| eval(a, get, clock))
            .is_some_and(|c| truthy(&c));
        let pick = if c { args.get(1) } else { args.get(2) };
        return pick.map_or(LVal::Text(String::new()), |a| eval(a, get, clock));
    }
    for a in args {
        v.push(eval(a, get, clock));
    }
    let n = |i: usize| v.get(i).map_or(0.0, |x| x.num());
    let s = |i: usize| v.get(i).map_or(String::new(), text);
    let has = |i: usize| i < v.len();
    let words =
        |t: &str, f: &dyn Fn(&str) -> String| t.split(' ').map(f).collect::<Vec<_>>().join(" ");
    match f {
        "min" => LVal::Num(v.iter().map(|x| x.num()).fold(f64::INFINITY, f64::min)).finite(),
        "max" => LVal::Num(v.iter().map(|x| x.num()).fold(f64::NEG_INFINITY, f64::max)).finite(),
        "abs" => LVal::Num(n(0).abs()),
        "arrondi" | "round" => {
            let k = 10f64.powi(n(1).round().clamp(0.0, 10.0) as i32);
            LVal::Num((n(0) * k).round() / k)
        }
        "plancher" | "floor" => LVal::Num(n(0).floor()),
        "plafond" | "ceil" => LVal::Num(n(0).ceil()),
        "limiter" | "clamp" => {
            let (lo, hi) = (n(1), n(2).max(n(1)));
            LVal::Num(n(0).clamp(lo, hi))
        }
        "remapper" | "remap" => {
            let (a, b2, c, d) = (n(1), n(2), n(3), n(4));
            if b2 == a {
                return LVal::Num(c);
            }
            let k = ((n(0) - a) / (b2 - a)).clamp(0.0, 1.0);
            LVal::Num(c + (d - c) * k)
        }
        "racine" | "sqrt" => LVal::Num(n(0).max(0.0).sqrt()),
        "puissance" | "pow" => LVal::Num(n(0).powf(n(1))).finite(),
        "vide" | "empty" => b(!has(0) || text(&v[0]).trim().is_empty()),
        "longueur" | "len" => LVal::Num(s(0).chars().count() as f64),
        "majuscules" | "upper" => LVal::Text(s(0).to_uppercase()),
        "minuscules" | "lower" => LVal::Text(s(0).to_lowercase()),
        "capitaliser" | "capitalize" => LVal::Text(words(&s(0), &|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                None => String::new(),
            }
        })),
        "nettoyer" | "trim" => LVal::Text(s(0).trim().to_string()),
        "contient" | "contains" => b(s(0).to_lowercase().contains(&s(1).to_lowercase())),
        "commence" | "startswith" => b(s(0).to_lowercase().starts_with(&s(1).to_lowercase())),
        "finit" | "endswith" => b(s(0).to_lowercase().ends_with(&s(1).to_lowercase())),
        "remplacer" | "replace" => {
            let find = s(1);
            LVal::Text(if find.is_empty() {
                s(0)
            } else {
                s(0).replace(&find, &s(2))
            })
        }
        "ligne" | "line" => {
            let i = n(1).round().max(1.0) as usize;
            LVal::Text(s(0).split('\n').nth(i - 1).unwrap_or("").to_string())
        }
        "gauche" | "left" => LVal::Text(s(0).chars().take(n(1).max(0.0) as usize).collect()),
        "droite" | "right" => {
            let t: Vec<char> = s(0).chars().collect();
            let k = (n(1).max(0.0) as usize).min(t.len());
            LVal::Text(t[t.len() - k..].iter().collect())
        }
        "format" | "fmt" => {
            let d = if has(1) {
                n(1).round().clamp(0.0, 6.0) as usize
            } else {
                0
            };
            let g = !has(2) || truthy(&v[2]);
            LVal::Text(format_fr(n(0), d, g))
        }
        "compact" | "short" => LVal::Text(short(n(0))),
        "pluriel" | "plural" => LVal::Text(if n(0).abs() >= 2.0 { s(2) } else { s(1) }),
        "nombre" | "num" => {
            LVal::Num(as_number(v.first().unwrap_or(&LVal::Num(0.0))).unwrap_or(0.0))
        }
        "texte" | "text" => LVal::Text(s(0)),
        "entre" | "between" => {
            let (lo, hi) = (n(1).min(n(2)), n(1).max(n(2)));
            b(n(0) >= lo && n(0) <= hi)
        }
        "temps" | "time" => LVal::Num(clock.secs),
        "heure" | "hour" => LVal::Num(hour_parts(clock.now_ms).0),
        "minute" | "minutes" => LVal::Num(hour_parts(clock.now_ms).1),
        "seconde" | "seconds" => LVal::Num(hour_parts(clock.now_ms).2),
        "osciller" | "osc" => {
            let p = if has(0) && n(0) > 0.0 { n(0) } else { 1.0 };
            LVal::Num(0.5 - 0.5 * (std::f64::consts::TAU * clock.secs / p).cos())
        }
        "clignoter" | "blink" => {
            let p = if has(0) && n(0) > 0.0 { n(0) } else { 1.0 };
            b((clock.secs / p).fract() < 0.5)
        }
        "melanger" | "mix" => {
            let (Some(a), Some(c)) = (hex(&s(0)), hex(&s(1))) else {
                return LVal::Text(s(0));
            };
            let k = n(2).clamp(0.0, 1.0);
            let m: Vec<u8> = (0..4)
                .map(|i| (a[i] + (c[i] - a[i]) * k).round() as u8)
                .collect();
            LVal::Text(if m[3] == 255 {
                format!("#{:02x}{:02x}{:02x}", m[0], m[1], m[2])
            } else {
                format!("#{:02x}{:02x}{:02x}{:02x}", m[0], m[1], m[2], m[3])
            })
        }
        _ => LVal::Text(String::new()),
    }
}

impl LVal {
    fn finite(self) -> LVal {
        match self {
            LVal::Num(n) if !n.is_finite() => LVal::Num(0.0),
            v => v,
        }
    }
}

/// The value of `e`, its names read with `get`.
pub fn eval(e: &Expr, get: &mut dyn FnMut(&str) -> LVal, clock: &Clock) -> LVal {
    match e {
        Expr::Num(n) => LVal::Num(*n),
        Expr::Text(s) => LVal::Text(s.clone()),
        Expr::Name(n) => get(n),
        Expr::Neg(a) => LVal::Num(-eval(a, get, clock).num()),
        Expr::Not(a) => b(!truthy(&eval(a, get, clock))),
        Expr::Bin(op, x, y) => {
            match op {
                Op::And => return b(truthy(&eval(x, get, clock)) && truthy(&eval(y, get, clock))),
                Op::Or => return b(truthy(&eval(x, get, clock)) || truthy(&eval(y, get, clock))),
                _ => {}
            }
            let a = eval(x, get, clock);
            let c = eval(y, get, clock);
            use std::cmp::Ordering::*;
            match op {
                Op::Add => match (as_number(&a), as_number(&c)) {
                    (Some(p), Some(q)) => LVal::Num(p + q),
                    // A text and a number: joined.
                    _ if matches!(a, LVal::Text(ref t) if !t.trim().is_empty())
                        || matches!(c, LVal::Text(ref t) if !t.trim().is_empty()) =>
                    {
                        LVal::Text(text(&a) + &text(&c))
                    }
                    _ => LVal::Num(a.num() + c.num()),
                },
                Op::Sub => LVal::Num(a.num() - c.num()),
                Op::Mul => LVal::Num(a.num() * c.num()),
                Op::Div => LVal::Num(if c.num() == 0.0 {
                    0.0
                } else {
                    a.num() / c.num()
                }),
                Op::Rem => LVal::Num(if c.num() == 0.0 {
                    0.0
                } else {
                    a.num().rem_euclid(c.num())
                }),
                Op::Pow => LVal::Num(a.num().powf(c.num())).finite(),
                Op::Join => LVal::Text(text(&a) + &text(&c)),
                Op::Eq => b(compare(&a, &c) == Equal),
                Op::Ne => b(compare(&a, &c) != Equal),
                Op::Lt => b(compare(&a, &c) == Less),
                Op::Le => b(compare(&a, &c) != Greater),
                Op::Gt => b(compare(&a, &c) == Greater),
                Op::Ge => b(compare(&a, &c) != Less),
                Op::And | Op::Or => unreachable!(),
            }
        }
        Expr::Call(f, args) => call(f, args, get, clock),
    }
}

/// Parses and evaluates `s` (empty on an error).
pub fn run(s: &str, get: &mut dyn FnMut(&str) -> LVal, clock: &Clock) -> LVal {
    match parse(s) {
        Ok(e) => eval(&e, get, clock),
        Err(_) => LVal::Text(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str, vars: &[(&str, LVal)]) -> LVal {
        let mut get = |n: &str| {
            vars.iter()
                .find(|(k, _)| *k == n)
                .map(|(_, v)| v.clone())
                .unwrap_or(LVal::Text(String::new()))
        };
        run(
            s,
            &mut get,
            &Clock {
                secs: 1.25,
                now_ms: 0,
            },
        )
    }
    fn t(s: &str) -> LVal {
        LVal::Text(s.into())
    }

    #[test]
    fn arithmetic_and_texts() {
        assert_eq!(
            ev("a + b * 2", &[("a", LVal::Num(1.0)), ("b", t("3"))]),
            LVal::Num(7.0)
        );
        assert_eq!(
            ev("(a + b) / 2", &[("a", t("1,5")), ("b", LVal::Num(2.5))]),
            LVal::Num(2.0)
        );
        assert_eq!(ev("2 ^ 3 - -1", &[]), LVal::Num(9.0));
        assert_eq!(ev("a & \" pts\"", &[("a", LVal::Num(12.0))]), t("12 pts"));
        assert_eq!(
            ev("\"Score : \" + a", &[("a", LVal::Num(3.0))]),
            t("Score : 3")
        );
        assert_eq!(ev("10 / 0", &[]), LVal::Num(0.0));
        assert_eq!(
            ev("format(a, 1)", &[("a", LVal::Num(1234.56))]),
            t("1\u{202f}234,6")
        );
        assert_eq!(ev("compact(a)", &[("a", LVal::Num(1240.0))]), t("1,2 k"));
        assert_eq!(ev("compact(3400000)", &[]), t("3,4 M"));
        assert_eq!(
            ev(
                "pluriel(a, \"point\", \"points\")",
                &[("a", LVal::Num(1.0))]
            ),
            t("point")
        );
        assert_eq!(ev("Majuscules(a)", &[("a", t("psg"))]), t("PSG"));
        assert_eq!(
            ev("limiter(a, 300, 1200)", &[("a", LVal::Num(80.0))]),
            LVal::Num(300.0)
        );
        assert_eq!(ev("remapper(50, 0, 100, 0, 800)", &[]), LVal::Num(400.0));
        assert_eq!(ev("arrondi(2.345, 2)", &[]), LVal::Num(2.35));
        assert_eq!(ev("temps() * 2", &[]), LVal::Num(2.5));
        assert_eq!(
            ev("mélanger(\"#000000\", \"#ffffff\", 0.5)", &[]),
            t("#808080")
        );
    }

    #[test]
    fn conditions() {
        let v = [("a", LVal::Num(3.0)), ("b", t("1")), ("c", t("OUI"))];
        assert_eq!(ev("a > b et c = \"oui\"", &v), LVal::Num(1.0));
        assert_eq!(ev("a < b ou non (c = 'OUI')", &v), LVal::Num(0.0));
        assert_eq!(ev("a ≥ 3 && b != 2", &v), LVal::Num(1.0));
        assert_eq!(ev("vide(d)", &v), LVal::Num(1.0));
        assert_eq!(ev("contient(c, «ou»)", &v), LVal::Num(1.0));
        assert_eq!(ev("si(a > 2, \"haut\", \"bas\")", &v), t("haut"));
        assert_eq!(ev("entre(a, 5, 1)", &v), LVal::Num(1.0));
        assert_eq!(ev("\"10\" > \"9\"", &v), LVal::Num(1.0));
        assert!(parse("a >").is_err());
        assert!(parse("foo(a)").is_err());
        assert!(parse("(a + 1").is_err());
        assert!(parse("\"abc").is_err());
        let mut n = Vec::new();
        names(&parse("max(a, b) + c * a").unwrap(), &mut n);
        assert_eq!(n, ["a", "b", "c"]);
    }
}
