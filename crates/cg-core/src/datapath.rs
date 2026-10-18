//! Values of data sources (JSON documents) and the paths that bind template
//! fields to them.
//!
//! Path syntax, from the root of the source's value:
//! - `title`, `match.home.score`: object keys (dots between keys);
//! - `items[0]`, `items[-1]`: array index (negative = from the end);
//! - `rows[{row}]`: `{key}` is replaced by the item's data (the operator
//!   picks the row, the player number…);
//! - `players[number=10]`, `players[number={num}]`: first element whose
//!   key equals the value;
//! - `items[*].title`: every element, one value per line (tickers, lists);
//! - `items.length`: number of elements (or characters of a text).

use std::collections::HashMap;

use serde_json::Value as Json;

use crate::anim::Data;
use crate::model::{DataFilter, DataSort, FilterOp, Template};

/// Latest value of each data source, by source id.
pub type Store = HashMap<String, Json>;

/// The text at `path` in `value`, with `{key}` taken from `data`.
pub fn lookup(value: &Json, path: &str, data: &Data) -> Option<String> {
    let path = substitute(path, data);
    let p = path.trim();
    // `….length`: how many elements (or characters).
    if let Some(base) = p
        .strip_suffix("length")
        .filter(|b| b.is_empty() || b.ends_with('.'))
    {
        let found = walk(value, base.trim_end_matches('.'));
        let n = match found.as_slice() {
            [] => return None,
            [one] if !base.contains("[*]") => match one {
                Json::Array(a) => a.len(),
                Json::Object(o) => o.len(),
                Json::String(s) => s.chars().count(),
                Json::Null => 0,
                _ => 1,
            },
            many => many.len(),
        };
        return Some(n.to_string());
    }
    let found = walk(value, p);
    if found.is_empty() {
        return None;
    }
    Some(found.into_iter().map(text).collect::<Vec<_>>().join("\n"))
}

fn walk<'a>(value: &'a Json, path: &str) -> Vec<&'a Json> {
    let mut cur: Vec<&Json> = vec![value];
    for seg in segments(path) {
        let mut next = Vec::new();
        for v in cur {
            match &seg {
                Seg::Key(k) => next.extend(v.get(k.as_str())),
                Seg::Index(i) => {
                    if let Some(a) = v.as_array() {
                        let i = if *i < 0 { a.len() as i64 + i } else { *i };
                        next.extend(usize::try_from(i).ok().and_then(|i| a.get(i)));
                    } else if let Some(o) = v.as_object() {
                        // Numbered keys ("1": …) behave like indexes.
                        next.extend(o.get(&i.to_string()));
                    }
                }
                Seg::All => match v {
                    Json::Array(a) => next.extend(a.iter()),
                    Json::Object(o) => next.extend(o.values()),
                    _ => {}
                },
                Seg::Filter(k, want) => {
                    if let Some(a) = v.as_array() {
                        next.extend(a.iter().find(|e| {
                            e.get(k.as_str()).map(text).as_deref() == Some(want.as_str())
                        }));
                    }
                }
            }
        }
        cur = next;
        if cur.is_empty() {
            break;
        }
    }
    cur
}

/// Fills the bound fields of `template` into `data`. Returns true when a
/// value changed. A source without a value at the path leaves the field as
/// it is (typed by the operator, or its default).
pub fn bind(template: &Template, data: &mut Data, store: &Store) -> bool {
    let mut changed = false;
    for f in &template.fields {
        let Some(b) = &f.binding else { continue };
        let Some(v) = store.get(&b.source) else {
            continue;
        };
        let sorted;
        let v = match &b.sort {
            Some(s) => {
                sorted = sort(v, s);
                &sorted
            }
            None => v,
        };
        let Some(text) = lookup_filtered(v, &b.path, &b.filters, data) else {
            continue;
        };
        if data.get(&f.key) != Some(&text) {
            data.insert(f.key.clone(), text);
            changed = true;
        }
    }
    changed
}

/// [`lookup`] then the filters; a missing value goes through them as an
/// empty text only when one of them gives a default.
pub fn lookup_filtered(
    value: &Json,
    path: &str,
    filters: &[DataFilter],
    data: &Data,
) -> Option<String> {
    let raw = match lookup(value, path, data) {
        Some(t) => t,
        None if filters
            .iter()
            .any(|f| matches!(f, DataFilter::Default { .. })) =>
        {
            String::new()
        }
        None => return None,
    };
    Some(filters.iter().fold(raw, |t, f| filter(&t, f)))
}

/// `value` with the list `s.list` sorted by `s.by`.
pub fn sort(value: &Json, s: &DataSort) -> Json {
    let mut out = value.clone();
    let mut cur = &mut out;
    for key in s.list.split('.').filter(|k| !k.is_empty()) {
        cur = match cur {
            Json::Object(o) => match o.get_mut(key) {
                Some(v) => v,
                None => return out,
            },
            Json::Array(a) => match key.parse::<usize>().ok().and_then(|i| a.get_mut(i)) {
                Some(v) => v,
                None => return out,
            },
            _ => return out,
        };
    }
    if let Json::Array(items) = cur {
        let key = |e: &Json| e.get(s.by.as_str()).map(text).unwrap_or_default();
        let num = |e: &Json| {
            key(e)
                .trim()
                .replace(',', ".")
                .parse::<f64>()
                .unwrap_or(f64::NEG_INFINITY)
        };
        items.sort_by(|a, b| {
            let o = if s.numeric {
                num(a).total_cmp(&num(b))
            } else {
                key(a).to_lowercase().cmp(&key(b).to_lowercase())
            };
            if s.descending {
                o.reverse()
            } else {
                o
            }
        });
    }
    out
}

/// One filter step.
pub fn filter(text: &str, f: &DataFilter) -> String {
    let number = || text.trim().replace(',', ".").parse::<f64>().ok();
    match f {
        DataFilter::Upper => text.to_uppercase(),
        DataFilter::Lower => text.to_lowercase(),
        DataFilter::Capitalize => {
            let mut out = String::with_capacity(text.len());
            let mut start = true;
            for c in text.chars() {
                if start && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                    start = false;
                } else {
                    out.push(c);
                    if c.is_whitespace() || c == '-' {
                        start = true;
                    }
                }
            }
            out
        }
        DataFilter::Trim => text.trim().to_string(),
        DataFilter::Prefix { text: p } => format!("{p}{text}"),
        DataFilter::Suffix { text: s } => format!("{text}{s}"),
        DataFilter::Replace { find, with } if !find.is_empty() => text.replace(find.as_str(), with),
        DataFilter::Replace { .. } => text.to_string(),
        DataFilter::Truncate { max } => {
            if text.chars().count() > *max {
                let mut t: String = text.chars().take(*max).collect();
                t = t.trim_end().to_string();
                t.push('…');
                t
            } else {
                text.to_string()
            }
        }
        DataFilter::Lines { from, count } => {
            let lines: Vec<&str> = text.split('\n').collect();
            let n = lines.len() as i64;
            let start = if *from < 0 { n + from } else { from - 1 }.clamp(0, n) as usize;
            let end = if *count == 0 {
                lines.len()
            } else {
                (start + count).min(lines.len())
            };
            lines[start..end].join("\n")
        }
        DataFilter::Join { separator } => text
            .split('\n')
            .filter(|l| !l.trim().is_empty())
            .collect::<Vec<_>>()
            .join(separator),
        DataFilter::Number { decimals, grouping } => match number() {
            Some(v) => crate::widgets::format_number(v, *decimals, *grouping),
            None => text.to_string(),
        },
        DataFilter::Math { op, value } => match number() {
            Some(v) => {
                let r = match op {
                    FilterOp::Add => v + value,
                    FilterOp::Sub => v - value,
                    FilterOp::Mul => v * value,
                    FilterOp::Div if *value != 0.0 => v / value,
                    FilterOp::Div => v,
                };
                let r = (r * 1e6).round() / 1e6;
                if r.fract() == 0.0 && r.abs() < 1e15 {
                    format!("{}", r as i64)
                } else {
                    r.to_string()
                }
            }
            None => text.to_string(),
        },
        DataFilter::Default { text: d } if text.trim().is_empty() => d.clone(),
        DataFilter::Default { .. } => text.to_string(),
        DataFilter::Map { when, then } if text.trim() == when.trim() => then.clone(),
        DataFilter::Map { .. } => text.to_string(),
    }
}

/// Sources a template reads.
pub fn sources(template: &Template) -> impl Iterator<Item = &str> {
    template
        .fields
        .iter()
        .filter_map(|f| f.binding.as_ref().map(|b| b.source.as_str()))
}

/// A JSON value as display text.
pub fn text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Null => String::new(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        other => other.to_string(),
    }
}

fn substitute(path: &str, data: &Data) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        match rest[i + 1..].find('}') {
            Some(j) => {
                let key = rest[i + 1..i + 1 + j].trim();
                out.push_str(data.get(key).map(|s| s.trim()).unwrap_or(""));
                rest = &rest[i + 2 + j..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(Debug, PartialEq)]
enum Seg {
    Key(String),
    Index(i64),
    All,
    Filter(String, String),
}

fn segments(path: &str) -> Vec<Seg> {
    let mut out = Vec::new();
    let path = path.trim().trim_start_matches('$').trim_start_matches('.');
    let mut key = String::new();
    let mut chars = path.chars().peekable();
    let flush = |key: &mut String, out: &mut Vec<Seg>| {
        if !key.trim().is_empty() {
            out.push(Seg::Key(key.trim().to_string()));
        }
        key.clear();
    };
    while let Some(c) = chars.next() {
        match c {
            '.' => flush(&mut key, &mut out),
            '[' => {
                flush(&mut key, &mut out);
                let mut inner = String::new();
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                    inner.push(c);
                }
                let inner = inner.trim().trim_matches(|c| c == '\'' || c == '"');
                out.push(if inner == "*" {
                    Seg::All
                } else if let Ok(i) = inner.parse::<i64>() {
                    Seg::Index(i)
                } else if let Some((k, v)) = inner.split_once('=') {
                    Seg::Filter(
                        k.trim().to_string(),
                        v.trim().trim_matches(|c| c == '\'' || c == '"').to_string(),
                    )
                } else {
                    Seg::Key(inner.to_string())
                });
            }
            c => key.push(c),
        }
    }
    flush(&mut key, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(pairs: &[(&str, &str)]) -> Data {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn paths() {
        let v = json!({
            "match": { "home": { "name": "PSG", "score": 2 }, "minute": 67.5 },
            "items": [{ "title": "One" }, { "title": "Two" }, { "title": "Three" }],
            "players": [{ "number": 10, "name": "Mbappé" }, { "number": 7, "name": "Dembélé" }],
            "live": true
        });
        let none = Data::new();
        assert_eq!(lookup(&v, "match.home.name", &none).as_deref(), Some("PSG"));
        assert_eq!(lookup(&v, "match.home.score", &none).as_deref(), Some("2"));
        assert_eq!(lookup(&v, "$.match.minute", &none).as_deref(), Some("67.5"));
        assert_eq!(lookup(&v, "items[1].title", &none).as_deref(), Some("Two"));
        assert_eq!(
            lookup(&v, "items[-1].title", &none).as_deref(),
            Some("Three")
        );
        assert_eq!(
            lookup(&v, "items[*].title", &none).as_deref(),
            Some("One\nTwo\nThree")
        );
        assert_eq!(lookup(&v, "items.length", &none).as_deref(), Some("3"));
        assert_eq!(
            lookup(&v, "players[number=7].name", &none).as_deref(),
            Some("Dembélé")
        );
        assert_eq!(
            lookup(&v, "players[number={n}].name", &d(&[("n", "10")])).as_deref(),
            Some("Mbappé")
        );
        assert_eq!(
            lookup(&v, "items[{row}].title", &d(&[("row", "0")])).as_deref(),
            Some("One")
        );
        assert_eq!(lookup(&v, "live", &none).as_deref(), Some("true"));
        assert_eq!(lookup(&v, "nope.x", &none), None);
        assert_eq!(lookup(&v, "items[9].title", &none), None);
    }

    #[test]
    fn binds_fields() {
        let mut t = crate::sample::score_bug();
        t.fields[2].binding = Some(crate::model::FieldBinding {
            source: "match".into(),
            path: "home.score".into(),
            filters: vec![],
            sort: None,
        });
        let mut store = Store::new();
        let mut data = d(&[("homeScore", "0")]);
        // No value yet: untouched.
        assert!(!bind(&t, &mut data, &store));
        store.insert("match".into(), json!({ "home": { "score": 3 } }));
        assert!(bind(&t, &mut data, &store));
        assert_eq!(data["homeScore"], "3");
        assert!(!bind(&t, &mut data, &store));
        assert_eq!(sources(&t).collect::<Vec<_>>(), vec!["match"]);
    }

    #[test]
    fn sorts_a_list_before_reading_it() {
        let v = json!({ "table": [{ "team": "Lyon", "pts": "52" }, { "team": "PSG", "pts": "74" }, { "team": "Lens", "pts": "9" }] });
        let s = DataSort {
            list: "table".into(),
            by: "pts".into(),
            descending: true,
            numeric: true,
        };
        assert_eq!(
            lookup(&sort(&v, &s), "table[*].team", &Data::new()).as_deref(),
            Some("PSG\nLyon\nLens")
        );
        let s = DataSort {
            list: "table".into(),
            by: "team".into(),
            descending: false,
            numeric: false,
        };
        assert_eq!(
            lookup(&sort(&v, &s), "table[0].team", &Data::new()).as_deref(),
            Some("Lens")
        );
    }

    #[test]
    fn filters_change_the_text() {
        use crate::model::{DataFilter as F, FilterOp};
        let v = json!({ "name": "  marie curie ", "items": ["a", "b", "c"], "n": "1234.5" });
        let none = Data::new();
        let run = |path: &str, fs: Vec<F>| lookup_filtered(&v, path, &fs, &none);
        assert_eq!(
            run("name", vec![F::Trim, F::Capitalize]).as_deref(),
            Some("Marie Curie")
        );
        assert_eq!(
            run(
                "name",
                vec![F::Trim, F::Upper, F::Prefix { text: "Dr ".into() }]
            )
            .as_deref(),
            Some("Dr MARIE CURIE")
        );
        assert_eq!(
            run("items[*]", vec![F::Lines { from: 2, count: 1 }]).as_deref(),
            Some("b")
        );
        assert_eq!(
            run(
                "items[*]",
                vec![
                    F::Lines { from: -2, count: 0 },
                    F::Join {
                        separator: " · ".into()
                    }
                ]
            )
            .as_deref(),
            Some("b · c")
        );
        assert_eq!(
            run(
                "n",
                vec![F::Math {
                    op: FilterOp::Mul,
                    value: 2.0
                }]
            )
            .as_deref(),
            Some("2469")
        );
        assert_eq!(
            run(
                "n",
                vec![F::Number {
                    decimals: 1,
                    grouping: true
                }]
            )
            .as_deref(),
            Some("1\u{202f}234,5")
        );
        assert_eq!(run("nope", vec![]), None);
        assert_eq!(
            run("nope", vec![F::Default { text: "—".into() }]).as_deref(),
            Some("—")
        );
        assert_eq!(
            run(
                "items[0]",
                vec![F::Map {
                    when: "a".into(),
                    then: "Alpha".into()
                }]
            )
            .as_deref(),
            Some("Alpha")
        );
        assert_eq!(
            run("name", vec![F::Trim, F::Truncate { max: 5 }]).as_deref(),
            Some("marie…")
        );
    }
}
