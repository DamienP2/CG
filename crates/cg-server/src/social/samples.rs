//! Sample messages of each platform, published by the Test button (and by
//! tests of what comes after: moderation, templates).

use super::run::message;
use super::{Author, Message, Platform, SocialSource};

/// The picture of the sample WhatsApp / SMS messages, under the media.
pub const PHOTO: &str = "social/sample-photo.jpg";

fn who(id: &str, name: &str, handle: &str) -> Author {
    Author {
        id: id.into(),
        name: name.into(),
        handle: handle.into(),
        ..Default::default()
    }
}

/// Three realistic messages of the connection's platform, new each time.
pub fn samples(src: &SocialSource) -> Vec<Message> {
    let photo = format!("/assets/{PHOTO}");
    // (author, text, amount, photo)
    let list: Vec<(Author, &str, &str, bool)> = match src.platform {
        Platform::Youtube => vec![
            (
                who("UCa1", "Sophie L.", ""),
                "Pourquoi la réforme ne concerne pas les indépendants ?",
                "",
                false,
            ),
            (who("UCb2", "Marc B.", ""), "Merci pour ce JT 👏", "", false),
            (
                who("UCc3", "Lina", ""),
                "Bravo à toute l’équipe",
                "5,00 €",
                false,
            ),
        ],
        Platform::Twitch => vec![
            (
                who("1201", "kevin_bzh", "kevin_bzh"),
                "premier !!",
                "",
                false,
            ),
            (
                who("1202", "Yanis", "yanis_tv"),
                "GG la régie, le direct est nickel",
                "",
                false,
            ),
            (
                who("1203", "MaelleGames", "maellegames"),
                "Cheer100 Bravo pour l’émission",
                "100 bits",
                false,
            ),
        ],
        Platform::Facebook => vec![
            (
                who("5521", "Pierre Durand", ""),
                "On peut revoir le reportage sur Brest ?",
                "",
                false,
            ),
            (
                who("5522", "Martine Leroy", ""),
                "Merci pour ces explications très claires",
                "",
                false,
            ),
            (
                who("5523", "Julien Morel", ""),
                "Et pour les retraités, qu’est-ce qui change ?",
                "",
                false,
            ),
        ],
        Platform::Instagram => vec![
            (
                who("1784", "julie.mrt", "julie.mrt"),
                "Superbe sujet ce soir 😍",
                "",
                false,
            ),
            (
                who("1785", "thomas_photo", "thomas_photo"),
                "Vous passez à Lyon demain ?",
                "",
                false,
            ),
            (
                who("1786", "camille.dsn", "camille.dsn"),
                "Le plateau est magnifique",
                "",
                false,
            ),
        ],
        Platform::X => vec![
            (
                who("99", "Anon", "anon_8812"),
                "Question pour le #JT20H : et les retraites ?",
                "",
                false,
            ),
            (
                who("100", "Le Figaro", "Le_Figaro"),
                "Le plateau du #JT20H ce soir 👇",
                "",
                false,
            ),
            (
                who("101", "Claire V.", "clairev"),
                "Très bon débat sur le #JT20H, enfin du fond",
                "",
                false,
            ),
        ],
        Platform::Tiktok => vec![
            (
                who("6812", "Lina ✨", "lina.tt"),
                "On vous regarde depuis Brest",
                "",
                false,
            ),
            (who("6813", "Marc", "marc.off"), "", "Rose × 5", false),
            (
                who("6814", "Inès", "ines_k"),
                "C’est quand le prochain live ?",
                "",
                false,
            ),
        ],
        Platform::Whatsapp => vec![
            (
                phone("+33612344107"),
                "Photo des inondations à Quimperlé ce soir 🌊",
                "",
                true,
            ),
            (
                phone("+33698761234"),
                "Bravo pour le reportage sur les agriculteurs",
                "",
                false,
            ),
            (
                who("+33755501122", "Sophie", ""),
                "Il pleut encore très fort à Morlaix",
                "",
                false,
            ),
        ],
        Platform::Sms => vec![
            (
                phone_in("+33612344107", "Lyon"),
                "Que fait le gouvernement pour les loyers ?",
                "",
                false,
            ),
            (
                phone_in("+33644558899", "Rennes"),
                "Merci pour le JT, toujours au top",
                "",
                false,
            ),
            (
                phone_in("+33677001234", "Brest"),
                "La route de Brest est coupée depuis ce matin",
                "",
                true,
            ),
        ],
    };
    list.into_iter()
        .map(|(author, text, amount, with_photo)| {
            let id = format!("test-{}", uuid::Uuid::new_v4().simple());
            let mut m = message(src, &id, author, text);
            m.amount = amount.into();
            if with_photo {
                m.photos.push(photo.clone());
            }
            m
        })
        .collect()
}

fn phone(n: &str) -> Author {
    Author {
        id: n.into(),
        name: super::webhooks::mask_phone(n),
        ..Default::default()
    }
}

fn phone_in(n: &str, city: &str) -> Author {
    Author {
        city: city.into(),
        ..phone(n)
    }
}

/// A 16:9 picture for the sample messages.
pub fn photo_jpeg() -> Vec<u8> {
    let (w, h) = (960u32, 540u32);
    let img = image::RgbImage::from_fn(w, h, |x, y| {
        let fx = x as f32 / w as f32;
        let fy = y as f32 / h as f32;
        // Sky to water, a darker shore line.
        let shore = ((fy - 0.55 - 0.05 * (fx * 9.0).sin()).abs() < 0.015) as u8 as f32;
        let r = 40.0 + 90.0 * (1.0 - fy) - 30.0 * shore;
        let g = 70.0 + 100.0 * (1.0 - fy) + 20.0 * fx - 40.0 * shore;
        let b = 110.0 + 120.0 * fy.min(0.55) + 60.0 * fx - 60.0 * shore;
        image::Rgb([r as u8, g as u8, b.min(255.0) as u8])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    let _ = img.write_to(&mut out, image::ImageFormat::Jpeg);
    out.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_new_samples_per_platform() {
        for p in [
            Platform::Youtube,
            Platform::Twitch,
            Platform::Facebook,
            Platform::Instagram,
            Platform::X,
            Platform::Tiktok,
            Platform::Whatsapp,
            Platform::Sms,
        ] {
            let src = SocialSource {
                id: "s".into(),
                name: "S".into(),
                platform: p,
                enabled: true,
                settings: Default::default(),
            };
            let a = samples(&src);
            assert_eq!(a.len(), 3);
            assert!(a
                .iter()
                .all(|m| m.platform == p && m.id.starts_with("s:test-")));
            assert_ne!(a[0].id, samples(&src)[0].id);
        }
        assert!(photo_jpeg().starts_with(&[0xFF, 0xD8]));
    }
}
