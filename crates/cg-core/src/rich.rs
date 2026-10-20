//! Rich text of the texts typed in the Designer: parts of the text in bold,
//! italic, underlined, struck through or in another colour.
//!
//! The style is written in the text itself with a few tags (mirror of
//! `web/src/engine/rich.ts`):
//!
//! `<b>bold</b> <i>italic</i> <u>underlined</u> <s>struck</s> <c=#ff3b5c>red</c>`
//!
//! Tags nest. Anything else that looks like a tag stays text. A `{{key}}`
//! takes the style around it. Only what people type is styled: the text of
//! the Designer, and the values the operator types (`rich` keys); the values
//! of the data sources never add styles (a `<b>` in them is text).

use crate::anim::{interpolate_text, Data};
use crate::model::{LayerKind, Template};

/// Keys whose values may have styles: the template's values typed by the
/// operator (not read from a data source).
pub fn typed_key(t: &Template, key: &str) -> bool {
    t.fields.iter().any(|f| f.key == key && f.binding.is_none())
}

/// The styled parts of a Text layer of `t` as shown with `data`; `None`
/// when it has no styles (one style for all).
pub fn layer_runs(t: &Template, layer: &crate::model::Layer, data: &Data) -> Option<Vec<Run>> {
    let LayerKind::Text {
        text,
        uppercase,
        transform,
        ..
    } = &layer.kind
    else {
        return None;
    };
    runs(
        text,
        data,
        |k| typed_key(t, k),
        |s| {
            if *uppercase {
                s.to_uppercase()
            } else {
                transform.apply(s)
            }
        },
    )
}

/// The style of a part of the text, over the style of the whole text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// `#rrggbb[aa]`; none = the colour of the text.
    pub color: Option<String>,
}

/// A part of the text and its style.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub style: Style,
}

enum Tag {
    Open(char, Option<String>),
    Close(char),
}

/// The tag at the start of `s` and its length in bytes.
fn tag_at(s: &str) -> Option<(Tag, usize)> {
    let end = s.find('>')?;
    let inner = &s[1..end];
    let tag = match inner {
        "b" | "i" | "u" | "s" | "c" => return None,
        "/b" | "/i" | "/u" | "/s" | "/c" => Tag::Close(inner.chars().nth(1)?),
        _ => {
            let hex = inner.strip_prefix("c=")?;
            let h = hex.strip_prefix('#')?;
            if !(matches!(h.len(), 3 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit())) {
                return None;
            }
            Tag::Open('c', Some(hex.to_string()))
        }
    };
    Some((tag, end + 1))
}

/// `<b>`, `<i>`, `<u>`, `<s>` (bare letters are matched here, `c` needs a colour).
fn open_at(s: &str) -> Option<(Tag, usize)> {
    for t in ['b', 'i', 'u', 's'] {
        if s.starts_with(&format!("<{t}>")) {
            return Some((Tag::Open(t, None), 3));
        }
    }
    tag_at(s)
}

/// Whether `s` has style tags.
pub fn has_markup(s: &str) -> bool {
    s.match_indices('<')
        .any(|(i, _)| open_at(&s[i..]).is_some())
}

/// The parts of `markup` with their style (one part, unstyled, without tags).
pub fn parse(markup: &str) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let mut stack: Vec<(char, Option<String>)> = Vec::new();
    let style = |stack: &[(char, Option<String>)]| {
        let mut s = Style::default();
        for (t, v) in stack {
            match t {
                'b' => s.bold = true,
                'i' => s.italic = true,
                'u' => s.underline = true,
                's' => s.strike = true,
                _ => s.color = v.clone(),
            }
        }
        s
    };
    let mut cur = String::new();
    let mut rest = markup;
    let flush = |cur: &mut String, runs: &mut Vec<Run>, st: Style| {
        if cur.is_empty() {
            return;
        }
        match runs.last_mut() {
            Some(r) if r.style == st => r.text.push_str(cur),
            _ => runs.push(Run {
                text: cur.clone(),
                style: st,
            }),
        }
        cur.clear();
    };
    while let Some(i) = rest.find('<') {
        cur.push_str(&rest[..i]);
        let at = &rest[i..];
        match open_at(at) {
            Some((tag, len)) => {
                flush(&mut cur, &mut runs, style(&stack));
                match tag {
                    Tag::Open(t, v) => stack.push((t, v)),
                    Tag::Close(t) => {
                        if let Some(p) = stack.iter().rposition(|(x, _)| *x == t) {
                            stack.remove(p);
                        }
                    }
                }
                rest = &at[len..];
            }
            None => {
                cur.push('<');
                rest = &at[1..];
            }
        }
    }
    cur.push_str(rest);
    flush(&mut cur, &mut runs, style(&stack));
    runs
}

/// The text without its tags.
pub fn plain(markup: &str) -> String {
    parse(markup).into_iter().map(|r| r.text).collect()
}

/// The parts of a text as shown: its `{{key}}` replaced by the data (which
/// take the style around them; the values of `rich` keys, typed by the
/// operator, may have styles of their own) and its case changed by `case`
/// (on the whole text when that keeps its length, so "Capitalize" sees whole
/// words). `None` when the text has no style tags.
pub fn runs(
    markup: &str,
    data: &Data,
    rich: impl Fn(&str) -> bool,
    case: impl Fn(&str) -> String,
) -> Option<Vec<Run>> {
    // The operator's styled values first, as if typed in the text.
    let mut expanded = String::with_capacity(markup.len());
    let mut rest = markup;
    while let Some(i) = rest.find("{{") {
        expanded.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find("}}") {
            Some(end) if rich(after[..end].trim()) && data.contains_key(after[..end].trim()) => {
                expanded.push_str(&data[after[..end].trim()]);
                rest = &after[end + 2..];
            }
            _ => {
                expanded.push_str("{{");
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    let markup = expanded.as_str();
    if !has_markup(markup) {
        return None;
    }
    let mut runs: Vec<Run> = parse(markup)
        .into_iter()
        .map(|r| Run {
            text: interpolate_text(&r.text, data),
            style: r.style,
        })
        .collect();
    let whole: String = runs.iter().map(|r| r.text.as_str()).collect();
    let cased = case(&whole);
    if cased.chars().count() == whole.chars().count() {
        let mut chars = cased.chars();
        for r in &mut runs {
            let n = r.text.chars().count();
            r.text = chars.by_ref().take(n).collect();
        }
    } else {
        for r in &mut runs {
            r.text = case(&r.text);
        }
    }
    runs.retain(|r| !r.text.is_empty());
    Some(runs)
}

/// Spaces the line breaking may change (French spaces before `: ; ! ?`).
fn space(c: char) -> bool {
    matches!(c, ' ' | '\u{a0}' | '\u{202f}' | '\n' | '\t')
}

/// Follows the shown lines through the text: the parts of each line, as
/// `(text, index of the run)`. Characters the breaking added (a hyphen, "…")
/// take the style before them; spaces it dropped are skipped.
pub fn align(runs: &[Run], lines: &[&str]) -> Vec<Vec<(String, usize)>> {
    let chars: Vec<(char, usize)> = runs
        .iter()
        .enumerate()
        .flat_map(|(i, r)| r.text.chars().map(move |c| (c, i)))
        .collect();
    let mut at = 0usize;
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        let mut parts: Vec<(String, usize)> = Vec::new();
        for ch in line.chars() {
            // Skip what the breaking dropped (spaces, line ends) when the
            // character comes right after them.
            if !space(ch) {
                let mut j = at;
                while j < chars.len() && chars[j].0 != ch && space(chars[j].0) {
                    j += 1;
                }
                if j < chars.len() && chars[j].0 == ch {
                    at = j;
                }
            }
            let run =
                if at < chars.len() && (chars[at].0 == ch || (space(ch) && space(chars[at].0))) {
                    at += 1;
                    chars[at - 1].1
                } else {
                    // Added by the breaking: the style before.
                    chars.get(at.saturating_sub(1)).map_or(0, |c| c.1)
                };
            match parts.last_mut() {
                Some((s, r)) if *r == run => s.push(ch),
                _ => parts.push((ch.to_string(), run)),
            }
        }
        out.push(parts);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(f: impl Fn(&mut Style)) -> Style {
        let mut s = Style::default();
        f(&mut s);
        s
    }

    #[test]
    fn tags_give_styles() {
        let r = parse("Hello <b>big <c=#ff0000>red</c></b> world");
        assert_eq!(r.len(), 4);
        assert_eq!(r[0].text, "Hello ");
        assert_eq!(
            (r[1].text.as_str(), &r[1].style),
            ("big ", &st(|s| s.bold = true))
        );
        assert_eq!(
            (r[2].text.as_str(), &r[2].style),
            (
                "red",
                &st(|s| {
                    s.bold = true;
                    s.color = Some("#ff0000".into())
                })
            )
        );
        assert_eq!(r[3].text, " world");
        assert_eq!(plain("a <i>b</i> c"), "a b c");
        // Not tags: kept as text.
        assert_eq!(plain("1 < 2 <x> <c=red>a</c>"), "1 < 2 <x> <c=red>a");
        assert!(!has_markup("a < b"));
        assert!(has_markup("<u>a</u>"));
    }

    #[test]
    fn data_takes_the_style_around_it_and_never_adds_any() {
        let data: Data = [("name".to_string(), "<b>Zoé</b>".to_string())].into();
        let r = runs(
            "<c=#00ff00>{{name}}</c> !",
            &data,
            |_| false,
            |t| t.to_uppercase(),
        )
        .unwrap();
        assert_eq!(r[0].text, "<B>ZOÉ</B>");
        assert_eq!(r[0].style.color.as_deref(), Some("#00ff00"));
        assert_eq!(r[1].text, " !");
        assert!(runs("plain {{name}}", &data, |_| false, |t| t.to_string()).is_none());
        // Typed by the operator: its own styles count.
        let r = runs("{{name}} !", &data, |k| k == "name", |t| t.to_string()).unwrap();
        assert_eq!((r[0].text.as_str(), r[0].style.bold), ("Zoé", true));
    }

    #[test]
    fn lines_keep_their_styles() {
        let r = parse("ab <b>cd ef</b> gh");
        // Broken as "ab cd" / "ef gh", or with a hyphen added.
        let l = align(&r, &["ab cd", "ef gh"]);
        assert_eq!(l[0], vec![("ab ".into(), 0), ("cd".into(), 1)]);
        assert_eq!(l[1], vec![("ef".into(), 1), (" gh".into(), 2)]);
        let l = align(&r, &["ab c-", "d ef…"]);
        assert_eq!(l[0], vec![("ab ".into(), 0), ("c-".into(), 1)]);
        assert_eq!(l[1], vec![("d ef…".into(), 1)]);
    }
}
