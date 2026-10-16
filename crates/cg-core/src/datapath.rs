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
use crate::model::Template;

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
        let Some(text) = lookup(v, &b.path, data) else {
            continue;
        };
        if data.get(&f.key) != Some(&text) {
            data.insert(f.key.clone(), text);
            changed = true;
        }
    }
    changed
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
}
