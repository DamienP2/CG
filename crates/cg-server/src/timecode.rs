//! An external timecode: the time-of-day timecode an SDI input carries
//! (RP188 VITC / LTC, else VITC), read by the DeckLink card with each frame.
//! The schedule fires its « at timecode » entries on it (see
//! [`crate::schedule`]) and the Operator's chip shows it; with none (or a
//! source that stopped), the server's time of day stands in.

use std::time::{Duration, Instant};

use cg_core::FrameRate;
use serde::Serialize;

/// A reading older than this is no longer the source's time.
pub const STALE: Duration = Duration::from_millis(1500);

/// A timecode read: ms since midnight (in the source's count), when.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub ms_of_day: i64,
    pub at: Instant,
}

impl Reading {
    /// The source's time of day now (ms), run on from the reading.
    pub fn now(&self) -> i64 {
        (self.ms_of_day + self.at.elapsed().as_millis() as i64).rem_euclid(crate::schedule::DAY_MS)
    }
    pub fn fresh(&self) -> bool {
        self.at.elapsed() < STALE
    }
}

/// The ms of day of a timecode read on an input whose frames come at
/// `rate`: above 30 frames a second RP188 counts pairs of frames (the field
/// mark telling the second one), unless the count goes past a pair's.
pub fn ms_of_day(tc: &cg_output::decklink::InputTimecode, rate: FrameRate) -> Option<i64> {
    let nominal = rate.as_f64().round() as i64;
    let pairs = nominal > 30 && (tc.frames as i64) < nominal / 2;
    let (base, extra) = if pairs {
        let half = FrameRate::new(rate.num, rate.den.saturating_mul(2));
        let frame_ms = 1000.0 * rate.den as f64 / rate.num.max(1) as f64;
        (
            half,
            if tc.field_mark {
                frame_ms.round() as i64
            } else {
                0
            },
        )
    } else {
        (rate, 0)
    };
    let sep = if tc.drop_frame { ';' } else { ':' };
    let text = format!(
        "{:02}:{:02}:{:02}{sep}{:02}",
        tc.hours, tc.minutes, tc.seconds, tc.frames
    );
    crate::schedule::tc_ms_of_day(&text, base)
        .ok()
        .map(|ms| ms + extra)
}

/// The difference between the source's time of day and the server's (ms),
/// within ±12 h (a source a little ahead across midnight is ahead).
pub fn offset(source_ms_of_day: i64, server_ms_of_day: i64) -> i64 {
    let day = crate::schedule::DAY_MS;
    let d = (source_ms_of_day - server_ms_of_day).rem_euclid(day);
    if d > day / 2 {
        d - day
    } else {
        d
    }
}

/// What the Settings and the Operator show of the timecode in use.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimecodeState {
    /// The input chosen ("" = the server's clock).
    pub input: String,
    /// Its timecode is coming in.
    pub ok: bool,
    /// Source − server time of day, ms (0 with the server's clock).
    pub offset_ms: i64,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_output::decklink::InputTimecode;

    fn tc(h: u8, m: u8, s: u8, f: u8, drop: bool, mark: bool) -> InputTimecode {
        InputTimecode {
            hours: h,
            minutes: m,
            seconds: s,
            frames: f,
            drop_frame: drop,
            field_mark: mark,
            count: 1,
        }
    }

    #[test]
    fn a_read_timecode_is_a_time_of_day() {
        let p25 = FrameRate::new(25, 1);
        assert_eq!(
            ms_of_day(&tc(20, 41, 30, 12, false, false), p25),
            Some(74_490_480)
        );
        // 50p, RP188 counting pairs: frame 12 of 25, second of the pair.
        let p50 = FrameRate::new(50, 1);
        assert_eq!(ms_of_day(&tc(0, 0, 1, 12, false, false), p50), Some(1_480));
        assert_eq!(ms_of_day(&tc(0, 0, 1, 12, false, true), p50), Some(1_500));
        // A full count (frame 40 of 50).
        assert_eq!(ms_of_day(&tc(0, 0, 1, 40, false, false), p50), Some(1_800));
        // Drop frame at 29.97.
        let df = FrameRate::new(30000, 1001);
        let ms = ms_of_day(&tc(0, 10, 0, 0, true, false), df).unwrap();
        assert!((ms - 600_000).abs() < 40, "{ms}");
    }

    #[test]
    fn the_offset_goes_the_short_way_round_midnight() {
        assert_eq!(offset(10_000, 4_000), 6_000);
        assert_eq!(offset(1_000, crate::schedule::DAY_MS - 1_000), 2_000);
        assert_eq!(offset(crate::schedule::DAY_MS - 1_000, 1_000), -2_000);
    }
}
